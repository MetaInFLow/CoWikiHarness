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
    ? defaultRuntimeRoot(env, platform)
    : resolve(expandHome(configuredRoot));
  const configuredWorkspace = env.OPENLIFEWIKI_WORKSPACE?.trim();
  const workspaceRoot = configuredWorkspace === undefined || configuredWorkspace.length === 0
    ? join(homedir(), "openLifeWiki")
    : resolve(expandHome(configuredWorkspace));
  const qmdInstallDir = join(root, "components", "qmd", QMD_RELEASE.version);

  return {
    root,
    workspaceRoot,
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    componentsDir: join(root, "components"),
    dataDir: join(root, "data"),
    runtimeDir: join(root, "runtime"),
    logsDir: join(root, "logs"),
    sourcesDir: join(workspaceRoot, "sources"),
    wikiDir: join(workspaceRoot, "wiki"),
    qmdConfigDir: join(root, "data", "qmd", "config"),
    qmdCacheDir: join(root, "data", "qmd", "cache"),
    qmdInstallDir,
    qmdExecutable: join(qmdInstallDir, "node_modules", ".bin", platform === "win32" ? "qmd.cmd" : "qmd"),
  };
}

function defaultRuntimeRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "openLifeWiki");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return join(
      localAppData === undefined || localAppData.length === 0
        ? join(homedir(), "AppData", "Local")
        : resolve(expandHome(localAppData)),
      "openLifeWiki",
    );
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(
    xdgDataHome === undefined || xdgDataHome.length === 0
      ? join(homedir(), ".local", "share")
      : resolve(expandHome(xdgDataHome)),
    "openlifewiki",
  );
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
