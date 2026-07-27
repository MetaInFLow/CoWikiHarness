import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  buildSkeletonTrustedChildren,
  createAgentScanInvocationReceipt,
  createScanPlan,
  createScanPlanPolicyMaterial,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanInputContext,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type ConnectorStatus,
  type ScanPlan,
  type RuntimeLayout,
  type ScanDecision,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import {
  approveScanPlan,
  beginScanLayerDecision,
  closeScanFrontier,
  commitScanLayerOutcome,
  controlScan,
  createScanStore,
  currentOwnerIdentityFingerprint,
  progressiveConnectorScopeHash,
  readScanWorkspace,
  readScanStore,
  recordScanEnumerationPage,
  recordScanProbeConnected,
  recordScanSourceRoots,
  resolveRuntimeLayout,
  scanStoreStatePath,
  writeConfig,
  type AgentLayerSummary,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const TEST_AGENT = { id: "agent_codex_native", runtime: "codex" as const, mode: "native-cli" as const };
const CANONICAL_SKILL_HASH = sha256Canonical(await readFile(
  new URL("../../../skills/openlifewiki-progressive-scan/SKILL.md", import.meta.url), "utf8",
));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("progressive scan frontier", () => {
  it("requires an exact connected status for every authorized Source", async () => {
    const layout = await temporaryLayout();
    const dataDir = layout.dataDir;
    const sources = [authorizedSource("source_a"), authorizedSource("source_b", "github")];
    const plan = scanPlan(sources);
    await authorizeHostConfig(dataDir, sources);
    await createScanStore({ dataDir, plan });
    await approveScanPlan({ dataDir, layout, scanId: plan.scanId, expectedRevision: 0 });

    await expect(recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources,
      statuses: [connectedStatus(sources[0]!)],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await expect(recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources,
      statuses: [connectedStatus(sources[0]!), {
        ...connectedStatus(sources[1]!),
        identity: { fingerprint: HASH_B },
      }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await expect(recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources: [...sources].reverse(),
      statuses: sources.map(connectedStatus).reverse(),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await expect(recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources,
      statuses: [connectedStatus(sources[0]!), {
        ...connectedStatus(sources[1]!),
        providerProject: "wrong/project",
      }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const connected = await recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources,
      statuses: sources.map(connectedStatus),
    });
    expect(connected.state.phase).toBe("Discovering");
    expect(connected.connectorStatuses).toHaveLength(2);

    await expect(recordScanSourceRoots({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 2,
      roots: [...sources].reverse().map((source) => ({
        source,
        page: rootPage(source, plan, 0),
        createdAt: AT,
      })),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("persists provider roots and enforces the durable pagination cursor without reading bodies", async () => {
    const layout = await temporaryLayout();
    const dataDir = layout.dataDir;
    const source = authorizedSource();
    const plan = scanPlan([source]);
    await authorizeHostConfig(dataDir, [source]);
    await createScanStore({ dataDir, plan });
    await approveScanPlan({ dataDir, layout, scanId: plan.scanId, expectedRevision: 0 });
    await recordScanProbeConnected({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources: [source],
      statuses: [connectedStatus(source)],
    });

    const forgedRoot = { ...rootPage(source, plan), body: "private source body" };
    await expect(recordScanSourceRoots({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 2,
      roots: [{ source, page: forgedRoot as SkeletonPage, createdAt: AT }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const rooted = await recordScanSourceRoots({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 2,
      roots: [{ source, page: rootPage(source, plan), createdAt: AT }],
    });
    const intent = rooted.receipts.find((receipt) => (
      "schema" in receipt && receipt.schema === "openlifewiki.enumeration-intent/v1"
    ));
    expect(intent).toBeDefined();

    const first = childrenPage(source, plan, null, true, "cursor-2", [
      childNode(source, "child_a", null, true),
    ]);
    const firstRecorded = await recordScanEnumerationPage({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 3,
      source,
      intentId: (intent as { intentId: string }).intentId,
      requestCursor: null,
      page: first,
    });
    expect(firstRecorded.snapshot.state.phase).toBe("Discovering");

    const second = childrenPage(source, plan, "cursor-2", false, null, [
      childNode(source, "child_b", "cursor-2", false),
    ]);
    await expect(recordScanEnumerationPage({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 4,
      source,
      intentId: (intent as { intentId: string }).intentId,
      requestCursor: "forged-cursor",
      page: second,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const completed = await recordScanEnumerationPage({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 4,
      source,
      intentId: (intent as { intentId: string }).intentId,
      requestCursor: "cursor-2",
      page: second,
    });
    expect(completed.snapshot.state.phase).toBe("Summarizing");
    const workspace = await readScanWorkspace({ dataDir, scanId: plan.scanId });
    expect(workspace?.nodes.map(({ nodeId }) => nodeId)).toEqual(["root", "child_a", "child_b"]);
    expect(JSON.stringify(workspace)).not.toContain("private source body");
  });

  it("binds prepared summary metadata to the exact durable layer and rejects scratch tampering", async () => {
    const fixture = await preparedLeafLayer();
    const prepared = await beginScanLayerDecision({
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 4,
      intentId: fixture.intent.intentId,
      scanInput: fixture.scanInput,
      summary: fixture.summary,
      persistedAt: AT,
    });
    expect(prepared.snapshot.state.phase).toBe("Deciding");
    expect(prepared.snapshot.pendingLayer?.scanInput).toEqual(fixture.scanInput);

    await writeFile(
      join(fixture.runtimeDir, "scans", fixture.plan.scanId, "layer-summary.json"),
      JSON.stringify({ ...fixture.summary, overview: { ...fixture.summary.overview, title: "tampered" } }),
    );
    await expect(commitScanLayerOutcome({
      ...fixture.commit,
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
    })).rejects.toMatchObject({ code: "SCAN_SCRATCH_INVALID" });
    expect((await readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId }))?.state.phase)
      .toBe("Deciding");
  });

  it("commits one canonical qmd leaf selection and closes a fully decided frontier", async () => {
    const fixture = await preparedLeafLayer();
    await fixture.begin();
    const committed = await commitScanLayerOutcome({
      ...fixture.commit,
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
    });
    expect(committed.receipts.filter((receipt) => (
      "schema" in receipt && receipt.schema === "openlifewiki.leaf-selection/v1"
    ))).toHaveLength(1);
    const closed = await closeScanFrontier({
      dataDir: fixture.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
    });
    expect(closed.state.phase).toBe("ReadingLeaves");
  });

  it.each(["metadata-only", "excluded"] as const)(
    "fails closed when a leaf descend conflicts with %s indexing",
    async (indexingDefault) => {
      const fixture = await preparedLeafLayer({ indexingDefault });
      await fixture.begin();
      await expect(commitScanLayerOutcome({
        ...fixture.commit,
        dataDir: fixture.dataDir,
        runtimeDir: fixture.runtimeDir,
        scanId: fixture.plan.scanId,
        expectedRevision: 5,
      })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    },
  );

  it("fails closed when indexing rules have not been deterministically resolved", async () => {
    const fixture = await preparedLeafLayer({
      indexingRules: [{ match: "**/*.md", disposition: "qmd-current" }],
    });
    await fixture.begin();
    await expect(commitScanLayerOutcome({
      ...fixture.commit,
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("retains prepared metadata across pause and rewrites exact scratch before resuming a decision", async () => {
    const fixture = await preparedLeafLayer();
    await fixture.begin();
    const paused = await controlScan({
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
      event: { type: "pause" },
    });
    expect(paused).toMatchObject({ state: { phase: "Paused", resumePhase: "Deciding" } });
    expect(paused.pendingLayer).not.toBeNull();
    await expect(stat(join(fixture.runtimeDir, "scans", fixture.plan.scanId, "layer-summary.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const resumed = await controlScan({
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
      event: { type: "resume" },
    });
    expect(resumed.state.phase).toBe("Deciding");
    await beginScanLayerDecision({
      dataDir: fixture.dataDir,
      runtimeDir: fixture.runtimeDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 7,
      intentId: fixture.intent.intentId,
      scanInput: fixture.scanInput,
      summary: fixture.summary,
      persistedAt: AT,
    });
    expect(await stat(join(fixture.runtimeDir, "scans", fixture.plan.scanId, "layer-summary.json")))
      .toBeDefined();
  });

  it("keeps a durable commit when disposable scratch cleanup is denied", async () => {
    const fixture = await preparedLeafLayer();
    await fixture.begin();
    const scratchParent = join(fixture.runtimeDir, "scans");
    await chmod(scratchParent, 0o500);
    try {
      const committed = await commitScanLayerOutcome({
        ...fixture.commit,
        dataDir: fixture.dataDir,
        runtimeDir: fixture.runtimeDir,
        scanId: fixture.plan.scanId,
        expectedRevision: 5,
      });
      expect(committed.ledger.entries).toHaveLength(1);
      expect((await readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId }))?.ledger.entries)
        .toHaveLength(1);
    } finally {
      await chmod(scratchParent, 0o700);
    }
  });

  it("rejects a rehashed snapshot whose durable scope or page evidence is rewritten", async () => {
    const fixture = await preparedLeafLayer();
    const path = scanStoreStatePath(fixture.dataDir, fixture.plan.scanId);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const skeleton = structuredClone(snapshot.skeleton) as {
      nodes: Array<Record<string, unknown>>;
      pages: Array<Record<string, unknown>>;
    };
    const page = { ...skeleton.pages[0], expectedScopeHash: HASH_A } as Record<string, unknown>;
    delete page.recordHash;
    skeleton.pages[0] = { ...page, recordHash: sha256Canonical(page) };
    const unsigned: Record<string, unknown> = { ...snapshot, skeleton };
    delete unsigned.snapshotHash;
    await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));

    await expect(readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });
});

const AT = "2026-07-27T00:00:00.000Z";

async function temporaryLayout(): Promise<RuntimeLayout> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-frontier-test-"));
  roots.push(root);
  return resolveRuntimeLayout({ OPENLIFEWIKI_HOME: join(root, "runtime"), OPENLIFEWIKI_WORKSPACE: join(root, "workspace") });
}

async function authorizeHostConfig(dataDir: string, sources: readonly AuthorizedSourceV1[]): Promise<void> {
  await writeConfig(join(dataDir, "..", "config.json"), {
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources,
    hostConfig: { schema: "openlifewiki.host-config/v1", selectedAgentId: TEST_AGENT.id, agents: [TEST_AGENT] },
    scanPolicy: null,
    compatibility: { p0Sources: [], agentBindings: [] },
  });
}

async function preparedLeafLayer(options: {
  readonly indexingDefault?: "qmd-current" | "metadata-only" | "excluded";
  readonly indexingRules?: ScanPlan["policy"]["indexing"]["rules"];
} = {}) {
  const layout = await temporaryLayout();
  const source = authorizedSource();
  const plan = scanPlan([source], options);
  await authorizeHostConfig(layout.dataDir, [source]);
  await createScanStore({ dataDir: layout.dataDir, plan });
  await approveScanPlan({ dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0 });
  await recordScanProbeConnected({
    dataDir: layout.dataDir,
    scanId: plan.scanId,
    expectedRevision: 1,
    sources: [source],
    statuses: [connectedStatus(source)],
  });
  const root = rootPage(source, plan, 1);
  const rooted = await recordScanSourceRoots({
    dataDir: layout.dataDir,
    scanId: plan.scanId,
    expectedRevision: 2,
    roots: [{ source, page: root, createdAt: AT }],
  });
  const intent = rooted.receipts.find((receipt) => (
    "schema" in receipt && receipt.schema === "openlifewiki.enumeration-intent/v1"
  )) as import("@openlifewiki/protocol").EnumerationIntent;
  const leaf = childNode(source, "leaf", null, false);
  await recordScanEnumerationPage({
    dataDir: layout.dataDir,
    scanId: plan.scanId,
    expectedRevision: 3,
    source,
    intentId: intent.intentId,
    requestCursor: null,
    page: childrenPage(source, plan, null, false, null, [leaf]),
  });
  const completeChildren = buildSkeletonTrustedChildren([leaf]);
  const target = completeChildren[0]!.target;
  const coverage = {
    directChildrenEnumerated: 1,
    pageComplete: true,
    openCursor: false,
    unknownChildCount: false,
  } as const;
  const remainingBudget = { nodes: 99, bodyBytes: 1_000_000, agentCalls: 9 };
  const indexing = {
    default: options.indexingDefault ?? "qmd-current",
    rules: (options.indexingRules ?? []).map((rule) => ({ ...rule })),
  };
  const resolvedPolicy = {
    resolutionHash: plan.policyResolutionHash,
    hostBindingHash: plan.policyBindings.host.bindingHash,
    wikiBindingHash: plan.policyBindings.wiki.bindingHash,
    priorityReferenceHashes: [], include: [...plan.policy.include], exclude: [...plan.policy.exclude],
    remainingBudget, indexing,
    targetEffects: [{
      targetNodeId: target.nodeId, eligible: true as const, effectiveSensitivity: "normal" as const,
      ownerApprovalRequired: false, indexingDisposition: indexing.default,
      priorityRelation: "none" as const, matchedPriorityReferenceHashes: [], matchedNarrowingRuleHashes: [],
    }],
  };
  const summary: AgentLayerSummary = {
    schema: "openlifewiki.layer-summary/v1",
    overview: {
      title: "Approved knowledge root",
      description: "One direct metadata-only child is ready for a scan decision.",
      providerDescription: "Local Folder filesystem metadata.",
    },
    parent: root.nodes[0]!,
    children: [{ target, metadataHash: completeChildren[0]!.metadataHash, skeleton: leaf }],
    metadataSamples: [],
    coverage,
    policy: { scanIntent: plan.scanIntent, resolvedPolicy },
  };
  const layer = {
    sourceId: source.sourceId,
    parentNodeId: source.rootNodeId,
    parentNodeVersion: root.nodes[0]!.nodeVersion,
    summaryHash: sha256Canonical(summary),
    childSetHash: sha256Canonical(completeChildren),
    decisionTargetSetHash: sha256Canonical([target]),
    coverage,
    systemOutcomes: [],
  };
  const scanInput: AgentScanInputContext = {
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    layer,
    completeChildren,
    decisionTargets: [target],
    scanIntent: plan.scanIntent,
    resolvedPolicy,
    skillHash: plan.skillHash,
  };
  const inputSetHash = buildAgentScanInputSetHash(scanInput);
  const agent = {
    id: plan.agentProfileId,
    runtime: "codex" as const,
    mode: "native-cli" as const,
    driverContractVersion: "v1",
  };
  const childOutcome = {
    target,
    outcome: "descend" as const,
    reason: "Current knowledge leaf matches the approved scan intent.",
    estimatedCost: { nodes: 1, bodyBytes: 32, agentCalls: 0 },
    revisitCondition: null,
    question: null,
  };
  const agentResult: AgentScanResult = {
    schema: "openlifewiki.agent-scan-result/v1",
    operationId: "operation_leaf",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    skillHash: plan.skillHash,
    inputSetHash,
    agent,
    layer,
    childOutcomes: [childOutcome],
    status: "decision-ready",
  };
  const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    authorizationHash: source.authorizationHash,
    sourceId: source.sourceId,
    parentNodeId: source.rootNodeId,
    parentNodeVersion: root.nodes[0]!.nodeVersion,
    childSetHash: layer.childSetHash,
    nodeId: leaf.nodeId,
    nodeVersion: leaf.nodeVersion,
    targetKind: "leaf",
    summaryHash: layer.summaryHash,
    inputSetHash,
    decision: "descend",
    reason: childOutcome.reason,
    revisitCondition: null,
    question: null,
    actor: plan.agentProfileId,
    estimatedCost: childOutcome.estimatedCost,
    persistedAt: AT,
  };
  const decision = { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  const agentInvocationReceipt = createAgentScanInvocationReceipt({
    plan,
    scanInput,
    result: agentResult,
    runtimeVersion: "1.0.0",
    outputSchemaHash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
    invokedAt: AT,
  });
  const commit = {
    intent,
    scanInput,
    agentResult,
    agentInvocationReceipt,
    agentDecisions: [decision],
    systemOutcomes: [],
    committedAt: AT,
  };
  return {
    ...layout,
    source,
    plan,
    intent,
    scanInput,
    summary,
    commit,
    begin: async () => await beginScanLayerDecision({
      dataDir: layout.dataDir,
      runtimeDir: layout.runtimeDir,
      scanId: plan.scanId,
      expectedRevision: 4,
      intentId: intent.intentId,
      scanInput,
      summary,
      persistedAt: AT,
    }),
  };
}

function authorizedSource(
  sourceId = "source_local",
  connectorType: "local-folder" | "github" = "local-folder",
): AuthorizedSourceV1 {
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: AT,
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    previewHash: HASH_A,
    configHash: HASH_A,
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const approval = { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) };
  const common = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId,
    rootNodeId: "root",
    identityFingerprint: HASH_A,
    approval,
    providerObservation: {
      providerName: "openlifewiki-test-provider",
      providerVersion: "1.0.0",
      contractHash: HASH_B,
    },
    include: ["**/*.md"],
    exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    approvedBy: "human:owner" as const,
    approvedAt: AT,
  };
  const payload = connectorType === "local-folder" ? {
    ...common,
    connectorType,
    scope: { schema: "openlifewiki.scope/local-folder/v1" as const, root: `/approved/${sourceId}`, symlinkPolicy: "deny" as const },
  } : {
    ...common,
    connectorType,
    scope: { schema: "openlifewiki.scope/github/v1" as const, hostname: "github.com", repository: "MetaInFLow/openLifeWiki", path: null, ref: "main" },
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function scanPlan(
  sources: readonly AuthorizedSourceV1[],
  options: {
    readonly indexingDefault?: "qmd-current" | "metadata-only" | "excluded";
    readonly indexingRules?: ScanPlan["policy"]["indexing"]["rules"];
  } = {},
): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_frontier",
    sourceIds: sources.map(({ sourceId }) => sourceId),
    authorizationHashes: sources.map(({ authorizationHash }) => authorizationHash),
    rootNodeIds: sources.map(({ rootNodeId }) => rootNodeId),
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    hostConfigRevision: 0,
    selectedAgentConfigHash: sha256Canonical(TEST_AGENT),
    skillHash: CANONICAL_SKILL_HASH,
    scanIntent: "Map the approved knowledge sources progressively.",
    ...createScanPlanPolicyMaterial({ ownerPolicy: {
      schema: "openlifewiki.scan-narrowing-policy/v1",
      include: ["**/*.md"],
      exclude: [],
      sensitivity: { default: "normal", rules: [] },
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: options.indexingDefault ?? "qmd-current", rules: options.indexingRules ?? [] },
    } }),
  });
}

function connectedStatus(source: AuthorizedSourceV1): ConnectorStatus {
  const github = source.connectorType === "github";
  return {
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: source.connectorType,
    providerName: "openlifewiki-test-provider",
    providerProject: github ? "cli/cli" : "openLifeWiki",
    providerVersion: "1.0.0",
    providerContractHash: HASH_B,
    identity: github
      ? { account: "a***d", host: "github.com", fingerprint: source.identityFingerprint }
      : { profile: "local", account: "a***d", fingerprint: source.identityFingerprint },
    authorizedScope: source.scope,
    status: "connected",
    lastProbe: AT,
    changedItems: 0,
    blocking: null,
  };
}

function rootPage(source: AuthorizedSourceV1, plan: ScanPlan, childCount = 2): SkeletonPage {
  return {
    schema: "openlifewiki.skeleton-page/v1",
    sourceId: source.sourceId,
    parentNodeId: source.rootNodeId,
    requestScopeHash: progressiveConnectorScopeHash(source),
    nodes: [{
      schema: "openlifewiki.skeleton-node/v1",
      sourceId: source.sourceId,
      nodeId: source.rootNodeId,
      parentId: null,
      kind: "directory",
      title: "Approved root",
      locator: `file:///approved/${source.sourceId}`,
      childCount: { value: childCount, kind: "known" },
      modifiedRange: null,
      permission: "readable",
      scanability: "metadata-only",
      page: { cursor: null, hasMore: false },
      sizeEstimate: { bytes: null, kind: "unknown" },
      nodeVersion: "root-v1",
    }],
    nextCursor: null,
    pageComplete: true,
    observedAt: AT,
    skeletonVersion: plan.skeletonVersion,
  };
}

function childrenPage(
  source: AuthorizedSourceV1,
  plan: ScanPlan,
  requestCursor: string | null,
  hasMore: boolean,
  nextCursor: string | null,
  nodes: readonly SkeletonNode[],
): SkeletonPage {
  return {
    schema: "openlifewiki.skeleton-page/v1",
    sourceId: source.sourceId,
    parentNodeId: source.rootNodeId,
    requestScopeHash: progressiveConnectorScopeHash(source),
    nodes,
    nextCursor,
    pageComplete: !hasMore,
    observedAt: AT,
    skeletonVersion: plan.skeletonVersion,
  };
}

function childNode(
  source: AuthorizedSourceV1,
  nodeId: string,
  cursor: string | null,
  hasMore: boolean,
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: source.sourceId,
    nodeId,
    parentId: source.rootNodeId,
    kind: "file",
    title: nodeId,
    locator: `file:///approved/${source.sourceId}/${nodeId}.md`,
    childCount: { value: 0, kind: "known" },
    modifiedRange: null,
    permission: "readable",
    scanability: "metadata-and-body",
    page: { cursor, hasMore },
    sizeEstimate: { bytes: 32, kind: "estimated" },
    nodeVersion: `${nodeId}-v1`,
  };
}
