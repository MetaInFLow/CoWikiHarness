import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createScanPlan, sha256Canonical, type RuntimeLayout, type ScanPlan } from "@openlifewiki/protocol";

import type { CommandOptions, CommandResult, CommandRunner } from "../src/command-runner.js";
import { resolveRuntimeLayout } from "../src/layout.js";
import {
  inspectActiveQmdGeneration,
  publishQmdCurrentGeneration,
  type QmdCurrentLeaf,
} from "../src/qmd-generation.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
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
    expect(result.manifestReceipt.manifestHash).toBe(sha256Canonical({
      generationId: result.manifestReceipt.generationId,
      entries: result.manifestReceipt.entries,
    }));
    expect((await inspectActiveQmdGeneration({ layout }))?.generationId).toBe("gen-a");
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
});

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
    sourceId: "source_local", nodeId, nodeVersion: `version-${hash(body).slice(-8)}`,
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
