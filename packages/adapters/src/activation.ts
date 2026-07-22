import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { createActivationPlan, QMD_RELEASE } from "@openlifewiki/core";
import type {
  ActivationPlan,
  ActivationResult,
  AuthorizedSource,
  McpLaunchConfig,
  RuntimeLayout,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "./command-runner.js";
import { readConfig, writeConfig } from "./config-store.js";
import { AdapterError } from "./errors.js";
import { readQmdVersion } from "./initializer.js";
import {
  DEFAULT_QMD_COLLECTION,
  DEFAULT_QMD_MASK,
  DEFAULT_SOURCE_ID,
  parseQmdCollectionDetails,
  parseQmdCollectionNames,
  pathsReferToSameLocation,
  qmdEnvironment,
} from "./qmd.js";
import { readDurableState, writeJsonAtomic } from "./state-store.js";

const MCP_CONFIG: McpLaunchConfig = {
  transport: "stdio",
  command: "openlifewiki",
  args: ["mcp", "--stdio"],
};

export function previewActivation(layout: RuntimeLayout): ActivationPlan {
  return createActivationPlan(layout);
}

export async function activateDefaultSource(options: {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
}): Promise<ActivationResult> {
  const state = await readDurableState(options.layout.stateFile);
  if (state === undefined) {
    throw new AdapterError("INITIALIZATION_REQUIRED", "Run initialization before activation");
  }
  if (await readQmdVersion(options.layout, options.runner) !== QMD_RELEASE.version) {
    throw new AdapterError("ACTIVATION_FAILED", "The installed QMD release is unavailable or has changed");
  }

  const config = await readConfig(options.layout.configFile);
  if (config === undefined) {
    throw new AdapterError("INITIALIZATION_REQUIRED", "The openLifeWiki configuration is missing");
  }
  const existingSource = config.sources.find(({ id }) => id === DEFAULT_SOURCE_ID);
  if (config.sources.some(({ id }) => id !== DEFAULT_SOURCE_ID)) {
    throw new AdapterError("ACTIVATION_FAILED", "P0 permits only the default local Source");
  }
  if (existingSource !== undefined
    && !await pathsReferToSameLocation(existingSource.path, options.layout.sourcesDir)) {
    throw new AdapterError(
      "ACTIVATION_FAILED",
      `The active Source is ${existingSource.path}; use the original workspace or a fresh runtime`,
    );
  }

  const documents = await listSearchableMarkdown(options.layout.sourcesDir);
  if (documents.length === 0) {
    if (state.stableState === "ACTIVE") {
      await writeJsonAtomic(options.layout.stateFile, {
        ...state,
        stableState: "INITIALIZED",
        completedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    }
    return activationResult("source-empty", "INITIALIZED", options.layout.sourcesDir, 0, "add-markdown");
  }
  const env = qmdEnvironment(options.layout);

  try {
    const collectionList = await options.runner.run(options.layout.qmdExecutable, ["collection", "list"], {
      cwd: options.layout.root,
      env,
      timeoutMs: 30_000,
    });
    const collectionNames = parseQmdCollectionNames(collectionList.stdout);
    if (collectionNames.some((name) => name !== DEFAULT_QMD_COLLECTION)) {
      throw new AdapterError("ACTIVATION_FAILED", "The isolated QMD configuration contains an unauthorized collection");
    }
    const collectionExists = collectionNames.includes(DEFAULT_QMD_COLLECTION);

    if (!collectionExists) {
      await options.runner.run(options.layout.qmdExecutable, [
        "collection",
        "add",
        options.layout.sourcesDir,
        "--name",
        DEFAULT_QMD_COLLECTION,
        "--mask",
        DEFAULT_QMD_MASK,
      ], { cwd: options.layout.root, env, timeoutMs: 5 * 60_000 });
    } else {
      const collection = await options.runner.run(options.layout.qmdExecutable, [
        "collection",
        "show",
        DEFAULT_QMD_COLLECTION,
      ], { cwd: options.layout.root, env, timeoutMs: 30_000 });
      const details = parseQmdCollectionDetails(collection.stdout);
      if (details.path === undefined
        || !await pathsReferToSameLocation(details.path, options.layout.sourcesDir)
        || details.mask !== DEFAULT_QMD_MASK) {
        throw new AdapterError(
          "ACTIVATION_FAILED",
          "The isolated QMD collection does not match the approved Source",
        );
      }
      await options.runner.run(options.layout.qmdExecutable, ["update"], {
        cwd: options.layout.root,
        env,
        timeoutMs: 5 * 60_000,
      });
    }

    const probeQuery = documents[0]!.query;
    const probe = await options.runner.run(options.layout.qmdExecutable, [
      "search",
      probeQuery,
      "--json",
      "-n",
      "1",
      "-c",
      DEFAULT_QMD_COLLECTION,
    ], { cwd: options.layout.root, env, timeoutMs: 60_000 });
    if (!hasSearchResult(probe.stdout)) {
      throw new AdapterError(
        "ACTIVATION_FAILED",
        "QMD indexed the Source but the retrieval smoke returned no citation",
      );
    }

    const completedAt = (options.now ?? (() => new Date()))().toISOString();
    const source: AuthorizedSource = existingSource ?? {
      id: DEFAULT_SOURCE_ID,
      kind: "local-folder",
      path: options.layout.sourcesDir,
      collection: DEFAULT_QMD_COLLECTION,
      mask: DEFAULT_QMD_MASK,
      authorizedAt: completedAt,
    };
    await writeConfig(options.layout.configFile, {
      ...config,
      sources: [...config.sources.filter(({ id }) => id !== DEFAULT_SOURCE_ID), source],
    });
    await writeJsonAtomic(options.layout.stateFile, {
      ...state,
      stableState: "ACTIVE",
      completedAt,
    });

    return activationResult(
      state.stableState === "ACTIVE" && existingSource !== undefined ? "already-active" : "activated",
      "ACTIVE",
      options.layout.sourcesDir,
      documents.length,
      "connect-agent",
    );
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("ACTIVATION_FAILED", "Default Source activation did not complete", { cause: error });
  }
}

function activationResult(
  status: ActivationResult["status"],
  stableState: ActivationResult["stableState"],
  sourcePath: string,
  indexedFiles: number,
  nextAction: ActivationResult["nextAction"],
): ActivationResult {
  return {
    schema: "openlifewiki.activation-result/v1",
    status,
    stableState,
    sourcePath,
    indexedFiles,
    mcp: MCP_CONFIG,
    nextAction,
  };
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  await walk(directory, files);
  return files.sort();
}

async function listSearchableMarkdown(directory: string): Promise<Array<{ path: string; query: string }>> {
  const documents: Array<{ path: string; query: string }> = [];
  for (const path of await listMarkdownFiles(directory)) {
    const query = await deriveProbeQuery(path);
    if (query !== undefined) documents.push({ path, query });
  }
  return documents;
}

async function walk(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
}

async function deriveProbeQuery(path: string): Promise<string | undefined> {
  const content = (await readFile(path, "utf8")).slice(0, 32_000);
  const heading = content.split(/\r?\n/u)
    .map((line) => line.replace(/^\s*#+\s*/u, "").trim())
    .find((line) => line.length >= 3);
  const candidate = heading ?? content.trim();
  const latinWord = candidate.match(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}_-]{3,}/u)?.[0];
  if (latinWord !== undefined) return latinWord;
  const cjk = candidate.match(/[\p{Script=Han}]{2,}/u)?.[0];
  if (cjk !== undefined) return cjk.slice(0, 6);
  return undefined;
}

function hasSearchResult(output: string): boolean {
  try {
    const value = JSON.parse(output) as unknown;
    return Array.isArray(value)
      && value.some((result) => typeof result === "object" && result !== null
        && typeof (result as Record<string, unknown>).file === "string");
  } catch {
    return false;
  }
}
