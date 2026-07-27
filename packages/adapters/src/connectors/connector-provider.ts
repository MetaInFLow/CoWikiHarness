import {
  sha256Canonical,
  type AuthorizedSourceV1,
  type ConnectorStatus,
  type ConnectorType,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type ScanDecision,
  type ScanPlan,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import type { BodyReadGateInput } from "@openlifewiki/core";

import type { CommandRunner } from "../command-runner.js";

export type ProbeSource = Pick<
  AuthorizedSourceV1,
  "sourceId" | "connectorType" | "rootNodeId" | "scope" | "providerObservation"
>;

export interface ConnectorProbeOptions {
  readonly source: ProbeSource;
  readonly runner: CommandRunner;
  readonly now: () => Date;
  readonly scratchRoot: string;
}

export interface ConnectorProvider {
  readonly connectorType: ConnectorType;
  probe(options: ConnectorProbeOptions): Promise<ConnectorStatus>;
}

export interface ProgressiveConnectorBinding {
  readonly source: AuthorizedSourceV1;
  readonly plan: ScanPlan;
  readonly sourceId: string;
  readonly authorizationHash: string;
  readonly rootNodeId: string;
  readonly scopeHash: string;
}

export interface ProgressiveConnectorProbeOptions extends ProgressiveConnectorBinding {
  readonly now: () => Date;
}

export interface ProgressiveConnectorListOptions extends ProgressiveConnectorBinding {
  readonly limit: number;
  readonly cursor: string | null;
  readonly now: () => Date;
}

export interface ProgressiveConnectorChildrenOptions extends ProgressiveConnectorListOptions {
  readonly parent: SkeletonNode;
  readonly intent: EnumerationIntent;
  readonly trustedDecisionReceipts: readonly ScanDecision[];
  readonly trustedReceiptHashes: readonly string[];
  readonly previousPageReceipt: EnumerationPageReceipt | null;
}

export interface ProgressiveConnectorNodeOptions extends ProgressiveConnectorBinding {
  readonly node: SkeletonNode;
}

export interface ProgressiveConnectorReadOptions extends ProgressiveConnectorNodeOptions {
  readonly expectedVersion: string;
  readonly budgetReservation: BodyBudgetReservationReceipt;
  readonly activeBodyReadLease: ActiveBodyReadLease;
  readonly expectedPhysicalIoAccountingHash: string;
  readonly bodyReadGate: BodyReadGateInput;
}

export interface ActiveBodyReadLease {
  readonly scanId: string;
  readonly reservationReceiptHash: string;
  readonly scanTransitionSequence: number;
}

const liveBodyReadLeases = new WeakSet<ActiveBodyReadLease>();
const activeBodyReadLeaseByScan = new Map<string, ActiveBodyReadLease>();

/** Internal runtime capability. Deliberately omitted from the package entry point. */
export function issueActiveBodyReadLease(input: ActiveBodyReadLease): ActiveBodyReadLease {
  const previous = activeBodyReadLeaseByScan.get(input.scanId);
  if (previous !== undefined) liveBodyReadLeases.delete(previous);
  const lease = Object.freeze({ ...input });
  liveBodyReadLeases.add(lease);
  activeBodyReadLeaseByScan.set(lease.scanId, lease);
  return lease;
}

/** Internal runtime capability. Deliberately omitted from the package entry point. */
export function revokeActiveBodyReadLease(lease: ActiveBodyReadLease): void {
  liveBodyReadLeases.delete(lease);
  if (activeBodyReadLeaseByScan.get(lease.scanId) === lease) {
    activeBodyReadLeaseByScan.delete(lease.scanId);
  }
}

export interface BodyBudgetReservationReceipt {
  readonly schema: "openlifewiki.body-budget-reservation/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly scanTransitionSequence: number;
  readonly physicalIoAccountingHash: string;
  readonly remainingBeforeBytes: number;
  readonly reservedBytes: number;
  readonly reservedAt: string;
  readonly receiptHash: string;
}

export type BodyBudgetReservationDraft = Omit<BodyBudgetReservationReceipt, "receiptHash">;

export function createBodyBudgetReservationReceipt(
  draft: BodyBudgetReservationDraft,
): BodyBudgetReservationReceipt {
  if (draft.schema !== "openlifewiki.body-budget-reservation/v1"
    || !Number.isSafeInteger(draft.remainingBeforeBytes)
    || draft.remainingBeforeBytes < 0
    || !Number.isSafeInteger(draft.reservedBytes)
    || draft.reservedBytes < 0
    || draft.reservedBytes > draft.remainingBeforeBytes
    || !Number.isSafeInteger(draft.scanTransitionSequence)
    || draft.scanTransitionSequence < 0
    || !Number.isFinite(Date.parse(draft.reservedAt))) {
    throw new Error("Body budget reservation is invalid");
  }
  for (const hash of [
    draft.scanPlanHash,
    draft.skeletonVersion,
    draft.authorizationHash,
    draft.physicalIoAccountingHash,
  ]) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error("Body budget reservation hash is invalid");
  }
  for (const id of [draft.scanId, draft.sourceId, draft.nodeId, draft.nodeVersion]) {
    if (id.length === 0) throw new Error("Body budget reservation binding is invalid");
  }
  return { ...draft, receiptHash: sha256Canonical(draft) };
}

export function assertBodyBudgetReservationReceipt(
  receipt: BodyBudgetReservationReceipt,
  context: {
    readonly source: AuthorizedSourceV1;
    readonly plan: ScanPlan;
    readonly node: SkeletonNode;
    readonly activeBodyReadLease: ActiveBodyReadLease;
    readonly expectedPhysicalIoAccountingHash: string;
    readonly trustedReceiptHashes: readonly string[];
  },
): void {
  const { receiptHash, ...draft } = receipt;
  const canonical = createBodyBudgetReservationReceipt(draft);
  const sourceIndex = context.plan.sourceIds.indexOf(context.source.sourceId);
  const planMax = context.plan.policy.budget.maxBodyBytes;
  const lease = context.activeBodyReadLease;
  if (canonical.receiptHash !== receiptHash
    || !context.trustedReceiptHashes.includes(receiptHash)
    || !liveBodyReadLeases.has(lease)
    || activeBodyReadLeaseByScan.get(receipt.scanId) !== lease
    || lease.scanId !== receipt.scanId
    || lease.reservationReceiptHash !== receiptHash
    || lease.scanTransitionSequence !== receipt.scanTransitionSequence
    || sourceIndex < 0
    || receipt.scanId !== context.plan.scanId
    || receipt.scanPlanHash !== context.plan.scanPlanHash
    || receipt.skeletonVersion !== context.plan.skeletonVersion
    || receipt.authorizationHash !== context.source.authorizationHash
    || context.plan.authorizationHashes[sourceIndex] !== receipt.authorizationHash
    || receipt.sourceId !== context.source.sourceId
    || receipt.nodeId !== context.node.nodeId
    || receipt.nodeVersion !== context.node.nodeVersion
    || receipt.physicalIoAccountingHash !== context.expectedPhysicalIoAccountingHash
    || receipt.remainingBeforeBytes > context.source.budget.maxBodyBytes
    || receipt.reservedBytes > context.source.budget.maxBodyBytes
    || (planMax !== undefined && (
      receipt.remainingBeforeBytes > planMax || receipt.reservedBytes > planMax
    ))) {
    throw new Error("Body budget reservation is forged, untrusted or mismatched");
  }
}

export interface ApprovedLeafBody {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly stream: AsyncIterable<Uint8Array>;
}

export interface ProgressiveConnectorProvider {
  readonly connectorType: ConnectorType;
  probe(options: ProgressiveConnectorProbeOptions): Promise<ConnectorStatus>;
  listRootsMetadata(options: ProgressiveConnectorListOptions): Promise<SkeletonPage>;
  listChildrenMetadata(options: ProgressiveConnectorChildrenOptions): Promise<SkeletonPage>;
  getVersion(options: ProgressiveConnectorNodeOptions): Promise<string>;
  readApprovedLeafBody(options: ProgressiveConnectorReadOptions): Promise<ApprovedLeafBody>;
}

export function progressiveConnectorScopeHash(source: AuthorizedSourceV1): string {
  return sha256Canonical({
    sourceId: source.sourceId,
    connectorType: source.connectorType,
    rootNodeId: source.rootNodeId,
    authorizationHash: source.authorizationHash,
    scope: source.scope,
    include: source.include,
    exclude: source.exclude,
  });
}

export function redacted(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 2) return "**";
  return `${normalized[0]}***${normalized.at(-1)}`;
}

export function safeBlocking(code: string, remediation: string): ConnectorStatus["blocking"] {
  return { code, remediation };
}

export function commandFailureKind(error: unknown): "missing" | "timeout" | "failed" {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = "code" in current ? current.code : undefined;
    if (code === "ENOENT") return "missing";
    if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "timeout";
    if (("killed" in current && current.killed === true) || ("signal" in current && current.signal !== null)) return "timeout";
    current = current.cause;
  }
  return "failed";
}

export function parseVersion(value: string): string | undefined {
  return value.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u)?.[1];
}
