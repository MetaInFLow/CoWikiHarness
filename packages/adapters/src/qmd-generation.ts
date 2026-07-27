import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { QMD_RELEASE } from "@openlifewiki/core";
import {
  assertScanPlan,
  sha256Canonical,
  type ActiveQmdManifestReceipt,
  type RuntimeLayout,
  type ScanPlan,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "./command-runner.js";
import { AdapterError } from "./errors.js";
import { writeJsonAtomic } from "./state-store.js";

const COLLECTION = "openlifewiki-current";
const MASK = "**/*.md";
const HASH = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface QmdCurrentLeaf {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly bodyCheckpointReceiptHash: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly openBody: () => AsyncIterable<Uint8Array | string>;
}

interface QmdManifestEntry {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly bodyCheckpointReceiptHash: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly document: string;
  readonly canary: string;
}

interface QmdGenerationManifest {
  readonly schema: "openlifewiki.qmd-generation-manifest/v1";
  readonly generationId: string;
  readonly generationKey: string;
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly qmdVersion: string;
  readonly collection: string;
  readonly entries: readonly QmdManifestEntry[];
  readonly selectedSetHash: string;
  readonly builtAt: string;
  readonly manifestHash: string;
}

interface QmdProbeReceipt {
  readonly schema: "openlifewiki.qmd-public-probe/v1";
  readonly generationId: string;
  readonly manifestHash: string;
  readonly expectedCurrentCount: number;
  readonly historicalCanaryCount: number;
  readonly queryPassed: true;
  readonly getPassed: true;
  readonly stagingAbsent: true;
  readonly probedAt: string;
  readonly receiptHash: string;
}

interface QmdDeletionReceipt {
  readonly schema: "openlifewiki.qmd-prior-generation-deletion/v1";
  readonly generationId: string;
  readonly previousGenerationId: string | null;
  readonly previousGenerationKey: string | null;
  readonly deletedAt: string;
  readonly receiptHash: string;
}

interface ActivePointer {
  readonly schema: "openlifewiki.qmd-active-pointer/v1";
  readonly state: "active";
  readonly generationId: string;
  readonly generationKey: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly manifestHash: string;
  readonly publicProbeReceiptHash: string;
  readonly previousGenerationDeletionReceiptHash: string;
  readonly publishedAt: string;
  readonly pointerHash: string;
}

interface PublishingPointer {
  readonly schema: "openlifewiki.qmd-active-pointer/v1";
  readonly state: "publishing";
  readonly generationId: string;
  readonly generationKey: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly manifestHash: string;
  readonly previousGenerationId: string;
  readonly previousGenerationKey: string;
  readonly startedAt: string;
  readonly pointerHash: string;
}

export interface QmdActiveGenerationInspection {
  readonly generationId: string;
  readonly generationKey: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly manifestHash: string;
  readonly manifestReceiptHash: string;
  readonly publicProbeReceiptHash: string;
  readonly selectedLeaves: number;
  readonly sourceIds: readonly string[];
  readonly publishedAt: string;
}

export interface QmdGenerationPublishResult {
  readonly status: "published" | "already-active";
  readonly active: QmdActiveGenerationInspection;
  readonly manifestReceipt: ActiveQmdManifestReceipt;
}

export async function publishQmdCurrentGeneration(options: {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly plan: ScanPlan;
  readonly generationId: string;
  readonly leaves: readonly QmdCurrentLeaf[];
  readonly now?: () => Date;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
}): Promise<QmdGenerationPublishResult> {
  validateInput(options.plan, options.generationId, options.leaves);
  const now = options.now ?? (() => new Date());
  const paths = generationPaths(options.layout, options.generationId, options.plan);
  const entries = manifestEntries(options.leaves);
  const selectedSetHash = sha256Canonical(entries);
  const initial = await loadActive(options.layout, true);
  if (initial !== null && initial.pointer.generationId === options.generationId) {
    if (initial.manifest.selectedSetHash !== selectedSetHash
      || initial.pointer.generationKey !== paths.generationKey) {
      throw generationError("QMD_GENERATION_CONFLICT", "Generation ID is already bound to different evidence", options.generationId, "validate");
    }
    return publicationResult("already-active", initial);
  }

  let pointerSwitched = false;
  let completed = false;
  try {
    await rm(paths.generationDir, { recursive: true, force: true });
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.stagingDir, { recursive: true, mode: 0o700 });
    await materialize(options.leaves, entries, paths.stagingDir, options.generationId);
    const environment = isolatedQmdEnvironment(paths, options.baseEnvironment ?? process.env);
    await runQmd(options, ["collection", "add", paths.stagingDir, "--name", COLLECTION, "--mask", MASK], paths, environment, "build");
    await runQmd(options, ["update"], paths, environment, "build");
    await rm(paths.stagingDir, { recursive: true, force: true });

    const historicalCanaries = initial === null
      ? []
      : initial.manifest.entries.map(({ canary }) => canary).filter((canary) => !entries.some((entry) => entry.canary === canary));
    await probeCurrent(options, entries, historicalCanaries, paths, environment);
    const builtAt = now().toISOString();
    const manifestPayload = {
      schema: "openlifewiki.qmd-generation-manifest/v1" as const,
      generationId: options.generationId,
      generationKey: paths.generationKey,
      scanId: options.plan.scanId,
      scanPlanHash: options.plan.scanPlanHash,
      skeletonVersion: options.plan.skeletonVersion,
      qmdVersion: QMD_RELEASE.version,
      collection: COLLECTION,
      entries,
      selectedSetHash,
      builtAt,
    };
    const manifest: QmdGenerationManifest = { ...manifestPayload, manifestHash: sha256Canonical(manifestPayload) };
    const probePayload = {
      schema: "openlifewiki.qmd-public-probe/v1" as const,
      generationId: options.generationId,
      manifestHash: manifest.manifestHash,
      expectedCurrentCount: entries.length,
      historicalCanaryCount: historicalCanaries.length,
      queryPassed: true as const,
      getPassed: true as const,
      stagingAbsent: true as const,
      probedAt: now().toISOString(),
    };
    const probe: QmdProbeReceipt = { ...probePayload, receiptHash: sha256Canonical(probePayload) };
    await writeImmutableJson(paths.manifestPath, manifest);
    await writeImmutableJson(paths.probePath, probe);

    await acquirePublishLock(paths.lockDir, options.generationId);
    try {
      const current = await loadActive(options.layout, true);
      if (activeIdentity(current) !== activeIdentity(initial)) {
        throw generationError("QMD_GENERATION_CONFLICT", "Active QMD generation changed during build", options.generationId, "publish");
      }
      let deletion: QmdDeletionReceipt;
      if (current === null) {
        deletion = deletionReceipt(options.generationId, null, now().toISOString());
      } else {
        const switching = publishingPointer(options, paths, manifest, current, now().toISOString());
        await writeJsonAtomic(paths.activePath, switching);
        pointerSwitched = true;
        try {
          await rm(generationDirectory(options.layout, current.pointer.generationKey), { recursive: true, force: false });
        } catch {
          throw generationError(
            "QMD_GENERATION_RECOVERY_REQUIRED",
            "The new generation is queryable but prior-generation cleanup requires recovery",
            options.generationId,
            "delete-prior",
          );
        }
        deletion = deletionReceipt(options.generationId, current.pointer, now().toISOString());
      }
      await writeImmutableJson(paths.deletionPath, deletion);
      const pointer = activePointer(options, paths, manifest, probe, deletion, now().toISOString());
      const receipt = activeManifestReceipt(options.plan, manifest, pointer, probe, deletion);
      await writeImmutableJson(paths.receiptPath, receipt);
      await writeJsonAtomic(paths.activePath, pointer);
      pointerSwitched = true;
      completed = true;
      return publicationResult("published", { pointer, manifest, probe, deletion, receipt });
    } finally {
      await rm(paths.lockDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!pointerSwitched) await rm(paths.generationDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AdapterError && error.code.startsWith("QMD_GENERATION_")) throw error;
    throw generationError("QMD_GENERATION_FAILED", "QMD generation did not complete", options.generationId, "build");
  } finally {
    await rm(paths.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (!completed && !pointerSwitched) await rm(paths.generationDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectActiveQmdGeneration(options: {
  readonly layout: RuntimeLayout;
}): Promise<QmdActiveGenerationInspection | null> {
  const active = await loadActive(options.layout, false);
  return active === null ? null : inspectLoaded(active);
}

function validateInput(plan: ScanPlan, generationId: string, leaves: readonly QmdCurrentLeaf[]): void {
  try { assertScanPlan(plan); } catch { throw generationError("QMD_GENERATION_INVALID", "Scan Plan is invalid", generationId, "validate"); }
  if (!IDENTIFIER.test(generationId)) throw generationError("QMD_GENERATION_INVALID", "Generation ID is invalid", generationId, "validate");
  if (leaves.length === 0) throw generationError("QMD_GENERATION_INVALID", "A generation requires selected current evidence", generationId, "validate");
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const key = `${leaf.sourceId}\0${leaf.nodeId}`;
    if (typeof leaf.sourceId !== "string" || !IDENTIFIER.test(leaf.sourceId)
      || typeof leaf.nodeId !== "string" || !IDENTIFIER.test(leaf.nodeId)
      || typeof leaf.nodeVersion !== "string" || leaf.nodeVersion.length === 0
      || !HASH.test(leaf.bodyCheckpointReceiptHash) || !HASH.test(leaf.contentHash)
      || !Number.isSafeInteger(leaf.bytes) || leaf.bytes < 0 || seen.has(key)
      || !plan.sourceIds.includes(leaf.sourceId) || typeof leaf.openBody !== "function") {
      throw generationError("QMD_GENERATION_INVALID", "Selected current evidence is invalid or ambiguous", generationId, "validate");
    }
    seen.add(key);
  }
}

function manifestEntries(leaves: readonly QmdCurrentLeaf[]): QmdManifestEntry[] {
  return leaves.map((leaf) => {
    const identity = { sourceId: leaf.sourceId, nodeId: leaf.nodeId, nodeVersion: leaf.nodeVersion, contentHash: leaf.contentHash };
    const digest = sha256Canonical(identity).slice("sha256:".length);
    return { sourceId: leaf.sourceId, nodeId: leaf.nodeId, nodeVersion: leaf.nodeVersion,
      bodyCheckpointReceiptHash: leaf.bodyCheckpointReceiptHash, contentHash: leaf.contentHash,
      bytes: leaf.bytes, document: `${digest}.md`, canary: `olwkqmd_${digest}` };
  }).sort((left, right) => `${left.sourceId}\0${left.nodeId}`.localeCompare(`${right.sourceId}\0${right.nodeId}`));
}

async function materialize(
  leaves: readonly QmdCurrentLeaf[],
  entries: readonly QmdManifestEntry[],
  stagingDir: string,
  generationId: string,
): Promise<void> {
  const byKey = new Map(leaves.map((leaf) => [`${leaf.sourceId}\0${leaf.nodeId}`, leaf]));
  for (const entry of entries) {
    const leaf = byKey.get(`${entry.sourceId}\0${entry.nodeId}`)!;
    const handle = await open(join(stagingDir, entry.document), "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      await handle.write(`---\nopenlifewiki_qmd_canary: ${entry.canary}\n---\n${entry.canary}\n\n`);
      let stream: AsyncIterable<Uint8Array | string>;
      try { stream = leaf.openBody(); } catch { throw generationError("QMD_GENERATION_FAILED", "Selected body stream could not be opened", generationId, "materialize"); }
      try {
        for await (const chunk of stream) {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > entry.bytes) throw new Error("size mismatch");
          hash.update(buffer);
          await handle.write(buffer);
        }
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw generationError("QMD_GENERATION_FAILED", "Selected body stream failed validation", generationId, "materialize");
      }
    } finally {
      await handle.close();
    }
    if (bytes !== entry.bytes || `sha256:${hash.digest("hex")}` !== entry.contentHash) {
      throw generationError("QMD_GENERATION_FAILED", "Selected body does not match its authorized receipt", generationId, "materialize");
    }
  }
}

async function probeCurrent(
  options: Parameters<typeof publishQmdCurrentGeneration>[0],
  entries: readonly QmdManifestEntry[],
  historicalCanaries: readonly string[],
  paths: ReturnType<typeof generationPaths>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const entry of entries) {
    const search = await runQmd(options, ["search", entry.canary, "--format", "json", "-n", "5", "-c", COLLECTION], paths, environment, "query");
    const reference = matchingReference(search.stdout, entry.document);
    if (reference === null) throw generationError("QMD_GENERATION_FAILED", "QMD could not retrieve expected current evidence", options.generationId, "query");
    const get = await runQmd(options, ["get", `${reference}:1:10`, "--no-line-numbers"], paths, environment, "get");
    if (!get.stdout.includes(entry.canary)) throw generationError("QMD_GENERATION_FAILED", "QMD get did not resolve expected current evidence", options.generationId, "get");
  }
  for (const canary of historicalCanaries) {
    const search = await runQmd(options, ["search", canary, "--format", "json", "-n", "1", "-c", COLLECTION], paths, environment, "query");
    if (searchReferences(search.stdout).length !== 0) {
      throw generationError("QMD_GENERATION_FAILED", "QMD retained removed or replaced historical evidence", options.generationId, "query");
    }
  }
}

async function runQmd(
  options: Parameters<typeof publishQmdCurrentGeneration>[0],
  args: readonly string[],
  paths: ReturnType<typeof generationPaths>,
  environment: NodeJS.ProcessEnv,
  phase: string,
) {
  try {
    return await options.runner.run(options.layout.qmdExecutable, args, {
      cwd: paths.generationDir, env: environment, timeoutMs: phase === "build" ? 5 * 60_000 : 60_000,
    });
  } catch {
    throw generationError("QMD_GENERATION_FAILED", `QMD public ${phase} operation failed`, options.generationId, phase);
  }
}

function matchingReference(output: string, document: string): string | null {
  return searchReferences(output).find((reference) => basename(reference) === document) ?? null;
}

function searchReferences(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && "results" in parsed
      ? (parsed as { readonly results?: unknown }).results : [];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const record = row as Record<string, unknown>;
      const value = record.file ?? record.path ?? record.uri;
      return typeof value === "string" && value.length > 0 ? [value] : [];
    });
  } catch { return []; }
}

function isolatedQmdEnvironment(paths: ReturnType<typeof generationPaths>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"] as const) {
    if (base[key] !== undefined) environment[key] = base[key];
  }
  environment.NO_COLOR = "1";
  environment.QMD_CONFIG_DIR = paths.configDir;
  environment.XDG_CACHE_HOME = paths.cacheDir;
  return environment;
}

function generationPaths(layout: RuntimeLayout, generationId: string, plan: ScanPlan) {
  const root = join(layout.dataDir, "qmd-current");
  const generationKey = `g-${sha256Canonical({ generationId, scanPlanHash: plan.scanPlanHash, skeletonVersion: plan.skeletonVersion }).slice(7)}`;
  const generationDir = generationDirectory(layout, generationKey);
  const stagingRoot = join(layout.runtimeDir, "qmd-current", "staging");
  return { root, generationKey, generationDir, configDir: join(generationDir, "qmd-config"), cacheDir: join(generationDir, "qmd-cache"),
    stagingDir: join(stagingRoot, `${generationKey}-${process.pid}-${Date.now()}`), activePath: join(root, "active.json"),
    lockDir: join(root, "publish.lock"), manifestPath: join(generationDir, "manifest.json"), probePath: join(generationDir, "probe.json"),
    deletionPath: join(generationDir, "deletion.json"), receiptPath: join(generationDir, "receipt.json") };
}

function generationDirectory(layout: RuntimeLayout, generationKey: string): string {
  return join(layout.dataDir, "qmd-current", "generations", generationKey);
}

async function acquirePublishLock(path: string, generationId: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw generationError("QMD_GENERATION_CONFLICT", "Another QMD generation publication is in progress", generationId, "publish"); }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

function deletionReceipt(generationId: string, previous: ActivePointer | null, deletedAt: string): QmdDeletionReceipt {
  const payload = { schema: "openlifewiki.qmd-prior-generation-deletion/v1" as const, generationId,
    previousGenerationId: previous?.generationId ?? null, previousGenerationKey: previous?.generationKey ?? null, deletedAt };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function publishingPointer(
  options: Parameters<typeof publishQmdCurrentGeneration>[0], paths: ReturnType<typeof generationPaths>,
  manifest: QmdGenerationManifest, previous: LoadedActive, startedAt: string,
): PublishingPointer {
  const payload = { schema: "openlifewiki.qmd-active-pointer/v1" as const, state: "publishing" as const,
    generationId: options.generationId, generationKey: paths.generationKey, scanPlanHash: options.plan.scanPlanHash,
    skeletonVersion: options.plan.skeletonVersion, manifestHash: manifest.manifestHash,
    previousGenerationId: previous.pointer.generationId, previousGenerationKey: previous.pointer.generationKey, startedAt };
  return { ...payload, pointerHash: sha256Canonical(payload) };
}

function activePointer(
  options: Parameters<typeof publishQmdCurrentGeneration>[0], paths: ReturnType<typeof generationPaths>, manifest: QmdGenerationManifest,
  probe: QmdProbeReceipt, deletion: QmdDeletionReceipt, publishedAt: string,
): ActivePointer {
  const payload = { schema: "openlifewiki.qmd-active-pointer/v1" as const, state: "active" as const,
    generationId: options.generationId, generationKey: paths.generationKey, scanPlanHash: options.plan.scanPlanHash,
    skeletonVersion: options.plan.skeletonVersion, manifestHash: manifest.manifestHash,
    publicProbeReceiptHash: probe.receiptHash, previousGenerationDeletionReceiptHash: deletion.receiptHash, publishedAt };
  return { ...payload, pointerHash: sha256Canonical(payload) };
}

function activeManifestReceipt(
  plan: ScanPlan, manifest: QmdGenerationManifest, pointer: ActivePointer, probe: QmdProbeReceipt, deletion: QmdDeletionReceipt,
): ActiveQmdManifestReceipt {
  const entries = manifest.entries.map(({ sourceId, nodeId, nodeVersion, bodyCheckpointReceiptHash }) => ({
    sourceId, nodeId, nodeVersion, bodyCheckpointReceiptHash,
  }));
  const payload = { schema: "openlifewiki.active-qmd-manifest/v1" as const, scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, generationId: manifest.generationId, entries,
    manifestHash: sha256Canonical({ generationId: manifest.generationId, entries }),
    activePointerReceiptHash: pointer.pointerHash, publicProbeReceiptHash: probe.receiptHash,
    previousGenerationDeletionReceiptHash: deletion.receiptHash, publishedAt: pointer.publishedAt };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

type LoadedActive = { readonly pointer: ActivePointer; readonly manifest: QmdGenerationManifest; readonly probe: QmdProbeReceipt;
  readonly deletion: QmdDeletionReceipt; readonly receipt: ActiveQmdManifestReceipt };

async function loadActive(layout: RuntimeLayout, allowMissing: boolean): Promise<LoadedActive | null> {
  const activePath = join(layout.dataDir, "qmd-current", "active.json");
  let raw: string;
  try { raw = await readFile(activePath, "utf8"); }
  catch (error) {
    if (isMissing(error) && allowMissing) return null;
    if (isMissing(error)) return null;
    throw generationError("QMD_GENERATION_INVALID", "Active QMD pointer cannot be read", "unknown", "inspect");
  }
  let unknown: unknown;
  try { unknown = JSON.parse(raw); } catch { throw generationError("QMD_GENERATION_INVALID", "Active QMD pointer is invalid", "unknown", "inspect"); }
  if (!isRecord(unknown) || unknown.state === "publishing") {
    throw generationError("QMD_GENERATION_RECOVERY_REQUIRED", "QMD generation publication requires recovery", valueString(unknown, "generationId"), "inspect");
  }
  if (!isActivePointerShape(unknown)) {
    throw generationError("QMD_GENERATION_INVALID", "Active QMD pointer is invalid", valueString(unknown, "generationId"), "inspect");
  }
  const pointer = unknown as unknown as ActivePointer;
  assertSelfHash(pointer, "pointerHash", "QMD_GENERATION_INVALID", pointer.generationId);
  if (pointer.schema !== "openlifewiki.qmd-active-pointer/v1" || pointer.state !== "active" || !safeGenerationKey(pointer.generationKey)) {
    throw generationError("QMD_GENERATION_INVALID", "Active QMD pointer is invalid", pointer.generationId, "inspect");
  }
  const expectedKey = `g-${sha256Canonical({ generationId: pointer.generationId, scanPlanHash: pointer.scanPlanHash, skeletonVersion: pointer.skeletonVersion }).slice(7)}`;
  if (pointer.generationKey !== expectedKey) throw generationError("QMD_GENERATION_INVALID", "Active QMD pointer binding is invalid", pointer.generationId, "inspect");
  const directory = generationDirectory(layout, pointer.generationKey);
  const [manifest, probe, deletion, receipt] = await Promise.all([
    readJson(join(directory, "manifest.json"), pointer.generationId), readJson(join(directory, "probe.json"), pointer.generationId),
    readJson(join(directory, "deletion.json"), pointer.generationId), readJson(join(directory, "receipt.json"), pointer.generationId),
  ]) as unknown as [QmdGenerationManifest, QmdProbeReceipt, QmdDeletionReceipt, ActiveQmdManifestReceipt];
  assertSelfHash(manifest, "manifestHash", "QMD_GENERATION_INVALID", pointer.generationId);
  assertSelfHash(probe, "receiptHash", "QMD_GENERATION_INVALID", pointer.generationId);
  assertSelfHash(deletion, "receiptHash", "QMD_GENERATION_INVALID", pointer.generationId);
  assertSelfHash(receipt, "receiptHash", "QMD_GENERATION_INVALID", pointer.generationId);
  if (!isManifestShape(manifest) || !isProbeShape(probe) || !isDeletionShape(deletion) || !isActiveReceiptShape(receipt)
    || manifest.schema !== "openlifewiki.qmd-generation-manifest/v1" || manifest.generationKey !== pointer.generationKey
    || manifest.manifestHash !== pointer.manifestHash || manifest.scanPlanHash !== pointer.scanPlanHash
    || manifest.skeletonVersion !== pointer.skeletonVersion || manifest.selectedSetHash !== sha256Canonical(manifest.entries)
    || probe.schema !== "openlifewiki.qmd-public-probe/v1" || probe.manifestHash !== manifest.manifestHash
    || probe.receiptHash !== pointer.publicProbeReceiptHash || deletion.receiptHash !== pointer.previousGenerationDeletionReceiptHash
    || receipt.schema !== "openlifewiki.active-qmd-manifest/v1" || receipt.receiptHash.length === 0
    || receipt.activePointerReceiptHash !== pointer.pointerHash
    || receipt.manifestHash !== sha256Canonical({ generationId: receipt.generationId, entries: receipt.entries })
    || receipt.scanId !== manifest.scanId || receipt.scanPlanHash !== manifest.scanPlanHash
    || receipt.skeletonVersion !== manifest.skeletonVersion || receipt.generationId !== manifest.generationId
    || sha256Canonical(receipt.entries) !== sha256Canonical(manifest.entries.map(
      ({ sourceId, nodeId, nodeVersion, bodyCheckpointReceiptHash }) => ({ sourceId, nodeId, nodeVersion, bodyCheckpointReceiptHash }),
    ))
    || receipt.publicProbeReceiptHash !== probe.receiptHash || receipt.previousGenerationDeletionReceiptHash !== deletion.receiptHash) {
    throw generationError("QMD_GENERATION_INVALID", "Active QMD receipts do not agree", pointer.generationId, "inspect");
  }
  return { pointer, manifest, probe, deletion, receipt };
}

async function readJson(path: string, generationId: string): Promise<Record<string, unknown>> {
  try { const value = JSON.parse(await readFile(path, "utf8")) as unknown; if (isRecord(value)) return value; }
  catch { /* sanitized below */ }
  throw generationError("QMD_GENERATION_INVALID", "Active QMD receipt is invalid", generationId, "inspect");
}

function assertSelfHash(value: object, field: string, code: "QMD_GENERATION_INVALID", generationId: string): void {
  const record = value as unknown as Record<string, unknown>;
  const stored = record[field];
  const payload = { ...record }; delete payload[field];
  if (typeof stored !== "string" || sha256Canonical(payload) !== stored) {
    throw generationError(code, "Active QMD receipt hash mismatch", generationId, "inspect");
  }
}

function publicationResult(status: QmdGenerationPublishResult["status"], loaded: LoadedActive): QmdGenerationPublishResult {
  return { status, active: inspectLoaded(loaded), manifestReceipt: loaded.receipt };
}

function inspectLoaded(loaded: LoadedActive): QmdActiveGenerationInspection {
  return { generationId: loaded.pointer.generationId, generationKey: loaded.pointer.generationKey,
    scanPlanHash: loaded.pointer.scanPlanHash, skeletonVersion: loaded.pointer.skeletonVersion,
    manifestHash: loaded.receipt.manifestHash, manifestReceiptHash: loaded.receipt.receiptHash,
    publicProbeReceiptHash: loaded.probe.receiptHash, selectedLeaves: loaded.manifest.entries.length,
    sourceIds: [...new Set(loaded.manifest.entries.map(({ sourceId }) => sourceId))].sort(), publishedAt: loaded.pointer.publishedAt };
}

function activeIdentity(active: LoadedActive | null): string { return active?.pointer.pointerHash ?? "none"; }
function safeGenerationKey(value: unknown): value is string { return typeof value === "string" && /^g-[a-f0-9]{64}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isActivePointerShape(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ["schema", "state", "generationId", "generationKey", "scanPlanHash", "skeletonVersion",
    "manifestHash", "publicProbeReceiptHash", "previousGenerationDeletionReceiptHash", "publishedAt", "pointerHash"])
    && value.schema === "openlifewiki.qmd-active-pointer/v1" && value.state === "active"
    && typeof value.generationId === "string" && IDENTIFIER.test(value.generationId)
    && safeGenerationKey(value.generationKey) && validHashes(value, ["scanPlanHash", "skeletonVersion", "manifestHash",
      "publicProbeReceiptHash", "previousGenerationDeletionReceiptHash", "pointerHash"])
    && validTimestamp(value.publishedAt);
}
function isManifestShape(value: QmdGenerationManifest): boolean {
  const record = value as unknown as Record<string, unknown>;
  return hasExactKeys(record, ["schema", "generationId", "generationKey", "scanId", "scanPlanHash", "skeletonVersion",
    "qmdVersion", "collection", "entries", "selectedSetHash", "builtAt", "manifestHash"])
    && value.schema === "openlifewiki.qmd-generation-manifest/v1" && IDENTIFIER.test(value.generationId)
    && safeGenerationKey(value.generationKey) && IDENTIFIER.test(value.scanId) && value.qmdVersion === QMD_RELEASE.version
    && value.collection === COLLECTION && validHashes(record, ["scanPlanHash", "skeletonVersion", "selectedSetHash", "manifestHash"])
    && validTimestamp(value.builtAt) && Array.isArray(value.entries) && value.entries.every(isManifestEntryShape);
}
function isManifestEntryShape(value: QmdManifestEntry): boolean {
  const record = value as unknown as Record<string, unknown>;
  return hasExactKeys(record, ["sourceId", "nodeId", "nodeVersion", "bodyCheckpointReceiptHash", "contentHash", "bytes", "document", "canary"])
    && IDENTIFIER.test(value.sourceId) && IDENTIFIER.test(value.nodeId) && typeof value.nodeVersion === "string" && value.nodeVersion.length > 0
    && validHashes(record, ["bodyCheckpointReceiptHash", "contentHash"])
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}\.md$/u.test(value.document)
    && /^olwkqmd_[a-f0-9]{64}$/u.test(value.canary) && value.document.slice(0, 64) === value.canary.slice("olwkqmd_".length);
}
function isProbeShape(value: QmdProbeReceipt): boolean {
  const record = value as unknown as Record<string, unknown>;
  return hasExactKeys(record, ["schema", "generationId", "manifestHash", "expectedCurrentCount", "historicalCanaryCount",
    "queryPassed", "getPassed", "stagingAbsent", "probedAt", "receiptHash"])
    && value.schema === "openlifewiki.qmd-public-probe/v1" && IDENTIFIER.test(value.generationId)
    && validHashes(record, ["manifestHash", "receiptHash"]) && Number.isSafeInteger(value.expectedCurrentCount)
    && value.expectedCurrentCount >= 0 && Number.isSafeInteger(value.historicalCanaryCount) && value.historicalCanaryCount >= 0
    && value.queryPassed === true && value.getPassed === true && value.stagingAbsent === true && validTimestamp(value.probedAt);
}
function isDeletionShape(value: QmdDeletionReceipt): boolean {
  const record = value as unknown as Record<string, unknown>;
  return hasExactKeys(record, ["schema", "generationId", "previousGenerationId", "previousGenerationKey", "deletedAt", "receiptHash"])
    && value.schema === "openlifewiki.qmd-prior-generation-deletion/v1" && IDENTIFIER.test(value.generationId)
    && (value.previousGenerationId === null || IDENTIFIER.test(value.previousGenerationId))
    && (value.previousGenerationKey === null || safeGenerationKey(value.previousGenerationKey))
    && ((value.previousGenerationId === null) === (value.previousGenerationKey === null))
    && validTimestamp(value.deletedAt) && HASH.test(value.receiptHash);
}
function isActiveReceiptShape(value: ActiveQmdManifestReceipt): boolean {
  const record = value as unknown as Record<string, unknown>;
  return hasExactKeys(record, ["schema", "scanId", "scanPlanHash", "skeletonVersion", "generationId", "entries", "manifestHash",
    "activePointerReceiptHash", "publicProbeReceiptHash", "previousGenerationDeletionReceiptHash", "publishedAt", "receiptHash"])
    && value.schema === "openlifewiki.active-qmd-manifest/v1" && IDENTIFIER.test(value.scanId) && IDENTIFIER.test(value.generationId)
    && validHashes(record, ["scanPlanHash", "skeletonVersion", "manifestHash", "activePointerReceiptHash", "publicProbeReceiptHash",
      "previousGenerationDeletionReceiptHash", "receiptHash"]) && validTimestamp(value.publishedAt) && Array.isArray(value.entries)
    && value.entries.every((entry) => {
      const item = entry as unknown as Record<string, unknown>;
      return hasExactKeys(item, ["sourceId", "nodeId", "nodeVersion", "bodyCheckpointReceiptHash"])
        && typeof entry.sourceId === "string" && IDENTIFIER.test(entry.sourceId) && typeof entry.nodeId === "string" && IDENTIFIER.test(entry.nodeId)
        && typeof entry.nodeVersion === "string" && entry.nodeVersion.length > 0 && HASH.test(entry.bodyCheckpointReceiptHash);
    });
}
function validHashes(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && HASH.test(value[field]));
}
function validTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function valueString(value: unknown, key: string): string { return isRecord(value) && typeof value[key] === "string" ? value[key] : "unknown"; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function generationError(
  code: "QMD_GENERATION_CONFLICT" | "QMD_GENERATION_FAILED" | "QMD_GENERATION_INVALID" | "QMD_GENERATION_RECOVERY_REQUIRED",
  message: string, generationId: string, phase: string,
): AdapterError {
  return new AdapterError(code, message, { publicDetails: { generationId, phase } });
}
