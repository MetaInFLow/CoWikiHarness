import type {
  AgentFailure,
  AgentScanInputContext,
  AgentScanResult,
} from "@openlifewiki/protocol";

export interface AgentScanRequest {
  readonly operationId: string;
  readonly scanInput: AgentScanInputContext;
}

export type AgentScanDecision = AgentScanResult | AgentFailure;

/** A selected Agent can decide one fully-enumerated scan layer. */
export interface AgentDriver {
  decideScan(request: AgentScanRequest): Promise<AgentScanDecision>;
}
