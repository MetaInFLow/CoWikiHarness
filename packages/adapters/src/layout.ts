import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { QMD_RELEASE } from "@openlifewiki/core";
import type { RuntimeLayout } from "@openlifewiki/protocol";

export function resolveRuntimeLayout(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RuntimeLayout {
  const configuredRoot = env.OPENLIFEWIKI_HOME?.trim();
  const root = configuredRoot === undefined || configuredRoot.length === 0
    ? join(homedir(), ".openlifewiki")
    : resolve(expandHome(configuredRoot));
  const qmdInstallDir = join(root, "components", "qmd", QMD_RELEASE.version);

  return {
    root,
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    componentsDir: join(root, "components"),
    dataDir: join(root, "data"),
    runtimeDir: join(root, "runtime"),
    logsDir: join(root, "logs"),
    wikiDir: join(root, "wiki"),
    qmdInstallDir,
    qmdExecutable: join(qmdInstallDir, "node_modules", ".bin", platform === "win32" ? "qmd.cmd" : "qmd"),
  };
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
