import { spawn } from "node:child_process";

import type { RuntimeLayout } from "@openlifewiki/protocol";
import { QMD_RELEASE } from "@openlifewiki/core";

import type { CommandRunner } from "./command-runner.js";
import { getP0Sources, readConfig } from "./config-store.js";
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
import { readDurableState } from "./state-store.js";

export interface InteractiveProcessRunner {
  run(command: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<number>;
}

export const nodeInteractiveProcessRunner: InteractiveProcessRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { ...options, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal !== null) {
          reject(new AdapterError("COMMAND_FAILED", `QMD MCP stopped by signal ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

export async function launchLocalMcp(options: {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly interactiveRunner?: InteractiveProcessRunner;
}): Promise<number> {
  const state = await readDurableState(options.layout.stateFile);
  if (state?.stableState !== "ACTIVE") {
    throw new AdapterError("MCP_NOT_READY", "Activate the default Source before starting MCP");
  }
  if (await readQmdVersion(options.layout, options.runner) !== QMD_RELEASE.version) {
    throw new AdapterError("MCP_NOT_READY", "The installed QMD release is unavailable or has changed");
  }
  const qmdOptions = {
    cwd: options.layout.root,
    env: qmdEnvironment(options.layout),
  };
  try {
    const config = await readConfig(options.layout.configFile);
    const p0Sources = config === undefined ? [] : getP0Sources(config);
    const source = p0Sources.find(({ id }) => id === DEFAULT_SOURCE_ID);
    if (config === undefined
      || p0Sources.length !== 1
      || source === undefined
      || !await pathsReferToSameLocation(source.path, options.layout.sourcesDir)
      || source.collection !== DEFAULT_QMD_COLLECTION
      || source.mask !== DEFAULT_QMD_MASK) {
      throw new Error("openLifeWiki Source authorization does not match the default workspace");
    }
    const collectionList = await options.runner.run(options.layout.qmdExecutable, ["collection", "list"], {
      ...qmdOptions,
      timeoutMs: 30_000,
    });
    const collectionNames = parseQmdCollectionNames(collectionList.stdout);
    if (collectionNames.length !== 1 || collectionNames[0] !== DEFAULT_QMD_COLLECTION) {
      throw new Error("QMD contains a collection outside the approved P0 scope");
    }
    const collection = await options.runner.run(options.layout.qmdExecutable, [
      "collection",
      "show",
      DEFAULT_QMD_COLLECTION,
    ], { ...qmdOptions, timeoutMs: 30_000 });
    const details = parseQmdCollectionDetails(collection.stdout);
    if (details.path === undefined
      || !await pathsReferToSameLocation(details.path, options.layout.sourcesDir)
      || details.mask !== DEFAULT_QMD_MASK) {
      throw new Error("QMD collection does not match the approved Source");
    }
    await options.runner.run(options.layout.qmdExecutable, ["update"], {
      ...qmdOptions,
      timeoutMs: 5 * 60_000,
    });
  } catch (error) {
    throw new AdapterError("MCP_NOT_READY", "QMD could not refresh the authorized Source", { cause: error });
  }
  return await (options.interactiveRunner ?? nodeInteractiveProcessRunner).run(
    options.layout.qmdExecutable,
    ["mcp"],
    qmdOptions,
  );
}
