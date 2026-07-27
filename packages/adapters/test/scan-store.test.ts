import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  createAgentScanInvocationReceipt,
  createEnumerationIntent,
  createScanPlan,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanInputContext,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type BodyObservationReceipt,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
} from "@openlifewiki/protocol";
import { createScanLedger, createScanState, transitionScanState } from "@openlifewiki/core";

import * as adapters from "../src/index.js";
import {
  approveScanPlan,
  commitScanLayerOutcome,
  controlScan,
  createScanStore,
  readScanStore,
  recordScanEnumerationIntent,
  reserveScanBodyBudget,
  scanStoreStatePath,
} from "../src/index.js";
import { recordTrustedScanPhysicalIo } from "../src/scan-store.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("typed durable scan transactions", () => {
  it("creates an owner-only restartable snapshot", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    const created = await createScanStore({ dataDir, plan });

    expect(created).toMatchObject({
      revision: 0,
      plan,
      state: createScanState(plan.scanId),
      ledger: createScanLedger(plan),
      receipts: [],
    });
    expect((await stat(scanStoreStatePath(dataDir, plan.scanId))).mode & 0o777).toBe(0o600);
    expect(await readScanStore({ dataDir, scanId: plan.scanId })).toEqual(created);
  });

  it("has no public generic mutation or standalone clear and cannot walk to Complete", async () => {
    expect((adapters as Record<string, unknown>).updateScanStore).toBeUndefined();
    expect((adapters as Record<string, unknown>).clearScanScratch).toBeUndefined();
    expect((adapters as Record<string, unknown>).recordScanPhysicalIo).toBeUndefined();
    expect((adapters as Record<string, unknown>).PhysicalIoObservationInput).toBeUndefined();
    const { dataDir, runtimeDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const probing = await approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 });
    expect(probing.state.phase).toBe("Probing");

    await expect(controlScan({
      dataDir,
      runtimeDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      event: { type: "qmd-published" } as never,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    await expect(approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect((await readScanStore({ dataDir, scanId: plan.scanId }))?.state.phase).toBe("Probing");
  });

  it("clears exact scratch before pause and rolls back when cleanup fails", async () => {
    const { dataDir, runtimeDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    await approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 });
    const scratch = join(runtimeDir, "scans", plan.scanId, "layer-summary.json");
    await mkdir(join(runtimeDir, "scans", plan.scanId), { recursive: true });
    await writeFile(scratch, "disposable");

    const paused = await controlScan({
      dataDir, runtimeDir, scanId: plan.scanId, expectedRevision: 1, event: { type: "pause" },
    });
    expect(paused.state.phase).toBe("Paused");
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });

    const failed = await temporaryLayout();
    const failedData = failed.dataDir;
    const blockedRuntime = failed.runtimeDir;
    await createScanStore({ dataDir: failedData, plan });
    await approveScanPlan({ dataDir: failedData, scanId: plan.scanId, expectedRevision: 0 });
    await mkdir(blockedRuntime, { recursive: true });
    await writeFile(join(blockedRuntime, "scans"), "not-a-directory");
    await expect(controlScan({
      dataDir: failedData,
      runtimeDir: blockedRuntime,
      scanId: plan.scanId,
      expectedRevision: 1,
      event: { type: "pause" },
    })).rejects.toBeDefined();
    expect(await readScanStore({ dataDir: failedData, scanId: plan.scanId })).toMatchObject({
      revision: 1, state: { phase: "Probing" },
    });
  });

  it("rejects unknown durable receipt schemas even with a valid self-hash", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const path = scanStoreStatePath(dataDir, plan.scanId);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const payload = {
      schema: "openlifewiki.unknown-receipt/v1",
      scanId: plan.scanId,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
    };
    const unknown = { ...payload, receiptHash: sha256Canonical(payload) };
    const unsigned = { ...snapshot, receipts: [unknown] } as Record<string, unknown>;
    delete unsigned.snapshotHash;
    await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));

    await expect(readScanStore({ dataDir, scanId: plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("derives body reservations from current accounting and rejects stale, duplicate and excess requests", async () => {
    const { dataDir } = await temporaryLayout();
    const source = authorizedSource();
    const plan = scanPlan(source.authorizationHash);
    const created = await createScanStore({ dataDir, plan });
    const accountingHash = sha256Canonical(created.physicalIo);
    const first = await reserveScanBodyBudget({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 0,
      expectedPhysicalIoAccountingHash: accountingHash,
      source,
      nodeId: "leaf",
      nodeVersion: "v1",
      reservedBytes: 600_000,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    expect(first.reservation).toMatchObject({
      physicalIoAccountingHash: accountingHash,
      remainingBeforeBytes: 700_000,
      reservedBytes: 600_000,
    });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: HASH_B,
      source, nodeId: "other", nodeVersion: "v1", reservedBytes: 1,
    })).rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: accountingHash,
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 1,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const multi = await temporaryLayout();
    const sourceA = authorizedSource("source_a");
    const sourceB = authorizedSource("source_b");
    const multiPlan = scanPlanForSources([sourceA, sourceB]);
    const multiCreated = await createScanStore({ dataDir: multi.dataDir, plan: multiPlan });
    const multiAccounting = sha256Canonical(multiCreated.physicalIo);
    await reserveScanBodyBudget({
      dataDir: multi.dataDir, scanId: multiPlan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: multiAccounting,
      source: sourceA, nodeId: "a", nodeVersion: "v1", reservedBytes: 600_000,
    });
    await expect(reserveScanBodyBudget({
      dataDir: multi.dataDir, scanId: multiPlan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: multiAccounting,
      source: sourceB, nodeId: "b", nodeVersion: "v1", reservedBytes: 400_001,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: accountingHash,
      source, nodeId: "other", nodeVersion: "v1", reservedBytes: 400_001,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("records only a protocol-validated authorized-root intent", async () => {
    const { dataDir } = await temporaryLayout();
    const input = emptyLayerFixture();
    await createScanStore({ dataDir, plan: input.plan });

    const recorded = await recordScanEnumerationIntent({
      dataDir, scanId: input.plan.scanId, expectedRevision: 0, intent: input.commit.intent,
    });
    expect(recorded.receipts).toEqual([input.commit.intent]);

    const forgedPayload = {
      ...input.commit.intent,
      targetNodeId: "not-the-authorized-root",
    } as Record<string, unknown>;
    delete forgedPayload.receiptHash;
    const forged = { ...forgedPayload, receiptHash: sha256Canonical(forgedPayload) };
    await expect(recordScanEnumerationIntent({
      dataDir, scanId: input.plan.scanId, expectedRevision: 1, intent: forged as never,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("records a container intent only from its ledger-committed descend decision", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const decision = containerDecision(plan);
    const intent = createEnumerationIntent({
      plan, trustedDecisionReceiptHashes: [decision.receiptHash], decisionReceipt: decision,
      intent: {
        schema: "openlifewiki.enumeration-intent/v1", intentId: "intent_child", sourceId: "source_local",
        targetNodeId: "child", targetNodeVersion: "child-v1", authorizationHash: plan.authorizationHashes[0]!,
        origin: "container-descend", parentLayerNodeId: "root", childSetHash: decision.childSetHash,
        inputSetHash: decision.inputSetHash, createdAt: "2026-07-27T00:00:01.000Z",
      },
    });
    await expect(recordScanEnumerationIntent({
      dataDir, scanId: plan.scanId, expectedRevision: 0, intent,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await appendDecisionFixture(dataDir, plan, decision);
    const recorded = await recordScanEnumerationIntent({
      dataDir, scanId: plan.scanId, expectedRevision: 0, intent,
    });
    expect(recorded.receipts.at(-1)).toEqual(intent);
  });

  it("keeps caller-authored physical I/O internal and binds it to one durable reservation", async () => {
    const { dataDir } = await temporaryLayout();
    const source = authorizedSource();
    const plan = scanPlan(source.authorizationHash);
    const created = await createScanStore({ dataDir, plan });
    const reserved = await reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: sha256Canonical(created.physicalIo),
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    });
    const { decision, selection } = leafSelection(plan);
    await appendDecisionFixture(dataDir, plan, decision, selection);
    const observation = bodyObservation(plan, selection, 10);

    const recorded = await recordTrustedScanPhysicalIo({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: reserved.reservation }],
    });
    expect(recorded.physicalIo.counters).toMatchObject({ initialReadItems: 1, initialReadBytes: 10 });
    await expect(recordTrustedScanPhysicalIo({
      dataDir, scanId: plan.scanId, expectedRevision: 2,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: reserved.reservation }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("never takes over an incomplete stale lock directory", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const lock = `${scanStoreStatePath(dataDir, plan.scanId)}.lock`;
    await mkdir(lock, { mode: 0o700 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);

    await expect(approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect((await readScanStore({ dataDir, scanId: plan.scanId }))?.revision).toBe(0);
    await rm(lock, { recursive: true, force: true });
  }, 5_000);

  it("rejects layer commit without its exact durable intent and known-schema extra fields", async () => {
    const layout = await temporaryLayout();
    const input = emptyLayerFixture();
    await createScanStore({ dataDir: layout.dataDir, plan: input.plan });
    await forceDecidingFixture(layout.dataDir, input.plan.scanId);
    await expect(commitScanLayerOutcome({
      dataDir: layout.dataDir, runtimeDir: layout.runtimeDir, scanId: input.plan.scanId,
      expectedRevision: 0, ...input.commit,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await recordScanEnumerationIntent({
      dataDir: layout.dataDir, scanId: input.plan.scanId, expectedRevision: 0, intent: input.commit.intent,
    });
    await forceDecidingFixture(layout.dataDir, input.plan.scanId);
    const summaryPayload = { ...input.commit.summary, message: "private source body" } as Record<string, unknown>;
    delete summaryPayload.receiptHash;
    const summary = { ...summaryPayload, receiptHash: sha256Canonical(summaryPayload) };
    await expect(commitScanLayerOutcome({
      dataDir: layout.dataDir, runtimeDir: layout.runtimeDir, scanId: input.plan.scanId,
      expectedRevision: 1, ...input.commit, summary: summary as never,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("commits a validated Core layer batch only after exact scratch cleanup", async () => {
    const layout = await temporaryLayout();
    const input = emptyLayerFixture();
    await createScanStore({ dataDir: layout.dataDir, plan: input.plan });
    await recordScanEnumerationIntent({
      dataDir: layout.dataDir, scanId: input.plan.scanId, expectedRevision: 0, intent: input.commit.intent,
    });
    await forceDecidingFixture(layout.dataDir, input.plan.scanId);
    const scratch = join(layout.runtimeDir, "scans", input.plan.scanId, "layer-summary.json");
    await mkdir(dirname(scratch), { recursive: true });
    await writeFile(scratch, "disposable");

    const committed = await commitScanLayerOutcome({
      dataDir: layout.dataDir,
      runtimeDir: layout.runtimeDir,
      scanId: input.plan.scanId,
      expectedRevision: 1,
      ...input.commit,
    });
    expect(committed.ledger.entries).toHaveLength(1);
    expect(committed.receipts).toHaveLength(3);
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });

    const blocked = await temporaryLayout();
    await createScanStore({ dataDir: blocked.dataDir, plan: input.plan });
    await recordScanEnumerationIntent({
      dataDir: blocked.dataDir, scanId: input.plan.scanId, expectedRevision: 0, intent: input.commit.intent,
    });
    await forceDecidingFixture(blocked.dataDir, input.plan.scanId);
    await mkdir(blocked.runtimeDir, { recursive: true });
    await writeFile(join(blocked.runtimeDir, "scans"), "not-a-directory");
    await expect(commitScanLayerOutcome({
      dataDir: blocked.dataDir,
      runtimeDir: blocked.runtimeDir,
      scanId: input.plan.scanId,
      expectedRevision: 1,
      ...input.commit,
    })).rejects.toBeDefined();
    expect(await readScanStore({ dataDir: blocked.dataDir, scanId: input.plan.scanId }))
      .toMatchObject({ revision: 1, ledger: { entries: [] } });
  });
});

function scanPlan(authorizationHash = HASH_A): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_01",
    sourceIds: ["source_local"],
    authorizationHashes: [authorizationHash],
    rootNodeIds: ["root"],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: "Index current product documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function scanPlanForSources(sources: readonly AuthorizedSourceV1[]): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_multi",
    sourceIds: sources.map(({ sourceId }) => sourceId),
    authorizationHashes: sources.map(({ authorizationHash }) => authorizationHash),
    rootNodeIds: sources.map(({ rootNodeId }) => rootNodeId),
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: "Index current product documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function authorizedSource(sourceId = "source_local"): AuthorizedSourceV1 {
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint: HASH_A,
    previewHash: HASH_A,
    configHash: HASH_A,
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const approval = { ...approvalUnsigned, approvalHash: sha256Canonical(approvalUnsigned) };
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId,
    connectorType: "local-folder" as const,
    rootNodeId: "root",
    identityFingerprint: HASH_A,
    approval,
    scope: { schema: "openlifewiki.scope/local-folder/v1" as const, root: "/approved", symlinkPolicy: "deny" as const },
    include: ["**/*.md"],
    exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 700_000, maxAgentCalls: 10 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
}

async function temporaryLayout(): Promise<{ readonly dataDir: string; readonly runtimeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-scan-store-test-"));
  roots.push(root);
  return { dataDir: join(root, "data"), runtimeDir: join(root, "runtime") };
}

function emptyLayerFixture() {
  const plan = scanPlan();
  const intent = createEnumerationIntent({
    plan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: "intent_root",
      sourceId: "source_local",
      targetNodeId: "root",
      targetNodeVersion: "root-v1",
      authorizationHash: HASH_A,
      origin: "authorized-root",
      parentLayerNodeId: null,
      childSetHash: null,
      inputSetHash: HASH_A,
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  });
  const layer = {
    sourceId: "source_local",
    parentNodeId: "root",
    parentNodeVersion: "root-v1",
    summaryHash: sha256Canonical("empty-summary"),
    childSetHash: sha256Canonical([]),
    decisionTargetSetHash: sha256Canonical([]),
    coverage: {
      directChildrenEnumerated: 0,
      pageComplete: true,
      openCursor: false,
      unknownChildCount: false,
    },
    systemOutcomes: [],
  };
  const scanInput: AgentScanInputContext = {
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    layer,
    completeChildren: [],
    decisionTargets: [],
    remainingBudget: { nodes: 100, bodyBytes: 1_000_000, agentCalls: 10 },
    sensitivityByTarget: [],
    scanIntent: plan.scanIntent,
    indexing: {
      default: plan.policy.indexing.default,
      rules: plan.policy.indexing.rules.map((rule) => ({ ...rule })),
    },
    skillHash: plan.skillHash,
    wikiHash: HASH_A,
    hostPolicyHash: HASH_B,
  };
  const inputSetHash = buildAgentScanInputSetHash(scanInput);
  const summaryPayload = {
    schema: "openlifewiki.layer-summary-receipt/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    sourceId: "source_local",
    intentId: intent.intentId,
    summaryHash: layer.summaryHash,
    childSetHash: layer.childSetHash,
    inputSetHash,
    persistedAt: "2026-07-27T00:00:00.000Z",
  };
  const summary: LayerSummaryReceipt = {
    ...summaryPayload,
    receiptHash: sha256Canonical(summaryPayload),
  };
  const agentResult: AgentScanResult = {
    schema: "openlifewiki.agent-scan-result/v1",
    operationId: "operation_empty",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    skillHash: plan.skillHash,
    inputSetHash,
    agent: {
      id: "agent_codex_native",
      runtime: "codex",
      mode: "native-cli",
      driverContractVersion: "v1",
    },
    layer,
    childOutcomes: [],
    status: "decision-ready",
  };
  const agentInvocationReceipt = createAgentScanInvocationReceipt({
    plan,
    scanInput,
    result: agentResult,
    runtimeVersion: "1.0.0",
    outputSchemaHash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
    invokedAt: "2026-07-27T00:00:00.000Z",
  });
  return {
    plan,
    commit: {
      intent,
      scanInput,
      summary,
      agentResult,
      agentInvocationReceipt,
      agentDecisions: [],
      systemOutcomes: [],
      committedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

async function forceDecidingFixture(dataDir: string, scanId: string): Promise<void> {
  const path = scanStoreStatePath(dataDir, scanId);
  const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  let state = createScanState(scanId);
  state = transitionScanState(state, { type: "approve-plan" });
  state = transitionScanState(state, { type: "probe-connected" });
  state = transitionScanState(state, { type: "layer-discovered" });
  state = transitionScanState(state, { type: "layer-summarized" });
  const unsigned = { ...snapshot, state } as Record<string, unknown>;
  delete unsigned.snapshotHash;
  await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));
}

function leafSelection(plan: ScanPlan): { readonly decision: ScanDecision; readonly selection: LeafSelectionReceipt } {
  const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: plan.authorizationHashes[0]!, sourceId: "source_local",
    parentNodeId: "root", parentNodeVersion: "root-v1", childSetHash: HASH_A, nodeId: "leaf", nodeVersion: "v1",
    targetKind: "leaf", summaryHash: HASH_A, inputSetHash: HASH_A, decision: "descend", reason: "selected",
    revisitCondition: null, question: null, actor: plan.agentProfileId,
    estimatedCost: { nodes: 1, bodyBytes: 10, agentCalls: 0 }, persistedAt: "2026-07-27T00:00:00.000Z",
  };
  const decision = { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1", scanId: plan.scanId, sourceId: "source_local", nodeId: "leaf",
    nodeVersion: "v1", scanPlanHash: plan.scanPlanHash, skeletonVersion: plan.skeletonVersion,
    authorizationHash: plan.authorizationHashes[0]!, inputSetHash: HASH_A, decisionReceiptHash: decision.receiptHash,
    actor: plan.agentProfileId, reason: "selected", persistedAt: "2026-07-27T00:00:00.000Z",
  };
  return { decision, selection: { ...selectionPayload, receiptHash: sha256Canonical(selectionPayload) } };
}

function containerDecision(plan: ScanPlan): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: plan.authorizationHashes[0]!, sourceId: "source_local",
    parentNodeId: "root", parentNodeVersion: "root-v1", childSetHash: HASH_A, nodeId: "child", nodeVersion: "child-v1",
    targetKind: "container", summaryHash: HASH_A, inputSetHash: HASH_A, decision: "descend", reason: "scan child",
    revisitCondition: null, question: null, actor: plan.agentProfileId,
    estimatedCost: { nodes: 1, bodyBytes: 0, agentCalls: 1 }, persistedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function bodyObservation(plan: ScanPlan, selection: LeafSelectionReceipt, bytes: number): BodyObservationReceipt {
  const payload: Omit<BodyObservationReceipt, "receiptHash"> = {
    schema: "openlifewiki.body-observation-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: selection.authorizationHash, sourceId: selection.sourceId,
    nodeId: selection.nodeId, nodeVersion: selection.nodeVersion, inputSetHash: selection.inputSetHash,
    selectionReceiptHash: selection.receiptHash, contentHash: HASH_A, bytes, purpose: "initial-read",
    rematerializationAuthorizationHash: null, previousObservationReceiptHash: null,
    observedAt: "2026-07-27T00:00:01.000Z",
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

async function appendDecisionFixture(
  dataDir: string,
  plan: ScanPlan,
  decision: ScanDecision,
  selection?: LeafSelectionReceipt,
): Promise<void> {
  const path = scanStoreStatePath(dataDir, plan.scanId);
  const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const summaryPayload = {
    schema: "openlifewiki.layer-summary-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, sourceId: "source_local", intentId: "fixture-intent",
    summaryHash: HASH_A, childSetHash: HASH_A, inputSetHash: HASH_A, persistedAt: "2026-07-27T00:00:00.000Z",
  };
  const summary = { ...summaryPayload, receiptHash: sha256Canonical(summaryPayload) };
  const invocationPayload = {
    schema: "openlifewiki.agent-scan-invocation-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, sourceId: "source_local", layerHash: HASH_A, operationId: "fixture-op",
    inputSetHash: HASH_A, skillHash: plan.skillHash,
    agent: { id: plan.agentProfileId, runtime: "codex", mode: "native-cli", driverContractVersion: "v1" },
    runtimeVersion: "1.0.0", outputSchemaId: "openlifewiki.agent-scan-result/v1",
    outputSchemaHash: HASH_A, resultHash: HASH_A, invokedAt: "2026-07-27T00:00:00.000Z",
  };
  const invocation = { ...invocationPayload, receiptHash: sha256Canonical(invocationPayload) };
  const batch = {
    summaryReceiptHash: summary.receiptHash, agentInvocationReceiptHash: invocation.receiptHash,
    agentResultHash: invocation.resultHash, agentDecisionReceiptHashes: [decision.receiptHash],
    systemOutcomeReceiptHashes: [],
  };
  const entryPayload = {
    schema: "openlifewiki.scan-ledger-entry/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, sequence: 1, previousEntryHash: null, sourceId: "source_local",
    intentId: "fixture-intent", parentNodeId: "root", ...batch, batchHash: sha256Canonical(batch),
    committedAt: "2026-07-27T00:00:00.000Z",
  };
  const entry = { ...entryPayload, entryHash: sha256Canonical(entryPayload) };
  const ledger = { ...(snapshot.ledger as object), entries: [entry], headHash: entry.entryHash };
  const receipts = [
    ...snapshot.receipts as object[], summary, invocation, decision,
    ...(selection === undefined ? [] : [selection]),
  ];
  const unsigned = { ...snapshot, ledger, receipts } as Record<string, unknown>;
  delete unsigned.snapshotHash;
  await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));
}
