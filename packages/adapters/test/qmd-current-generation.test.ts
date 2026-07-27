import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { calculateScanProgress, deriveScanProgress, type TrustedScanProgressEvidence } from "@openlifewiki/core";
import {
  createEnumerationIntent,
  createScanPlan,
  sha256Canonical,
  type ActiveQmdManifestReceipt,
  type EnumerationPageReceipt,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type RuntimeLayout,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanPlan,
} from "@openlifewiki/protocol";

import type { CommandOptions, CommandResult, CommandRunner } from "../src/command-runner.js";
import { resolveRuntimeLayout } from "../src/layout.js";
import {
  inspectActiveQmdGeneration,
  publishQmdCurrentGeneration,
  recoverQmdGenerationPublication,
  type QmdCurrentLeaf,
} from "../src/qmd-generation.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated active QMD generations", () => {
  it("publishes one body-free generation receipt using only isolated public QMD commands", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const secret = "private alpha source body";

    const result = await publishQmdCurrentGeneration({
      layout, runner, plan: plan(), generationId: "gen-a", leaves: [leaf("one", secret)],
      now: fixedClock("2026-07-27T01:00:00.000Z"),
    });

    expect(result.status).toBe("published");
    const activeManifest = await readActiveManifest(layout);
    expect(result.manifestReceipt.manifestHash).toBe(sha256Canonical({
      generationId: result.manifestReceipt.generationId,
      entries: result.manifestReceipt.entries,
    }));
    expect(result.manifestReceipt.manifestHash).not.toBe(activeManifest.manifestHash);
    expect(await inspectActiveQmdGeneration({ layout })).toMatchObject({
      generationId: "gen-a",
      manifestHash: result.manifestReceipt.manifestHash,
      internalManifestHash: activeManifest.manifestHash,
    });
    expect(await generationNames(layout)).toHaveLength(1);
    expect(await stagingNames(layout)).toEqual([]);
    const durableText = await readOwnedGenerationText(layout);
    expect(durableText).not.toContain(secret);
    expect(runner.calls.map(({ args }) => args.slice(0, 2))).toEqual(expect.arrayContaining([
      ["collection", "add"], ["update"], ["search", expect.any(String)], ["get", expect.any(String)],
    ]));
    for (const call of runner.calls) {
      expect(call.options.env?.QMD_CONFIG_DIR).toContain(join("qmd-current", "generations"));
      expect(call.options.env?.XDG_CACHE_HOME).toContain(join("qmd-current", "generations"));
      expect(call.options.env?.INDEX_PATH).toBeUndefined();
      expect(call.options.env?.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it("produces an active manifest that Core accepts as committed-index evidence", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const scanPlan = plan();
    const version = hash("alpha");
    const evidence = oneLeafProgressEvidence(scanPlan, version, "gen-a");
    const current = {
      ...leaf("leaf-1", "alpha"),
      bodyCheckpointReceiptHash: evidence.checkpoint.receiptHash,
    };
    const published = await publishQmdCurrentGeneration({
      layout, runner, plan: scanPlan, generationId: "gen-a", leaves: [current],
      now: fixedClock("2026-07-27T01:00:00.000Z"),
    });
    const activeQmdManifest = published.manifestReceipt;
    const trustedReceiptHashes = [
      ...evidence.trustedReceiptHashes,
      activeQmdManifest.receiptHash,
      activeQmdManifest.activePointerReceiptHash,
      activeQmdManifest.publicProbeReceiptHash,
      activeQmdManifest.previousGenerationDeletionReceiptHash,
    ];
    const progress = calculateScanProgress(deriveScanProgress({
      ...evidence.input,
      trustedReceiptHashes,
      activeQmdManifest,
    }));
    expect(progress.committedIndex).toEqual({ completed: 1, total: 1, percent: 100, complete: true });
  });

  it("replaces A with B and proves removed and replaced canaries are absent", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    await publish(layout, runner, "gen-a", [leaf("removed", "old removed"), leaf("changed", "old changed")]);
    const oldCanaries = await activeCanaries(layout);
    runner.calls.length = 0;

    await publish(layout, runner, "gen-b", [leaf("changed", "new changed"), leaf("added", "new added")]);

    expect((await inspectActiveQmdGeneration({ layout }))?.generationId).toBe("gen-b");
    expect(await generationNames(layout)).toHaveLength(1);
    const absentSearches = runner.calls.filter(({ args }) => args[0] === "search" && oldCanaries.includes(args[1]!));
    expect(absentSearches).toHaveLength(2);
  });

  it.each(["build", "search", "get"] as const)("rolls back a failed public QMD %s operation", async (failure) => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    await publish(layout, runner, "gen-a", [leaf("one", "alpha")]);
    runner.fail = failure;

    const failed = publish(layout, runner, "gen-b", [leaf("two", "beta")]);
    await expect(failed).rejects.toMatchObject({ code: "QMD_GENERATION_FAILED" });
    await expect(failed).rejects.not.toThrow("raw secret tool output");

    expect((await inspectActiveQmdGeneration({ layout }))?.generationId).toBe("gen-a");
    expect(await generationNames(layout)).toHaveLength(1);
    expect(await stagingNames(layout)).toEqual([]);
  });

  it("rejects an active-pointer CAS race and preserves the concurrent winner", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    await publish(layout, runner, "gen-a", [leaf("one", "alpha")]);
    runner.onFirstGet = async () => {
      await publish(layout, new FakeQmdRunner(), "gen-c", [leaf("three", "gamma")]);
    };

    await expect(publish(layout, runner, "gen-b", [leaf("two", "beta")]))
      .rejects.toMatchObject({ code: "QMD_GENERATION_CONFLICT" });
    expect((await inspectActiveQmdGeneration({ layout }))?.generationId).toBe("gen-c");
    expect(await generationNames(layout)).toHaveLength(1);
  });

  it("fails closed when the active pointer or immutable manifest is tampered", async () => {
    const layout = await temporaryLayout();
    await publish(layout, new FakeQmdRunner(), "gen-a", [leaf("one", "alpha")]);
    const pointerPath = join(layout.dataDir, "qmd-current", "active.json");
    const original = await readFile(pointerPath, "utf8");
    const pointer = JSON.parse(original) as Record<string, unknown>;
    await writeFile(pointerPath, JSON.stringify({ ...pointer, manifestHash: HASH_B }));
    await expect(inspectActiveQmdGeneration({ layout }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_INVALID" });

    await writeFile(pointerPath, original);
    const active = await inspectActiveQmdGeneration({ layout });
    expect(active).not.toBeNull();
    const manifestPath = join(layout.dataDir, "qmd-current", "generations", active!.generationKey, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, collection: "tampered" }));
    await expect(inspectActiveQmdGeneration({ layout }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_INVALID" });
  });

  it("is idempotent for the exact active generation and rejects same-id conflicts", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    let opens = 0;
    const current = leaf("one", "alpha", () => { opens += 1; });
    await publish(layout, runner, "gen-a", [current]);
    const repeated = await publish(layout, runner, "gen-a", [current]);
    expect(repeated.status).toBe("already-active");
    expect(opens).toBe(1);

    await expect(publish(layout, runner, "gen-a", [leaf("one", "different")]))
      .rejects.toMatchObject({ code: "QMD_GENERATION_CONFLICT" });
  });

  it("publishes an empty generation to remove every prior current document", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    await publish(layout, runner, "gen-a", [leaf("one", "alpha")]);
    const oldCanaries = await activeCanaries(layout);
    runner.calls.length = 0;

    const result = await publish(layout, runner, "gen-b", []);

    expect(result.active).toMatchObject({ generationId: "gen-b", selectedLeaves: 0, sourceIds: [] });
    expect(await generationNames(layout)).toHaveLength(1);
    expect(runner.calls.filter(({ args }) => args[0] === "search" && oldCanaries.includes(args[1]!))).toHaveLength(1);
  });

  it("rejects invalid UTF-8 and unpaired surrogate bodies before QMD build", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const invalidBytes = Buffer.from([0xc3, 0x28]);
    const badBytes: QmdCurrentLeaf = {
      sourceId: "source_local", nodeId: "bad-bytes", nodeVersion: HASH_B,
      bodyCheckpointReceiptHash: HASH_A, contentHash: hashBytes(invalidBytes), bytes: invalidBytes.length,
      openBody: () => (async function* () { yield invalidBytes; })(),
    };
    await expect(publishQmdCurrentGeneration({ layout, runner, plan: plan(), generationId: "bad-a", leaves: [badBytes] }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_FAILED" });

    const badText = "bad\ud800text";
    const bytes = Buffer.from(badText);
    const badString: QmdCurrentLeaf = {
      sourceId: "source_local", nodeId: "bad-string", nodeVersion: HASH_B,
      bodyCheckpointReceiptHash: HASH_A, contentHash: hashBytes(bytes), bytes: bytes.length,
      openBody: () => (async function* () { yield badText; })(),
    };
    await expect(publishQmdCurrentGeneration({ layout, runner, plan: plan(), generationId: "bad-b", leaves: [badString] }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_FAILED" });
    expect(runner.calls.some(({ args }) => args[0] === "collection")).toBe(false);
  });

  it.each(["materialized-body", "qmd-build", "public-probe", "immutable-manifest"])(
    "cleans dead pre-switch %s artifacts while preserving the active generation",
    async (phase) => {
      const layout = await temporaryLayout();
      const runner = new FakeQmdRunner();
      await publish(layout, runner, "gen-a", [leaf("one", "alpha")]);
      const orphanKey = `g-${"c".repeat(64)}`;
      const orphanGeneration = join(layout.dataDir, "qmd-current", "generations", orphanKey);
      const orphanStaging = join(layout.runtimeDir, "qmd-current", "staging", `${orphanKey}-999999-1`);
      await mkdir(orphanGeneration, { recursive: true });
      await mkdir(orphanStaging, { recursive: true });
      const staleBuildLock = join(layout.dataDir, "qmd-current", "build-locks", orphanKey);
      await mkdir(staleBuildLock, { recursive: true });
      await writeFile(join(staleBuildLock, "owner.json"), JSON.stringify({ pid: 99_999_999, token: "dead" }));
      await writeFile(join(orphanStaging, "source.md"), `private-${phase}`);
      if (phase !== "materialized-body") await mkdir(join(orphanGeneration, "qmd-cache"), { recursive: true });
      if (phase === "public-probe" || phase === "immutable-manifest") {
        await writeFile(join(orphanGeneration, "probe.partial"), "probe");
      }
      if (phase === "immutable-manifest") await writeFile(join(orphanGeneration, "manifest.json"), "{}");

      await expect(recoverQmdGenerationPublication({ layout, runner })).resolves.toMatchObject({ status: "already-active" });
      expect(await generationNames(layout)).toHaveLength(1);
      expect(await stagingNames(layout)).toEqual([]);
      expect(await readOwnedGenerationText(layout)).not.toContain(`private-${phase}`);
    },
  );

  it.each([
    "arbitrary-version",
    "token\nprivate-source-body",
    `secret-token-${"x".repeat(300)}`,
  ])("rejects unsafe opaque node version %s before creating durable generation data", async (nodeVersion) => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const unsafe = { ...leaf("one", "alpha"), nodeVersion };
    await expect(publishQmdCurrentGeneration({
      layout, runner, plan: plan(), generationId: "unsafe-version", leaves: [unsafe],
    })).rejects.toMatchObject({ code: "QMD_GENERATION_INVALID" });
    expect(await generationNames(layout)).toEqual([]);
    expect(await stagingNames(layout)).toEqual([]);
  });

  it("recovers a crash after the publishing pointer and deletes the prior generation", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const crash = await simulatePublishingCrash(layout, runner, false);
    const orphanKey = `g-${"f".repeat(64)}`;
    await mkdir(join(layout.dataDir, "qmd-current", "generations", orphanKey), { recursive: true });
    await mkdir(join(layout.runtimeDir, "qmd-current", "staging", `${orphanKey}-999999-1`), { recursive: true });
    runner.calls.length = 0;

    const recovered = await recoverQmdGenerationPublication({
      layout, runner, now: fixedClock("2026-07-27T03:00:00.000Z"),
    });
    expect(recovered).toMatchObject({ status: "published", active: { generationId: "gen-b" } });
    expect(await generationNames(layout)).toEqual([crash.currentKey]);
    expect(await stagingNames(layout)).toEqual([]);
    expect(runner.calls.filter(({ args }) => args[0] === "search")).toHaveLength(2);
    expect(runner.calls.filter(({ args }) => args[0] === "get")).toHaveLength(1);
    await expect(recoverQmdGenerationPublication({ layout, runner })).resolves.toMatchObject({ status: "already-active" });
  });

  it("preserves the prior generation when recovery public probes fail", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const crash = await simulatePublishingCrash(layout, runner, false);
    runner.fail = "search";

    await expect(recoverQmdGenerationPublication({ layout, runner }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_FAILED" });
    expect((await inspectActiveQmdGeneration({ layout }))?.generationId).toBe("gen-a");
    expect(await generationNames(layout)).toEqual([crash.previousKey]);
  });

  it("recovers byte-equivalently when deletion and active receipt were already written", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const crash = await simulatePublishingCrash(layout, runner, true);
    const receiptPath = join(layout.dataDir, "qmd-current", "generations", crash.currentKey, "receipt.json");
    const before = await readFile(receiptPath, "utf8");

    await expect(recoverQmdGenerationPublication({ layout, runner })).resolves.toMatchObject({
      status: "published", active: { generationId: "gen-b" },
    });
    expect(await readFile(receiptPath, "utf8")).toBe(before);
  });

  it("rejects a rehashed publishing pointer with a non-derived generation key before old deletion", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const crash = await simulatePublishingCrash(layout, runner, false);
    const activePath = join(layout.dataDir, "qmd-current", "active.json");
    const current = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    const { pointerHash: _old, ...payload } = current;
    const forged = { ...payload, generationKey: `g-${"d".repeat(64)}` };
    await writeFile(activePath, JSON.stringify({ ...forged, pointerHash: sha256Canonical(forged) }));

    await expect(recoverQmdGenerationPublication({ layout, runner }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_INVALID" });
    expect(await generationNames(layout)).toContain(crash.previousKey);
  });

  it("rejects a rehashed publishing pointer with a non-derived previous key before old deletion", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const crash = await simulatePublishingCrash(layout, runner, false);
    const activePath = join(layout.dataDir, "qmd-current", "active.json");
    const current = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    const previous = current.previousPointer as Record<string, unknown>;
    const { pointerHash: _previousHash, ...previousPayload } = previous;
    const forgedPreviousPayload = { ...previousPayload, generationKey: `g-${"d".repeat(64)}` };
    const forgedPrevious = {
      ...forgedPreviousPayload,
      pointerHash: sha256Canonical(forgedPreviousPayload),
    };
    const { pointerHash: _currentHash, ...currentPayload } = current;
    const forgedCurrentPayload = { ...currentPayload, previousPointer: forgedPrevious };
    await writeFile(activePath, JSON.stringify({
      ...forgedCurrentPayload,
      pointerHash: sha256Canonical(forgedCurrentPayload),
    }));

    await expect(recoverQmdGenerationPublication({ layout, runner }))
      .rejects.toMatchObject({ code: "QMD_GENERATION_INVALID" });
    expect(await generationNames(layout)).toContain(crash.previousKey);
  });

  it("cleans all dead artifacts with no active generation but leaves a live build owner untouched", async () => {
    const layout = await temporaryLayout();
    const runner = new FakeQmdRunner();
    const deadKey = `g-${"d".repeat(64)}`;
    const liveKey = `g-${"e".repeat(64)}`;
    for (const key of [deadKey, liveKey]) {
      await mkdir(join(layout.dataDir, "qmd-current", "generations", key), { recursive: true });
      await mkdir(join(layout.runtimeDir, "qmd-current", "staging", `${key}-${process.pid}-1`), { recursive: true });
    }
    const liveLock = join(layout.dataDir, "qmd-current", "build-locks", liveKey);
    await mkdir(liveLock, { recursive: true });
    await writeFile(join(liveLock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }));

    await expect(recoverQmdGenerationPublication({ layout, runner })).resolves.toMatchObject({ status: "nothing-to-recover" });
    expect(await generationNames(layout)).toEqual([liveKey]);
    expect(await stagingNames(layout)).toEqual([`${liveKey}-${process.pid}-1`]);
  });
});

async function simulatePublishingCrash(
  layout: RuntimeLayout,
  runner: CommandRunner,
  keepFinalReceipts: boolean,
): Promise<{ readonly previousKey: string; readonly currentKey: string }> {
  await publish(layout, runner, "gen-a", [leaf("one", "alpha")]);
  const root = join(layout.dataDir, "qmd-current");
  const previousPointer = JSON.parse(await readFile(join(root, "active.json"), "utf8")) as Record<string, unknown>;
  const previousKey = String(previousPointer.generationKey);
  const backup = join(layout.runtimeDir, `previous-generation-backup-${crypto.randomUUID()}`);
  await cp(join(root, "generations", previousKey), backup, { recursive: true });

  await publish(layout, runner, "gen-b", [leaf("two", "beta")]);
  const active = JSON.parse(await readFile(join(root, "active.json"), "utf8")) as Record<string, unknown>;
  const currentKey = String(active.generationKey);
  await cp(backup, join(root, "generations", previousKey), { recursive: true });
  if (!keepFinalReceipts) {
    await rm(join(root, "generations", currentKey, "deletion.json"));
    await rm(join(root, "generations", currentKey, "receipt.json"));
  }
  const publishingPayload = {
    schema: "openlifewiki.qmd-active-pointer/v1",
    state: "publishing",
    generationId: active.generationId,
    generationKey: active.generationKey,
    scanPlanHash: active.scanPlanHash,
    skeletonVersion: active.skeletonVersion,
    manifestHash: active.internalManifestHash ?? active.manifestHash,
    previousPointer,
    startedAt: String(active.publishedAt),
    publishedAt: String(active.publishedAt),
  };
  await writeFile(join(root, "active.json"), JSON.stringify({
    ...publishingPayload,
    pointerHash: sha256Canonical(publishingPayload),
  }));
  return { previousKey, currentKey };
}

function oneLeafProgressEvidence(scanPlan: ScanPlan, nodeVersion: string, generationId: string): {
  readonly checkpoint: ScanCheckpoint;
  readonly trustedReceiptHashes: readonly string[];
  readonly input: Omit<TrustedScanProgressEvidence, "trustedReceiptHashes" | "activeQmdManifest">;
} {
  const authorizationHash = scanPlan.authorizationHashes[0]!;
  const intent = createEnumerationIntent({
    plan: scanPlan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1", intentId: "intent-source-local", sourceId: "source_local",
      targetNodeId: "root", targetNodeVersion: HASH_A, authorizationHash, origin: "authorized-root",
      parentLayerNodeId: null, childSetHash: null, inputSetHash: HASH_A,
      createdAt: "2026-07-27T01:00:00.000Z",
    },
  });
  const page = signedReceipt<Omit<EnumerationPageReceipt, "receiptHash">>({
    schema: "openlifewiki.enumeration-page-receipt/v1", scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash, skeletonVersion: scanPlan.skeletonVersion,
    sourceId: "source_local", intentId: intent.intentId, pageSequence: 1, eventSequence: 1,
    previousPageReceiptHash: null, discoveredNodeIds: ["leaf-1"], knownUnenumeratedSlotIds: [],
    nextCursor: null, childCountKind: "known", state: "complete", childSetHash: HASH_C,
    observedAt: "2026-07-27T01:00:00.000Z",
  });
  const summary = signedReceipt<Omit<LayerSummaryReceipt, "receiptHash">>({
    schema: "openlifewiki.layer-summary-receipt/v1", scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash, skeletonVersion: scanPlan.skeletonVersion,
    sourceId: "source_local", intentId: intent.intentId, summaryHash: HASH_B, childSetHash: HASH_C,
    inputSetHash: HASH_A, persistedAt: "2026-07-27T01:00:00.000Z",
  });
  const decision = signedReceipt<Omit<ScanDecision, "receiptHash">>({
    schema: "openlifewiki.scan-decision/v1", scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash, skeletonVersion: scanPlan.skeletonVersion,
    authorizationHash, sourceId: "source_local", parentNodeId: "root", parentNodeVersion: HASH_A,
    childSetHash: HASH_C, nodeId: "leaf-1", nodeVersion, targetKind: "leaf", summaryHash: HASH_B,
    inputSetHash: HASH_A, decision: "descend", reason: "Selected current evidence", revisitCondition: null,
    question: null, actor: "agent-codex", estimatedCost: { nodes: 1, bodyBytes: 5, agentCalls: 1 },
    persistedAt: "2026-07-27T01:00:00.000Z",
  });
  const selection = signedReceipt<Omit<LeafSelectionReceipt, "receiptHash">>({
    schema: "openlifewiki.leaf-selection/v1", scanId: scanPlan.scanId, sourceId: "source_local",
    nodeId: "leaf-1", nodeVersion, scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion, authorizationHash, inputSetHash: HASH_A,
    decisionReceiptHash: decision.receiptHash, actor: "control-plane", reason: "Selected current evidence",
    persistedAt: "2026-07-27T01:00:00.000Z",
  });
  const checkpoint = signedReceipt<Omit<ScanCheckpoint, "receiptHash">>({
    schema: "openlifewiki.scan-checkpoint/v1", scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash, skeletonVersion: scanPlan.skeletonVersion,
    sourceId: "source_local", authorizationHash, nodeId: "leaf-1", nodeVersion,
    phase: "qmd-committed", indexingDisposition: "qmd-current", inputSetHash: HASH_A,
    qmdGenerationId: generationId,
  });
  const receipts = [intent, page, summary, decision, selection, checkpoint];
  return {
    checkpoint,
    trustedReceiptHashes: receipts.map(({ receiptHash }) => receiptHash),
    input: {
      plan: scanPlan, enumerationIntents: [intent], enumerationPages: [page], layerSummaries: [summary],
      decisions: [decision], leafSelections: [selection], checkpoints: [checkpoint], systemOutcomes: [],
    },
  };
}

function signedReceipt<T extends object>(payload: T): T & { readonly receiptHash: string } {
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

class FakeQmdRunner implements CommandRunner {
  readonly calls: Array<{ args: readonly string[]; options: CommandOptions }> = [];
  readonly indexes = new Map<string, Map<string, string>>();
  fail: "build" | "search" | "get" | null = null;
  onFirstGet: (() => Promise<void>) | undefined;

  async run(_command: string, args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ args, options });
    const config = options.env?.QMD_CONFIG_DIR;
    if (config === undefined) throw new Error("missing isolated config");
    if (args[0] === "collection" && args[1] === "add") {
      if (this.fail === "build") throw new Error("raw secret tool output");
      const stage = args[2]!;
      const docs = new Map<string, string>();
      for (const name of await readdir(stage)) docs.set(name, await readFile(join(stage, name), "utf8"));
      this.indexes.set(config, docs);
      return { stdout: "added", stderr: "" };
    }
    if (args[0] === "update") return { stdout: "updated", stderr: "" };
    if (args[0] === "search") {
      if (this.fail === "search") throw new Error("raw secret tool output");
      const query = args[1]!;
      const docs = this.indexes.get(config) ?? new Map();
      const matches = [...docs].filter(([, body]) => body.includes(query));
      return {
        stdout: JSON.stringify(matches.map(([name]) => ({ file: `qmd://openlifewiki-current/${name}` }))),
        stderr: "",
      };
    }
    if (args[0] === "get") {
      if (this.fail === "get") throw new Error("raw secret tool output");
      if (this.onFirstGet !== undefined) {
        const callback = this.onFirstGet;
        this.onFirstGet = undefined;
        await callback();
      }
      const name = args[1]!.split("/").at(-1)!.replace(/:\d+:\d+$/u, "");
      return { stdout: this.indexes.get(config)?.get(name) ?? "", stderr: "" };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  }
}

async function publish(layout: RuntimeLayout, runner: CommandRunner, generationId: string, leaves: QmdCurrentLeaf[]) {
  return publishQmdCurrentGeneration({
    layout, runner, plan: plan(), generationId, leaves,
    now: fixedClock(generationId === "gen-a" ? "2026-07-27T01:00:00.000Z" : "2026-07-27T02:00:00.000Z"),
  });
}

function leaf(nodeId: string, body: string, onOpen?: () => void): QmdCurrentLeaf {
  const bytes = Buffer.from(body);
  return {
    sourceId: "source_local", nodeId, nodeVersion: hash(body),
    bodyCheckpointReceiptHash: HASH_A, contentHash: hash(body), bytes: bytes.length,
    openBody() {
      onOpen?.();
      return (async function* () { yield bytes; })();
    },
  };
}

function plan(): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1", scanId: "scan-1", sourceIds: ["source_local"],
    authorizationHashes: [HASH_A], rootNodeIds: ["root"], skeletonVersion: HASH_B,
    agentProfileId: "codex", skillHash: HASH_A, scanIntent: "Index selected current evidence.",
    priorityDocumentRefs: [],
    policy: { include: ["**"], exclude: [], sensitivity: "normal", budget: { bodyBytes: 100_000 },
      indexing: { default: "qmd-current", rules: [] } },
  });
}

async function temporaryLayout(): Promise<RuntimeLayout> {
  const root = join(tmpdir(), `openlifewiki-qmd-generation-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return resolveRuntimeLayout({ OPENLIFEWIKI_HOME: join(root, "runtime-home"), OPENLIFEWIKI_WORKSPACE: join(root, "workspace") });
}

function fixedClock(value: string): () => Date { return () => new Date(value); }
function hash(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function hashBytes(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
async function generationNames(layout: RuntimeLayout): Promise<string[]> {
  return readdir(join(layout.dataDir, "qmd-current", "generations")).catch(() => []);
}
async function stagingNames(layout: RuntimeLayout): Promise<string[]> {
  return readdir(join(layout.runtimeDir, "qmd-current", "staging")).catch(() => []);
}
async function readOwnedGenerationText(layout: RuntimeLayout): Promise<string> {
  const [name] = await generationNames(layout);
  const directory = join(layout.dataDir, "qmd-current", "generations", name!);
  return Promise.all(["manifest.json", "probe.json", "receipt.json"].map((file) => readFile(join(directory, file), "utf8")))
    .then((parts) => parts.join("\n"));
}
async function activeCanaries(layout: RuntimeLayout): Promise<string[]> {
  const active = await inspectActiveQmdGeneration({ layout });
  const manifest = JSON.parse(await readFile(
    join(layout.dataDir, "qmd-current", "generations", active!.generationKey, "manifest.json"),
    "utf8",
  )) as { readonly entries: Array<{ readonly canary: string }> };
  return manifest.entries.map(({ canary }) => canary);
}
async function readActiveManifest(layout: RuntimeLayout): Promise<{ readonly manifestHash: string }> {
  const active = await inspectActiveQmdGeneration({ layout });
  return JSON.parse(await readFile(
    join(layout.dataDir, "qmd-current", "generations", active!.generationKey, "manifest.json"),
    "utf8",
  )) as { readonly manifestHash: string };
}
