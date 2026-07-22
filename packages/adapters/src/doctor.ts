import { QMD_RELEASE } from "@openlifewiki/core";
import type {
  ComponentHealth,
  DoctorReport,
  RuntimeLayout,
  StatusReport,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "./command-runner.js";
import { readQmdVersion } from "./initializer.js";
import { readDurableState } from "./state-store.js";

export async function inspectRuntime(
  layout: RuntimeLayout,
  runner: CommandRunner,
): Promise<DoctorReport> {
  const state = await readDurableState(layout.stateFile);
  if (state === undefined) {
    return {
      schema: "openlifewiki.doctor/v1",
      status: "setup-required",
      stableState: "INSTALLED",
      stateRoot: layout.root,
      workspaceRoot: layout.workspaceRoot,
      sourcePath: layout.sourcesDir,
      components: [qmdHealth(layout, "missing")],
      nextAction: "initialize",
    };
  }

  const actualVersion = await readQmdVersion(layout, runner);
  const health: ComponentHealth = actualVersion === QMD_RELEASE.version
    ? qmdHealth(layout, "ready", actualVersion)
    : qmdHealth(layout, actualVersion === undefined ? "probe-failed" : "version-mismatch", actualVersion);

  if (health.status !== "ready") {
    return {
      schema: "openlifewiki.doctor/v1",
      status: "degraded",
      stableState: "DEGRADED",
      stateRoot: layout.root,
      workspaceRoot: layout.workspaceRoot,
      sourcePath: layout.sourcesDir,
      components: [health],
      nextAction: "repair",
    };
  }

  return {
    schema: "openlifewiki.doctor/v1",
    status: "ready",
    stableState: state.stableState,
    stateRoot: layout.root,
    workspaceRoot: layout.workspaceRoot,
    sourcePath: layout.sourcesDir,
    components: [health],
    nextAction: state.stableState === "ACTIVE" ? "use" : "activate",
  };
}

export function statusFromDoctor(report: DoctorReport): StatusReport {
  return {
    schema: "openlifewiki.status/v1",
    stableState: report.stableState,
    ready: report.status === "ready",
    stateRoot: report.stateRoot,
    workspaceRoot: report.workspaceRoot,
    sourcePath: report.sourcePath,
    nextAction: report.nextAction,
  };
}

function qmdHealth(
  layout: RuntimeLayout,
  status: ComponentHealth["status"],
  actualVersion?: string,
): ComponentHealth {
  return {
    id: QMD_RELEASE.id,
    status,
    expectedVersion: QMD_RELEASE.version,
    ...(actualVersion === undefined ? {} : { actualVersion }),
    executable: layout.qmdExecutable,
  };
}
