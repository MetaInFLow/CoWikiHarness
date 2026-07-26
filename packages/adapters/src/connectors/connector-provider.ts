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
  readonly bodyReadGate: BodyReadGateInput;
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
