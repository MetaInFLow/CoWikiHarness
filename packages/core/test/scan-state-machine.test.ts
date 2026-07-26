import { describe, expect, it } from "vitest";

import { createScanState, transitionScanState } from "../src/index.js";

describe("progressive scan state machine", () => {
  it("follows the fixed scan path and only Complete follows successful publication", () => {
    let state = createScanState("scan-1");
    const path = [
      ["approve-plan", "Probing"],
      ["probe-connected", "Discovering"],
      ["layer-discovered", "Summarizing"],
      ["layer-summarized", "Deciding"],
      ["continue-discovery", "Discovering"],
      ["frontier-discovered", "ReadingLeaves"],
      ["leaves-read", "BuildingQMD"],
      ["qmd-built", "VerifyingQMD"],
      ["qmd-verified", "PublishingQMD"],
      ["qmd-published", "Complete"],
    ] as const;
    for (const [event, phase] of path) {
      state = transitionScanState(state, { type: event });
      expect(state.phase).toBe(phase);
    }
    expect(state.completed).toBe(true);
  });

  it("pauses and resumes the exact running phase without claiming completion", () => {
    let state = createScanState("scan-1");
    state = transitionScanState(state, { type: "approve-plan" });
    state = transitionScanState(state, { type: "probe-connected" });
    state = transitionScanState(state, { type: "pause" });
    expect(state).toMatchObject({ phase: "Paused", resumePhase: "Discovering", completed: false });
    state = transitionScanState(state, { type: "resume" });
    expect(state).toMatchObject({ phase: "Discovering", resumePhase: null, completed: false });
  });

  it("cancels terminally and retries failure only at its recorded recovery phase", () => {
    let state = transitionScanState(createScanState("scan-1"), { type: "approve-plan" });
    state = transitionScanState(state, { type: "fail", retryPhase: "Probing", code: "PROBE_FAILED" });
    expect(state).toMatchObject({ phase: "Failed", retryPhase: "Probing", completed: false });
    state = transitionScanState(state, { type: "retry" });
    expect(state.phase).toBe("Probing");
    state = transitionScanState(state, { type: "cancel" });
    expect(state).toMatchObject({ phase: "Cancelled", completed: false });
    expect(() => transitionScanState(state, { type: "resume" })).toThrow(/illegal/i);
  });

  it("rejects phase jumps and controls from terminal states", () => {
    const draft = createScanState("scan-1");
    expect(() => transitionScanState(draft, { type: "qmd-published" })).toThrow(/illegal/i);
    expect(() => transitionScanState(draft, { type: "pause" })).toThrow(/illegal/i);
    const complete = [
      "approve-plan", "probe-connected", "frontier-discovered", "leaves-read",
      "qmd-built", "qmd-verified", "qmd-published",
    ].reduce((state, type) => transitionScanState(state, { type } as never), draft);
    expect(() => transitionScanState(complete, { type: "cancel" })).toThrow(/illegal/i);
  });
});
