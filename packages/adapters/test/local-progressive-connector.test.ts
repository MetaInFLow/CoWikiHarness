import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  createScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
  type LeafSelectionReceipt,
  type ScanDecision,
  type SkeletonNode,
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
    const source = authorizedLocalSource(root);
    const action = bound(source);
    fileBodyCalls.open.mockClear();
    fileBodyCalls.readFile.mockClear();

    const rootsPage = await localFolderConnector.listRootsMetadata({ ...action, limit: 10, cursor: null, now });
    const rootNode = rootsPage.nodes[0]!;
    const first = await localFolderConnector.listChildrenMetadata({
      ...action, parent: rootNode, limit: 10, cursor: null, now,
    });
    expect(first.nodes.map(({ title }) => title)).toEqual(["alpha", "beta.md"]);
    expect(first.nodes.map(({ locator }) => locator).join("\n")).not.toContain("leaf.md");

    const alpha = first.nodes[0]!;
    const second = await localFolderConnector.listChildrenMetadata({
      ...action, parent: alpha, limit: 10, cursor: null, now,
    });
    expect(second.nodes.map(({ title }) => title)).toEqual(["nested"]);
    const third = await localFolderConnector.listChildrenMetadata({
      ...action, parent: second.nodes[0]!, limit: 10, cursor: null, now,
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
  });

  it("paginates deterministically with a cursor bound to source, parent and version", async () => {
    const root = await temporaryRoot();
    await Promise.all(["c.md", "a.md", "b.md"].map((name) => writeFile(join(root, name), name)));
    const source = authorizedLocalSource(root);
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({
      ...action, limit: 1, cursor: null, now,
    })).nodes[0]!;

    const page1 = await localFolderConnector.listChildrenMetadata({
      ...action, parent: rootNode, limit: 2, cursor: null, now,
    });
    const page2 = await localFolderConnector.listChildrenMetadata({
      ...action, parent: rootNode, limit: 2, cursor: page1.nextCursor, now,
    });
    expect(page1.nodes.map(({ title }) => title)).toEqual(["a.md", "b.md"]);
    expect(page1.pageComplete).toBe(false);
    expect(page2.nodes.map(({ title }) => title)).toEqual(["c.md"]);
    expect(page2).toMatchObject({ nextCursor: null, pageComplete: true });

    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
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
      parent: { ...rootNode, locator: "file:///tmp" },
      limit: 2,
      cursor: null,
      now,
    })).rejects.toThrow(/root|scope|binding/i);
    await expect(localFolderConnector.listChildrenMetadata({
      ...action,
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
    const source = authorizedLocalSource(root, { exclude: ["/private.md"], symlinkPolicy: "within-root" });
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await localFolderConnector.listChildrenMetadata({
      ...action, parent: rootNode, limit: 10, cursor: null, now,
    });

    expect(Object.fromEntries(page.nodes.map((node) => [node.title, node.permission]))).toEqual({
      ".hidden.md": "denied",
      "escape.md": "denied",
      "private.md": "denied",
    });
    expect(page.nodes.every(({ scanability }) => scanability === "metadata-only")).toBe(true);
  });

  it("returns metadata versions and refuses stale or unauthorized body reads", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "leaf.md"), "approved body");
    const source = authorizedLocalSource(root);
    const action = bound(source);
    const rootNode = (await localFolderConnector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const leaf = (await localFolderConnector.listChildrenMetadata({
      ...action, parent: rootNode, limit: 10, cursor: null, now,
    })).nodes[0]!;
    const gate = bodyGate(source, rootNode, leaf);

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
});

function bound(source: AuthorizedSourceV1) {
  return {
    source,
    sourceId: source.sourceId,
    authorizationHash: source.authorizationHash,
    rootNodeId: source.rootNodeId,
    scopeHash: progressiveConnectorScopeHash(source),
  } as const;
}

function authorizedLocalSource(
  root: string,
  overrides: { readonly exclude?: readonly string[]; readonly symlinkPolicy?: "deny" | "within-root" } = {},
): AuthorizedSourceV1 {
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
    identityFingerprint: sha256Canonical({ root }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    scope: {
      schema: "openlifewiki.scope/local-folder/v1",
      root,
      symlinkPolicy: overrides.symlinkPolicy ?? "deny",
    },
    include: ["**/*.md"],
    exclude: overrides.exclude ?? [],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function bodyGate(source: AuthorizedSourceV1, root: SkeletonNode, leaf: SkeletonNode) {
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
