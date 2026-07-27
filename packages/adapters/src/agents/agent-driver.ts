import type {
  AgentFailure,
  AgentScanInputContext,
  AgentScanResult,
  MetadataSample,
  SkeletonNode,
} from "@openlifewiki/protocol";

export interface AgentScanRequest {
  readonly operationId: string;
  readonly scanInput: AgentScanInputContext;
  readonly layerSummary: AgentLayerSummary;
}

type AgentScanTarget = AgentScanInputContext["decisionTargets"][number];
type AgentScanCoverage = AgentScanInputContext["layer"]["coverage"];

export interface AgentLayerSummaryNode {
  readonly target: AgentScanTarget;
  readonly metadataHash: string;
  readonly skeleton: SkeletonNode;
}

/** Bounded public metadata for exactly one completed layer; Source bodies are prohibited. */
export interface AgentLayerSummary {
  readonly schema: "openlifewiki.layer-summary/v1";
  readonly overview: {
    readonly title: string;
    readonly description: string;
    readonly providerDescription: string | null;
  };
  readonly parent: SkeletonNode;
  readonly children: readonly AgentLayerSummaryNode[];
  readonly metadataSamples: readonly MetadataSample[];
  readonly coverage: AgentScanCoverage;
  readonly policy: {
    readonly scanIntent: string;
    readonly resolvedPolicy: AgentScanInputContext["resolvedPolicy"];
  };
}

export type AgentScanDecision = AgentScanResult | AgentFailure;

export interface AgentInvocationEvidence {
  readonly schema: "openlifewiki.agent-invocation/v1";
  readonly binary: {
    readonly command: string;
    readonly version: string | null;
  };
  readonly agent: {
    readonly id: string;
    readonly runtime: "codex" | "claude" | "gemini" | "pi" | "openclaw" | "hermes";
    readonly mode: "native-cli" | "provider-runtime";
    readonly driverContractVersion: string;
  };
  readonly inputSetHash: string;
  readonly skillHash: string;
  readonly outputSchema: {
    readonly id: "openlifewiki.agent-scan-result/v1";
    readonly hash: string;
  };
}

export interface AgentScanInvocation {
  readonly decision: AgentScanDecision;
  readonly invocation: AgentInvocationEvidence;
}

/** A selected Agent can decide one fully-enumerated scan layer. */
export interface AgentDriver {
  decideScan(request: AgentScanRequest): Promise<AgentScanInvocation>;
}
