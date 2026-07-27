import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  assertBodyObservationReceipt,
  createBodyObservationReceipt,
  assertEnumerationIntent,
  assertScanPlan,
  sha256Canonical,
  type AgentScanInputContext,
  type AgentScanInvocationReceipt,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type BodyObservationReceipt,
  type EnumerationIntent,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
  type ScanSystemOutcomeReceipt,
} from "@openlifewiki/protocol";
import {
  appendLayerOutcomeBatch,
  createPhysicalIoAccounting,
  createScanLedger,
  createScanState,
  recordPhysicalIo,
  transitionScanState,
  type PhysicalIoAccounting,
  type ScanLedger,
  type ScanState,
  type ScanStateEvent,
  type ScanWorkPhase,
} from "@openlifewiki/core";

import {
  createBodyBudgetReservationReceipt,
  issueActiveBodyReadLease,
  revokeActiveBodyReadLease,
  type ActiveBodyReadLease,
  type ApprovedLeafBody,
  type BodyBudgetReservationReceipt,
} from "./connectors/connector-provider.js";
import { AdapterError } from "./errors.js";
import { clearScanScratch } from "./scan-scratch.js";
import { writeJsonAtomic } from "./state-store.js";

const SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const B2_RECEIPT_KEYS = new Map<string, readonly string[]>([
  ["openlifewiki.enumeration-intent/v1", [
    "authorizationHash", "childSetHash", "createdAt", "decisionReceiptHash", "inputSetHash",
    "intentId", "origin", "parentLayerNodeId", "receiptHash", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId", "targetNodeId", "targetNodeVersion",
  ]],
  ["openlifewiki.layer-summary-receipt/v1", [
    "childSetHash", "inputSetHash", "intentId", "persistedAt", "receiptHash", "scanId",
    "scanPlanHash", "schema", "skeletonVersion", "sourceId", "summaryHash",
  ]],
  ["openlifewiki.agent-scan-invocation-receipt/v1", [
    "agent", "inputSetHash", "invokedAt", "layerHash", "operationId", "outputSchemaHash",
    "outputSchemaId", "receiptHash", "resultHash", "runtimeVersion", "scanId", "scanPlanHash",
    "schema", "skeletonVersion", "skillHash", "sourceId",
  ]],
  ["openlifewiki.scan-decision/v1", [
    "actor", "authorizationHash", "childSetHash", "decision", "estimatedCost", "inputSetHash",
    "nodeId", "nodeVersion", "parentNodeId", "parentNodeVersion", "persistedAt", "question",
    "reason", "receiptHash", "revisitCondition", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId", "summaryHash", "targetKind",
  ]],
  ["openlifewiki.scan-system-outcome/v1", [
    "code", "nodeId", "outcome", "persistedAt", "phase", "receiptHash", "scanId",
    "scanPlanHash", "schema", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-budget-reservation/v1", [
    "authorizationHash", "nodeId", "nodeVersion", "physicalIoAccountingHash", "receiptHash",
    "remainingBeforeBytes", "reservedAt", "reservedBytes", "scanId", "scanPlanHash", "schema",
    "scanTransitionSequence", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.leaf-selection/v1", [
    "actor", "authorizationHash", "decisionReceiptHash", "inputSetHash", "nodeId", "nodeVersion",
    "persistedAt", "reason", "receiptHash", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-observation-receipt/v1", [
    "authorizationHash", "bytes", "contentHash", "inputSetHash", "nodeId", "nodeVersion",
    "observedAt", "previousObservationReceiptHash", "purpose", "receiptHash",
    "rematerializationAuthorizationHash", "scanId", "scanPlanHash", "schema",
    "selectionReceiptHash", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-read-commit/v1", [
    "committedAt", "nodeId", "nodeVersion", "observationReceiptHash", "receiptHash",
    "reservationReceiptHash", "scanId", "scanPlanHash", "scanTransitionSequence", "schema",
    "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-read-epoch-boundary/v1", [
    "event", "fromTransitionSequence", "persistedAt", "receiptHash", "scanId", "scanPlanHash",
    "schema", "skeletonVersion", "toTransitionSequence",
  ]],
]);
const SNAPSHOT_KEYS = [
  "ledger",
  "physicalIo",
  "plan",
  "receipts",
  "revision",
  "schema",
  "snapshotHash",
  "state",
] as const;

export type ScanStoreReceipt = Readonly<object>;

export interface ScanStoreSnapshot {
  readonly schema: "openlifewiki.scan-store-snapshot/v1";
  readonly revision: number;
  readonly plan: ScanPlan;
  readonly state: ScanState;
  readonly ledger: ScanLedger;
  readonly receipts: readonly ScanStoreReceipt[];
  readonly physicalIo: PhysicalIoAccounting;
  readonly snapshotHash: string;
}

interface BodyReadCommitReceipt {
  readonly schema: "openlifewiki.body-read-commit/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly reservationReceiptHash: string;
  readonly observationReceiptHash: string;
  readonly scanTransitionSequence: number;
  readonly committedAt: string;
  readonly receiptHash: string;
}

interface BodyReadEpochBoundaryReceipt {
  readonly schema: "openlifewiki.body-read-epoch-boundary/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly event: ScanControlEvent["type"];
  readonly fromTransitionSequence: number;
  readonly toTransitionSequence: number;
  readonly persistedAt: string;
  readonly receiptHash: string;
}

type ScanStoreUpdate = ScanStoreSnapshot;

export function scanStoreStatePath(dataDir: string, scanId: string): string {
  assertScanId(scanId);
  return join(dataDir, "scans", scanId, "state.json");
}

export async function createScanStore(options: {
  readonly dataDir: string;
  readonly plan: ScanPlan;
}): Promise<ScanStoreSnapshot> {
  assertScanPlan(options.plan);
  const path = scanStoreStatePath(options.dataDir, options.plan.scanId);
  return await withScanLock(path, async () => {
    if (await fileExists(path)) throw conflict("Scan state already exists");
    const snapshot = createSnapshot({
      revision: 0,
      plan: options.plan,
      state: createScanState(options.plan.scanId),
      ledger: createScanLedger(options.plan),
      receipts: [],
      physicalIo: createPhysicalIoAccounting(),
    });
    await persist(path, snapshot);
    return snapshot;
  });
}

export async function readScanStore(options: {
  readonly dataDir: string;
  readonly scanId: string;
}): Promise<ScanStoreSnapshot | undefined> {
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalid("Scan state is not valid JSON", error);
  }
  try {
    const snapshot = assertSnapshot(value);
    if (snapshot.plan.scanId !== options.scanId) throw new Error("scanId path binding mismatch");
    return freeze(structuredClone(snapshot));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw invalid("Scan state failed integrity validation", error);
  }
}

export async function approveScanPlan(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
}): Promise<ScanStoreSnapshot> {
  return await updateScanStore(options, (current) => ({
    ...current,
    state: transitionScanState(current.state, { type: "approve-plan" }),
  }));
}

export async function recordScanEnumerationIntent(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly intent: EnumerationIntent;
}): Promise<ScanStoreSnapshot> {
  return await updateScanStore(options, (current) => {
    const trustedDecisionHashes = new Set(current.ledger.entries.flatMap(({ agentDecisionReceiptHashes }) => agentDecisionReceiptHashes));
    const decisions = (receiptsBySchema(current.receipts, "openlifewiki.scan-decision/v1") as ScanDecision[])
      .filter(({ receiptHash }) => trustedDecisionHashes.has(receiptHash));
    assertEnumerationIntent(options.intent, { plan: current.plan, trustedDecisionReceipts: decisions });
    assertEnumerationIntentUniqueness([
      ...receiptsBySchema(current.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[],
      options.intent,
    ]);
    return { ...current, receipts: [...current.receipts, options.intent] };
  });
}

export type ScanControlEvent =
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly retryPhase: ScanWorkPhase; readonly code: string }
  | { readonly type: "retry" };

export async function controlScan(options: {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly event: ScanControlEvent;
}): Promise<ScanStoreSnapshot> {
  assertRuntimeBinding(options.dataDir, options.runtimeDir);
  if (!(["pause", "resume", "cancel", "fail", "retry"] as const).includes(options.event.type)) {
    throw invalid("Scan control event is not allowed by the B2 lifecycle boundary");
  }
  return await updateScanStore(options, async (current) => {
    const state = transitionScanState(current.state, options.event);
    if (["pause", "cancel", "fail"].includes(options.event.type)) {
      const reason = options.event.type === "fail"
        ? "failure"
        : options.event.type === "pause" ? "pause" : "cancel";
      await clearScanScratch({
        runtimeDir: options.runtimeDir,
        scanId: options.scanId,
        reason,
      });
    }
    const boundary = createBodyReadEpochBoundaryReceipt({
      scanId: current.plan.scanId,
      scanPlanHash: current.plan.scanPlanHash,
      skeletonVersion: current.plan.skeletonVersion,
      event: options.event.type,
      fromTransitionSequence: current.state.transitionSequence,
      toTransitionSequence: state.transitionSequence,
      persistedAt: new Date().toISOString(),
    });
    return { ...current, state, receipts: [...current.receipts, boundary] };
  });
}

export async function commitScanLayerOutcome(options: {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly intent: EnumerationIntent;
  readonly scanInput: AgentScanInputContext;
  readonly summary: LayerSummaryReceipt;
  readonly agentResult: AgentScanResult;
  readonly agentInvocationReceipt: AgentScanInvocationReceipt;
  readonly agentDecisions: readonly ScanDecision[];
  readonly systemOutcomes: readonly ScanSystemOutcomeReceipt[];
  readonly committedAt: string;
}): Promise<ScanStoreSnapshot> {
  assertRuntimeBinding(options.dataDir, options.runtimeDir);
  return await updateScanStore(options, async (current) => {
    if (current.state.phase !== "Deciding") throw new Error("Layer outcome requires Deciding state");
    const durableIntent = current.receipts.find((receipt) => (
      schemaOf(receipt) === "openlifewiki.enumeration-intent/v1"
      && (receipt as EnumerationIntent).intentId === options.intent.intentId
    ));
    if (durableIntent === undefined || sha256Canonical(durableIntent) !== sha256Canonical(options.intent)) {
      throw new Error("Layer outcome requires its exact durable Enumeration Intent");
    }
    const additions: ScanStoreReceipt[] = [
      options.summary,
      options.agentInvocationReceipt,
      ...options.agentDecisions,
      ...options.systemOutcomes,
    ];
    const trustedReceiptHashes = [
      ...receiptHashes(current.receipts),
      ...receiptHashes(additions),
    ];
    const ledger = appendLayerOutcomeBatch({
      ledger: current.ledger,
      plan: current.plan,
      expectedHeadHash: current.ledger.headHash,
      sequence: current.ledger.entries.length + 1,
      intent: options.intent,
      scanInput: options.scanInput,
      summary: options.summary,
      agentResult: options.agentResult,
      agentInvocationReceipt: options.agentInvocationReceipt,
      agentDecisions: options.agentDecisions,
      systemOutcomes: options.systemOutcomes,
      trustedReceiptHashes,
      committedAt: options.committedAt,
    });
    await clearScanScratch({
      runtimeDir: options.runtimeDir,
      scanId: options.scanId,
      reason: "decision-committed",
    });
    return { ...current, ledger, receipts: [...current.receipts, ...additions] };
  });
}

export interface ActiveScanBodyLeaseContext {
  readonly lease: ActiveBodyReadLease;
  readonly snapshot: ScanStoreSnapshot;
  readonly reservation: BodyBudgetReservationReceipt;
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly trustedReceiptHashes: readonly string[];
  readonly expectedPhysicalIoAccountingHash: string;
}

export interface ConsumedBodyEvidence {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly bytes: number;
  readonly contentHash: string;
  readonly observationReceiptHash: string;
  readonly commitReceiptHash: string;
}

/** Package-internal atomic body-read path. Deliberately omitted from the package entry point. */
export async function withActiveScanBodyLease(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly open: (context: ActiveScanBodyLeaseContext) => Promise<ApprovedLeafBody>;
  readonly onChunk?: (chunk: Uint8Array) => Promise<void>;
  readonly now?: () => Date;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly evidence: ConsumedBodyEvidence }> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }
    if (current.state.phase !== "ReadingLeaves") {
      throw invalid("Body read requires ReadingLeaves");
    }
    const active = currentActiveBodyBudgetReservations(current);
    if (active.length !== 1) throw invalid("Body read requires one current JIT reservation");
    const reservation = active[0]!;
    if (reservation.sourceId !== options.sourceId
      || reservation.nodeId !== options.nodeId
      || reservation.nodeVersion !== options.nodeVersion) {
      throw invalid("Body read target does not own the current JIT reservation");
    }
    const selectionReceipt = durableLeafSelection(
      current,
      reservation.sourceId,
      reservation.nodeId,
      reservation.nodeVersion,
      reservation.authorizationHash,
    );
    if (selectionReceipt === undefined) throw invalid("Body read has no durable selected leaf");
    const lease = issueActiveBodyReadLease({
      scanId: current.plan.scanId,
      reservationReceiptHash: reservation.receiptHash,
      scanTransitionSequence: current.state.transitionSequence,
    });
    try {
      const body = await options.open({
        lease,
        snapshot: current,
        reservation,
        selectionReceipt,
        trustedReceiptHashes: receiptHashes(current.receipts),
        expectedPhysicalIoAccountingHash: sha256Canonical(current.physicalIo),
      });
      if (body.sourceId !== reservation.sourceId
        || body.nodeId !== reservation.nodeId
        || body.nodeVersion !== reservation.nodeVersion) {
        throw new Error("Approved body stream does not bind the active reservation");
      }
      const digest = createHash("sha256");
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      for await (const chunk of body.stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Approved body stream yielded a non-byte chunk");
        const nextBytes = bytes + chunk.byteLength;
        if (!Number.isSafeInteger(nextBytes) || nextBytes > reservation.reservedBytes) {
          throw new Error("Approved body stream exceeded its active reservation");
        }
        utf8.decode(chunk, { stream: true });
        digest.update(chunk);
        if (options.onChunk !== undefined) await options.onChunk(chunk);
        bytes = nextBytes;
      }
      utf8.decode();
      const contentHash = `sha256:${digest.digest("hex")}`;
      const committedAt = (options.now ?? (() => new Date()))().toISOString();
      const observation = createBodyObservationReceipt({
        plan: current.plan,
        trustedSelectionReceiptHashes: receiptHashes(current.receipts),
        selectionReceipt,
        previousObservationReceipt: null,
        observation: {
          schema: "openlifewiki.body-observation-receipt/v1",
          sourceId: reservation.sourceId,
          nodeId: reservation.nodeId,
          nodeVersion: reservation.nodeVersion,
          contentHash,
          bytes,
          purpose: "initial-read",
          rematerializationAuthorizationHash: null,
          observedAt: committedAt,
        },
      });
      const commit = createBodyReadCommitReceipt({
        scanId: current.plan.scanId,
        scanPlanHash: current.plan.scanPlanHash,
        skeletonVersion: current.plan.skeletonVersion,
        sourceId: reservation.sourceId,
        nodeId: reservation.nodeId,
        nodeVersion: reservation.nodeVersion,
        reservationReceiptHash: reservation.receiptHash,
        observationReceiptHash: observation.receiptHash,
        scanTransitionSequence: current.state.transitionSequence,
        committedAt,
      });
      const proposed = appendTrustedBodyObservation(current, {
        observation,
        selectionReceipt,
        budgetReservation: reservation,
        commit,
      });
      assertUpdate(current, proposed);
      const next = createSnapshot({
        revision: current.revision + 1,
        plan: proposed.plan,
        state: proposed.state,
        ledger: proposed.ledger,
        receipts: proposed.receipts,
        physicalIo: proposed.physicalIo,
      });
      await persist(path, next);
      return {
        snapshot: next,
        evidence: Object.freeze({
          sourceId: reservation.sourceId,
          nodeId: reservation.nodeId,
          nodeVersion: reservation.nodeVersion,
          bytes,
          contentHash,
          observationReceiptHash: observation.receiptHash,
          commitReceiptHash: commit.receiptHash,
        }),
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Active body read failed", error);
    } finally {
      revokeActiveBodyReadLease(lease);
    }
  });
}

export async function reserveScanBodyBudget(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly expectedPhysicalIoAccountingHash: string;
  readonly source: AuthorizedSourceV1;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly reservedBytes: number;
  readonly now?: () => Date;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly reservation: BodyBudgetReservationReceipt }> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }
    if (current.state.phase !== "ReadingLeaves") {
      throw invalid("Body budget reservation requires ReadingLeaves");
    }
    const accountingHash = sha256Canonical(current.physicalIo);
    const requestedKey = bodyWorkKey(options.source.sourceId, options.nodeId, options.nodeVersion);
    const active = currentActiveBodyBudgetReservations(current);
    const existing = active.length === 1 && bodyWorkKey(
      active[0]!.sourceId,
      active[0]!.nodeId,
      active[0]!.nodeVersion,
    ) === requestedKey ? active[0] : undefined;
    if (existing !== undefined
      && existing.reservedBytes === options.reservedBytes
      && existing.physicalIoAccountingHash === options.expectedPhysicalIoAccountingHash) {
      assertAuthorizedSourceBinding(options.source, current.plan);
      return { snapshot: current, reservation: existing };
    }
    if (options.expectedPhysicalIoAccountingHash !== accountingHash) {
      throw conflict("Physical I/O accounting changed before budget reservation");
    }
    assertAuthorizedSourceBinding(options.source, current.plan);
    const sourceIndex = current.plan.sourceIds.indexOf(options.source.sourceId);
    const selection = durableLeafSelection(
      current,
      options.source.sourceId,
      options.nodeId,
      options.nodeVersion,
      options.source.authorizationHash,
    );
    if (selection === undefined) {
      throw invalid("Body budget reservation requires an exact durable selected leaf");
    }
    const observations = current.receipts.filter((receipt) => (
      schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1"
    )) as readonly BodyObservationReceipt[];
    if (observations.some((item) => bodyWorkKey(item.sourceId, item.nodeId, item.nodeVersion) === requestedKey)) {
      throw invalid("Selected leaf body was already observed");
    }
    if (active.length > 0) {
      throw invalid("A current JIT body budget reservation already exists");
    }
    const planLimit = current.plan.policy.budget.maxBodyBytes;
    if (planLimit === undefined) throw invalid("Scan Plan has no body budget");
    const limit = Math.min(options.source.budget.maxBodyBytes, planLimit);
    if (!Number.isSafeInteger(limit) || limit < 0) throw invalid("Scan Plan has no valid body budget");
    const sourceConsumed = observations
      .filter(({ sourceId }) => sourceId === options.source.sourceId)
      .reduce((total, item) => total + item.bytes, 0);
    const planConsumed = observations.reduce((total, item) => total + item.bytes, 0);
    const remainingBeforeBytes = Math.min(
      options.source.budget.maxBodyBytes - sourceConsumed,
      planLimit - planConsumed,
    );
    if (!Number.isSafeInteger(options.reservedBytes)
      || options.reservedBytes <= 0
      || options.reservedBytes > remainingBeforeBytes) {
      throw invalid("Body budget reservation exceeds the durable remaining budget");
    }
    const reservation = createBodyBudgetReservationReceipt({
      schema: "openlifewiki.body-budget-reservation/v1",
      scanId: current.plan.scanId,
      scanPlanHash: current.plan.scanPlanHash,
      skeletonVersion: current.plan.skeletonVersion,
      authorizationHash: current.plan.authorizationHashes[sourceIndex]!,
      sourceId: options.source.sourceId,
      nodeId: options.nodeId,
      nodeVersion: options.nodeVersion,
      scanTransitionSequence: current.state.transitionSequence,
      physicalIoAccountingHash: accountingHash,
      remainingBeforeBytes,
      reservedBytes: options.reservedBytes,
      reservedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    const proposed = { ...current, receipts: [...current.receipts, reservation] };
    try {
      assertUpdate(current, proposed);
      const next = createSnapshot({
        revision: current.revision + 1,
        plan: proposed.plan,
        state: proposed.state,
        ledger: proposed.ledger,
        receipts: proposed.receipts,
        physicalIo: proposed.physicalIo,
      });
      await persist(path, next);
      return { snapshot: next, reservation };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Proposed scan update failed integrity validation", error);
    }
  });
}

async function updateScanStore(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
}, update: (snapshot: ScanStoreSnapshot) => ScanStoreUpdate | Promise<ScanStoreUpdate>): Promise<ScanStoreSnapshot> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }

    let proposed: ScanStoreUpdate;
    try {
      proposed = await update(freeze(structuredClone(current)));
      assertUpdate(current, proposed);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Proposed scan update failed integrity validation", error);
    }
    const next = createSnapshot({
      revision: current.revision + 1,
      plan: proposed.plan,
      state: proposed.state,
      ledger: proposed.ledger,
      receipts: proposed.receipts,
      physicalIo: proposed.physicalIo,
    });
    await persist(path, next);
    return next;
  });
}

function schemaOf(receipt: ScanStoreReceipt): string | undefined {
  return isRecord(receipt) && typeof receipt.schema === "string" ? receipt.schema : undefined;
}

function receiptsBySchema(receipts: readonly ScanStoreReceipt[], schema: string): ScanStoreReceipt[] {
  return receipts.filter((receipt) => schemaOf(receipt) === schema);
}

function artifactHash(receipt: ScanStoreReceipt): string | undefined {
  if (!isRecord(receipt)) return undefined;
  if (typeof receipt.receiptHash === "string") return receipt.receiptHash;
  return typeof receipt.authorizationHash === "string" ? receipt.authorizationHash : undefined;
}

function receiptHashes(receipts: readonly ScanStoreReceipt[]): string[] {
  return receipts.map((receipt) => {
    const hash = artifactHash(receipt);
    if (hash === undefined) throw new Error("Durable scan artifact has no trusted hash");
    return hash;
  });
}

interface TrustedBodyObservationInput {
  readonly observation: BodyObservationReceipt;
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly budgetReservation: BodyBudgetReservationReceipt;
  readonly commit: BodyReadCommitReceipt;
}

function createBodyReadCommitReceipt(
  input: Omit<BodyReadCommitReceipt, "schema" | "receiptHash">,
): BodyReadCommitReceipt {
  const payload = { schema: "openlifewiki.body-read-commit/v1" as const, ...input };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function createBodyReadEpochBoundaryReceipt(
  input: Omit<BodyReadEpochBoundaryReceipt, "schema" | "receiptHash">,
): BodyReadEpochBoundaryReceipt {
  const payload = { schema: "openlifewiki.body-read-epoch-boundary/v1" as const, ...input };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function appendTrustedBodyObservation(
  current: ScanStoreSnapshot,
  item: TrustedBodyObservationInput,
): ScanStoreSnapshot {
  if (current.state.phase !== "ReadingLeaves") {
    throw new Error("Body observation requires ReadingLeaves");
  }
  assertTrustedBodyObservation(item, current);
  const existingObservations = receiptsBySchema(
    current.receipts,
    "openlifewiki.body-observation-receipt/v1",
  ) as BodyObservationReceipt[];
  assertBodyReadCommit(item.commit, item.observation, item.budgetReservation);
  const additions: ScanStoreReceipt[] = [item.observation, item.commit];
  const physicalIo = recordPhysicalIo({
    accounting: current.physicalIo,
    priorObservations: existingObservations,
    observations: [item.observation],
    rematerializationAuthorizations: [],
    trustedReceiptHashes: [...receiptHashes(current.receipts), item.observation.receiptHash],
  });
  return { ...current, physicalIo, receipts: [...current.receipts, ...additions] };
}

function assertTrustedBodyObservation(
  item: TrustedBodyObservationInput,
  current: ScanStoreSnapshot,
): void {
  const selectionHash = item.selectionReceipt.receiptHash;
  const durableSelection = current.receipts.find((receipt) => artifactHash(receipt) === selectionHash);
  if (durableSelection === undefined || sha256Canonical(durableSelection) !== sha256Canonical(item.selectionReceipt)) {
    throw new Error("Body observation selection is outside the durable trusted receipt set");
  }
  const reservation = item.budgetReservation;
  const durableReservation = current.receipts.find((receipt) => artifactHash(receipt) === reservation.receiptHash);
  const activeReservations = currentActiveBodyBudgetReservations(current);
  const activeReservation = activeReservations.length === 1 ? activeReservations[0] : undefined;
  const accountingHash = sha256Canonical(current.physicalIo);
  if (durableReservation === undefined
    || sha256Canonical(durableReservation) !== sha256Canonical(reservation)
    || activeReservation?.receiptHash !== reservation.receiptHash
    || reservation.sourceId !== item.observation.sourceId
    || reservation.nodeId !== item.observation.nodeId
    || reservation.nodeVersion !== item.observation.nodeVersion
    || reservation.authorizationHash !== item.observation.authorizationHash
    || reservation.physicalIoAccountingHash !== accountingHash
    || item.observation.bytes > reservation.reservedBytes
    || current.receipts.some((receipt) => schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1"
      && (receipt as BodyObservationReceipt).sourceId === reservation.sourceId
      && (receipt as BodyObservationReceipt).nodeId === reservation.nodeId
      && (receipt as BodyObservationReceipt).nodeVersion === reservation.nodeVersion)) {
    throw new Error("Body observation does not bind one current unconsumed budget reservation");
  }
  assertBodyObservationReceipt(item.observation, {
    plan: current.plan,
    trustedSelectionReceiptHashes: receiptHashes(current.receipts),
    selectionReceipt: item.selectionReceipt,
    previousObservationReceipt: null,
  });
}

function assertBodyReadCommit(
  commit: BodyReadCommitReceipt,
  observation: BodyObservationReceipt,
  reservation: BodyBudgetReservationReceipt,
): void {
  const { receiptHash, ...unsigned } = commit;
  if (sha256Canonical(unsigned) !== receiptHash
    || commit.schema !== "openlifewiki.body-read-commit/v1"
    || commit.scanId !== reservation.scanId
    || commit.scanPlanHash !== reservation.scanPlanHash
    || commit.skeletonVersion !== reservation.skeletonVersion
    || commit.sourceId !== reservation.sourceId
    || commit.nodeId !== reservation.nodeId
    || commit.nodeVersion !== reservation.nodeVersion
    || commit.reservationReceiptHash !== reservation.receiptHash
    || commit.observationReceiptHash !== observation.receiptHash
    || commit.scanTransitionSequence !== reservation.scanTransitionSequence
    || !Number.isFinite(Date.parse(commit.committedAt))) {
    throw new Error("Body read commit does not bind its active reservation and observation");
  }
}

function assertAuthorizedSourceBinding(source: AuthorizedSourceV1, plan: ScanPlan): void {
  const { authorizationHash, ...unsigned } = source;
  const index = plan.sourceIds.indexOf(source.sourceId);
  if (sha256Canonical(unsigned) !== authorizationHash
    || index < 0
    || plan.authorizationHashes[index] !== authorizationHash) {
    throw new Error("Authorized Source does not bind the active Scan Plan");
  }
}

function assertRuntimeBinding(dataDir: string, runtimeDir: string): void {
  const expected = resolve(dirname(resolve(dataDir)), "runtime");
  if (resolve(runtimeDir) !== expected) {
    throw invalid("Scan scratch runtime must be the runtime sibling of the durable data directory");
  }
}

function createSnapshot(input: Omit<ScanStoreSnapshot, "schema" | "snapshotHash">): ScanStoreSnapshot {
  const unsigned = {
    schema: "openlifewiki.scan-store-snapshot/v1" as const,
    revision: input.revision,
    plan: structuredClone(input.plan),
    state: structuredClone(input.state),
    ledger: structuredClone(input.ledger),
    receipts: structuredClone(input.receipts),
    physicalIo: structuredClone(input.physicalIo),
  };
  const snapshot = { ...unsigned, snapshotHash: sha256Canonical(unsigned) };
  assertSnapshot(snapshot);
  return freeze(snapshot);
}

function assertSnapshot(value: unknown): ScanStoreSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) throw new Error("snapshot shape is invalid");
  if (value.schema !== "openlifewiki.scan-store-snapshot/v1"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || typeof value.snapshotHash !== "string"
    || !SHA256.test(value.snapshotHash)) {
    throw new Error("snapshot header is invalid");
  }
  const { snapshotHash, ...unsigned } = value;
  if (sha256Canonical(unsigned) !== snapshotHash) throw new Error("snapshotHash mismatch");
  assertScanPlan(value.plan);
  const plan = value.plan;
  assertState(value.state, plan);
  assertLedger(value.ledger, plan);
  const receipts = assertReceipts(value.receipts, plan, value.ledger);
  assertPhysicalIo(value.physicalIo, receipts);
  assertLedgerReferences(value.ledger, receipts);
  return value as unknown as ScanStoreSnapshot;
}

function assertUpdate(current: ScanStoreSnapshot, proposed: ScanStoreUpdate): void {
  if (!isRecord(proposed) || !hasExactKeys(proposed, SNAPSHOT_KEYS)
    || proposed.schema !== "openlifewiki.scan-store-snapshot/v1") {
    throw new Error("Proposed scan snapshot shape is invalid");
  }
  assertScanPlan(proposed.plan);
  assertState(proposed.state, proposed.plan);
  assertLedger(proposed.ledger, proposed.plan);
  const receipts = assertReceipts(proposed.receipts, proposed.plan, proposed.ledger);
  assertPhysicalIo(proposed.physicalIo, receipts);
  assertLedgerReferences(proposed.ledger, receipts);
  if (sha256Canonical(proposed.plan) !== sha256Canonical(current.plan)) {
    throw new Error("Scan Plan is immutable");
  }
  assertStateAdvance(current.state, proposed.state);
  assertLedgerAppendOnly(current.ledger, proposed.ledger);
  assertReceiptAppendOnly(current.receipts, proposed.receipts);
  assertPhysicalIoAppendOnly(current.physicalIo, proposed.physicalIo);
  if (proposed.revision !== current.revision || proposed.snapshotHash !== current.snapshotHash) {
    throw new Error("Updater cannot forge revision or snapshotHash");
  }
}

function assertState(value: unknown, plan: ScanPlan): asserts value is ScanState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "completed", "failureCode", "phase", "resumePhase", "retryPhase", "scanId", "schema", "transitionSequence",
  ])) throw new Error("Scan state shape is invalid");
  if (value.schema !== "openlifewiki.scan-state/v1"
    || value.scanId !== plan.scanId
    || !Number.isSafeInteger(value.transitionSequence)
    || Number(value.transitionSequence) < 0
    || typeof value.completed !== "boolean") throw new Error("Scan state binding is invalid");
  const phases = new Set([
    "Draft", "Probing", "Discovering", "Summarizing", "Deciding", "ReadingLeaves",
    "BuildingQMD", "VerifyingQMD", "PublishingQMD", "Paused", "Cancelled", "Failed", "Complete",
  ]);
  const workPhases = new Set([
    "Probing", "Discovering", "Summarizing", "Deciding", "ReadingLeaves",
    "BuildingQMD", "VerifyingQMD", "PublishingQMD",
  ]);
  if (!phases.has(String(value.phase))) throw new Error("Scan phase is invalid");
  if (value.completed !== (value.phase === "Complete")) throw new Error("Scan completion flag is invalid");
  if (!(value.resumePhase === null || workPhases.has(String(value.resumePhase)))
    || !(value.retryPhase === null || workPhases.has(String(value.retryPhase)))
    || !(value.failureCode === null || typeof value.failureCode === "string" && value.failureCode.length > 0)) {
    throw new Error("Scan recovery state is invalid");
  }
  if (value.phase === "Paused") {
    if (value.resumePhase === null || value.retryPhase !== null || value.failureCode !== null) {
      throw new Error("Paused scan recovery state is invalid");
    }
  } else if (value.phase === "Failed") {
    if (value.resumePhase !== null || value.retryPhase === null || value.failureCode === null) {
      throw new Error("Failed scan recovery state is invalid");
    }
  } else if (value.resumePhase !== null || value.retryPhase !== null || value.failureCode !== null) {
    throw new Error("Stable scan phase cannot retain recovery fields");
  }
}

function assertStateAdvance(current: ScanState, proposed: ScanState): void {
  if (sha256Canonical(current) === sha256Canonical(proposed)) return;
  if (proposed.transitionSequence !== current.transitionSequence + 1) {
    throw new Error("Scan state transition sequence must advance exactly once");
  }
  const events: ScanStateEvent[] = [
    { type: "approve-plan" }, { type: "probe-connected" }, { type: "layer-discovered" },
    { type: "layer-summarized" }, { type: "continue-discovery" }, { type: "frontier-discovered" },
    { type: "leaves-read" }, { type: "qmd-built" }, { type: "qmd-verified" }, { type: "qmd-published" },
    { type: "pause" }, { type: "resume" }, { type: "cancel" }, { type: "retry" },
  ];
  if (proposed.phase === "Failed" && proposed.retryPhase !== null && proposed.failureCode !== null) {
    events.push({ type: "fail", retryPhase: proposed.retryPhase, code: proposed.failureCode });
  }
  for (const event of events) {
    try {
      if (sha256Canonical(transitionScanState(current, event)) === sha256Canonical(proposed)) return;
    } catch {
      // Try the remaining legal events.
    }
  }
  throw new Error("Scan state update is not a legal transition");
}

function assertLedger(value: unknown, plan: ScanPlan): asserts value is ScanLedger {
  if (!isRecord(value) || !hasExactKeys(value, [
    "entries", "headHash", "scanId", "scanPlanHash", "schema", "skeletonVersion",
  ])) throw new Error("Scan ledger shape is invalid");
  if (value.schema !== "openlifewiki.scan-ledger/v1"
    || value.scanId !== plan.scanId
    || value.scanPlanHash !== plan.scanPlanHash
    || value.skeletonVersion !== plan.skeletonVersion
    || !Array.isArray(value.entries)) throw new Error("Scan ledger plan binding is invalid");
  let previous: string | null = null;
  const layers = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      "agentDecisionReceiptHashes", "agentInvocationReceiptHash", "agentResultHash", "batchHash",
      "committedAt", "entryHash", "intentId", "parentNodeId", "previousEntryHash", "scanId",
      "scanPlanHash", "schema", "sequence", "skeletonVersion", "sourceId",
      "summaryReceiptHash", "systemOutcomeReceiptHashes",
    ])) throw new Error("Scan ledger entry is invalid");
    const { entryHash, ...unsigned } = entry;
    if (entry.schema !== "openlifewiki.scan-ledger-entry/v1"
      || entry.scanId !== plan.scanId
      || entry.scanPlanHash !== plan.scanPlanHash
      || entry.skeletonVersion !== plan.skeletonVersion
      || entry.sequence !== index + 1
      || entry.previousEntryHash !== previous
      || typeof entryHash !== "string"
      || sha256Canonical(unsigned) !== entryHash) throw new Error("Scan ledger hash chain is invalid");
    const batch = {
      summaryReceiptHash: entry.summaryReceiptHash,
      agentInvocationReceiptHash: entry.agentInvocationReceiptHash,
      agentResultHash: entry.agentResultHash,
      agentDecisionReceiptHashes: entry.agentDecisionReceiptHashes,
      systemOutcomeReceiptHashes: entry.systemOutcomeReceiptHashes,
    };
    if (typeof entry.sourceId !== "string"
      || !plan.sourceIds.includes(entry.sourceId)
      || typeof entry.parentNodeId !== "string"
      || typeof entry.intentId !== "string"
      || typeof entry.summaryReceiptHash !== "string"
      || !SHA256.test(entry.summaryReceiptHash)
      || typeof entry.agentInvocationReceiptHash !== "string"
      || !SHA256.test(entry.agentInvocationReceiptHash)
      || typeof entry.agentResultHash !== "string"
      || !SHA256.test(entry.agentResultHash)
      || !Array.isArray(entry.agentDecisionReceiptHashes)
      || !Array.isArray(entry.systemOutcomeReceiptHashes)
      || [...entry.agentDecisionReceiptHashes, ...entry.systemOutcomeReceiptHashes]
        .some((hash) => typeof hash !== "string" || !SHA256.test(hash))
      || typeof entry.batchHash !== "string"
      || sha256Canonical(batch) !== entry.batchHash
      || typeof entry.committedAt !== "string"
      || !Number.isFinite(Date.parse(entry.committedAt))) {
      throw new Error("Scan ledger batch is invalid");
    }
    const layerKey = `${entry.sourceId}\0${entry.parentNodeId}`;
    if (layers.has(layerKey)) throw new Error("Scan ledger layer is duplicated");
    layers.add(layerKey);
    previous = entryHash;
  });
  if (value.headHash !== previous) throw new Error("Scan ledger headHash is invalid");
}

function assertLedgerAppendOnly(current: ScanLedger, proposed: ScanLedger): void {
  if (proposed.entries.length < current.entries.length) throw new Error("Scan ledger cannot remove entries");
  current.entries.forEach((entry, index) => {
    if (sha256Canonical(proposed.entries[index]) !== sha256Canonical(entry)) {
      throw new Error("Scan ledger cannot rewrite committed entries");
    }
  });
}

function assertReceipts(value: unknown, plan: ScanPlan, ledger: ScanLedger): readonly ScanStoreReceipt[] {
  if (!Array.isArray(value)) throw new Error("Scan receipts must be an array");
  const hashes = new Set<string>();
  const receipts = value.map((receipt) => {
    if (!isRecord(receipt)
      || typeof receipt.schema !== "string"
      || !hasExactKeys(receipt, B2_RECEIPT_KEYS.get(receipt.schema) ?? [])) {
      throw new Error("Scan receipt does not match an exact B2 schema");
    }
    assertReceiptSchemaShape(receipt);
    const { receiptHash, ...unsigned } = receipt;
    if (typeof receiptHash !== "string"
      || !SHA256.test(receiptHash)
      || sha256Canonical(unsigned) !== receiptHash) throw new Error("Scan receipt self-hash is invalid");
    const hash = receiptHash;
    if (hashes.has(hash)) throw new Error("Scan receipt is duplicated");
    hashes.add(hash);
    if (receipt.scanId !== plan.scanId
      || receipt.scanPlanHash !== plan.scanPlanHash
      || receipt.skeletonVersion !== plan.skeletonVersion) {
      throw new Error("Scan receipt does not bind the active plan and skeleton");
    }
    if (typeof receipt.sourceId === "string" && !plan.sourceIds.includes(receipt.sourceId)) {
      throw new Error("Scan receipt Source is outside the active plan");
    }
    return receipt;
  });
  assertReceiptRelationships(receipts, plan, ledger);
  return receipts;
}

function assertReceiptSchemaShape(receipt: Record<string, unknown>): void {
  const timestamp = (field: string): boolean => typeof receipt[field] === "string" && Number.isFinite(Date.parse(receipt[field]));
  const hash = (field: string): boolean => typeof receipt[field] === "string" && SHA256.test(receipt[field]);
  const text = (field: string): boolean => typeof receipt[field] === "string" && receipt[field].length > 0;
  const identifier = (field: string): boolean => typeof receipt[field] === "string" && SCAN_ID.test(receipt[field]);
  const boundedText = (field: string): boolean => typeof receipt[field] === "string"
    && receipt[field].length > 0 && receipt[field].length <= 8_192;
  switch (receipt.schema) {
    case "openlifewiki.enumeration-intent/v1":
      if (!text("intentId") || !text("targetNodeId") || !text("targetNodeVersion") || !hash("authorizationHash")
        || !hash("inputSetHash") || !timestamp("createdAt")) throw new Error("Enumeration Intent shape is invalid");
      break;
    case "openlifewiki.layer-summary-receipt/v1":
      if (!text("intentId") || !hash("summaryHash") || !hash("childSetHash") || !hash("inputSetHash")
        || !timestamp("persistedAt")) throw new Error("Layer Summary receipt shape is invalid");
      break;
    case "openlifewiki.agent-scan-invocation-receipt/v1": {
      const agent = receipt.agent;
      if (!isRecord(agent) || !hasExactKeys(agent, ["driverContractVersion", "id", "mode", "runtime"])
        || Object.values(agent).some((value) => typeof value !== "string" || value.length === 0)
        || !["native-cli", "provider-runtime"].includes(String(agent.mode))
        || !text("sourceId") || !hash("layerHash") || !hash("inputSetHash") || !hash("skillHash")
        || !hash("outputSchemaHash") || !hash("resultHash") || !text("operationId") || !text("runtimeVersion")
        || receipt.outputSchemaId !== "openlifewiki.agent-scan-result/v1" || !timestamp("invokedAt")) {
        throw new Error("Agent invocation receipt shape is invalid");
      }
      break;
    }
    case "openlifewiki.scan-decision/v1": {
      const cost = receipt.estimatedCost;
      const decision = receipt.decision;
      const validOutcomeFields = (decision === "skip" || decision === "descend")
        ? receipt.question === null && receipt.revisitCondition === null
        : decision === "defer"
          ? receipt.question === null && boundedText("revisitCondition")
          : decision === "ask-user"
            ? boundedText("question") && receipt.revisitCondition === null
            : false;
      if (!isRecord(cost) || !hasExactKeys(cost, ["agentCalls", "bodyBytes", "nodes"])
        || Object.values(cost).some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
        || !hash("authorizationHash") || !hash("childSetHash") || !hash("summaryHash") || !hash("inputSetHash")
        || !identifier("sourceId") || !identifier("parentNodeId") || !boundedText("parentNodeVersion")
        || !identifier("nodeId") || !boundedText("nodeVersion") || !boundedText("reason") || !identifier("actor")
        || !["descend", "skip", "defer", "ask-user"].includes(String(decision))
        || !["container", "leaf"].includes(String(receipt.targetKind)) || !validOutcomeFields
        || !timestamp("persistedAt")) throw new Error("Scan decision receipt shape is invalid");
      break;
    }
    case "openlifewiki.scan-system-outcome/v1":
      if (!text("nodeId") || !text("code") || !["blocked", "failed", "unknown"].includes(String(receipt.outcome))
        || !["discovery", "summarization", "selectedScan", "committedIndex"].includes(String(receipt.phase))
        || !timestamp("persistedAt")) throw new Error("System outcome receipt shape is invalid");
      break;
    case "openlifewiki.body-budget-reservation/v1": {
      const { receiptHash: _receiptHash, ...draft } = receipt;
      createBodyBudgetReservationReceipt(draft as Parameters<typeof createBodyBudgetReservationReceipt>[0]);
      break;
    }
    case "openlifewiki.leaf-selection/v1":
      if (!hash("authorizationHash") || !hash("inputSetHash") || !hash("decisionReceiptHash")
        || !text("sourceId") || !text("nodeId") || !text("nodeVersion") || !text("actor") || !text("reason")
        || !timestamp("persistedAt")) throw new Error("Leaf selection receipt shape is invalid");
      break;
    case "openlifewiki.body-observation-receipt/v1":
      if (!hash("authorizationHash") || !hash("inputSetHash") || !hash("selectionReceiptHash") || !hash("contentHash")
        || !Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 0 || !timestamp("observedAt")) {
        throw new Error("Body observation receipt shape is invalid");
      }
      break;
    case "openlifewiki.body-read-commit/v1":
      if (!text("sourceId") || !text("nodeId") || !text("nodeVersion")
        || !hash("reservationReceiptHash") || !hash("observationReceiptHash")
        || !Number.isSafeInteger(receipt.scanTransitionSequence)
        || Number(receipt.scanTransitionSequence) < 0 || !timestamp("committedAt")) {
        throw new Error("Body read commit receipt shape is invalid");
      }
      break;
    case "openlifewiki.body-read-epoch-boundary/v1":
      if (!(["pause", "resume", "cancel", "fail", "retry"] as const).includes(
        receipt.event as ScanControlEvent["type"],
      ) || !Number.isSafeInteger(receipt.fromTransitionSequence)
        || !Number.isSafeInteger(receipt.toTransitionSequence)
        || Number(receipt.fromTransitionSequence) < 0
        || receipt.toTransitionSequence !== Number(receipt.fromTransitionSequence) + 1
        || !timestamp("persistedAt")) {
        throw new Error("Body read epoch boundary receipt shape is invalid");
      }
      break;
    default:
      throw new Error("Scan receipt schema is outside B2");
  }
}

function assertReceiptRelationships(receipts: readonly ScanStoreReceipt[], plan: ScanPlan, ledger: ScanLedger): void {
  const durableDecisionHashes = new Set(ledger.entries.flatMap(({ agentDecisionReceiptHashes }) => agentDecisionReceiptHashes));
  const durableSummaryHashes = new Set(ledger.entries.map(({ summaryReceiptHash }) => summaryReceiptHash));
  const durableInvocationHashes = new Set(ledger.entries.map(({ agentInvocationReceiptHash }) => agentInvocationReceiptHash));
  const durableSystemHashes = new Set(ledger.entries.flatMap(({ systemOutcomeReceiptHashes }) => systemOutcomeReceiptHashes));
  for (const receipt of receipts) {
    const schema = schemaOf(receipt);
    const hash = artifactHash(receipt);
    if ((schema === "openlifewiki.layer-summary-receipt/v1" && !durableSummaryHashes.has(String(hash)))
      || (schema === "openlifewiki.agent-scan-invocation-receipt/v1" && !durableInvocationHashes.has(String(hash)))
      || (schema === "openlifewiki.scan-decision/v1" && !durableDecisionHashes.has(String(hash)))
      || (schema === "openlifewiki.scan-system-outcome/v1" && !durableSystemHashes.has(String(hash)))) {
      throw new Error("Layer receipt is not committed by the Core ledger");
    }
  }
  const decisions = (receiptsBySchema(receipts, "openlifewiki.scan-decision/v1") as ScanDecision[])
    .filter(({ receiptHash }) => durableDecisionHashes.has(receiptHash));
  const intents = receiptsBySchema(receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[];
  for (const intent of intents) {
    assertEnumerationIntent(intent, { plan, trustedDecisionReceipts: decisions });
  }
  assertEnumerationIntentUniqueness(intents);
  for (const selectionValue of receiptsBySchema(receipts, "openlifewiki.leaf-selection/v1")) {
    const selection = selectionValue as LeafSelectionReceipt;
    const decision = decisions.find(({ receiptHash }) => receiptHash === selection.decisionReceiptHash);
    if (decision === undefined || decision.decision !== "descend" || decision.targetKind !== "leaf"
      || decision.sourceId !== selection.sourceId || decision.nodeId !== selection.nodeId
      || decision.nodeVersion !== selection.nodeVersion || decision.authorizationHash !== selection.authorizationHash
      || decision.inputSetHash !== selection.inputSetHash) throw new Error("Leaf selection lacks its exact durable descend decision");
  }
  const selections = receiptsBySchema(receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[];
  const observations = receiptsBySchema(receipts, "openlifewiki.body-observation-receipt/v1") as BodyObservationReceipt[];
  const reservations = receiptsBySchema(receipts, "openlifewiki.body-budget-reservation/v1") as BodyBudgetReservationReceipt[];
  for (const reservation of reservations) {
    if (!selections.some((selection) => selection.sourceId === reservation.sourceId
      && selection.nodeId === reservation.nodeId && selection.nodeVersion === reservation.nodeVersion
      && selection.authorizationHash === reservation.authorizationHash)) {
      throw new Error("Body budget reservation lacks its exact durable selected leaf");
    }
  }
  replayBodyBudgetReservations(receipts);
  const observedNodeVersions = new Set<string>();
  for (const observation of observations) {
    const selection = selections.find(({ receiptHash }) => receiptHash === observation.selectionReceiptHash);
    const previous = observation.previousObservationReceiptHash === null ? null
      : observations.find(({ receiptHash }) => receiptHash === observation.previousObservationReceiptHash) ?? null;
    const nodeVersionKey = `${observation.sourceId}\0${observation.nodeId}\0${observation.nodeVersion}`;
    if (selection === undefined || observedNodeVersions.has(nodeVersionKey)
      || observation.purpose !== "initial-read") {
      throw new Error("B2 Body observation lacks its exact durable selection or uses an unavailable rematerialization path");
    }
    observedNodeVersions.add(nodeVersionKey);
    assertBodyObservationReceipt(observation, {
      plan,
      trustedSelectionReceiptHashes: selections.map(({ receiptHash }) => receiptHash),
      selectionReceipt: selection,
      previousObservationReceipt: previous,
    });
  }
}

function durableLeafSelection(
  snapshot: ScanStoreSnapshot,
  sourceId: string,
  nodeId: string,
  nodeVersion: string,
  authorizationHash: string,
): LeafSelectionReceipt | undefined {
  return (receiptsBySchema(snapshot.receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[])
    .find((selection) => selection.sourceId === sourceId && selection.nodeId === nodeId
      && selection.nodeVersion === nodeVersion && selection.authorizationHash === authorizationHash);
}

function activeBodyBudgetReservations(receipts: readonly ScanStoreReceipt[]): BodyBudgetReservationReceipt[] {
  return [...replayBodyBudgetReservations(receipts).values()];
}

function currentActiveBodyBudgetReservations(snapshot: ScanStoreSnapshot): BodyBudgetReservationReceipt[] {
  if (snapshot.state.phase !== "ReadingLeaves") return [];
  return activeBodyBudgetReservations(snapshot.receipts)
    .filter(({ scanTransitionSequence }) => scanTransitionSequence === snapshot.state.transitionSequence);
}

function replayBodyBudgetReservations(
  receipts: readonly ScanStoreReceipt[],
): ReadonlyMap<string, BodyBudgetReservationReceipt> {
  const latest = new Map<string, BodyBudgetReservationReceipt>();
  const observedReceiptHashes: string[] = [];
  const counters = {
    initialReadItems: 0,
    initialReadBytes: 0,
    rematerializedItems: 0,
    rematerializedBytes: 0,
  };
  let epochFloor = 0;
  for (const [index, receipt] of receipts.entries()) {
    if (schemaOf(receipt) === "openlifewiki.body-budget-reservation/v1") {
      const reservation = receipt as BodyBudgetReservationReceipt;
      if (reservation.scanTransitionSequence < epochFloor) {
        throw new Error("Body budget reservation predates a durable scan epoch boundary");
      }
      const key = bodyWorkKey(reservation.sourceId, reservation.nodeId, reservation.nodeVersion);
      const previous = latest.get(key);
      if (previous?.scanTransitionSequence === reservation.scanTransitionSequence) {
        throw new Error("A JIT body budget reservation cannot be replaced in the same scan epoch");
      }
      const currentEpoch = [...latest.values()].filter(
        ({ scanTransitionSequence }) => scanTransitionSequence === reservation.scanTransitionSequence,
      );
      if (currentEpoch.length > 0) {
        throw new Error("Only one JIT body budget reservation may be active per scan epoch");
      }
      latest.set(key, reservation);
    } else if (schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1") {
      const observation = receipt as BodyObservationReceipt;
      const key = bodyWorkKey(observation.sourceId, observation.nodeId, observation.nodeVersion);
      const reservation = latest.get(key);
      const commitValue = receipts[index + 1];
      const commit = schemaOf(commitValue ?? {}) === "openlifewiki.body-read-commit/v1"
        ? commitValue as BodyReadCommitReceipt
        : undefined;
      if (reservation === undefined
        || commit === undefined
        || reservation.sourceId !== observation.sourceId
        || reservation.nodeId !== observation.nodeId
        || reservation.nodeVersion !== observation.nodeVersion
        || reservation.authorizationHash !== observation.authorizationHash
        || reservation.physicalIoAccountingHash !== sha256Canonical({
          schema: "openlifewiki.scan-physical-io/v1",
          observedReceiptHashes,
          counters,
        })
        || observation.bytes > reservation.reservedBytes) {
        throw new Error("Body observation does not consume the latest active JIT reservation");
      }
      assertBodyReadCommit(commit, observation, reservation);
      latest.delete(key);
      observedReceiptHashes.push(observation.receiptHash);
      if (observation.purpose === "initial-read") {
        counters.initialReadItems += 1;
        counters.initialReadBytes += observation.bytes;
      } else {
        counters.rematerializedItems += 1;
        counters.rematerializedBytes += observation.bytes;
      }
    } else if (schemaOf(receipt) === "openlifewiki.body-read-commit/v1") {
      if (schemaOf(receipts[index - 1] ?? {}) !== "openlifewiki.body-observation-receipt/v1") {
        throw new Error("Body read commit must immediately follow its observation");
      }
    } else if (schemaOf(receipt) === "openlifewiki.body-read-epoch-boundary/v1") {
      const boundary = receipt as BodyReadEpochBoundaryReceipt;
      if (boundary.fromTransitionSequence < epochFloor) {
        throw new Error("Body read epoch boundaries cannot move backwards");
      }
      epochFloor = boundary.toTransitionSequence;
      latest.clear();
    }
  }
  return latest;
}

function bodyWorkKey(sourceId: string, nodeId: string, nodeVersion: string): string {
  return `${sourceId}\0${nodeId}\0${nodeVersion}`;
}

function assertEnumerationIntentUniqueness(intents: readonly EnumerationIntent[]): void {
  const intentIds = new Set<string>();
  const rootSources = new Set<string>();
  const targetVersions = new Set<string>();
  const decisionReceiptHashes = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.intentId)) throw new Error("Enumeration Intent ID is duplicated");
    intentIds.add(intent.intentId);
    if (intent.origin === "authorized-root") {
      if (rootSources.has(intent.sourceId)) {
        throw new Error("Each Source can have only one authorized-root Enumeration Intent");
      }
      rootSources.add(intent.sourceId);
    }
    const targetVersion = `${intent.sourceId}\0${intent.targetNodeId}\0${intent.targetNodeVersion}`;
    if (targetVersions.has(targetVersion)) {
      throw new Error("Enumeration Intent target and version must be unique per Source");
    }
    targetVersions.add(targetVersion);
    if (intent.decisionReceiptHash !== null) {
      if (decisionReceiptHashes.has(intent.decisionReceiptHash)) {
        throw new Error("Each descend decision can create only one Enumeration Intent");
      }
      decisionReceiptHashes.add(intent.decisionReceiptHash);
    }
  }
}

function assertReceiptAppendOnly(
  current: readonly ScanStoreReceipt[],
  proposed: readonly ScanStoreReceipt[],
): void {
  if (proposed.length < current.length) throw new Error("Durable scan receipts cannot be removed");
  current.forEach((receipt, index) => {
    if (sha256Canonical(proposed[index]) !== sha256Canonical(receipt)) {
      throw new Error("Durable scan receipts cannot be rewritten or reordered");
    }
  });
}

function assertPhysicalIo(value: unknown, receipts: readonly ScanStoreReceipt[]): void {
  if (!isRecord(value) || !hasExactKeys(value, ["counters", "observedReceiptHashes", "schema"])
    || value.schema !== "openlifewiki.scan-physical-io/v1"
    || !Array.isArray(value.observedReceiptHashes)
    || !isRecord(value.counters)
    || !hasExactKeys(value.counters, [
      "initialReadBytes", "initialReadItems", "rematerializedBytes", "rematerializedItems",
    ])) throw new Error("Physical I/O accounting shape is invalid");
  const observations = new Map<string, BodyObservationReceipt>();
  const observationOrder: string[] = [];
  for (const receipt of receipts) {
    const record = receipt as Record<string, unknown>;
    if (record.schema === "openlifewiki.body-observation-receipt/v1") {
      const hash = String(record.receiptHash);
      observations.set(hash, record as unknown as BodyObservationReceipt);
      observationOrder.push(hash);
    }
  }
  if (sha256Canonical(value.observedReceiptHashes) !== sha256Canonical(observationOrder)) {
    throw new Error("Physical I/O accounting must cover the exact durable body observation set in order");
  }
  const seen = new Set<string>();
  const expected = {
    initialReadItems: 0,
    initialReadBytes: 0,
    rematerializedItems: 0,
    rematerializedBytes: 0,
  };
  for (const hash of value.observedReceiptHashes) {
    if (typeof hash !== "string" || seen.has(hash)) throw new Error("Physical I/O receipt is invalid or duplicated");
    seen.add(hash);
    const observation = observations.get(hash);
    if (observation === undefined || !Number.isSafeInteger(observation.bytes) || observation.bytes < 0) {
      throw new Error("Physical I/O accounting references no valid observation");
    }
    if (observation.purpose === "initial-read") {
      expected.initialReadItems += 1;
      expected.initialReadBytes += observation.bytes;
    } else if (observation.purpose === "qmd-rematerialization") {
      expected.rematerializedItems += 1;
      expected.rematerializedBytes += observation.bytes;
    } else throw new Error("Body observation purpose is invalid");
  }
  if (sha256Canonical(value.counters) !== sha256Canonical(expected)) {
    throw new Error("Physical I/O counters are not derived from observed receipts");
  }
}

function assertPhysicalIoAppendOnly(
  current: PhysicalIoAccounting,
  proposed: PhysicalIoAccounting,
): void {
  if (proposed.observedReceiptHashes.length < current.observedReceiptHashes.length) {
    throw new Error("Physical I/O observations cannot be removed");
  }
  current.observedReceiptHashes.forEach((hash, index) => {
    if (proposed.observedReceiptHashes[index] !== hash) {
      throw new Error("Physical I/O observations cannot be rewritten or reordered");
    }
  });
  for (const key of [
    "initialReadItems", "initialReadBytes", "rematerializedItems", "rematerializedBytes",
  ] as const) {
    if (proposed.counters[key] < current.counters[key]) {
      throw new Error("Physical I/O counters cannot decrease");
    }
  }
}

function assertLedgerReferences(ledger: ScanLedger, receipts: readonly ScanStoreReceipt[]): void {
  const hashes = new Set(receiptHashes(receipts));
  for (const entry of ledger.entries) {
    const referenced = [
      entry.summaryReceiptHash,
      entry.agentInvocationReceiptHash,
      ...entry.agentDecisionReceiptHashes,
      ...entry.systemOutcomeReceiptHashes,
    ];
    if (referenced.some((hash) => !hashes.has(hash))) {
      throw new Error("Scan ledger references a receipt outside the durable receipt set");
    }
  }
}

async function persist(path: string, snapshot: ScanStoreSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeJsonAtomic(path, snapshot);
}

async function withScanLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let token: string | undefined;
  let inode: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(candidate, { mode: 0o700 });
      try {
        const details = await stat(candidate);
        token = randomUUID();
        inode = details.ino;
        await writeJsonAtomic(join(candidate, "owner.json"), {
          pid: process.pid,
          token,
          inode,
          createdAt: new Date().toISOString(),
        });
        if (await directoryEntryExists(lockPath)) {
          throw Object.assign(new Error("Scan lock already exists"), { code: "EEXIST" });
        }
        await rename(candidate, lockPath);
      } catch (error) {
        await rm(candidate, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      token = undefined;
      inode = undefined;
      await rm(candidate, { recursive: true, force: true });
      const observed = await readLockIdentity(lockPath);
      if (observed !== undefined && !processIsAlive(observed.pid) && await takeOverStaleLock(lockPath, observed)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (token === undefined || inode === undefined) throw conflict("Scan state is locked by another writer");
  try {
    return await operation();
  } finally {
    try {
      const current = await stat(lockPath);
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
      if (current.ino === inode && owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch {
      // A replaced or already-released lock is not ours to remove.
    }
  }
}

interface ScanLockIdentity {
  readonly pid: number;
  readonly token: string;
  readonly inode: number;
}

async function readLockIdentity(lockPath: string): Promise<ScanLockIdentity | undefined> {
  try {
    const details = await stat(lockPath);
    try {
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        pid?: unknown;
        token?: unknown;
        inode?: unknown;
      };
      if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== "string" || owner.token.length === 0 || owner.inode !== details.ino) {
        return undefined;
      }
      return {
        pid: owner.pid,
        token: owner.token,
        inode: details.ino,
      };
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      return undefined;
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function takeOverStaleLock(
  lockPath: string,
  observed: ScanLockIdentity,
): Promise<boolean> {
  const current = await readLockIdentity(lockPath);
  if (!sameLock(current, observed)) return false;
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const moved = await readLockIdentity(quarantine);
  if (!sameLock(moved, observed)) {
    try {
      await rename(quarantine, lockPath);
    } catch {
      // A different writer already owns the lock path.
    }
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

function sameLock(
  left: ScanLockIdentity | undefined,
  right: ScanLockIdentity,
): boolean {
  return left !== undefined && left.inode === right.inode && left.token === right.token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertScanId(scanId: string): void {
  if (!SCAN_ID.test(scanId)) throw invalid("scanId is invalid");
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function directoryEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function conflict(message: string): AdapterError {
  return new AdapterError("SCAN_CONFLICT", message);
}

function invalid(message: string, cause?: unknown): AdapterError {
  return new AdapterError("SCAN_INVALID", message, cause === undefined ? undefined : { cause });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
