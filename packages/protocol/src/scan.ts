export interface ScanPlan {
  readonly schema: "openlifewiki.scan-plan/v1";
  readonly scanId: string;
  readonly sourceIds: readonly string[];
  readonly authorizationHashes: readonly string[];
  readonly skeletonVersion: string;
  readonly agentProfileId: string;
  readonly skillHash: string;
  readonly priorityDocumentRefs: readonly string[];
  readonly policy: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly sensitivity: "normal" | "sensitive";
    readonly budget: Readonly<Record<string, number>>;
  };
  readonly scanPlanHash: string;
}

export type ScanDecisionValue = "descend" | "skip" | "defer" | "ask-user";

export interface ScanDecision {
  readonly schema: "openlifewiki.scan-decision/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly summaryHash: string;
  readonly inputSetHash: string;
  readonly decision: ScanDecisionValue;
  readonly reason: string;
  readonly actor: string;
  readonly coverage: {
    readonly directChildrenEnumerated: number;
    readonly pageComplete: boolean;
  };
  readonly estimatedCost: {
    readonly bodyBytes: number;
    readonly agentCalls: number;
  };
  readonly persistedAt: string;
  readonly receiptHash: string;
}

export interface ScanCheckpoint {
  readonly schema: "openlifewiki.scan-checkpoint/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly phase: "discovered" | "summarized" | "decided" | "body-processed" | "qmd-committed";
  readonly inputSetHash: string;
  readonly qmdGenerationId?: string;
  readonly receiptHash: string;
}

export interface ScanProgress {
  readonly schema: "openlifewiki.scan-progress/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly discovery: {
    readonly completed: number;
    readonly known: number;
    readonly unknownParents: number;
    readonly openPages: number;
  };
  readonly summarization: {
    readonly completed: number;
    readonly selected: number;
  };
  readonly selectedScan: {
    readonly completed: number;
    readonly selected: number;
  };
  readonly committedIndex: {
    readonly completed: number;
    readonly processed: number;
    readonly generation: string | null;
    readonly generationPublished?: boolean;
    readonly previousGenerationDeleted?: boolean;
  };
  readonly outcomes: {
    readonly skipped: number;
    readonly deferred: number;
    readonly blocked: number;
    readonly failed: number;
    readonly unknown: number;
    readonly askUser?: number;
  };
  readonly current: {
    readonly path: readonly string[];
    readonly summaryHash: string | null;
    readonly decision: ScanDecisionValue | null;
    readonly reason: string | null;
  } | null;
  readonly denominatorChanges: readonly {
    readonly sequence: number;
    readonly at: string;
    readonly dimension: "discovery" | "summarization" | "selectedScan" | "committedIndex";
    readonly from: number;
    readonly to: number;
    readonly reason: string;
  }[];
}
