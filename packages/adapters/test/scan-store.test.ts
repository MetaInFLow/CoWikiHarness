import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createScanPlan,
  createTemporaryQmdGenerationFailureReceipt,
  sha256Canonical,
  type ScanPlan,
} from "@openlifewiki/protocol";
import {
  createScanLedger,
  createScanState,
  transitionScanState,
} from "@openlifewiki/core";

import {
  createScanStore,
  readScanStore,
  scanStoreStatePath,
  updateScanStore,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable scan store", () => {
  it("creates an owner-only hash-bound snapshot and reads it after restart", async () => {
    const dataDir = await temporaryDataDir();
    const plan = scanPlan();
    const created = await createScanStore({ dataDir, plan });

    expect(created).toMatchObject({
      schema: "openlifewiki.scan-store-snapshot/v1",
      revision: 0,
      plan,
      state: createScanState(plan.scanId),
      ledger: createScanLedger(plan),
      receipts: [],
      physicalIo: { counters: { initialReadItems: 0, rematerializedItems: 0 } },
    });
    expect((await stat(scanStoreStatePath(dataDir, plan.scanId))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "scans", plan.scanId))).mode & 0o777).toBe(0o700);
    expect(await readScanStore({ dataDir, scanId: plan.scanId })).toEqual(created);
  });

  it("serializes concurrent revision-CAS updates and rejects the stale writer", async () => {
    const dataDir = await temporaryDataDir();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });

    const results = await Promise.allSettled([
      updateScanStore({
        dataDir, scanId: plan.scanId, expectedRevision: 0,
        update: (snapshot) => ({ ...snapshot, state: transitionScanState(snapshot.state, { type: "approve-plan" }) }),
      }),
      updateScanStore({
        dataDir, scanId: plan.scanId, expectedRevision: 0,
        update: (snapshot) => ({ ...snapshot, state: transitionScanState(snapshot.state, { type: "cancel" }) }),
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 0, update: (snapshot) => snapshot,
    })).rejects.toMatchObject({ code: "SCAN_CONFLICT" });

    const lockPath = `${scanStoreStatePath(dataDir, plan.scanId)}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647, token: "terminated-writer",
    }));
    expect((await updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 1, update: (snapshot) => snapshot,
    })).revision).toBe(2);
  });

  it("rejects snapshot tampering, body-bearing fields and plan substitution", async () => {
    const dataDir = await temporaryDataDir();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const path = scanStoreStatePath(dataDir, plan.scanId);
    const tampered = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const unsigned: Record<string, unknown> = { ...tampered, body: "private source" };
    delete unsigned.snapshotHash;
    await writeFile(path, `${JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) })}\n`);
    await expect(readScanStore({ dataDir, scanId: plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });

    const hashDir = await temporaryDataDir();
    await createScanStore({ dataDir: hashDir, plan });
    const hashPath = scanStoreStatePath(hashDir, plan.scanId);
    const hashTampered = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, unknown>;
    await writeFile(hashPath, `${JSON.stringify({ ...hashTampered, snapshotHash: HASH_A })}\n`);
    await expect(readScanStore({ dataDir: hashDir, scanId: plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });

    const cleanDir = await temporaryDataDir();
    await createScanStore({ dataDir: cleanDir, plan });
    const otherPlan = scanPlan({ scanIntent: "A changed scan intent" });
    await expect(updateScanStore({
      dataDir: cleanDir,
      scanId: plan.scanId,
      expectedRevision: 0,
      update: (snapshot) => ({ ...snapshot, plan: otherPlan }),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("accepts only unique self-hashed plan-bound receipts and derived I/O accounting", async () => {
    const dataDir = await temporaryDataDir();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const receipt = createTemporaryQmdGenerationFailureReceipt({
      plan, generationId: "qmdgen_01", phase: "build", failedAt: "2026-07-27T00:00:00.000Z",
    });
    await updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 0,
      update: (snapshot) => ({ ...snapshot, receipts: [receipt] }),
    });

    await expect(updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      update: (snapshot) => ({
        ...snapshot,
        receipts: [...snapshot.receipts, { ...receipt, receiptHash: HASH_A }],
      }),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await expect(updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      update: (snapshot) => ({ ...snapshot, receipts: [...snapshot.receipts, receipt] }),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const wrongPlan = scanPlan({ scanIntent: "Changed" });
    const wrongReceipt = createTemporaryQmdGenerationFailureReceipt({
      plan: wrongPlan, generationId: "qmdgen_02", phase: "build", failedAt: "2026-07-27T00:00:00.000Z",
    });
    await expect(updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      update: (snapshot) => ({ ...snapshot, receipts: [...snapshot.receipts, wrongReceipt] }),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    await expect(updateScanStore({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      update: (snapshot) => ({
        ...snapshot,
        physicalIo: {
          ...snapshot.physicalIo,
          counters: { ...snapshot.physicalIo.counters, initialReadItems: 1 },
        },
      }),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });
});

function scanPlan(overrides: Partial<{ scanIntent: string }> = {}): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_01",
    sourceIds: ["source_local"],
    authorizationHashes: [HASH_A],
    rootNodeIds: ["root"],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: overrides.scanIntent ?? "Index current product documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

async function temporaryDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-scan-store-test-"));
  roots.push(root);
  return join(root, "data");
}
