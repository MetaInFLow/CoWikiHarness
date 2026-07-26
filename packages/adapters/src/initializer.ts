import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createInitializationPlan, QMD_RELEASE } from "@openlifewiki/core";
import type {
  ComponentReceipt,
  InitializationPlan,
  InitializationResult,
  RuntimeLayout,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "./command-runner.js";
import { emptyConfig, readConfigSnapshot, writeConfig } from "./config-store.js";
import { AdapterError } from "./errors.js";
import { readDurableState, writeJsonAtomic } from "./state-store.js";

export function previewInitialization(layout: RuntimeLayout): InitializationPlan {
  return createInitializationPlan(layout);
}

export async function initializeRuntime(options: {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly npmCommand?: string;
}): Promise<InitializationResult> {
  const now = options.now ?? (() => new Date());
  const existing = await readDurableState(options.layout.stateFile);

  if (existing !== undefined && await qmdMatches(options.layout, options.runner)) {
    await createRuntimeLayout(options.layout);
    await writeDefaultConfigWhenAbsent(options.layout.configFile);
    return {
      schema: "openlifewiki.init-result/v1",
      status: "already-initialized",
      stableState: existing.stableState,
      stateRoot: options.layout.root,
      workspaceRoot: options.layout.workspaceRoot,
      components: existing.components,
    };
  }

  try {
    await createRuntimeLayout(options.layout);
    await writeDefaultConfigWhenAbsent(options.layout.configFile);
    await prepareQmdPackage(options.layout.qmdInstallDir);
    await options.runner.run(options.npmCommand ?? "npm", [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: options.layout.qmdInstallDir,
      timeoutMs: 15 * 60_000,
    });
    await verifyQmdPackageLock(options.layout.qmdInstallDir);

    const actualVersion = await readQmdVersion(options.layout, options.runner);
    if (actualVersion !== QMD_RELEASE.version) {
      throw new AdapterError(
        "COMPONENT_VERSION_MISMATCH",
        `Expected QMD ${QMD_RELEASE.version}, received ${actualVersion ?? "unknown"}`,
      );
    }

    const installedAt = now().toISOString();
    const receipt: ComponentReceipt = {
      id: QMD_RELEASE.id,
      version: QMD_RELEASE.version,
      integrity: QMD_RELEASE.integrity,
      executable: options.layout.qmdExecutable,
      installedAt,
    };
    const state = {
      schema: "openlifewiki.state/v1",
      stableState: "INITIALIZED",
      completedAt: installedAt,
      components: [receipt],
    } as const;
    await writeJsonAtomic(options.layout.stateFile, state);

    return {
      schema: "openlifewiki.init-result/v1",
      status: "initialized",
      stableState: "INITIALIZED",
      stateRoot: options.layout.root,
      workspaceRoot: options.layout.workspaceRoot,
      components: [receipt],
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("INITIALIZATION_FAILED", "Initialization did not complete", { cause: error });
  }
}

export async function readQmdVersion(
  layout: RuntimeLayout,
  runner: CommandRunner,
): Promise<string | undefined> {
  try {
    const result = await runner.run(layout.qmdExecutable, ["--version"], { timeoutMs: 30_000 });
    return extractVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return undefined;
  }
}

async function qmdMatches(layout: RuntimeLayout, runner: CommandRunner): Promise<boolean> {
  return await readQmdVersion(layout, runner) === QMD_RELEASE.version;
}

async function createRuntimeLayout(layout: RuntimeLayout): Promise<void> {
  const directories = [
    layout.root,
    layout.componentsDir,
    layout.dataDir,
    layout.runtimeDir,
    layout.logsDir,
    layout.workspaceRoot,
    layout.sourcesDir,
    layout.wikiDir,
    layout.qmdConfigDir,
    layout.qmdCacheDir,
  ];
  await Promise.all(directories.map(async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }));
}

async function writeDefaultConfigWhenAbsent(path: string): Promise<void> {
  const snapshot = await readConfigSnapshot(path);
  if (snapshot !== undefined) {
    await chmod(path, 0o600);
    return;
  }
  await writeConfig(path, emptyConfig());
}

async function prepareQmdPackage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeJsonAtomic(`${directory}/package.json`, {
    name: "openlifewiki-component-qmd",
    private: true,
    dependencies: {
      [QMD_RELEASE.packageName]: QMD_RELEASE.version,
    },
  });
}

async function verifyQmdPackageLock(directory: string): Promise<void> {
  const lockPath = join(directory, "package-lock.json");
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new AdapterError("INITIALIZATION_FAILED", "QMD package lock is missing or invalid", { cause: error });
  }

  const packageRecord = typeof lock === "object" && lock !== null
    ? (lock as { packages?: Record<string, unknown> }).packages?.["node_modules/@tobilu/qmd"]
    : undefined;
  if (typeof packageRecord !== "object" || packageRecord === null) {
    throw new AdapterError("INITIALIZATION_FAILED", "QMD package receipt is missing from package-lock.json");
  }
  const release = packageRecord as Record<string, unknown>;
  if (release.version !== QMD_RELEASE.version || release.integrity !== QMD_RELEASE.integrity) {
    throw new AdapterError(
      "COMPONENT_VERSION_MISMATCH",
      "Installed QMD release does not match the pinned version and integrity",
    );
  }
}

function extractVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/m)?.[1];
}
