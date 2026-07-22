import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  initializeRuntime,
  inspectRuntime,
  nodeCommandRunner,
  resolveRuntimeLayout,
} from "../src/index.js";

const realComponentTest = process.env.OPENLIFEWIKI_REAL_COMPONENT_TEST === "1" ? it : it.skip;

realComponentTest("installs and probes the pinned QMD release in isolation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "openlifewiki-qmd-contract-"));
  const layout = resolveRuntimeLayout({ OPENLIFEWIKI_HOME: join(temporary, "home") });

  try {
    const initialized = await initializeRuntime({ layout, runner: nodeCommandRunner });
    const doctor = await inspectRuntime(layout, nodeCommandRunner);

    expect(initialized).toMatchObject({
      stableState: "INITIALIZED",
      components: [{ id: "qmd", version: "2.5.3" }],
    });
    expect(doctor).toMatchObject({
      status: "ready",
      stableState: "INITIALIZED",
      nextAction: "activate",
      components: [{ id: "qmd", status: "ready", actualVersion: "2.5.3" }],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20 * 60_000);
