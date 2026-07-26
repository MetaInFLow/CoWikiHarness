export type ScanWorkPhase =
  | "Draft"
  | "Probing"
  | "Discovering"
  | "Summarizing"
  | "Deciding"
  | "ReadingLeaves"
  | "BuildingQMD"
  | "VerifyingQMD"
  | "PublishingQMD";

export type ScanPhase = ScanWorkPhase | "Paused" | "Cancelled" | "Failed" | "Complete";

export interface ScanState {
  readonly schema: "openlifewiki.scan-state/v1";
  readonly scanId: string;
  readonly phase: ScanPhase;
  readonly resumePhase: ScanWorkPhase | null;
  readonly retryPhase: ScanWorkPhase | null;
  readonly failureCode: string | null;
  readonly completed: boolean;
  readonly transitionSequence: number;
}

export type ScanStateEvent =
  | { readonly type: "approve-plan" }
  | { readonly type: "probe-connected" }
  | { readonly type: "layer-discovered" }
  | { readonly type: "layer-summarized" }
  | { readonly type: "continue-discovery" }
  | { readonly type: "frontier-discovered" }
  | { readonly type: "leaves-read" }
  | { readonly type: "qmd-built" }
  | { readonly type: "qmd-verified" }
  | { readonly type: "qmd-published" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly retryPhase: ScanWorkPhase; readonly code: string }
  | { readonly type: "retry" };

const FORWARD_TRANSITIONS: Readonly<Record<string, readonly [ScanWorkPhase, ScanPhase]>> = {
  "approve-plan": ["Draft", "Probing"],
  "probe-connected": ["Probing", "Discovering"],
  "layer-discovered": ["Discovering", "Summarizing"],
  "layer-summarized": ["Summarizing", "Deciding"],
  "continue-discovery": ["Deciding", "Discovering"],
  "frontier-discovered": ["Discovering", "ReadingLeaves"],
  "leaves-read": ["ReadingLeaves", "BuildingQMD"],
  "qmd-built": ["BuildingQMD", "VerifyingQMD"],
  "qmd-verified": ["VerifyingQMD", "PublishingQMD"],
  "qmd-published": ["PublishingQMD", "Complete"],
};

const RUNNING_PHASES: ReadonlySet<ScanPhase> = new Set([
  "Probing",
  "Discovering",
  "Summarizing",
  "Deciding",
  "ReadingLeaves",
  "BuildingQMD",
  "VerifyingQMD",
  "PublishingQMD",
]);

function illegal(state: ScanState, event: ScanStateEvent): never {
  throw new Error(`Illegal scan transition: ${state.phase} + ${event.type}`);
}

function nextState(state: ScanState, phase: ScanPhase, overrides: Partial<ScanState> = {}): ScanState {
  return Object.freeze({
    ...state,
    phase,
    completed: phase === "Complete",
    transitionSequence: state.transitionSequence + 1,
    ...overrides,
  });
}

export function createScanState(scanId: string): ScanState {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(scanId)) {
    throw new Error("scanId is invalid");
  }
  return Object.freeze({
    schema: "openlifewiki.scan-state/v1",
    scanId,
    phase: "Draft",
    resumePhase: null,
    retryPhase: null,
    failureCode: null,
    completed: false,
    transitionSequence: 0,
  });
}

export function transitionScanState(state: ScanState, event: ScanStateEvent): ScanState {
  if (event.type === "pause") {
    if (!RUNNING_PHASES.has(state.phase)) return illegal(state, event);
    return nextState(state, "Paused", {
      resumePhase: state.phase as ScanWorkPhase,
      retryPhase: null,
      failureCode: null,
    });
  }
  if (event.type === "resume") {
    if (state.phase !== "Paused" || state.resumePhase === null) return illegal(state, event);
    return nextState(state, state.resumePhase, { resumePhase: null });
  }
  if (event.type === "cancel") {
    if (state.phase === "Complete" || state.phase === "Cancelled") return illegal(state, event);
    return nextState(state, "Cancelled", {
      resumePhase: null,
      retryPhase: null,
      failureCode: null,
    });
  }
  if (event.type === "fail") {
    if (!RUNNING_PHASES.has(state.phase) || event.retryPhase !== state.phase || event.code.length === 0) {
      return illegal(state, event);
    }
    return nextState(state, "Failed", {
      resumePhase: null,
      retryPhase: event.retryPhase,
      failureCode: event.code,
    });
  }
  if (event.type === "retry") {
    if (state.phase !== "Failed" || state.retryPhase === null) return illegal(state, event);
    return nextState(state, state.retryPhase, {
      retryPhase: null,
      failureCode: null,
    });
  }

  const transition = FORWARD_TRANSITIONS[event.type];
  if (transition === undefined || state.phase !== transition[0]) return illegal(state, event);
  return nextState(state, transition[1], {
    resumePhase: null,
    retryPhase: null,
    failureCode: null,
  });
}
