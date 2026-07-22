import { readFile } from "node:fs/promises";

import type { OpenLifeWikiConfigV1 } from "@openlifewiki/protocol";

import { AdapterError } from "./errors.js";
import { writeJsonAtomic } from "./state-store.js";

export async function readConfig(path: string): Promise<OpenLifeWikiConfigV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AdapterError("INITIALIZATION_FAILED", "Configuration is not valid JSON", { cause: error });
  }
  if (!isConfig(value)) {
    throw new AdapterError("INITIALIZATION_FAILED", "Existing configuration is invalid");
  }
  return value;
}

export async function writeConfig(path: string, config: OpenLifeWikiConfigV1): Promise<void> {
  await writeJsonAtomic(path, config);
}

export function emptyConfig(): OpenLifeWikiConfigV1 {
  return {
    schema: "openlifewiki.config/v1",
    sources: [],
    agentBindings: [],
  };
}

function isConfig(value: unknown): value is OpenLifeWikiConfigV1 {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  if (config.schema !== "openlifewiki.config/v1"
    || !Array.isArray(config.sources)
    || !Array.isArray(config.agentBindings)
    || !config.agentBindings.every((binding) => typeof binding === "string")) return false;

  return config.sources.every((source) => {
    if (typeof source !== "object" || source === null) return false;
    const item = source as Record<string, unknown>;
    return typeof item.id === "string"
      && item.kind === "local-folder"
      && typeof item.path === "string"
      && typeof item.collection === "string"
      && item.mask === "**/*.md"
      && typeof item.authorizedAt === "string";
  });
}
