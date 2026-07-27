import { TextDecoder } from "node:util";

import { describe, expect, it } from "vitest";

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

import type { CommandOptions, CommandRunner } from "../src/command-runner.js";
import {
  createBodyBudgetReservationReceipt,
  progressiveConnectorScopeHash,
} from "../src/connectors/connector-provider.js";
import { createGithubConnector } from "../src/connectors/github.js";

const now = () => new Date("2026-07-27T00:00:00.000Z");
const PHYSICAL_IO_HASH = sha256Canonical("github-physical-io-accounting");

describe("GitHub progressive Connector", () => {
  it("enumerates repository metadata one direct layer at a time and reads no blob before approval", async () => {
    const fixture = githubFixture();
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());

    const roots = await connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now });
    const root = roots.nodes[0]!;
    const first = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    expect(first.nodes.map(({ title }) => title)).toEqual(["docs", "README.md"]);
    expect(first.nodes.map(({ title }) => title)).not.toContain("guide.md");

    const docs = first.nodes[0]!;
    const second = await connector.listChildrenMetadata({
      ...action, ...traversal(action, docs, root), parent: docs, limit: 10, cursor: null, now,
    });
    expect(second.nodes.map(({ title }) => title)).toEqual(["guide.md"]);
    expect(fixture.blobCalls()).toHaveLength(0);
    expect(fixture.treeCalls().every((call) => !call.args.includes("recursive"))).toBe(true);
    expect([...roots.nodes, ...first.nodes, ...second.nodes].every((node) => (
      node.sourceId === action.sourceId && node.locator.startsWith("openlifewiki-github:")
    ))).toBe(true);

    const readme = first.nodes[1]!;
    const approved = await connector.readApprovedLeafBody({
      ...action,
      node: readme,
      expectedVersion: readme.nodeVersion,
      ...bodyPermit(action, readme, bodyGate(action, root, readme)),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of approved.stream) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("# OpenLifeWiki\n");
    expect(fixture.blobCalls()).toHaveLength(1);
    expect(fixture.calls.every(({ options }) => (
      options?.env?.GH_TOKEN === undefined && options?.env?.GITHUB_TOKEN === undefined
    ))).toBe(true);
  });

  it("paginates a fixed tree with trusted, source-bound continuation receipts", async () => {
    const fixture = githubFixture({
      rootTree: [
        { path: "c.md", type: "blob", sha: "blob-c", size: 1 },
        { path: "a.md", type: "blob", sha: "blob-a", size: 1 },
        { path: "b.md", type: "blob", sha: "blob-b", size: 1 },
      ],
    });
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const rootTraversal = traversal(action, root, null);
    const page1 = await connector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: root, limit: 2, cursor: null, now,
    });
    const receipt1 = pageReceipt(action.plan, rootTraversal.intent, page1, 1, null);
    const page2 = await connector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: root,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    });
    expect(page1.nodes.map(({ title }) => title)).toEqual(["a.md", "b.md"]);
    expect(page2.nodes.map(({ title }) => title)).toEqual(["c.md"]);
    expect(page2).toMatchObject({ nextCursor: null, pageComplete: true });

    await expect(connector.listChildrenMetadata({
      ...action, ...rootTraversal, previousPageReceipt: null, parent: root,
      limit: 2, cursor: page1.nextCursor, now,
    })).rejects.toThrow(/page|receipt/i);
    await expect(connector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: root,
      limit: 2,
      cursor: forgeCursor(page1.nextCursor!),
      now,
    })).rejects.toThrow(/cursor|receipt/i);
    expect(fixture.blobCalls()).toHaveLength(0);
  });

  it("intersects authorized and plan scopes and rejects locator escapes", async () => {
    const fixture = githubFixture({
      docsTree: [
        { path: "guide.md", type: "blob", sha: "blob-guide", size: 8 },
        { path: "secret.md", type: "blob", sha: "blob-secret", size: 6 },
        { path: "archive", type: "tree", sha: "tree-archive", size: null },
      ],
    });
    const connector = createGithubConnector(fixture.runner);
    const source = authorizedGithubSource({ path: "docs", exclude: ["/secret.md"] });
    const action = bound(source, { include: ["/guide*"] });
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    expect(page.nodes.map(({ title }) => title)).toEqual(["guide.md"]);

    await expect(connector.getVersion({
      ...action,
      node: { ...page.nodes[0]!, locator: page.nodes[0]!.locator.replace("path=docs%2Fguide.md", "path=README.md") },
    })).rejects.toThrow(/scope|binding/i);
    await expect(connector.listRootsMetadata({
      ...action, authorizationHash: sha256Canonical("forged"), limit: 1, cursor: null, now,
    })).rejects.toThrow(/binding/i);
  });

  it("fails closed for malformed, duplicate or incomplete direct-child layers", async () => {
    for (const rootTree of [
      [
        { path: "same.md", type: "blob", sha: "one", size: 1 },
        { path: "same.md", type: "blob", sha: "two", size: 1 },
      ],
      [{ path: "nested/leaf.md", type: "blob", sha: "nested", size: 1 }],
    ] as const) {
      const fixture = githubFixture({ rootTree });
      const connector = createGithubConnector(fixture.runner);
      const action = bound(authorizedGithubSource());
      const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
      await expect(connector.listChildrenMetadata({
        ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
      })).rejects.toThrow(/incomplete|duplicate|invalid/i);
    }

    const truncated = githubFixture({ truncated: true });
    const connector = createGithubConnector(truncated.runner);
    const action = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    await expect(connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    })).rejects.toThrow(/incomplete/i);
  });

  it("binds body reads to the current blob version, trusted gate and byte reservation", async () => {
    const fixture = githubFixture();
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const readme = page.nodes.find(({ title }) => title === "README.md")!;
    const gate = bodyGate(action, root, readme);
    const permit = bodyPermit(action, readme, gate);

    await expect(connector.readApprovedLeafBody({
      ...action, node: readme, expectedVersion: "stale-sha", ...permit,
    })).rejects.toThrow(/binding|version/i);
    await expect(connector.readApprovedLeafBody({
      ...action,
      node: readme,
      expectedVersion: readme.nodeVersion,
      ...permit,
      bodyReadGate: { ...permit.bodyReadGate, trustedReceiptHashes: [] },
    })).rejects.toThrow(/trusted|ledger|budget/i);
    await expect(connector.readApprovedLeafBody({
      ...action,
      node: readme,
      expectedVersion: readme.nodeVersion,
      ...bodyPermit(action, readme, gate, 10),
    })).rejects.toThrow(/budget/i);

    fixture.setObject("main:README.md", { __typename: "Blob", oid: "blob-readme-new", byteSize: 15 });
    await expect(connector.readApprovedLeafBody({
      ...action, node: readme, expectedVersion: readme.nodeVersion, ...permit,
    })).rejects.toThrow(/changed|version/i);
    expect(fixture.blobCalls()).toHaveLength(0);
  });

  it("uses raw GraphQL string fields and rejects file-magic refs", async () => {
    const fixture = githubFixture();
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());
    await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now });
    const graphql = fixture.calls.find(({ args }) => args[1] === "graphql")!;
    expect(graphql.args).not.toContain("-F");
    expect(graphql.args.filter((arg) => arg === "-f")).toHaveLength(4);

    const dangerous = bound(authorizedGithubSource({ ref: "@/etc/hosts" }));
    await expect(connector.listRootsMetadata({ ...dangerous, limit: 1, cursor: null, now }))
      .rejects.toMatchObject({ code: "GITHUB_SCOPE_INVALID" });
  });

  it("rechecks effective scope and logical identity for version and body actions", async () => {
    const fixture = githubFixture();
    const connector = createGithubConnector(fixture.runner);
    const source = authorizedGithubSource({ exclude: ["/README.md"] });
    const action = bound(source);
    const allowedAction = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...allowedAction, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await connector.listChildrenMetadata({
      ...allowedAction, ...traversal(allowedAction, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const readme = page.nodes.find(({ title }) => title === "README.md")!;
    const excludedNode = { ...readme, sourceId: action.sourceId };
    const gate = bodyGate(action, { ...root, sourceId: action.sourceId }, excludedNode);

    await expect(connector.getVersion({ ...action, node: excludedNode }))
      .rejects.toMatchObject({ code: "GITHUB_SCOPE_DENIED" });
    await expect(connector.readApprovedLeafBody({
      ...action, node: excludedNode, expectedVersion: excludedNode.nodeVersion,
      ...bodyPermit(action, excludedNode, gate),
    })).rejects.toMatchObject({ code: "GITHUB_SCOPE_DENIED" });
    expect(fixture.blobCalls()).toHaveLength(0);
  });

  it("fails a large layer from count metadata before downloading the full tree", async () => {
    const rootTree = Array.from({ length: 2_001 }, (_, index) => ({
      path: `doc-${String(index).padStart(4, "0")}.md`, type: "blob" as const, sha: `blob-${index}`, size: 1,
    }));
    const fixture = githubFixture({ rootTree });
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    await expect(connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 500, cursor: null, now,
    })).rejects.toMatchObject({ code: "GITHUB_LAYER_TOO_LARGE" });
    expect(fixture.fullTreeCalls()).toHaveLength(0);
  });

  it("blocks unknown or oversized bodies before the buffered blob request", async () => {
    const fixture = githubFixture();
    fixture.setObject("main:README.md", { __typename: "Blob", oid: "blob-readme", byteSize: 700 * 1024 });
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource({ maxBodyBytes: 1_000_000 }));
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const readme = page.nodes.find(({ title }) => title === "README.md")!;
    await expect(connector.readApprovedLeafBody({
      ...action, node: readme, expectedVersion: readme.nodeVersion,
      ...bodyPermit(action, readme, bodyGate(action, root, readme), 800 * 1024),
    })).rejects.toMatchObject({ code: "GITHUB_BODY_TOO_LARGE" });
    expect(fixture.blobCalls()).toHaveLength(0);
  });

  it("keeps gitlink submodules as blocked metadata placeholders", async () => {
    const fixture = githubFixture({ rootTree: [
      { path: "vendor", type: "commit", sha: "submodule-sha", size: null },
    ] });
    const connector = createGithubConnector(fixture.runner);
    const action = bound(authorizedGithubSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const page = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    expect(page.nodes).toMatchObject([{ title: "vendor", kind: "submodule", permission: "denied", scanability: "metadata-only" }]);
  });
});

interface MockTreeEntry {
  readonly path: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  readonly size: number | null;
}

function githubFixture(overrides: {
  readonly rootTree?: readonly MockTreeEntry[];
  readonly docsTree?: readonly MockTreeEntry[];
  readonly truncated?: boolean;
} = {}) {
  const calls: { readonly args: readonly string[]; readonly options?: CommandOptions }[] = [];
  const objects = new Map<string, Record<string, unknown>>([
    ["main", { __typename: "Commit", oid: "commit-main", tree: { oid: "tree-root" } }],
    ["main:docs", { __typename: "Tree", oid: "tree-docs" }],
    ["main:README.md", { __typename: "Blob", oid: "blob-readme", byteSize: 15 }],
    ["main:docs/guide.md", { __typename: "Blob", oid: "blob-guide", byteSize: 8 }],
  ]);
  const trees = new Map<string, readonly MockTreeEntry[]>([
    ["tree-root", overrides.rootTree ?? [
      { path: "README.md", type: "blob", sha: "blob-readme", size: 15 },
      { path: "docs", type: "tree", sha: "tree-docs", size: null },
    ]],
    ["tree-docs", overrides.docsTree ?? [
      { path: "guide.md", type: "blob", sha: "blob-guide", size: 8 },
    ]],
  ]);
  const bodies = new Map<string, Uint8Array>([
    ["blob-readme", Buffer.from("# OpenLifeWiki\n")],
    ["blob-guide", Buffer.from("# Guide\n")],
  ]);
  const runner: CommandRunner = {
    async run(_command, args, options) {
      calls.push({ args, ...(options === undefined ? {} : { options }) });
      if (args[0] === "--version") return { stdout: "gh version 2.87.3\n", stderr: "" };
      if (args[0] === "auth") {
        return { stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, login: "octocat" }] } }), stderr: "" };
      }
      if (args[0] !== "api") throw new Error("Unexpected GitHub command");
      if (args[1] === "graphql") {
        const expression = args.find((arg) => arg.startsWith("expression="))?.slice("expression=".length);
        const object = expression === undefined ? undefined : objects.get(expression);
        return {
          stdout: JSON.stringify({ data: { repository: { nameWithOwner: "octo/wiki", object: object ?? null } } }),
          stderr: "",
        };
      }
      const treeSha = args[1]?.match(/\/git\/trees\/([^/?]+)/u)?.[1];
      if (treeSha !== undefined) {
        const tree = trees.get(treeSha) ?? [];
        if (args.includes("--jq")) {
          return {
            stdout: JSON.stringify({ truncated: overrides.truncated ?? false, count: tree.length }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({ truncated: overrides.truncated ?? false, tree }),
          stderr: "",
        };
      }
      const blobSha = args[1]?.match(/\/git\/blobs\/([^/?]+)/u)?.[1];
      if (blobSha !== undefined) {
        const body = bodies.get(blobSha) ?? Buffer.alloc(0);
        if (args.includes("--jq")) {
          return { stdout: `${Buffer.from(body).toString("base64")}\n`, stderr: "" };
        }
        return {
          stdout: JSON.stringify({ encoding: "base64", content: Buffer.from(body).toString("base64"), size: body.byteLength }),
          stderr: "",
        };
      }
      throw new Error("Unexpected GitHub API endpoint");
    },
  };
  return {
    runner,
    calls,
    treeCalls: () => calls.filter(({ args }) => args[1]?.includes("/git/trees/")),
    fullTreeCalls: () => calls.filter(({ args }) => args[1]?.includes("/git/trees/") && !args.includes("--jq")),
    blobCalls: () => calls.filter(({ args }) => args[1]?.includes("/git/blobs/")),
    setObject: (expression: string, object: Record<string, unknown>) => objects.set(expression, object),
  };
}

function authorizedGithubSource(overrides: {
  readonly path?: string | null;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly ref?: string;
} = {}): AuthorizedSourceV1 {
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: now().toISOString(),
    ownerIdentityFingerprint: sha256Canonical("owner"),
    previewHash: sha256Canonical("preview"),
    configHash: sha256Canonical("config"),
    configRevision: 1,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source-github",
    connectorType: "github" as const,
    rootNodeId: "github-root",
    identityFingerprint: sha256Canonical({ provider: "github", hostname: "github.com", login: "octocat" }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    providerObservation: { providerName: "gh", providerVersion: "2.87.3", contractHash: null },
    scope: {
      schema: "openlifewiki.scope/github/v1",
      hostname: "github.com",
      repository: "octo/wiki",
      ref: overrides.ref ?? "main",
      path: overrides.path ?? null,
    },
    include: overrides.include ?? ["/**"],
    exclude: overrides.exclude ?? [],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: overrides.maxBodyBytes ?? 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: now().toISOString(),
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function bound(source: AuthorizedSourceV1, policy: {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxBodyBytes?: number;
} = {}) {
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-github",
    sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash],
    rootNodeIds: [source.rootNodeId],
    skeletonVersion: sha256Canonical("github-skeleton-v1"),
    agentProfileId: "agent-codex",
    skillHash: sha256Canonical("skill"),
    scanIntent: "Build the current reusable knowledge Wiki.",
    priorityDocumentRefs: [],
    policy: {
      include: policy.include ?? ["/**"],
      exclude: policy.exclude ?? [],
      sensitivity: "normal",
      budget: policy.maxBodyBytes === undefined ? {} : { maxBodyBytes: policy.maxBodyBytes },
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

function traversal(action: ReturnType<typeof bound>, target: SkeletonNode, parentLayer: SkeletonNode | null) {
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

function bodyGate(action: ReturnType<typeof bound>, root: SkeletonNode, leaf: SkeletonNode) {
  const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1",
    scanId: action.plan.scanId,
    scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion,
    authorizationHash: action.authorizationHash,
    sourceId: action.sourceId,
    parentNodeId: root.nodeId,
    parentNodeVersion: root.nodeVersion,
    childSetHash: sha256Canonical("github-root-children"),
    nodeId: leaf.nodeId,
    nodeVersion: leaf.nodeVersion,
    targetKind: "leaf",
    summaryHash: sha256Canonical("github-summary"),
    inputSetHash: sha256Canonical("github-input"),
    decision: "descend",
    reason: "Selected within scope and budget",
    revisitCondition: null,
    question: null,
    actor: "agent-codex",
    estimatedCost: { nodes: 1, bodyBytes: 15, agentCalls: 1 },
    persistedAt: "2026-07-27T00:01:00.000Z",
  };
  const decision: ScanDecision = { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1",
    scanId: action.plan.scanId,
    sourceId: action.sourceId,
    nodeId: leaf.nodeId,
    nodeVersion: leaf.nodeVersion,
    scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion,
    authorizationHash: action.authorizationHash,
    inputSetHash: decision.inputSetHash,
    decisionReceiptHash: decision.receiptHash,
    actor: "agent-codex",
    reason: "Selected within the approved body budget",
    persistedAt: "2026-07-27T00:01:01.000Z",
  };
  const selection: LeafSelectionReceipt = { ...selectionPayload, receiptHash: sha256Canonical(selectionPayload) };
  return {
    request: {
      sourceId: action.sourceId,
      nodeId: leaf.nodeId,
      authorizationHash: action.authorizationHash,
      scanPlanHash: action.plan.scanPlanHash,
      skeletonVersion: action.plan.skeletonVersion,
      nodeVersion: leaf.nodeVersion,
    },
    authorization: action.source,
    plan: action.plan,
    path: [root, leaf],
    decisionReceipts: [decision],
    leafSelectionReceipts: [selection],
    trustedReceiptHashes: [decision.receiptHash, selection.receiptHash],
  };
}

function bodyPermit(
  action: ReturnType<typeof bound>,
  node: SkeletonNode,
  gate: ReturnType<typeof bodyGate>,
  reservedBytes = action.source.budget.maxBodyBytes,
) {
  const budgetReservation = createBodyBudgetReservationReceipt({
    schema: "openlifewiki.body-budget-reservation/v1",
    scanId: action.plan.scanId,
    scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion,
    authorizationHash: action.authorizationHash,
    sourceId: action.sourceId,
    nodeId: node.nodeId,
    nodeVersion: node.nodeVersion,
    physicalIoAccountingHash: PHYSICAL_IO_HASH,
    remainingBeforeBytes: action.source.budget.maxBodyBytes,
    reservedBytes,
    reservedAt: now().toISOString(),
  });
  return {
    budgetReservation,
    activeReservationReceiptHash: budgetReservation.receiptHash,
    expectedPhysicalIoAccountingHash: PHYSICAL_IO_HASH,
    bodyReadGate: {
      ...gate,
      trustedReceiptHashes: [...gate.trustedReceiptHashes, budgetReservation.receiptHash],
    },
  };
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
    readonly payload: Record<string, unknown>;
  };
  const payload = { ...parsed.payload, offset: Number(parsed.payload.offset) + 1 };
  return Buffer.from(JSON.stringify({ payload, hash: sha256Canonical(payload) })).toString("base64url");
}
