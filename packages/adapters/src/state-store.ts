import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DurableStateV1 } from "@openlifewiki/protocol";

import { AdapterError } from "./errors.js";

export async function readDurableState(path: string): Promise<DurableStateV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AdapterError("INVALID_STATE_FILE", "State file is not valid JSON", { cause: error });
  }

  if (!isDurableState(value)) {
    throw new AdapterError("INVALID_STATE_FILE", "State file does not match openlifewiki.state/v1");
  }
  return value;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isDurableState(value: unknown): value is DurableStateV1 {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state.schema !== "openlifewiki.state/v1") return false;
  if (state.stableState !== "INITIALIZED" && state.stableState !== "ACTIVE") return false;
  if (typeof state.completedAt !== "string" || !Array.isArray(state.components)) return false;
  return state.components.every((component) => {
    if (typeof component !== "object" || component === null) return false;
    const receipt = component as Record<string, unknown>;
    return typeof receipt.id === "string"
      && typeof receipt.version === "string"
      && typeof receipt.integrity === "string"
      && typeof receipt.executable === "string"
      && typeof receipt.installedAt === "string";
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
