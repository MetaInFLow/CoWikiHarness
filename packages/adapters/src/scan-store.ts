import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertScanPlan,
  sha256Canonical,
  type BodyObservationReceipt,
  type ScanPlan,
} from "@openlifewiki/protocol";
import {
  createPhysicalIoAccounting,
  createScanLedger,
  createScanState,
  transitionScanState,
  type PhysicalIoAccounting,
  type ScanLedger,
  type ScanState,
  type ScanStateEvent,
} from "@openlifewiki/core";

import { AdapterError } from "./errors.js";
import { writeJsonAtomic } from "./state-store.js";

const SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
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

export type ScanStoreUpdate = ScanStoreSnapshot;

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

export async function updateScanStore(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly update: (snapshot: ScanStoreSnapshot) => ScanStoreUpdate;
}): Promise<ScanStoreSnapshot> {
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
      proposed = options.update(freeze(structuredClone(current)));
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
  const receipts = assertReceipts(value.receipts, plan);
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
  const receipts = assertReceipts(proposed.receipts, proposed.plan);
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

function assertReceipts(value: unknown, plan: ScanPlan): readonly ScanStoreReceipt[] {
  if (!Array.isArray(value)) throw new Error("Scan receipts must be an array");
  const hashes = new Set<string>();
  return value.map((receipt) => {
    if (!isRecord(receipt)
      || typeof receipt.schema !== "string"
      || !/^openlifewiki\.[a-z0-9-]+\/v1$/u.test(receipt.schema)
      || receipt.schema === "openlifewiki.layer-summary/v1"
      || typeof receipt.receiptHash !== "string") throw new Error("Scan receipt shape is invalid");
    assertNoPrivatePayloadFields(receipt);
    const { receiptHash, ...unsigned } = receipt;
    if (!SHA256.test(receiptHash) || sha256Canonical(unsigned) !== receiptHash) {
      throw new Error("Scan receipt self-hash is invalid");
    }
    if (hashes.has(receiptHash)) throw new Error("Scan receipt is duplicated");
    hashes.add(receiptHash);
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
  const hashes = new Set(receipts.map((receipt) => String((receipt as Record<string, unknown>).receiptHash)));
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

function assertNoPrivatePayloadFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoPrivatePayloadFields(child);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^a-zA-Z0-9]/gu, "").toLowerCase();
    const hashOrCounter = /(hash|hashes|bytes)$/u.test(normalized);
    if (!hashOrCounter && /^(body|bodytext|bodycontent|content|excerpt|raw|rawtext|prompt|token|credential|apikey|secret|password|layersummary)$/u.test(normalized)) {
      throw new Error(`Private payload field ${key} cannot be persisted`);
    }
    assertNoPrivatePayloadFields(child);
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
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const details = await stat(lockPath);
        token = randomUUID();
        inode = details.ino;
        await writeJsonAtomic(join(lockPath, "owner.json"), {
          pid: process.pid,
          token,
          inode,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const observed = await readLockIdentity(lockPath);
      if (observed !== undefined && isStaleLock(observed) && await takeOverStaleLock(lockPath, observed)) {
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
  readonly pid: number | null;
  readonly token: string | null;
  readonly inode: number;
  readonly mtimeMs: number;
}

async function readLockIdentity(lockPath: string): Promise<ScanLockIdentity | undefined> {
  try {
    const details = await stat(lockPath);
    try {
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        pid?: unknown;
        token?: unknown;
      };
      return {
        pid: typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
          ? owner.pid
          : null,
        token: typeof owner.token === "string" ? owner.token : null,
        inode: details.ino,
        mtimeMs: details.mtimeMs,
      };
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      return { pid: null, token: null, inode: details.ino, mtimeMs: details.mtimeMs };
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isStaleLock(identity: ScanLockIdentity): boolean {
  return identity.pid === null
    ? Date.now() - identity.mtimeMs > 4_000
    : !processIsAlive(identity.pid);
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
  } catch {
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
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
