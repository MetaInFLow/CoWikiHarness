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
  createScanSystemOutcomeReceipt,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanInputContext,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type ConnectorStatus,
  type EnumerationIntent,
  type ScanDecision,
  type ScanPlan,
  type RuntimeLayout,
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

const AT = "2026-07-27T00:00:00.000Z";
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

describe("progressive scan frontier edge contracts", () => {
  it("rejects a caller-authored Source that is absent from the authoritative Host config", async () => {
    const layout = await temporaryLayout();
    const authorized = authorizedSource();
    const { authorizationHash: _authorizationHash, ...authorizedPayload } = authorized;
    const forgedPayload = { ...authorizedPayload, rootNodeId: "forged_root" };
    const forged = {
      ...forgedPayload,
      authorizationHash: sha256Canonical(forgedPayload),
    } as AuthorizedSourceV1;
    const plan = scanPlan([forged], {});
    await authorizeHostConfig(layout.dataDir, [authorized]);
    await createScanStore({ dataDir: layout.dataDir, plan });
    await expect(approveScanPlan({
      dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect((await readScanStore({ dataDir: layout.dataDir, scanId: plan.scanId }))?.state.phase).toBe("Draft");
  });

  it("rejects secret-shaped Connector identity extensions", async () => {
    const layout = await temporaryLayout();
    const source = authorizedSource();
    const plan = scanPlan([source], {});
    await authorizeHostConfig(layout.dataDir, [source]);
    await createScanStore({ dataDir: layout.dataDir, plan });
    await approveScanPlan({ dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0 });

    await expect(recordScanProbeConnected({
      dataDir: layout.dataDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      sources: [source],
      statuses: [{ ...connectedStatus(source), identity: {
        ...connectedStatus(source).identity,
        token: "secret-value",
      } }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("binds ScanPlan roots and caller order to the authoritative Source order", async () => {
    const layout = await temporaryLayout();
    const source = authorizedSource();
    const { scanPlanHash: _scanPlanHash, ...planDraft } = scanPlan([source], {});
    const wrongRootPlan = createScanPlan({
      ...planDraft,
      rootNodeIds: ["wrong_root"],
    });
    await authorizeHostConfig(layout.dataDir, [source]);
    await createScanStore({ dataDir: layout.dataDir, plan: wrongRootPlan });
    await expect(approveScanPlan({
      dataDir: layout.dataDir, layout, scanId: wrongRootPlan.scanId, expectedRevision: 0,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect((await readScanStore({ dataDir: layout.dataDir, scanId: wrongRootPlan.scanId }))?.state.phase).toBe("Draft");
  });

  it("keeps the exact pending layer through Deciding pause and resume", async () => {
    const fixture = await preparedLayer();
    const prepared = await fixture.begin();
    const pendingHash = prepared.snapshot.pendingLayer?.recordHash;

    const paused = await controlScan({
      ...fixture.layout,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
      event: { type: "pause" },
    });
    expect(paused).toMatchObject({
      state: { phase: "Paused", resumePhase: "Deciding" },
      pendingLayer: { recordHash: pendingHash },
    });
    await expect(stat(fixture.scratchPath)).rejects.toMatchObject({ code: "ENOENT" });

    const resumed = await controlScan({
      ...fixture.layout,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
      event: { type: "resume" },
    });
    expect(resumed).toMatchObject({ state: { phase: "Deciding" }, pendingLayer: { recordHash: pendingHash } });

    const restored = await fixture.begin(7);
    expect(restored.snapshot.revision).toBe(7);
    expect(await stat(fixture.scratchPath)).toBeDefined();
    expect((await readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))?.pendingLayer?.recordHash)
      .toBe(pendingHash);
  });

  it("keeps the exact pending layer through Deciding fail and retry", async () => {
    const fixture = await preparedLayer();
    const prepared = await fixture.begin();
    const pendingHash = prepared.snapshot.pendingLayer?.recordHash;

    const failed = await controlScan({
      ...fixture.layout,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
      event: { type: "fail", retryPhase: "Deciding", code: "AGENT_INTERRUPTED" },
    });
    expect(failed).toMatchObject({
      state: { phase: "Failed", retryPhase: "Deciding", failureCode: "AGENT_INTERRUPTED" },
      pendingLayer: { recordHash: pendingHash },
    });
    await expect(stat(fixture.scratchPath)).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await controlScan({
      ...fixture.layout,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
      event: { type: "retry" },
    });
    expect(retried).toMatchObject({ state: { phase: "Deciding" }, pendingLayer: { recordHash: pendingHash } });
    await fixture.begin(7);
    expect(await stat(fixture.scratchPath)).toBeDefined();
  });

  it("atomically clears a pending Deciding layer when cancelled", async () => {
    const fixture = await preparedLayer();
    await fixture.begin();

    const cancelled = await controlScan({
      ...fixture.layout,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
      event: { type: "cancel" },
    });
    expect(cancelled).toMatchObject({
      state: { phase: "Cancelled", resumePhase: null, retryPhase: null },
      pendingLayer: null,
    });
    await expect(stat(fixture.scratchPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))?.pendingLayer)
      .toBeNull();
  });

  it("rejects a continuation cursor that does not advance", async () => {
    const fixture = await rootedFrontier(2);
    await recordPage(fixture, 3, null, "A", [childNode(fixture.source, "child_a", null, true)]);

    await expect(recordPage(
      fixture,
      4,
      "A",
      "A",
      [childNode(fixture.source, "child_b", "A", true)],
    )).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("rejects an A-B-A cursor cycle", async () => {
    const fixture = await rootedFrontier(3);
    await recordPage(fixture, 3, null, "A", [childNode(fixture.source, "child_a", null, true)]);
    await recordPage(fixture, 4, "A", "B", [childNode(fixture.source, "child_b", "A", true)]);

    await expect(recordPage(
      fixture,
      5,
      "B",
      "A",
      [childNode(fixture.source, "child_c", "B", true)],
    )).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("accepts and closes a fully committed empty layer", async () => {
    const fixture = await preparedLayer({ empty: true });
    await fixture.begin();
    const committed = await fixture.commit(5);
    expect(committed).toMatchObject({ state: { phase: "Discovering" }, ledger: { entries: [{ intentId: fixture.intent.intentId }] } });

    const closed = await closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
    });
    expect(closed.state.phase).toBe("ReadingLeaves");
  });

  it.each([
    { indexingDefault: "metadata-only" as const, indexingRules: [] },
    { indexingDefault: "excluded" as const, indexingRules: [] },
    { indexingDefault: "qmd-current" as const, indexingRules: [{ match: "**/*.md", disposition: "qmd-current" as const }] },
  ])("fails closed when a leaf descend has unresolved or non-QMD indexing: $indexingDefault", async (indexing) => {
    const fixture = await preparedLayer(indexing);
    await fixture.begin();

    await expect(fixture.commit(5)).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect((await readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))?.state.phase)
      .toBe("Deciding");
  });

  it("refuses to close an open paginated frontier", async () => {
    const fixture = await rootedFrontier(2);
    await recordPage(fixture, 3, null, "A", [childNode(fixture.source, "child_a", null, true)]);

    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 4,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("refuses to close a completed but uncommitted layer", async () => {
    const fixture = await preparedLayer();

    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 4,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("refuses to close while a prepared layer is pending", async () => {
    const fixture = await preparedLayer();
    await fixture.begin();

    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 5,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("refuses to close an ask-user decision", async () => {
    const fixture = await preparedLayer({ outcome: "ask-user" });
    await fixture.begin();
    await fixture.commit(5);

    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("refuses to close a layer with a blocked system outcome", async () => {
    const fixture = await preparedLayer({ blocked: true });
    await fixture.begin();
    await fixture.commit(5);

    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("refuses to close when a descend decision is missing its derived selection", async () => {
    const fixture = await preparedLayer();
    await fixture.begin();
    await fixture.commit(5);
    const path = scanStoreStatePath(fixture.layout.dataDir, fixture.plan.scanId);
    await rewriteSnapshot(path, (snapshot) => {
      snapshot.receipts = (snapshot.receipts as Array<Record<string, unknown>>)
        .filter(({ schema }) => schema !== "openlifewiki.leaf-selection/v1");
    });
    await expect(closeScanFrontier({
      dataDir: fixture.layout.dataDir,
      scanId: fixture.plan.scanId,
      expectedRevision: 6,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it.each([
    {
      name: "node metadata",
      mutate(snapshot: Record<string, unknown>) {
        const skeleton = snapshot.skeleton as SkeletonStoreShape;
        const record = skeleton.nodes[1]!;
        record.node = { ...(record.node as Record<string, unknown>), title: "forged title" };
        rehashRecord(record);
      },
    },
    {
      name: "node scope",
      mutate(snapshot: Record<string, unknown>) {
        const skeleton = snapshot.skeleton as SkeletonStoreShape;
        const record = skeleton.nodes[1]!;
        record.expectedScopeHash = HASH_A;
        rehashRecord(record);
      },
    },
    {
      name: "page attribution",
      mutate(snapshot: Record<string, unknown>) {
        const skeleton = snapshot.skeleton as SkeletonStoreShape;
        const record = skeleton.nodes[1]!;
        record.pageReceiptHash = HASH_A;
        rehashRecord(record);
      },
    },
  ])("rejects a fully rehashed snapshot with forged $name", async ({ mutate }) => {
    const fixture = await preparedLayer();
    const path = scanStoreStatePath(fixture.layout.dataDir, fixture.plan.scanId);
    await rewriteSnapshot(path, mutate);

    await expect(readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("rejects a fully rehashed snapshot with a rewritten pending layer", async () => {
    const fixture = await preparedLayer();
    await fixture.begin();
    const path = scanStoreStatePath(fixture.layout.dataDir, fixture.plan.scanId);
    await rewriteSnapshot(path, (snapshot) => {
      const pending = structuredClone(snapshot.pendingLayer) as Record<string, unknown>;
      const scanInput = structuredClone(pending.scanInput) as AgentScanInputContext;
      scanInput.layer = { ...scanInput.layer, parentNodeVersion: "forged-parent-version" };
      const scanInputHash = sha256Canonical(scanInput);
      const summaryReceipt = structuredClone(pending.summaryReceipt) as Record<string, unknown>;
      summaryReceipt.inputSetHash = scanInputHash;
      rehashReceipt(summaryReceipt);
      pending.scanInput = scanInput;
      pending.scanInputHash = scanInputHash;
      pending.summaryReceipt = summaryReceipt;
      rehashRecord(pending);
      snapshot.pendingLayer = pending;
    });

    await expect(readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("recomputes the canonical authorized-root intent after snapshot reload", async () => {
    const fixture = await rootedFrontier(1);
    const path = scanStoreStatePath(fixture.layout.dataDir, fixture.plan.scanId);
    await rewriteSnapshot(path, (snapshot) => {
      const intent = (snapshot.receipts as Array<Record<string, unknown>>)
        .find(({ schema }) => schema === "openlifewiki.enumeration-intent/v1")!;
      intent.inputSetHash = HASH_A;
      rehashReceipt(intent);
    });

    await expect(readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("rejects a fully rehashed ledger entry whose intent is missing", async () => {
    const fixture = await preparedLayer({ empty: true });
    await fixture.begin();
    await fixture.commit(5);
    const path = scanStoreStatePath(fixture.layout.dataDir, fixture.plan.scanId);
    await rewriteSnapshot(path, (snapshot) => {
      const ledger = snapshot.ledger as Record<string, unknown>;
      const entries = ledger.entries as Array<Record<string, unknown>>;
      entries[0]!.intentId = "missing_intent";
      rehashLedger(entries, ledger);
    });

    await expect(readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("keeps a durable cleanup obligation and settles it on workspace inspection", async () => {
    const fixture = await preparedLayer({ empty: true });
    await fixture.begin();
    const scansRoot = join(fixture.layout.runtimeDir, "scans");
    await chmod(scansRoot, 0o500);
    try {
      const committed = await fixture.commit(5);
      expect(committed.scratchCleanupRequired).toBe(true);
      await chmod(scansRoot, 0o700);

      const workspace = await readScanWorkspace({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId });
      expect(workspace?.revision).toBe(committed.revision + 1);
      expect((await readScanStore({ dataDir: fixture.layout.dataDir, scanId: fixture.plan.scanId }))?.scratchCleanupRequired)
        .toBe(false);
      await expect(stat(fixture.scratchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(scansRoot, 0o700);
    }
  });
});

interface LayerOptions {
  readonly empty?: boolean;
  readonly blocked?: boolean;
  readonly outcome?: "descend" | "ask-user";
  readonly indexingDefault?: "qmd-current" | "metadata-only" | "excluded";
  readonly indexingRules?: ScanPlan["policy"]["indexing"]["rules"];
}

interface SkeletonStoreShape {
  readonly nodes: Array<Record<string, unknown>>;
  readonly pages: Array<Record<string, unknown>>;
}

async function preparedLayer(options: LayerOptions = {}) {
  const childCount = options.empty ? 0 : 1;
  const rooted = await rootedFrontier(childCount, options);
  const leaf = options.empty ? null : childNode(rooted.source, "leaf", null, false);
  const page = childrenPage(rooted.source, rooted.plan, null, null, leaf === null ? [] : [leaf]);
  await recordScanEnumerationPage({
    dataDir: rooted.layout.dataDir,
    scanId: rooted.plan.scanId,
    expectedRevision: 3,
    source: rooted.source,
    intentId: rooted.intent.intentId,
    requestCursor: null,
    page,
  });

  const completeChildren = buildSkeletonTrustedChildren(leaf === null ? [] : [leaf]);
  const target = completeChildren[0]?.target;
  const systemOutcomes = options.blocked && target !== undefined
    ? [{ targetNodeId: target.nodeId, outcome: "blocked" as const, code: "PERMISSION_DENIED" }]
    : [];
  const decisionTargets = options.blocked || target === undefined ? [] : [target];
  const coverage = {
    directChildrenEnumerated: completeChildren.length,
    pageComplete: true,
    openCursor: false,
    unknownChildCount: false,
  } as const;
  const remainingBudget = { nodes: 99, bodyBytes: 1_000_000, agentCalls: 9 };
  const indexing = {
    default: options.indexingDefault ?? "qmd-current" as const,
    rules: (options.indexingRules ?? []).map((rule) => ({ ...rule })),
  };
  const resolvedPolicy = {
    resolutionHash: rooted.plan.policyResolutionHash,
    hostBindingHash: rooted.plan.policyBindings.host.bindingHash,
    wikiBindingHash: rooted.plan.policyBindings.wiki.bindingHash,
    priorityReferenceHashes: [], include: [...rooted.plan.policy.include], exclude: [...rooted.plan.policy.exclude],
    remainingBudget, indexing,
    targetEffects: decisionTargets.map(({ nodeId }) => ({
      targetNodeId: nodeId, eligible: true as const, effectiveSensitivity: "normal" as const,
      ownerApprovalRequired: false, indexingDisposition: indexing.default,
      priorityRelation: "none" as const, matchedPriorityReferenceHashes: [], matchedNarrowingRuleHashes: [],
    })),
  };
  const summary: AgentLayerSummary = {
    schema: "openlifewiki.layer-summary/v1",
    overview: {
      title: "Approved knowledge root",
      description: options.empty ? "The complete direct-child layer is empty." : "One direct child is ready for a decision.",
      providerDescription: "Test provider metadata.",
    },
    parent: rooted.root,
    children: leaf === null || target === undefined ? [] : [{
      target,
      metadataHash: completeChildren[0]!.metadataHash,
      skeleton: leaf,
    }],
    metadataSamples: [],
    coverage,
    policy: { scanIntent: rooted.plan.scanIntent, resolvedPolicy },
  };
  const layer = {
    sourceId: rooted.source.sourceId,
    parentNodeId: rooted.source.rootNodeId,
    parentNodeVersion: rooted.root.nodeVersion,
    summaryHash: sha256Canonical(summary),
    childSetHash: sha256Canonical(completeChildren),
    decisionTargetSetHash: sha256Canonical(decisionTargets),
    coverage,
    systemOutcomes,
  };
  const scanInput: AgentScanInputContext = {
    scanId: rooted.plan.scanId,
    scanPlanHash: rooted.plan.scanPlanHash,
    skeletonVersion: rooted.plan.skeletonVersion,
    layer,
    completeChildren,
    decisionTargets,
    scanIntent: rooted.plan.scanIntent,
    resolvedPolicy,
    skillHash: rooted.plan.skillHash,
  };
  const inputSetHash = buildAgentScanInputSetHash(scanInput);
  const outcome = options.outcome ?? "descend";
  const estimatedCost = outcome === "descend"
    ? { nodes: 1, bodyBytes: 32, agentCalls: 0 }
    : { nodes: 0, bodyBytes: 0, agentCalls: 0 };
  const reason = outcome === "descend"
    ? "Current knowledge leaf matches the approved scan intent."
    : "Owner input is required before selecting this leaf.";
  const question = outcome === "ask-user" ? "Should this leaf be included in the current Wiki?" : null;
  const childOutcomes = target === undefined || options.blocked ? [] : [{
    target,
    outcome,
    reason,
    estimatedCost,
    revisitCondition: null,
    question,
  }];
  const agentResult: AgentScanResult = {
    schema: "openlifewiki.agent-scan-result/v1",
    operationId: `operation_${options.empty ? "empty" : outcome}`,
    scanId: rooted.plan.scanId,
    scanPlanHash: rooted.plan.scanPlanHash,
    skeletonVersion: rooted.plan.skeletonVersion,
    skillHash: rooted.plan.skillHash,
    inputSetHash,
    agent: {
      id: rooted.plan.agentProfileId,
      runtime: "codex",
      mode: "native-cli",
      driverContractVersion: "v1",
    },
    layer,
    childOutcomes,
    status: "decision-ready",
  };
  const agentInvocationReceipt = createAgentScanInvocationReceipt({
    plan: rooted.plan,
    scanInput,
    result: agentResult,
    runtimeVersion: "1.0.0",
    outputSchemaHash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
    invokedAt: AT,
  });
  const decisions = target === undefined || options.blocked ? [] : [scanDecision({
    plan: rooted.plan,
    source: rooted.source,
    parent: rooted.root,
    target,
    scanInput,
    outcome,
    reason,
    estimatedCost,
    question,
  })];
  const scratchPath = join(rooted.layout.runtimeDir, "scans", rooted.plan.scanId, "layer-summary.json");

  return {
    ...rooted,
    scanInput,
    summary,
    scratchPath,
    begin: async (expectedRevision = 4) => await beginScanLayerDecision({
      ...rooted.layout,
      scanId: rooted.plan.scanId,
      expectedRevision,
      intentId: rooted.intent.intentId,
      scanInput,
      summary,
      persistedAt: AT,
    }),
    commit: async (expectedRevision: number) => {
      const current = await readScanStore({ dataDir: rooted.layout.dataDir, scanId: rooted.plan.scanId });
      const summaryReceipt = current?.pendingLayer?.summaryReceipt;
      if (summaryReceipt === undefined) throw new Error("Prepared layer summary receipt is missing");
      const durableSystemOutcomes = options.blocked && leaf !== null
        ? [createScanSystemOutcomeReceipt({
          plan: rooted.plan,
          scanInput,
          summaryReceipt,
          trustedReceiptHashes: [summaryReceipt.receiptHash],
          target: leaf,
          outcome: "blocked",
          code: "PERMISSION_DENIED",
          persistedAt: AT,
        })]
        : [];
      return await commitScanLayerOutcome({
        ...rooted.layout,
        scanId: rooted.plan.scanId,
        expectedRevision,
        intent: rooted.intent,
        scanInput,
        agentResult,
        agentInvocationReceipt,
        agentDecisions: decisions,
        systemOutcomes: durableSystemOutcomes,
        committedAt: AT,
      });
    },
  };
}

async function rootedFrontier(childCount: number, options: LayerOptions = {}) {
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
  const rootPageValue = rootPage(source, plan, childCount);
  const rooted = await recordScanSourceRoots({
    dataDir: layout.dataDir,
    scanId: plan.scanId,
    expectedRevision: 2,
    roots: [{ source, page: rootPageValue, createdAt: AT }],
  });
  const intent = rooted.receipts.find((receipt) => (
    "schema" in receipt && receipt.schema === "openlifewiki.enumeration-intent/v1"
  )) as EnumerationIntent | undefined;
  if (intent === undefined) throw new Error("Root Enumeration Intent is missing");
  return { layout, source, plan, intent, root: rootPageValue.nodes[0]! };
}

async function recordPage(
  fixture: Awaited<ReturnType<typeof rootedFrontier>>,
  expectedRevision: number,
  requestCursor: string | null,
  nextCursor: string | null,
  nodes: readonly SkeletonNode[],
) {
  return await recordScanEnumerationPage({
    dataDir: fixture.layout.dataDir,
    scanId: fixture.plan.scanId,
    expectedRevision,
    source: fixture.source,
    intentId: fixture.intent.intentId,
    requestCursor,
    page: childrenPage(fixture.source, fixture.plan, requestCursor, nextCursor, nodes),
  });
}

function scanDecision(input: {
  readonly plan: ScanPlan;
  readonly source: AuthorizedSourceV1;
  readonly parent: SkeletonNode;
  readonly target: AgentScanInputContext["decisionTargets"][number];
  readonly scanInput: AgentScanInputContext;
  readonly outcome: "descend" | "ask-user";
  readonly reason: string;
  readonly estimatedCost: { readonly nodes: number; readonly bodyBytes: number; readonly agentCalls: number };
  readonly question: string | null;
}): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1",
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    authorizationHash: input.source.authorizationHash,
    sourceId: input.source.sourceId,
    parentNodeId: input.parent.nodeId,
    parentNodeVersion: input.parent.nodeVersion,
    childSetHash: input.scanInput.layer.childSetHash,
    nodeId: input.target.nodeId,
    nodeVersion: input.target.nodeVersion,
    targetKind: input.target.kind,
    summaryHash: input.scanInput.layer.summaryHash,
    inputSetHash: sha256Canonical(input.scanInput),
    decision: input.outcome,
    reason: input.reason,
    revisitCondition: null,
    question: input.question,
    actor: input.plan.agentProfileId,
    estimatedCost: input.estimatedCost,
    persistedAt: AT,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

async function rewriteSnapshot(
  path: string,
  mutate: (snapshot: Record<string, unknown>) => void,
): Promise<void> {
  const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(snapshot);
  delete snapshot.snapshotHash;
  await writeFile(path, JSON.stringify({ ...snapshot, snapshotHash: sha256Canonical(snapshot) }));
}

function rehashRecord(record: Record<string, unknown>): void {
  delete record.recordHash;
  record.recordHash = sha256Canonical(record);
}

function rehashReceipt(receipt: Record<string, unknown>): void {
  delete receipt.receiptHash;
  receipt.receiptHash = sha256Canonical(receipt);
}

function rehashLedger(entries: Array<Record<string, unknown>>, ledger: Record<string, unknown>): void {
  let previous: string | null = null;
  for (const [index, entry] of entries.entries()) {
    entry.sequence = index + 1;
    entry.previousEntryHash = previous;
    delete entry.entryHash;
    entry.entryHash = sha256Canonical(entry);
    previous = entry.entryHash as string;
  }
  ledger.headHash = previous;
}

async function temporaryLayout(): Promise<RuntimeLayout> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-frontier-edge-test-"));
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

function authorizedSource(): AuthorizedSourceV1 {
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
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source_local",
    connectorType: "local-folder" as const,
    rootNodeId: "root",
    identityFingerprint: HASH_A,
    approval,
    providerObservation: {
      providerName: "openlifewiki-test-provider",
      providerVersion: "1.0.0",
      contractHash: HASH_B,
    },
    scope: { schema: "openlifewiki.scope/local-folder/v1" as const, root: "/approved/source_local", symlinkPolicy: "deny" as const },
    include: ["**/*.md"],
    exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    approvedBy: "human:owner" as const,
    approvedAt: AT,
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function scanPlan(sources: readonly AuthorizedSourceV1[], options: LayerOptions): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_frontier_edge",
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
      indexing: {
        default: options.indexingDefault ?? "qmd-current",
        rules: options.indexingRules ?? [],
      },
    } }),
  });
}

function connectedStatus(source: AuthorizedSourceV1): ConnectorStatus {
  return {
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: source.connectorType,
    providerName: "openlifewiki-test-provider",
    providerProject: "openLifeWiki",
    providerVersion: "1.0.0",
    providerContractHash: HASH_B,
    identity: { profile: "local", account: "a***d", fingerprint: source.identityFingerprint },
    authorizedScope: source.scope,
    status: "connected",
    lastProbe: AT,
    changedItems: 0,
    blocking: null,
  };
}

function rootPage(source: AuthorizedSourceV1, plan: ScanPlan, childCount: number): SkeletonPage {
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
      locator: "file:///approved/source_local",
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
    pageComplete: nextCursor === null,
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
