import { appendFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fileBodyCalls = vi.hoisted(() => ({ open: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fileBodyCalls.open.mockImplementation(actual.open);
  fileBodyCalls.readFile.mockImplementation(actual.readFile);
  return { ...actual, open: fileBodyCalls.open, readFile: fileBodyCalls.readFile };
});

import {
  createEnumerationIntent,
  createScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import {
  localFolderConnector,
  progressiveConnectorScopeHash,
} from "../src/index.js";

const roots: string[] = [];
const now = () => new Date("2026-07-27T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Local Folder progressive Connector", () => {
  it("enumerates three levels one direct layer at a time with zero body opens", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "alpha", "nested"), { recursive: true });
    await writeFile(join(root, "alpha", "nested", "leaf.md"), "private leaf body");
    await writeFile(join(root, "beta.md"), "private beta body");
    const source = await authorizedLocalSource(root);
    const action = bound(source);
    fileBodyCalls.open.mockClear();
    fileBodyCalls.readFile.mockClear();

    const rootsPage = await localFolderConnector.listRootsMetadata({ ...action, limit: 10, cursor: null, now });
    const rootNode = rootsPage.nodes[0]!;
    const firstTraversal = traversal(action, rootNode, null);
    const first = await localFolderConnector.listChildrenMetadata({
      ...action, ...firstTraversal, parent: rootNode, limit: 10, cursor: null, now,
    });
    expect(first.nodes.map(({ title }) => title)).toEqual(["alpha", "beta.md"]);
    expect(first.nodes.map(({ locator }) => locator).join("\n")).not.toContain("leaf.md");

    const alpha = first.nodes[0]!;
    const secondTraversal = traversal(action, alpha, rootNode);
    const second = await localFolderConnector.listChildrenMetadata({
      ...action, ...secondTraversal, parent: alpha, limit: 10, cursor: null, now,
    });
    expect(second.nodes.map(({ title }) => title)).toEqual(["nested"]);
    const thirdTraversal = traversal(action, second.nodes[0]!, alpha);
    const third = await localFolderConnector.listChildrenMetadata({
      ...action, ...thirdTraversal, parent: second.nodes[0]!, limit: 10, cursor: null, now,
    });
    expect(third.nodes.map(({ title }) => title)).toEqual(["leaf.md"]);

    expect(rootsPage.nodes).toHaveLength(1);
    expect(rootNode).toMatchObject({
      sourceId: source.sourceId,
      nodeId: source.rootNodeId,
      parentId: null,
      kind: "directory",
      permission: "readable",
      scanability: "metadata-only",
    });
    expect(first.nodes.every(completeSkeletonNode)).toBe(true);
    expect(fileBodyCalls.open).not.toHaveBeenCalled();
    expect(fileBodyCalls.readFile).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    await expect(localFolderConnector.listRootsMetadata({
      ...action, limit: 1, cursor: null, now,
    })).rejects.toThrow(/identity/i);
  });

  it("paginates deterministically with a cursor bound to source, parent and version", async () => {
    const root = await temporaryRoot();
    await Promise.all(["c.md", "a.md", "b.md"].map((name) => writeFile(join(root, name), name)));
    const source = await authorizedLocalSource(root);
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({
      ...action, limit: 1, cursor: null, now,
    })).nodes[0]!;

    const rootTraversal = traversal(action, rootNode, null);
    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [],
      parent: rootNode,
      limit: 2,
      cursor: null,
      now,
    })).rejects.toThrow(/intent|trusted/i);
    const page1 = await localFolderConnector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: rootNode, limit: 2, cursor: null, now,
    });
    const receipt1 = pageReceipt(action.plan, rootTraversal.intent, page1, 1, null);
    const page2 = await localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: rootNode,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    });
    expect(page1.nodes.map(({ title }) => title)).toEqual(["a.md", "b.md"]);
    expect(page1.pageComplete).toBe(false);
    expect(page2.nodes.map(({ title }) => title)).toEqual(["c.md"]);
    expect(page2).toMatchObject({ nextCursor: null, pageComplete: true });
    expect(page1.skeletonVersion).toBe(action.plan.skeletonVersion);
    expect(page2.skeletonVersion).toBe(action.plan.skeletonVersion);

    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      previousPageReceipt: null,
      parent: rootNode,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    })).rejects.toThrow(/page|receipt|cursor/i);
    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: rootNode,
      limit: 2,
      cursor: forgeCursor(page1.nextCursor!),
      now,
    })).rejects.toThrow(/page|receipt|cursor/i);

    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      sourceId: "other-source",
      parent: rootNode,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    })).rejects.toThrow(/sourceId|binding/i);
    await expect(localFolderConnector.listRootsMetadata({
      ...action,
      authorizationHash: sha256Canonical("forged-authorization"),
      limit: 1,
      cursor: null,
      now,
    })).rejects.toThrow(/binding/i);
    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      parent: { ...rootNode, locator: "file:///tmp" },
      limit: 2,
      cursor: null,
      now,
    })).rejects.toThrow(/root|scope|binding/i);
    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: { ...rootNode, nodeVersion: "stale" },
      limit: 2,
      cursor: page1.nextCursor,
      now,
    })).rejects.toThrow(/version|cursor/i);
  });

  it("fails closed for hidden, excluded and escaping symlink nodes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(root, ".hidden.md"), "hidden");
    await writeFile(join(root, "private.md"), "excluded");
    await writeFile(join(outside, "outside.md"), "outside");
    await import("node:fs/promises").then(({ symlink }) => symlink(join(outside, "outside.md"), join(root, "escape.md")));
    const source = await authorizedLocalSource(root, { exclude: ["/private.md"], symlinkPolicy: "within-root" });
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const rootTraversal = traversal(action, rootNode, null);
    const page = await localFolderConnector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: rootNode, limit: 10, cursor: null, now,
    });

    expect(JSON.stringify(page)).not.toMatch(/hidden|private|outside\.md|escape\.md|file:/iu);
    expect(page.nodes.every(({ permission, title, locator, sizeEstimate }) => (
      permission === "denied"
      && title === "Blocked item"
      && locator.startsWith("openlifewiki://blocked/")
      && sizeEstimate.bytes === null
    ))).toBe(true);
  });

  it("returns metadata versions and refuses stale or unauthorized body reads", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "leaf.md"), "approved body");
    const source = await authorizedLocalSource(root);
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const rootTraversal = traversal(action, rootNode, null);
    const leaf = (await localFolderConnector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: rootNode, limit: 10, cursor: null, now,
    })).nodes[0]!;
    const gate = bodyGate(action, rootNode, leaf);

    await expect(localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: { ...gate, decisionReceipts: [] },
    })).rejects.toThrow(/descend/i);
    await expect(localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: "stale",
      bodyReadGate: gate,
    })).rejects.toThrow(/version/i);
    const forgedSelection = {
      ...gate.leafSelectionReceipts[0]!, receiptHash: sha256Canonical("forged-selection"),
    };
    await expect(localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: {
        ...gate,
        leafSelectionReceipts: [forgedSelection],
        trustedReceiptHashes: [...gate.trustedReceiptHashes, forgedSelection.receiptHash],
      },
    })).rejects.toThrow(/integrity/i);
    await expect(localFolderConnector.readApprovedLeafBody({
      ...action,
      node: { ...leaf, locator: rootNode.locator },
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: gate,
    })).rejects.toThrow(/node|path|binding/i);

    expect(await localFolderConnector.getVersion({ ...action, node: leaf })).toBe(leaf.nodeVersion);
    const approved = await localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: gate,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of approved.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("approved body");

    await writeFile(join(root, "leaf.md"), "changed approved body with a new size");
    expect(await localFolderConnector.getVersion({ ...action, node: leaf })).not.toBe(leaf.nodeVersion);
    await expect(localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: gate,
    })).rejects.toThrow(/version/i);
    await rm(join(root, "leaf.md"), { force: true });
    await expect(localFolderConnector.getVersion({ ...action, node: leaf })).rejects.toThrow(/deleted|changed/i);
  });

  it("never emits bytes beyond the authorized budget when a selected leaf grows", async () => {
    const root = await temporaryRoot();
    const path = join(root, "growing.md");
    await writeFile(path, Buffer.alloc(64 * 1024, "a"));
    const source = await authorizedLocalSource(root, { maxBodyBytes: 70_000 });
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({
      ...action, limit: 1, cursor: null, now,
    })).nodes[0]!;
    const rootTraversal = traversal(action, rootNode, null);
    const leaf = (await localFolderConnector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: rootNode, limit: 10, cursor: null, now,
    })).nodes[0]!;
    const approved = await localFolderConnector.readApprovedLeafBody({
      ...action,
      node: leaf,
      expectedVersion: leaf.nodeVersion,
      bodyReadGate: bodyGate(action, rootNode, leaf),
    });
    const iterator = approved.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.byteLength).toBe(64 * 1024);
    await appendFile(path, Buffer.alloc(10_000, "b"));
    await expect(iterator.next()).rejects.toThrow(/budget/i);
  });
});

function bound(source: AuthorizedSourceV1) {
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-local",
    sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash],
    rootNodeIds: [source.rootNodeId],
    skeletonVersion: sha256Canonical("skeleton"),
    agentProfileId: "agent-codex",
    skillHash: sha256Canonical("skill"),
    scanIntent: "Build the current reusable knowledge Wiki.",
    priorityDocumentRefs: [],
    policy: {
      include: ["/**"], exclude: [], sensitivity: "normal", budget: {},
      indexing: { default: "qmd-current", rules: [] },
    },
  });
  return {
    source,
    plan,
    sourceId: source.sourceId,
    authorizationHash: source.authorizationHash,
    rootNodeId: source.rootNodeId,
    scopeHash: progressiveConnectorScopeHash(source),
  } as const;
}

async function authorizedLocalSource(
  root: string,
  overrides: {
    readonly exclude?: readonly string[];
    readonly symlinkPolicy?: "deny" | "within-root";
    readonly maxBodyBytes?: number;
  } = {},
): Promise<AuthorizedSourceV1> {
  const actual = await realpath(root);
  const details = await stat(actual);
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint: sha256Canonical("owner"),
    previewHash: sha256Canonical("preview"),
    configHash: sha256Canonical("config"),
    configRevision: 1,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source-local",
    connectorType: "local-folder" as const,
    rootNodeId: "local-root",
    identityFingerprint: sha256Canonical({
      provider: "filesystem", actual, device: String(details.dev), inode: String(details.ino),
    }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    scope: {
      schema: "openlifewiki.scope/local-folder/v1",
      root,
      symlinkPolicy: overrides.symlinkPolicy ?? "deny",
    },
    include: ["**/*.md"],
    exclude: overrides.exclude ?? [],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: overrides.maxBodyBytes ?? 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function bodyGate(
  action: ReturnType<typeof bound>,
  root: SkeletonNode,
  leaf: SkeletonNode,
) {
  const { plan, source } = action;
  const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    authorizationHash: source.authorizationHash,
    sourceId: source.sourceId,
    parentNodeId: root.nodeId,
    parentNodeVersion: root.nodeVersion,
    childSetHash: sha256Canonical("children"),
    nodeId: leaf.nodeId,
    nodeVersion: leaf.nodeVersion,
    targetKind: "leaf",
    summaryHash: sha256Canonical("summary"),
    inputSetHash: sha256Canonical("input"),
    decision: "descend",
    reason: "Selected within scope and budget",
    revisitCondition: null,
    question: null,
    actor: "agent-codex",
    estimatedCost: { nodes: 1, bodyBytes: 13, agentCalls: 1 },
    persistedAt: "2026-07-27T00:01:00.000Z",
  };
  const decision: ScanDecision = { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1",
    scanId: plan.scanId,
    sourceId: source.sourceId,
    nodeId: leaf.nodeId,
    nodeVersion: leaf.nodeVersion,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    authorizationHash: source.authorizationHash,
    inputSetHash: decision.inputSetHash,
    decisionReceiptHash: decision.receiptHash,
    actor: "agent-codex",
    reason: "Selected within the approved body budget",
    persistedAt: "2026-07-27T00:01:01.000Z",
  };
  const selection: LeafSelectionReceipt = {
    ...selectionPayload, receiptHash: sha256Canonical(selectionPayload),
  };
  return {
    request: {
      sourceId: source.sourceId,
      nodeId: leaf.nodeId,
      authorizationHash: source.authorizationHash,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
      nodeVersion: leaf.nodeVersion,
    },
    authorization: source,
    plan,
    path: [root, leaf],
    decisionReceipts: [decision],
    leafSelectionReceipts: [selection],
    trustedReceiptHashes: [decision.receiptHash, selection.receiptHash],
  };
}

function traversal(
  action: ReturnType<typeof bound>,
  target: SkeletonNode,
  parentLayer: SkeletonNode | null,
) {
  const decision = parentLayer === null ? null : containerDecision(action.plan, action.source, parentLayer, target);
  const intent = createEnumerationIntent({
    plan: action.plan,
    trustedDecisionReceiptHashes: decision === null ? [] : [decision.receiptHash],
    decisionReceipt: decision,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: `intent-${target.nodeId.slice(0, 20)}`,
      sourceId: action.sourceId,
      targetNodeId: target.nodeId,
      targetNodeVersion: target.nodeVersion,
      authorizationHash: action.authorizationHash,
      origin: parentLayer === null ? "authorized-root" : "container-descend",
      parentLayerNodeId: parentLayer?.nodeId ?? null,
      childSetHash: decision?.childSetHash ?? null,
      inputSetHash: decision?.inputSetHash ?? sha256Canonical(`root-${target.nodeId}`),
      createdAt: now().toISOString(),
    },
  });
  return {
    intent,
    trustedDecisionReceipts: decision === null ? [] : [decision],
    trustedReceiptHashes: [intent.receiptHash, ...(decision === null ? [] : [decision.receiptHash])],
    previousPageReceipt: null,
  } as const;
}

function containerDecision(
  plan: ScanPlan,
  source: AuthorizedSourceV1,
  parent: SkeletonNode,
  target: SkeletonNode,
): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    authorizationHash: source.authorizationHash,
    sourceId: source.sourceId,
    parentNodeId: parent.nodeId,
    parentNodeVersion: parent.nodeVersion,
    childSetHash: sha256Canonical({ parent: parent.nodeId, target: target.nodeId }),
    nodeId: target.nodeId,
    nodeVersion: target.nodeVersion,
    targetKind: "container",
    summaryHash: sha256Canonical(`summary-${parent.nodeId}`),
    inputSetHash: sha256Canonical(`input-${target.nodeId}`),
    decision: "descend",
    reason: "Selected container within scope and budget",
    revisitCondition: null,
    question: null,
    actor: "agent-codex",
    estimatedCost: { nodes: 1, bodyBytes: 0, agentCalls: 1 },
    persistedAt: now().toISOString(),
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function pageReceipt(
  plan: ScanPlan,
  intent: EnumerationIntent,
  page: SkeletonPage,
  pageSequence: number,
  previous: EnumerationPageReceipt | null,
): EnumerationPageReceipt {
  const payload: Omit<EnumerationPageReceipt, "receiptHash"> = {
    schema: "openlifewiki.enumeration-page-receipt/v1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    sourceId: intent.sourceId,
    intentId: intent.intentId,
    pageSequence,
    eventSequence: pageSequence,
    previousPageReceiptHash: previous?.receiptHash ?? null,
    discoveredNodeIds: page.nodes.map(({ nodeId }) => nodeId),
    knownUnenumeratedSlotIds: [],
    nextCursor: page.nextCursor,
    childCountKind: "known",
    state: page.pageComplete ? "complete" : "open",
    childSetHash: page.pageComplete ? sha256Canonical(page.nodes.map(({ nodeId }) => nodeId)) : null,
    observedAt: page.observedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function forgeCursor(cursor: string): string {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    payload: Record<string, unknown>;
  };
  const payload = { ...parsed.payload, offset: Number(parsed.payload.offset) + 1 };
  return Buffer.from(JSON.stringify({ payload, hash: sha256Canonical(payload) })).toString("base64url");
}

function completeSkeletonNode(node: SkeletonNode): boolean {
  return node.schema === "openlifewiki.skeleton-node/v1"
    && node.locator.startsWith("file:")
    && node.childCount.kind.length > 0
    && node.page.hasMore === false
    && node.sizeEstimate.kind.length > 0
    && node.nodeVersion.startsWith("sha256:");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-local-progressive-"));
  roots.push(root);
  return root;
}
