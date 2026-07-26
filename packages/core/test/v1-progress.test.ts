import { describe, expect, it } from "vitest";

import type { ScanProgress } from "@openlifewiki/protocol";

import { calculateScanProgress } from "../src/index.js";

function progress(overrides: Partial<ScanProgress> = {}): ScanProgress {
  return {
    schema: "openlifewiki.scan-progress/v1",
    scanId: "scan-1",
    scanPlanHash: "plan-a",
    skeletonVersion: "skeleton-a",
    discovery: { completed: 2, known: 2, unknownParents: 0, openPages: 0 },
    summarization: { completed: 1, selected: 1 },
    selectedScan: { completed: 2, selected: 2 },
    committedIndex: {
      completed: 2,
      processed: 2,
      generation: "generation-1",
      generationPublished: true,
      previousGenerationDeleted: true,
    },
    outcomes: {
      skipped: 0,
      deferred: 0,
      blocked: 0,
      failed: 0,
      unknown: 0,
      askUser: 0,
      unresolvedPhases: [],
    },
    current: null,
    denominatorChanges: [],
    ...overrides,
  };
}

describe("truthful V1 progress", () => {
  it("returns four independently bound complete dimensions", () => {
    const result = calculateScanProgress(progress());

    expect(result.scanPlanHash).toBe("plan-a");
    expect(result.skeletonVersion).toBe("skeleton-a");
    expect(result.discovery).toEqual({ completed: 2, total: 2, percent: 100, complete: true });
    expect(result.summarization.percent).toBe(100);
    expect(result.selectedScan.percent).toBe(100);
    expect(result.committedIndex.percent).toBe(100);
    expect(result.complete).toBe(true);
  });

  it.each([
    ["an unknown parent", { unknownParents: 1, openPages: 0 }],
    ["an open cursor", { unknownParents: 0, openPages: 1 }],
  ])("does not emit discovery percent while %s leaves its denominator open", (_label, gap) => {
    const result = calculateScanProgress(progress({
      discovery: { completed: 2, known: 2, ...gap },
    }));

    expect(result.discovery).toEqual({ completed: 2, total: 2, percent: null, complete: false });
    expect(result.complete).toBe(false);
  });

  it.each(["blocked", "failed", "unknown", "askUser"] as const)(
    "fails closed when global %s work has no phase attribution",
    (outcome) => {
      const base = progress();
      expect(() => calculateScanProgress(progress({
        outcomes: { ...base.outcomes, [outcome]: 1, unresolvedPhases: [] },
      }))).toThrow(/phase/i);
    },
  );

  it("fails closed when phase attribution contains an unknown dimension", () => {
    const base = progress();
    expect(() => calculateScanProgress(progress({
      outcomes: {
        ...base.outcomes,
        failed: 1,
        unresolvedPhases: ["not-a-phase" as "discovery"],
      },
    }))).toThrow(/phase/i);
  });

  it("fails closed when phase attribution exists without an unresolved outcome", () => {
    const base = progress();
    expect(() => calculateScanProgress(progress({
      outcomes: {
        ...base.outcomes,
        unresolvedPhases: ["discovery"],
      },
    }))).toThrow(/phase/i);
  });

  it.each(["skipped", "deferred", "blocked", "failed", "unknown", "askUser"] as const)(
    "rejects a negative %s outcome count",
    (outcome) => {
      const base = progress();
      expect(() => calculateScanProgress(progress({
        outcomes: { ...base.outcomes, [outcome]: -1 },
      }))).toThrow(/outcome/i);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "rejects invalid blocked outcome count %s",
    (blocked) => {
      const base = progress();
      expect(() => calculateScanProgress(progress({
        outcomes: {
          ...base.outcomes,
          blocked,
          unresolvedPhases: ["selectedScan"],
        },
      }))).toThrow(/outcome/i);
    },
  );

  it("keeps the first three dimensions complete for a QMD-only failure", () => {
    const base = progress();
    const result = calculateScanProgress(progress({
      outcomes: {
        ...base.outcomes,
        failed: 1,
        unresolvedPhases: ["committedIndex"],
      },
    }));

    expect(result.discovery).toMatchObject({ percent: 100, complete: true });
    expect(result.summarization).toMatchObject({ percent: 100, complete: true });
    expect(result.selectedScan).toMatchObject({ percent: 100, complete: true });
    expect(result.committedIndex).toMatchObject({ percent: null, complete: false });
    expect(result.complete).toBe(false);
  });

  it("keeps later dimensions complete for a discovery-only unresolved outcome", () => {
    const base = progress();
    const result = calculateScanProgress(progress({
      outcomes: {
        ...base.outcomes,
        unknown: 1,
        unresolvedPhases: ["discovery"],
      },
    }));

    expect(result.discovery).toMatchObject({ percent: null, complete: false });
    expect(result.summarization).toMatchObject({ percent: 100, complete: true });
    expect(result.selectedScan).toMatchObject({ percent: 100, complete: true });
    expect(result.committedIndex).toMatchObject({ percent: 100, complete: true });
    expect(result.complete).toBe(false);
  });

  it("shows the current denominator and does not hide its change", () => {
    const result = calculateScanProgress(progress({
      discovery: { completed: 2, known: 4, unknownParents: 0, openPages: 0 },
      denominatorChanges: [{
        sequence: 2,
        at: "2026-07-26T10:05:00Z",
        dimension: "discovery",
        from: 2,
        to: 4,
        reason: "next page enumerated",
      }],
    }));

    expect(result.discovery).toEqual({ completed: 2, total: 4, percent: 50, complete: false });
    expect(result.denominatorChanges).toEqual([{
      sequence: 2,
      at: "2026-07-26T10:05:00Z",
      dimension: "discovery",
      from: 2,
      to: 4,
      reason: "next page enumerated",
    }]);
  });

  it("does not report a complete committed index before publication and old-generation deletion", () => {
    const result = calculateScanProgress(progress({
      committedIndex: {
        completed: 2,
        processed: 2,
        generation: "generation-1",
        generationPublished: true,
        previousGenerationDeleted: false,
      },
    }));

    expect(result.committedIndex.percent).toBeNull();
    expect(result.committedIndex.complete).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("reports uncommitted processed leaves through the committed denominator", () => {
    const result = calculateScanProgress(progress({
      committedIndex: {
        completed: 2,
        processed: 4,
        generation: null,
        generationPublished: false,
        previousGenerationDeleted: false,
      },
    }));

    expect(result.committedIndex).toEqual({ completed: 2, total: 4, percent: 50, complete: false });
  });
});
