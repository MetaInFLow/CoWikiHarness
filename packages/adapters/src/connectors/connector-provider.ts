import type { AuthorizedSourceV1, ConnectorStatus, ConnectorType } from "@openlifewiki/protocol";

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
