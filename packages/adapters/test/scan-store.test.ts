import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  type LayerSummaryReceipt,
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
  recordScanPhysicalIo,
  reserveScanBodyBudget,
  scanStoreStatePath,
} from "../src/index.js";

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

  it("rejects a self-hashed BodyObservation without its trusted selection chain", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const payload = {
      schema: "openlifewiki.body-observation-receipt/v1" as const,
      scanId: plan.scanId,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
      authorizationHash: HASH_A,
      sourceId: "source_local",
      nodeId: "leaf",
      nodeVersion: "v1",
      inputSetHash: HASH_A,
      selectionReceiptHash: HASH_B,
      contentHash: HASH_A,
      bytes: 10,
      purpose: "initial-read" as const,
      rematerializationAuthorizationHash: null,
      previousObservationReceiptHash: null,
      observedAt: "2026-07-27T00:00:00.000Z",
    };
    const fake = { ...payload, receiptHash: sha256Canonical(payload) };
    await expect(recordScanPhysicalIo({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 0,
      observations: [{ observation: fake, selectionReceipt: null as never }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("commits a validated Core layer batch only after exact scratch cleanup", async () => {
    const layout = await temporaryLayout();
    const input = emptyLayerFixture();
    await createScanStore({ dataDir: layout.dataDir, plan: input.plan });
    await forceDecidingFixture(layout.dataDir, input.plan.scanId);
    const scratch = join(layout.runtimeDir, "scans", input.plan.scanId, "layer-summary.json");
    await mkdir(dirname(scratch), { recursive: true });
    await writeFile(scratch, "disposable");

    const committed = await commitScanLayerOutcome({
      dataDir: layout.dataDir,
      runtimeDir: layout.runtimeDir,
      scanId: input.plan.scanId,
      expectedRevision: 0,
      ...input.commit,
    });
    expect(committed.ledger.entries).toHaveLength(1);
    expect(committed.receipts).toHaveLength(3);
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });

    const blocked = await temporaryLayout();
    await createScanStore({ dataDir: blocked.dataDir, plan: input.plan });
    await forceDecidingFixture(blocked.dataDir, input.plan.scanId);
    await mkdir(blocked.runtimeDir, { recursive: true });
    await writeFile(join(blocked.runtimeDir, "scans"), "not-a-directory");
    await expect(commitScanLayerOutcome({
      dataDir: blocked.dataDir,
      runtimeDir: blocked.runtimeDir,
      scanId: input.plan.scanId,
      expectedRevision: 0,
      ...input.commit,
    })).rejects.toBeDefined();
    expect(await readScanStore({ dataDir: blocked.dataDir, scanId: input.plan.scanId }))
      .toMatchObject({ revision: 0, ledger: { entries: [] } });
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
