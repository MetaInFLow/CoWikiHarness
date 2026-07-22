import { describe, expect, it } from "vitest";

import type { RuntimeLayout } from "@openlifewiki/protocol";

import {
  COMPONENT_RELEASES,
  createInitializationPlan,
  LIFECYCLE_STAGES,
  QMD_RELEASE,
} from "../src/index.js";

const layout: RuntimeLayout = {
  root: "/tmp/openlifewiki",
  configFile: "/tmp/openlifewiki/config.json",
  stateFile: "/tmp/openlifewiki/state.json",
  componentsDir: "/tmp/openlifewiki/components",
  dataDir: "/tmp/openlifewiki/data",
  runtimeDir: "/tmp/openlifewiki/runtime",
  logsDir: "/tmp/openlifewiki/logs",
  wikiDir: "/tmp/openlifewiki/wiki",
  qmdInstallDir: "/tmp/openlifewiki/components/qmd/2.5.3",
  qmdExecutable: "/tmp/openlifewiki/components/qmd/2.5.3/node_modules/.bin/qmd",
};

describe("lifecycle baseline", () => {
  it("defines the complete product lifecycle in order", () => {
    expect(LIFECYCLE_STAGES.map(({ id }) => id)).toEqual([
      "discover",
      "install",
      "initialize",
      "activate",
      "use",
      "maintain",
      "uninstall",
    ]);
  });

  it("installs only QMD during initialization", () => {
    const plan = createInitializationPlan(layout);
    expect(plan.components).toEqual([QMD_RELEASE]);
    expect(plan.approvalRequired).toBe(true);
    expect(plan.actions.some(({ network }) => network)).toBe(true);
    expect(plan.excluded).toContain("llm-wiki-compiler installation");
  });

  it("defers every other executable until its first product stage", () => {
    expect(COMPONENT_RELEASES.filter(({ firstRequiredStage }) => firstRequiredStage === "initialize"))
      .toEqual([QMD_RELEASE]);
  });
});
