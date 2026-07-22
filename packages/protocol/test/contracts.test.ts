import { describe, expect, it } from "vitest";

import type { DurableStateV1, InitializationPlan } from "../src/index.js";

describe("protocol contracts", () => {
  it("keeps initialization approval explicit", () => {
    const plan = {
      schema: "openlifewiki.init-plan/v1",
      fromState: "INSTALLED",
      targetState: "INITIALIZED",
      approvalRequired: true,
      components: [],
      actions: [],
      excluded: [],
    } satisfies InitializationPlan;

    expect(plan.approvalRequired).toBe(true);
  });

  it("does not define a partial initialization as durable state", () => {
    const state = {
      schema: "openlifewiki.state/v1",
      stableState: "INITIALIZED",
      completedAt: "2026-07-22T00:00:00.000Z",
      components: [{
        id: "qmd",
        version: "2.5.3",
        integrity: "sha512-example",
        executable: "/tmp/qmd",
        installedAt: "2026-07-22T00:00:00.000Z",
      }],
    } satisfies DurableStateV1;

    expect(state.stableState).toBe("INITIALIZED");
  });
});
