import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
  type BodyObservationReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
} from "@openlifewiki/protocol";
import { createScanLedger, createScanState, transitionScanState } from "@openlifewiki/core";

import * as adapters from "../src/index.js";
import {
  approveScanPlan,
  controlScan,
  createScanStore,
  readScanStore,
  reserveScanBodyBudget,
  scanStoreStatePath,
} from "../src/index.js";
import {
  withActiveScanBodyLease,
  type ScanStoreSnapshot,
} from "../src/scan-store.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("typed durable scan transactions", () => {
  it("creates an owner-only restartable snapshot", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    const created = await createScanStore({ dataDir, plan });

    expect(created).toMatchObject({
      revision: 0,
      plan,
      state: createScanState(plan.scanId),
      ledger: createScanLedger(plan),
      receipts: [],
    });
    expect((await stat(scanStoreStatePath(dataDir, plan.scanId))).mode & 0o777).toBe(0o600);
    expect(await readScanStore({ dataDir, scanId: plan.scanId })).toEqual(created);
  });

  it("has no public generic mutation or standalone clear and cannot walk to Complete", async () => {
    expect((adapters as Record<string, unknown>).updateScanStore).toBeUndefined();
    expect((adapters as Record<string, unknown>).clearScanScratch).toBeUndefined();
    expect((adapters as Record<string, unknown>).recordScanPhysicalIo).toBeUndefined();
    expect((adapters as Record<string, unknown>).PhysicalIoObservationInput).toBeUndefined();
    expect((adapters as Record<string, unknown>).issueActiveBodyReadLease).toBeUndefined();
    expect((adapters as Record<string, unknown>).revokeActiveBodyReadLease).toBeUndefined();
    expect((adapters as Record<string, unknown>).withActiveScanBodyLease).toBeUndefined();
    const { dataDir, runtimeDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const probing = await approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 });
    expect(probing.state.phase).toBe("Probing");

    await expect(controlScan({
      dataDir,
      runtimeDir,
      scanId: plan.scanId,
      expectedRevision: 1,
      event: { type: "qmd-published" } as never,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    await expect(approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect((await readScanStore({ dataDir, scanId: plan.scanId }))?.state.phase).toBe("Probing");
  });

  it("clears exact scratch before pause and rolls back when cleanup fails", async () => {
    const { dataDir, runtimeDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    await approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 });
    const scratch = join(runtimeDir, "scans", plan.scanId, "layer-summary.json");
    await mkdir(join(runtimeDir, "scans", plan.scanId), { recursive: true });
    await writeFile(scratch, "disposable");

    const paused = await controlScan({
      dataDir, runtimeDir, scanId: plan.scanId, expectedRevision: 1, event: { type: "pause" },
    });
    expect(paused.state.phase).toBe("Paused");
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });

    const failed = await temporaryLayout();
    const failedData = failed.dataDir;
    const blockedRuntime = failed.runtimeDir;
    await createScanStore({ dataDir: failedData, plan });
    await approveScanPlan({ dataDir: failedData, scanId: plan.scanId, expectedRevision: 0 });
    await mkdir(blockedRuntime, { recursive: true });
    await writeFile(join(blockedRuntime, "scans"), "not-a-directory");
    await expect(controlScan({
      dataDir: failedData,
      runtimeDir: blockedRuntime,
      scanId: plan.scanId,
      expectedRevision: 1,
      event: { type: "pause" },
    })).rejects.toBeDefined();
    expect(await readScanStore({ dataDir: failedData, scanId: plan.scanId })).toMatchObject({
      revision: 1, state: { phase: "Probing" },
    });
  });

  it("rejects unknown durable receipt schemas even with a valid self-hash", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const path = scanStoreStatePath(dataDir, plan.scanId);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const payload = {
      schema: "openlifewiki.unknown-receipt/v1",
      scanId: plan.scanId,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
    };
    const unknown = { ...payload, receiptHash: sha256Canonical(payload) };
    const unsigned = { ...snapshot, receipts: [unknown] } as Record<string, unknown>;
    delete unsigned.snapshotHash;
    await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));

    await expect(readScanStore({ dataDir, scanId: plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("derives body reservations from current accounting and rejects stale and excess requests", async () => {
    const { dataDir, source, plan, accountingHash } = await selectedReadingFixture();
    const first = await reserveScanBodyBudget({
      dataDir,
      scanId: plan.scanId,
      expectedRevision: 0,
      expectedPhysicalIoAccountingHash: accountingHash,
      source,
      nodeId: "leaf",
      nodeVersion: "v1",
      reservedBytes: 600_000,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    expect(first.reservation).toMatchObject({
      physicalIoAccountingHash: accountingHash,
      remainingBeforeBytes: 700_000,
      reservedBytes: 600_000,
    });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: accountingHash,
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 600_000,
    })).rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: HASH_B,
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 1,
    })).rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    await expect(reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      expectedPhysicalIoAccountingHash: accountingHash,
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 700_001,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("reserves body budget only for durable selected work in ReadingLeaves", async () => {
    const draft = await temporaryLayout();
    const source = authorizedSource();
    const plan = scanPlan(source.authorizationHash);
    const created = await createScanStore({ dataDir: draft.dataDir, plan });
    await expect(reserveScanBodyBudget({
      dataDir: draft.dataDir, scanId: plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: sha256Canonical(created.physicalIo),
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const selected = await selectedReadingFixture();
    await expect(reserveScanBodyBudget({
      dataDir: selected.dataDir, scanId: selected.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: selected.accountingHash,
      source: selected.source, nodeId: "other", nodeVersion: "v1", reservedBytes: 10,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const paused = await controlScan({
      dataDir: selected.dataDir, runtimeDir: selected.runtimeDir,
      scanId: selected.plan.scanId, expectedRevision: 0, event: { type: "pause" },
    });
    await expect(reserveScanBodyBudget({
      dataDir: selected.dataDir, scanId: selected.plan.scanId, expectedRevision: paused.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(paused.physicalIo),
      source: selected.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const cancelled = await selectedReadingFixture();
    const stopped = await controlScan({
      dataDir: cancelled.dataDir, runtimeDir: cancelled.runtimeDir,
      scanId: cancelled.plan.scanId, expectedRevision: 0, event: { type: "cancel" },
    });
    await expect(reserveScanBodyBudget({
      dataDir: cancelled.dataDir, scanId: cancelled.plan.scanId, expectedRevision: stopped.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(stopped.physicalIo),
      source: cancelled.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("uses one JIT reservation and charges subsequent leaves by durable actual bytes", async () => {
    const fixture = await selectedReadingFixture(["leaf-a", "leaf-b"]);
    const first = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf-a", nodeVersion: "v1", reservedBytes: 600_000,
      now: () => new Date("2026-07-27T00:00:01.000Z"),
    });
    await expect(reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: first.snapshot.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(first.snapshot.physicalIo),
      source: fixture.source, nodeId: "leaf-b", nodeVersion: "v1", reservedBytes: 1,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const selection = fixture.selections.find(({ nodeId }) => nodeId === "leaf-a")!;
    const observation = bodyObservation(fixture.plan, selection, 100_000);
    const consumed = await recordTrustedScanPhysicalIo({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: first.snapshot.revision,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: first.reservation }],
    });
    await expect(reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: consumed.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(consumed.physicalIo),
      source: fixture.source, nodeId: "leaf-a", nodeVersion: "v1", reservedBytes: 1,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    const second = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: consumed.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(consumed.physicalIo),
      source: fixture.source, nodeId: "leaf-b", nodeVersion: "v1", reservedBytes: 600_000,
      now: () => new Date("2026-07-27T00:00:02.000Z"),
    });
    expect(second.reservation).toMatchObject({ remainingBeforeBytes: 600_000, reservedBytes: 600_000 });
  });

  it("reads selected leaves sequentially across four sources", async () => {
    const { dataDir } = await temporaryLayout();
    const sources = [1, 2, 3, 4].map((number) => authorizedSource(`source_${number}`));
    const plan = scanPlanForSources(sources);
    let snapshot = await createScanStore({ dataDir, plan });
    const selected = sources.map((source, index) => leafSelection(plan, `leaf-${index + 1}`, source.sourceId));
    await appendDecisionFixture(
      dataDir,
      plan,
      selected.map(({ decision }) => decision),
      selected.map(({ selection }) => selection),
    );
    await forceReadingLeavesFixture(dataDir, plan.scanId);

    for (const [index, source] of sources.entries()) {
      const { selection } = selected[index]!;
      const reserved = await reserveScanBodyBudget({
        dataDir, scanId: plan.scanId, expectedRevision: snapshot.revision,
        expectedPhysicalIoAccountingHash: sha256Canonical(snapshot.physicalIo),
        source, nodeId: selection.nodeId, nodeVersion: selection.nodeVersion, reservedBytes: 200_000,
        now: () => new Date(`2026-07-27T00:00:0${index + 1}.000Z`),
      });
      snapshot = await recordTrustedScanPhysicalIo({
        dataDir, scanId: plan.scanId, expectedRevision: reserved.snapshot.revision,
        observations: [{
          observation: bodyObservation(plan, selection, 100_000),
          selectionReceipt: selection,
          budgetReservation: reserved.reservation,
        }],
      });
    }

    expect(snapshot.physicalIo.counters).toMatchObject({ initialReadItems: 4, initialReadBytes: 400_000 });
  });

  it("reuses only an exact request and rejects same-epoch reservation replacement", async () => {
    const fixture = await selectedReadingFixture();
    const first = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
      now: () => new Date("2026-07-27T00:00:01.000Z"),
    });
    const reused = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: first.snapshot.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(first.snapshot.physicalIo),
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
      now: () => new Date("2026-07-27T00:00:02.000Z"),
    });
    expect(reused.reservation.receiptHash).toBe(first.reservation.receiptHash);
    expect(reused.snapshot.revision).toBe(first.snapshot.revision);
    await expect(reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: first.snapshot.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(first.snapshot.physicalIo),
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const selection = fixture.selections[0]!;
    const observation = bodyObservation(fixture.plan, selection, 10);
    await expect(recordTrustedScanPhysicalIo({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: first.snapshot.revision,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: first.reservation }],
    })).resolves.toMatchObject({ physicalIo: { counters: { initialReadBytes: 10, initialReadItems: 1 } } });
  });

  it("invalidates an unconsumed reservation across pause and resume", async () => {
    const fixture = await selectedReadingFixture();
    const first = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
      now: () => new Date("2026-07-27T00:00:01.000Z"),
    });
    const paused = await controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: first.snapshot.revision, event: { type: "pause" },
    });
    const resumed = await controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: paused.revision, event: { type: "resume" },
    });
    await expect(withActiveScanBodyLease({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: resumed.revision,
      sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
      open: async () => { throw new Error("must not run"); },
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });

    const replacement = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: resumed.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(resumed.physicalIo),
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    });
    const observation = bodyObservation(fixture.plan, fixture.selections[0]!, 10);
    await expect(recordTrustedScanPhysicalIo({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: replacement.snapshot.revision,
      observations: [{ observation, selectionReceipt: fixture.selections[0]!, budgetReservation: first.reservation }],
    }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect(replacement.reservation.reservedBytes).toBe(10);
  });

  it("invalidates an unconsumed reservation across failure and retry", async () => {
    const fixture = await selectedReadingFixture();
    const first = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    });
    const failed = await controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: first.snapshot.revision,
      event: { type: "fail", retryPhase: "ReadingLeaves", code: "BODY_READ_FAILED" },
    });
    const retried = await controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: failed.revision, event: { type: "retry" },
    });
    await expect(withActiveScanBodyLease({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: retried.revision,
      sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
      open: async () => { throw new Error("must not run"); },
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    await expect(reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: retried.revision,
      expectedPhysicalIoAccountingHash: sha256Canonical(retried.physicalIo),
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    })).resolves.toMatchObject({ reservation: { scanTransitionSequence: retried.state.transitionSequence } });
  });

  it("serializes pause behind an atomic body read and leaves a consistent committed observation", async () => {
    const fixture = await selectedReadingFixture();
    const reserved = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const bodyRead = withActiveScanBodyLease({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: reserved.snapshot.revision,
      sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
      open: async () => ({
        sourceId: fixture.source.sourceId,
        nodeId: "leaf",
        nodeVersion: "v1",
        stream: (async function* () {
          entered.resolve();
          await release.promise;
          yield new Uint8Array(10);
        })(),
      }),
    });
    await entered.promise;
    let pauseSettled = false;
    const pauseAttempt = controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: reserved.snapshot.revision, event: { type: "pause" },
    });
    void pauseAttempt.then(() => { pauseSettled = true; }, () => { pauseSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pauseSettled).toBe(false);
    release.resolve();
    const committed = await bodyRead;
    await expect(pauseAttempt).rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect(committed.snapshot.physicalIo.counters.initialReadBytes).toBe(10);
    const paused = await controlScan({
      dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
      expectedRevision: committed.snapshot.revision, event: { type: "pause" },
    });
    expect(paused.state.phase).toBe("Paused");
    expect(committed).not.toHaveProperty("stream");
  });

  it.each(["sink", "stream"] as const)("persists no body evidence when the %s fails mid-read", async (failure) => {
    const fixture = await selectedReadingFixture();
    const reserved = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    });
    await expect(withActiveScanBodyLease({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: reserved.snapshot.revision,
      sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
      open: async () => ({
        sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
        stream: (async function* () {
          yield new TextEncoder().encode("first");
          if (failure === "stream") throw new Error("read failed");
          yield new TextEncoder().encode("second");
        })(),
      }),
      ...(failure === "sink"
        ? { onChunk: async () => { throw new Error("stage failed"); } }
        : {}),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    const after = await readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId });
    expect(after?.revision).toBe(reserved.snapshot.revision);
    expect(after?.receipts.filter((receipt) => (
      (receipt as { schema?: string }).schema === "openlifewiki.body-observation-receipt/v1"
      || (receipt as { schema?: string }).schema === "openlifewiki.body-read-commit/v1"
    ))).toEqual([]);
  });

  it("rejects invalid streaming UTF-8 after a partial stage without committing body evidence", async () => {
    const fixture = await selectedReadingFixture();
    const reserved = await reserveScanBodyBudget({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: fixture.accountingHash,
      source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
    });
    const staged: Uint8Array[] = [];
    await expect(withActiveScanBodyLease({
      dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: reserved.snapshot.revision,
      sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
      open: async () => ({
        sourceId: fixture.source.sourceId, nodeId: "leaf", nodeVersion: "v1",
        stream: (async function* () {
          yield new TextEncoder().encode("valid");
          yield Uint8Array.of(0xc3);
        })(),
      }),
      onChunk: async (chunk) => { staged.push(chunk); },
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect(staged.length).toBeGreaterThan(0);
    const after = await readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId });
    expect(after?.physicalIo.counters.initialReadItems).toBe(0);
    expect(after?.receipts.some((receipt) => (
      (receipt as { schema?: string }).schema === "openlifewiki.body-read-commit/v1"
    ))).toBe(false);
  });

  it("rejects rehashed observations with missing, old or future epoch commits", async () => {
    const cases = ["missing-commit", "old-epoch-commit", "future-epoch-commit"] as const;
    for (const scenario of cases) {
      const fixture = await selectedReadingFixture();
      const reserved = await reserveScanBodyBudget({
        dataDir: fixture.dataDir, scanId: fixture.plan.scanId, expectedRevision: 0,
        expectedPhysicalIoAccountingHash: fixture.accountingHash,
        source: fixture.source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 20,
      });
      let snapshot = reserved.snapshot;
      if (scenario === "old-epoch-commit") {
        const paused = await controlScan({
          dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
          expectedRevision: snapshot.revision, event: { type: "pause" },
        });
        snapshot = await controlScan({
          dataDir: fixture.dataDir, runtimeDir: fixture.runtimeDir, scanId: fixture.plan.scanId,
          expectedRevision: paused.revision, event: { type: "resume" },
        });
      }
      const observation = bodyObservation(fixture.plan, fixture.selections[0]!, 10);
      const { receiptHash: _oldReservationHash, ...oldReservationPayload } = reserved.reservation;
      const forgedReservationPayload = {
        ...oldReservationPayload,
        scanTransitionSequence: scenario === "future-epoch-commit"
          ? snapshot.state.transitionSequence + 1
          : oldReservationPayload.scanTransitionSequence,
        reservedAt: "2026-07-27T00:00:09.000Z",
      };
      const forgedOldEpochReservation = {
        ...forgedReservationPayload,
        receiptHash: sha256Canonical(forgedReservationPayload),
      };
      const reservationForCommit = scenario === "missing-commit"
        ? reserved.reservation
        : forgedOldEpochReservation;
      const commitPayload = {
        schema: "openlifewiki.body-read-commit/v1",
        scanId: fixture.plan.scanId,
        scanPlanHash: fixture.plan.scanPlanHash,
        skeletonVersion: fixture.plan.skeletonVersion,
        sourceId: fixture.source.sourceId,
        nodeId: "leaf",
        nodeVersion: "v1",
        reservationReceiptHash: reservationForCommit.receiptHash,
        observationReceiptHash: observation.receiptHash,
        scanTransitionSequence: reservationForCommit.scanTransitionSequence,
        committedAt: "2026-07-27T00:00:10.000Z",
      } as const;
      const commit = { ...commitPayload, receiptHash: sha256Canonical(commitPayload) };
      const path = scanStoreStatePath(fixture.dataDir, fixture.plan.scanId);
      const unsigned = {
        ...snapshot,
        receipts: [
          ...snapshot.receipts,
          ...(scenario === "missing-commit" ? [] : [forgedOldEpochReservation]),
          observation,
          ...(scenario === "missing-commit" ? [] : [commit]),
        ],
        physicalIo: {
          schema: "openlifewiki.scan-physical-io/v1",
          observedReceiptHashes: [observation.receiptHash],
          counters: { initialReadItems: 1, initialReadBytes: 10, rematerializedItems: 0, rematerializedBytes: 0 },
        },
      } as Record<string, unknown>;
      delete unsigned.snapshotHash;
      await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));
      await expect(readScanStore({ dataDir: fixture.dataDir, scanId: fixture.plan.scanId }))
        .rejects.toMatchObject({ code: "SCAN_INVALID" });
    }
  });

  it("keeps caller-authored physical I/O internal and binds it to one durable reservation", async () => {
    const { dataDir, source, plan, selections, accountingHash } = await selectedReadingFixture();
    const reserved = await reserveScanBodyBudget({
      dataDir, scanId: plan.scanId, expectedRevision: 0,
      expectedPhysicalIoAccountingHash: accountingHash,
      source, nodeId: "leaf", nodeVersion: "v1", reservedBytes: 10,
    });
    const selection = selections[0]!;
    const observation = bodyObservation(plan, selection, 10);

    const recorded = await recordTrustedScanPhysicalIo({
      dataDir, scanId: plan.scanId, expectedRevision: 1,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: reserved.reservation }],
    });
    expect(recorded.physicalIo.counters).toMatchObject({ initialReadItems: 1, initialReadBytes: 10 });
    await expect(recordTrustedScanPhysicalIo({
      dataDir, scanId: plan.scanId, expectedRevision: 2,
      observations: [{ observation, selectionReceipt: selection, budgetReservation: reserved.reservation }],
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("never takes over an incomplete stale lock directory", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const lock = `${scanStoreStatePath(dataDir, plan.scanId)}.lock`;
    await mkdir(lock, { mode: 0o700 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);

    await expect(approveScanPlan({ dataDir, scanId: plan.scanId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect((await readScanStore({ dataDir, scanId: plan.scanId }))?.revision).toBe(0);
    await rm(lock, { recursive: true, force: true });
  }, 5_000);

  it("rejects a rehashed durable decision with nested private payload fields", async () => {
    const { dataDir } = await temporaryLayout();
    const plan = scanPlan();
    await createScanStore({ dataDir, plan });
    const valid = containerDecision(plan);
    const { receiptHash: _receiptHash, ...validPayload } = valid;
    const forgedPayload = {
      ...validPayload,
      question: { body: "private source body" },
    };
    const forged = { ...forgedPayload, receiptHash: sha256Canonical(forgedPayload) };

    await appendDecisionFixture(dataDir, plan, forged as never);

    await expect(readScanStore({ dataDir, scanId: plan.scanId }))
      .rejects.toMatchObject({ code: "SCAN_INVALID" });
  });

  it("rejects rehashed durable decisions with invalid atomic or outcome fields", async () => {
    const mutations: readonly Readonly<Record<string, unknown>>[] = [
      { actor: { body: "private source body" } },
      { reason: "x".repeat(8_193) },
      { targetKind: { body: "private source body" } },
      { decision: "defer", revisitCondition: null },
      { decision: "ask-user", question: null },
      { decision: "skip", question: "not allowed" },
    ];
    for (const mutation of mutations) {
      const { dataDir } = await temporaryLayout();
      const plan = scanPlan();
      await createScanStore({ dataDir, plan });
      const { receiptHash: _receiptHash, ...validPayload } = containerDecision(plan);
      const forgedPayload = { ...validPayload, ...mutation };
      const forged = { ...forgedPayload, receiptHash: sha256Canonical(forgedPayload) };
      await appendDecisionFixture(dataDir, plan, forged as never);

      await expect(readScanStore({ dataDir, scanId: plan.scanId }))
        .rejects.toMatchObject({ code: "SCAN_INVALID" });
    }
  });

});

function scanPlan(authorizationHash = HASH_A): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_01",
    sourceIds: ["source_local"],
    authorizationHashes: [authorizationHash],
    rootNodeIds: ["root"],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: "Index current product documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function scanPlanForSources(sources: readonly AuthorizedSourceV1[]): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_multi",
    sourceIds: sources.map(({ sourceId }) => sourceId),
    authorizationHashes: sources.map(({ authorizationHash }) => authorizationHash),
    rootNodeIds: sources.map(({ rootNodeId }) => rootNodeId),
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: "Index current product documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function authorizedSource(sourceId = "source_local"): AuthorizedSourceV1 {
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint: HASH_A,
    previewHash: HASH_A,
    configHash: HASH_A,
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const approval = { ...approvalUnsigned, approvalHash: sha256Canonical(approvalUnsigned) };
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId,
    connectorType: "local-folder" as const,
    rootNodeId: "root",
    identityFingerprint: HASH_A,
    approval,
    scope: { schema: "openlifewiki.scope/local-folder/v1" as const, root: "/approved", symlinkPolicy: "deny" as const },
    include: ["**/*.md"],
    exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 700_000, maxAgentCalls: 10 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
}

async function temporaryLayout(): Promise<{ readonly dataDir: string; readonly runtimeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-scan-store-test-"));
  roots.push(root);
  return { dataDir: join(root, "data"), runtimeDir: join(root, "runtime") };
}

function leafSelection(
  plan: ScanPlan,
  nodeId = "leaf",
  sourceId = "source_local",
): { readonly decision: ScanDecision; readonly selection: LeafSelectionReceipt } {
  const sourceIndex = plan.sourceIds.indexOf(sourceId);
  if (sourceIndex < 0) throw new Error(`Unknown fixture Source: ${sourceId}`);
  const authorizationHash = plan.authorizationHashes[sourceIndex]!;
  const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash, sourceId,
    parentNodeId: "root", parentNodeVersion: "root-v1", childSetHash: HASH_A, nodeId, nodeVersion: "v1",
    targetKind: "leaf", summaryHash: HASH_A, inputSetHash: HASH_A, decision: "descend", reason: "selected",
    revisitCondition: null, question: null, actor: plan.agentProfileId,
    estimatedCost: { nodes: 1, bodyBytes: 10, agentCalls: 0 }, persistedAt: "2026-07-27T00:00:00.000Z",
  };
  const decision = { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1", scanId: plan.scanId, sourceId, nodeId,
    nodeVersion: "v1", scanPlanHash: plan.scanPlanHash, skeletonVersion: plan.skeletonVersion,
    authorizationHash, inputSetHash: HASH_A, decisionReceiptHash: decision.receiptHash,
    actor: plan.agentProfileId, reason: "selected", persistedAt: "2026-07-27T00:00:00.000Z",
  };
  return { decision, selection: { ...selectionPayload, receiptHash: sha256Canonical(selectionPayload) } };
}

function containerDecision(plan: ScanPlan): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: plan.authorizationHashes[0]!, sourceId: "source_local",
    parentNodeId: "root", parentNodeVersion: "root-v1", childSetHash: HASH_A, nodeId: "child", nodeVersion: "child-v1",
    targetKind: "container", summaryHash: HASH_A, inputSetHash: HASH_A, decision: "descend", reason: "scan child",
    revisitCondition: null, question: null, actor: plan.agentProfileId,
    estimatedCost: { nodes: 1, bodyBytes: 0, agentCalls: 1 }, persistedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function bodyObservation(plan: ScanPlan, selection: LeafSelectionReceipt, bytes: number): BodyObservationReceipt {
  const payload: Omit<BodyObservationReceipt, "receiptHash"> = {
    schema: "openlifewiki.body-observation-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: selection.authorizationHash, sourceId: selection.sourceId,
    nodeId: selection.nodeId, nodeVersion: selection.nodeVersion, inputSetHash: selection.inputSetHash,
    selectionReceiptHash: selection.receiptHash, contentHash: HASH_A, bytes, purpose: "initial-read",
    rematerializationAuthorizationHash: null, previousObservationReceiptHash: null,
    observedAt: "2026-07-27T00:00:01.000Z",
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

async function appendDecisionFixture(
  dataDir: string,
  plan: ScanPlan,
  decisionInput: ScanDecision | readonly ScanDecision[],
  selectionInput?: LeafSelectionReceipt | readonly LeafSelectionReceipt[],
): Promise<void> {
  const decisions = Array.isArray(decisionInput) ? decisionInput : [decisionInput];
  const selections = selectionInput === undefined
    ? []
    : Array.isArray(selectionInput) ? selectionInput : [selectionInput];
  const path = scanStoreStatePath(dataDir, plan.scanId);
  const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const sourceIds = [...new Set(decisions.map(({ sourceId }) => sourceId))];
  const summaries: object[] = [];
  const invocations: object[] = [];
  const entries: object[] = [];
  let previousEntryHash: string | null = null;
  sourceIds.forEach((sourceId, index) => {
    const sequence = index + 1;
    const intentId = `fixture-intent-${sequence}`;
    const summaryPayload = {
      schema: "openlifewiki.layer-summary-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion, sourceId, intentId,
      summaryHash: HASH_A, childSetHash: HASH_A, inputSetHash: HASH_A, persistedAt: "2026-07-27T00:00:00.000Z",
    };
    const summary = { ...summaryPayload, receiptHash: sha256Canonical(summaryPayload) };
    const invocationPayload = {
      schema: "openlifewiki.agent-scan-invocation-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion, sourceId, layerHash: HASH_A, operationId: `fixture-op-${sequence}`,
      inputSetHash: HASH_A, skillHash: plan.skillHash,
      agent: { id: plan.agentProfileId, runtime: "codex", mode: "native-cli", driverContractVersion: "v1" },
      runtimeVersion: "1.0.0", outputSchemaId: "openlifewiki.agent-scan-result/v1",
      outputSchemaHash: HASH_A, resultHash: HASH_A, invokedAt: "2026-07-27T00:00:00.000Z",
    };
    const invocation = { ...invocationPayload, receiptHash: sha256Canonical(invocationPayload) };
    const batch = {
      summaryReceiptHash: summary.receiptHash, agentInvocationReceiptHash: invocation.receiptHash,
      agentResultHash: invocation.resultHash,
      agentDecisionReceiptHashes: decisions.filter((decision) => decision.sourceId === sourceId)
        .map(({ receiptHash }) => receiptHash),
      systemOutcomeReceiptHashes: [],
    };
    const entryPayload = {
      schema: "openlifewiki.scan-ledger-entry/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion, sequence, previousEntryHash, sourceId,
      intentId, parentNodeId: "root", ...batch, batchHash: sha256Canonical(batch),
      committedAt: "2026-07-27T00:00:00.000Z",
    };
    const entry = { ...entryPayload, entryHash: sha256Canonical(entryPayload) };
    summaries.push(summary);
    invocations.push(invocation);
    entries.push(entry);
    previousEntryHash = entry.entryHash;
  });
  const ledger = { ...(snapshot.ledger as object), entries, headHash: previousEntryHash };
  const receipts = [
    ...snapshot.receipts as object[], ...summaries, ...invocations, ...decisions, ...selections,
  ];
  const unsigned = { ...snapshot, ledger, receipts } as Record<string, unknown>;
  delete unsigned.snapshotHash;
  await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));
}

async function selectedReadingFixture(nodeIds: readonly string[] = ["leaf"]): Promise<{
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly source: AuthorizedSourceV1;
  readonly plan: ScanPlan;
  readonly selections: readonly LeafSelectionReceipt[];
  readonly accountingHash: string;
}> {
  const layout = await temporaryLayout();
  const source = authorizedSource();
  const plan = scanPlan(source.authorizationHash);
  const created = await createScanStore({ dataDir: layout.dataDir, plan });
  const selected = nodeIds.map((nodeId) => leafSelection(plan, nodeId));
  await appendDecisionFixture(
    layout.dataDir,
    plan,
    selected.map(({ decision }) => decision),
    selected.map(({ selection }) => selection),
  );
  await forceReadingLeavesFixture(layout.dataDir, plan.scanId);
  return {
    ...layout,
    source,
    plan,
    selections: selected.map(({ selection }) => selection),
    accountingHash: sha256Canonical(created.physicalIo),
  };
}

async function forceReadingLeavesFixture(dataDir: string, scanId: string): Promise<void> {
  const path = scanStoreStatePath(dataDir, scanId);
  const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  let state = createScanState(scanId);
  for (const event of [
    { type: "approve-plan" },
    { type: "probe-connected" },
    { type: "layer-discovered" },
    { type: "layer-summarized" },
    { type: "continue-discovery" },
    { type: "frontier-discovered" },
  ] as const) state = transitionScanState(state, event);
  const unsigned = { ...snapshot, state } as Record<string, unknown>;
  delete unsigned.snapshotHash;
  await writeFile(path, JSON.stringify({ ...unsigned, snapshotHash: sha256Canonical(unsigned) }));
}

async function recordTrustedScanPhysicalIo(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly observations: readonly {
    readonly observation: BodyObservationReceipt;
    readonly selectionReceipt: LeafSelectionReceipt;
    readonly budgetReservation: import("../src/connectors/connector-provider.js").BodyBudgetReservationReceipt;
  }[];
}): Promise<ScanStoreSnapshot> {
  if (options.observations.length !== 1) throw new Error("fixture requires one observation");
  const item = options.observations[0]!;
  const result = await withActiveScanBodyLease({
    dataDir: options.dataDir,
    scanId: options.scanId,
    expectedRevision: options.expectedRevision,
    sourceId: item.observation.sourceId,
    nodeId: item.observation.nodeId,
    nodeVersion: item.observation.nodeVersion,
    open: async ({ reservation, selectionReceipt }) => {
      if (reservation.receiptHash !== item.budgetReservation.receiptHash
        || selectionReceipt.receiptHash !== item.selectionReceipt.receiptHash) {
        throw new Error("fixture supplied a stale reservation or selection");
      }
      return {
        sourceId: item.observation.sourceId,
        nodeId: item.observation.nodeId,
        nodeVersion: item.observation.nodeVersion,
        stream: (async function* () { yield new Uint8Array(item.observation.bytes); })(),
      };
    },
  });
  return result.snapshot;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
