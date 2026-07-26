import type { ScanProgress } from "@openlifewiki/protocol";

const PROGRESS_PHASES = new Set([
  "discovery",
  "summarization",
  "selectedScan",
  "committedIndex",
] as const);

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
  const outcomeCounts = [
    progress.outcomes.skipped,
    progress.outcomes.deferred,
    progress.outcomes.blocked,
    progress.outcomes.failed,
    progress.outcomes.unknown,
    progress.outcomes.askUser ?? 0,
  ];
  if (outcomeCounts.some((count) => !Number.isFinite(count) || !Number.isInteger(count) || count < 0)) {
    throw new Error("Outcome counts must be finite non-negative integers");
  }
  const unresolvedCount = progress.outcomes.blocked
    + progress.outcomes.failed
    + progress.outcomes.unknown
    + (progress.outcomes.askUser ?? 0);
  const phaseAttribution = progress.outcomes.unresolvedPhases ?? [];
  if (phaseAttribution.some((phase) => !PROGRESS_PHASES.has(phase))) {
    throw new Error("Unresolved outcomes contain an unknown phase attribution");
  }
  const unresolvedPhases = new Set(phaseAttribution);
  if (unresolvedCount > 0 && unresolvedPhases.size === 0) {
    throw new Error("Unresolved outcomes require phase attribution");
  }
  if (unresolvedCount === 0 && unresolvedPhases.size > 0) {
    throw new Error("Phase attribution requires an unresolved outcome");
  }

  const discoveryUnresolved = unresolvedPhases.has("discovery");
  const summarizationUnresolved = unresolvedPhases.has("summarization");
  const selectedScanUnresolved = unresolvedPhases.has("selectedScan");
  const committedIndexUnresolved = unresolvedPhases.has("committedIndex");

  const discovery = calculateDimension(
    progress.discovery.completed,
    progress.discovery.known,
    !discoveryUnresolved
      && progress.discovery.unknownParents === 0
      && progress.discovery.openPages === 0,
    !discoveryUnresolved,
  );
  const summarization = calculateDimension(
    progress.summarization.completed,
    progress.summarization.selected,
    !summarizationUnresolved,
    !summarizationUnresolved,
  );
  const selectedScan = calculateDimension(
    progress.selectedScan.completed,
    progress.selectedScan.selected,
    !selectedScanUnresolved,
    !selectedScanUnresolved,
  );
  const committedIndex = calculateDimension(
    progress.committedIndex.completed,
    progress.committedIndex.processed,
    !committedIndexUnresolved,
    !committedIndexUnresolved
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
