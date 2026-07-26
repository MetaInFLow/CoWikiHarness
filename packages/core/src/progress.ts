import type { ScanProgress } from "@openlifewiki/protocol";

export interface CalculatedProgressDimension {
  readonly completed: number;
  readonly total: number;
  readonly percent: number | null;
  readonly complete: boolean;
}

export interface CalculatedScanProgress {
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly discovery: CalculatedProgressDimension;
  readonly summarization: CalculatedProgressDimension;
  readonly selectedScan: CalculatedProgressDimension;
  readonly committedIndex: CalculatedProgressDimension;
  readonly denominatorChanges: ScanProgress["denominatorChanges"];
  readonly complete: boolean;
}

function calculateDimension(
  completed: number,
  total: number,
  denominatorKnown: boolean,
  completionAllowed: boolean,
): CalculatedProgressDimension {
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 0) {
    throw new Error("Progress counters must be non-negative integers");
  }
  if (completed > total) throw new Error("Progress completed count cannot exceed its denominator");

  const rawPercent = total === 0 ? 100 : Math.round((completed / total) * 10_000) / 100;
  const percent = denominatorKnown && (rawPercent < 100 || completionAllowed) ? rawPercent : null;
  return {
    completed,
    total,
    percent,
    complete: percent === 100 && completionAllowed,
  };
}

export function calculateScanProgress(progress: ScanProgress): CalculatedScanProgress {
  const unresolved = progress.outcomes.blocked
    + progress.outcomes.failed
    + progress.outcomes.unknown
    + (progress.outcomes.askUser ?? 0) > 0;

  const discovery = calculateDimension(
    progress.discovery.completed,
    progress.discovery.known,
    progress.discovery.unknownParents === 0 && progress.discovery.openPages === 0,
    true,
  );
  const summarization = calculateDimension(
    progress.summarization.completed,
    progress.summarization.selected,
    true,
    true,
  );
  const selectedScan = calculateDimension(
    progress.selectedScan.completed,
    progress.selectedScan.selected,
    true,
    !unresolved,
  );
  const committedIndex = calculateDimension(
    progress.committedIndex.completed,
    progress.committedIndex.processed,
    true,
    !unresolved
      && progress.committedIndex.generationPublished === true
      && progress.committedIndex.previousGenerationDeleted === true,
  );

  return {
    scanPlanHash: progress.scanPlanHash,
    skeletonVersion: progress.skeletonVersion,
    discovery,
    summarization,
    selectedScan,
    committedIndex,
    denominatorChanges: progress.denominatorChanges,
    complete: discovery.complete
      && summarization.complete
      && selectedScan.complete
      && committedIndex.complete,
  };
}
