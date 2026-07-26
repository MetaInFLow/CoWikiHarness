import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256Canonical, type AgentScanInputContext } from "@openlifewiki/protocol";

import type { AgentLayerSummary } from "./agents/agent-driver.js";
import { isValidAgentLayerSummary } from "./agents/layer-summary.js";
import { AdapterError } from "./errors.js";
import { writeJsonAtomic } from "./state-store.js";

const SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type ScanScratchClearReason =
  | "decision-committed"
  | "pause"
  | "cancel"
  | "failure";

export async function writeScanLayerSummary(options: {
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly input: AgentScanInputContext;
  readonly summary: AgentLayerSummary;
}): Promise<void> {
  assertScanId(options.scanId);
  const summary = structuredClone(options.summary);
  if (options.input.scanId !== options.scanId
    || sha256Canonical(summary) !== options.input.layer.summaryHash
    || !isValidAgentLayerSummary(summary, options.input)) {
    throw invalid("Layer Summary does not match the trusted scan input and summaryHash");
  }
  const path = summaryPath(options.runtimeDir, options.scanId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeJsonAtomic(path, summary);
}

export async function readScanLayerSummary(options: {
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly input: AgentScanInputContext;
}): Promise<AgentLayerSummary | undefined> {
  assertScanId(options.scanId);
  if (options.input.scanId !== options.scanId) throw invalid("Layer Summary scanId binding is invalid");
  let raw: string;
  try {
    raw = await readFile(summaryPath(options.runtimeDir, options.scanId), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalid("Layer Summary scratch is not valid JSON", error);
  }
  if (sha256Canonical(value) !== options.input.layer.summaryHash
    || !isValidAgentLayerSummary(value, options.input)) {
    throw invalid("Layer Summary scratch failed shared validation");
  }
  return freeze(value);
}

export async function clearScanScratch(options: {
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly reason: ScanScratchClearReason;
}): Promise<void> {
  assertScanId(options.scanId);
  if (!["decision-committed", "pause", "cancel", "failure"].includes(options.reason)) {
    throw invalid("Scan scratch clear reason is invalid");
  }
  await rm(scanDirectory(options.runtimeDir, options.scanId), { recursive: true, force: true });
}

export async function cleanupOrphanScanScratch(options: {
  readonly runtimeDir: string;
}): Promise<{ readonly removed: number }> {
  const root = join(options.runtimeDir, "scans");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    await rm(join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}

function summaryPath(runtimeDir: string, scanId: string): string {
  return join(scanDirectory(runtimeDir, scanId), "layer-summary.json");
}

function scanDirectory(runtimeDir: string, scanId: string): string {
  assertScanId(scanId);
  return join(runtimeDir, "scans", scanId);
}

function assertScanId(scanId: string): void {
  if (!SCAN_ID.test(scanId)) throw invalid("scanId is invalid");
}

function invalid(message: string, cause?: unknown): AdapterError {
  return new AdapterError("SCAN_SCRATCH_INVALID", message, cause === undefined ? undefined : { cause });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
