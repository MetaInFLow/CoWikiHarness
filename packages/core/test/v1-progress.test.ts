import { describe, expect, it } from "vitest";

import {
  createEnumerationIntent,
  createScanPlan,
  sha256Canonical,
  type ActiveQmdManifestReceipt,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanPlan,
} from "@openlifewiki/protocol";

import {
  calculateScanProgress,
  calculateScanProgressRollup,
  deriveScanProgress,
  type TrustedScanProgressEvidence,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const AT = "2026-07-27T10:00:00Z";

function receipt<T extends object>(payload: T): T & { readonly receiptHash: string } {
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function plan(sourceIds = ["source-local"]): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-1",
    sourceIds,
    authorizationHashes: sourceIds.map((sourceId) => sha256Canonical({ auth: sourceId })),
    rootNodeIds: sourceIds.map(() => "root"),
    skeletonVersion: HASH_A,
    agentProfileId: "agent-codex",
    skillHash: HASH_B,
    scanIntent: "Build the current reusable knowledge Wiki.",
    priorityDocumentRefs: [],
    policy: {
      include: ["/**"],
      exclude: [],
      sensitivity: "normal",
      budget: { maxNodes: 1000, maxBodyBytes: 1_000_000, maxAgentCalls: 100 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function decision(
  scanPlan: ScanPlan,
  sourceId: string,
  nodeId: string,
  targetKind: "container" | "leaf",
  value: "descend" | "skip" | "defer" | "ask-user" = "descend",
): ScanDecision {
  const authorizationHash = scanPlan.authorizationHashes[scanPlan.sourceIds.indexOf(sourceId)]!;
  return receipt({
    schema: "openlifewiki.scan-decision/v1" as const,
    scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    authorizationHash,
    sourceId,
    parentNodeId: "root",
    parentNodeVersion: "root-v1",
    childSetHash: HASH_C,
    nodeId,
    nodeVersion: `${nodeId}-v1`,
    targetKind,
    summaryHash: HASH_B,
    inputSetHash: HASH_A,
    decision: value,
    reason: `Trusted ${value} decision`,
    actor: "agent-codex",
    estimatedCost: { nodes: value === "descend" ? 1 : 0, bodyBytes: 0, agentCalls: 0 },
    persistedAt: AT,
  });
}

function rootIntent(scanPlan: ScanPlan, sourceId: string): EnumerationIntent {
  return createEnumerationIntent({
    plan: scanPlan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: `intent-${sourceId}`,
      sourceId,
      targetNodeId: "root",
      targetNodeVersion: "root-v1",
      authorizationHash: scanPlan.authorizationHashes[scanPlan.sourceIds.indexOf(sourceId)]!,
      origin: "authorized-root",
      parentLayerNodeId: null,
      childSetHash: null,
      inputSetHash: HASH_A,
      createdAt: AT,
    },
  });
}

function page(
  scanPlan: ScanPlan,
  intent: EnumerationIntent,
  discoveredNodeIds: readonly string[],
  options: Partial<EnumerationPageReceipt> = {},
): EnumerationPageReceipt {
  const { receiptHash: _ignoredReceiptHash, ...safeOptions } = options;
  return receipt({
    schema: "openlifewiki.enumeration-page-receipt/v1" as const,
    scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    sourceId: intent.sourceId,
    intentId: intent.intentId,
    pageSequence: 1,
    eventSequence: 1,
    previousPageReceiptHash: null,
    discoveredNodeIds,
    knownUnenumeratedSlotIds: [],
    nextCursor: null,
    childCountKind: "known" as const,
    state: "complete" as const,
    childSetHash: HASH_C,
    observedAt: AT,
    ...safeOptions,
  } as Omit<EnumerationPageReceipt, "receiptHash">);
}

function summary(
  scanPlan: ScanPlan,
  intent: EnumerationIntent,
  childSetHash = HASH_C,
): LayerSummaryReceipt {
  return receipt({
    schema: "openlifewiki.layer-summary-receipt/v1" as const,
    scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    sourceId: intent.sourceId,
    intentId: intent.intentId,
    summaryHash: HASH_B,
    childSetHash,
    inputSetHash: HASH_A,
    persistedAt: AT,
  });
}

function selection(scanPlan: ScanPlan, leafDecision: ScanDecision): LeafSelectionReceipt {
  return receipt({
    schema: "openlifewiki.leaf-selection/v1" as const,
    scanId: scanPlan.scanId,
    sourceId: leafDecision.sourceId,
    nodeId: leafDecision.nodeId,
    nodeVersion: leafDecision.nodeVersion,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    authorizationHash: leafDecision.authorizationHash,
    inputSetHash: leafDecision.inputSetHash,
    decisionReceiptHash: leafDecision.receiptHash,
    actor: "control-plane",
    reason: "Selected by trusted leaf descend decision",
    persistedAt: AT,
  });
}

function checkpoint(scanPlan: ScanPlan, selected: LeafSelectionReceipt): ScanCheckpoint {
  return receipt({
    schema: "openlifewiki.scan-checkpoint/v1" as const,
    scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    sourceId: selected.sourceId,
    authorizationHash: selected.authorizationHash,
    nodeId: selected.nodeId,
    nodeVersion: selected.nodeVersion,
    phase: "qmd-committed" as const,
    indexingDisposition: "qmd-current" as const,
    inputSetHash: selected.inputSetHash,
    qmdGenerationId: "generation-1",
  });
}

function activeManifest(
  scanPlan: ScanPlan,
  checkpoints: readonly ScanCheckpoint[],
): { readonly manifest: ActiveQmdManifestReceipt; readonly supportHashes: readonly string[] } {
  const entries = checkpoints.map((item) => ({
    sourceId: item.sourceId,
    nodeId: item.nodeId,
    nodeVersion: item.nodeVersion,
    bodyCheckpointReceiptHash: item.receiptHash,
  }));
  const supportHashes = [
    sha256Canonical({ active: "generation-1" }),
    sha256Canonical({ probe: "generation-1" }),
    sha256Canonical({ deleted: "generation-0" }),
  ];
  const manifestHash = sha256Canonical({ generationId: "generation-1", entries });
  const manifest = receipt({
    schema: "openlifewiki.active-qmd-manifest/v1" as const,
    scanId: scanPlan.scanId,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    generationId: "generation-1",
    entries,
    manifestHash,
    activePointerReceiptHash: supportHashes[0]!,
    publicProbeReceiptHash: supportHashes[1]!,
    previousGenerationDeletionReceiptHash: supportHashes[2]!,
    publishedAt: AT,
  });
  return { manifest, supportHashes };
}

function completeEvidenceForPlan(
  scanPlan: ScanPlan,
  sourceId: string,
): TrustedScanProgressEvidence {
  const intent = rootIntent(scanPlan, sourceId);
  const enumerationPage = page(scanPlan, intent, ["leaf-1", "leaf-2"], {
    eventSequence: scanPlan.sourceIds.indexOf(sourceId) + 1,
  });
  const decisions = [
    decision(scanPlan, sourceId, "leaf-1", "leaf"),
    decision(scanPlan, sourceId, "leaf-2", "leaf"),
  ];
  const selections = decisions.map((item) => selection(scanPlan, item));
  const checkpoints = selections.map((item) => checkpoint(scanPlan, item));
  const { manifest, supportHashes } = activeManifest(scanPlan, checkpoints);
  const layerSummary = summary(scanPlan, intent);
  const receipts = [intent, enumerationPage, layerSummary, ...decisions, ...selections, ...checkpoints, manifest];
  return {
    plan: scanPlan,
    trustedReceiptHashes: [...receipts.map(({ receiptHash }) => receiptHash), ...supportHashes],
    enumerationIntents: [intent],
    enumerationPages: [enumerationPage],
    layerSummaries: [layerSummary],
    decisions,
    leafSelections: selections,
    checkpoints,
    systemOutcomes: [],
    activeQmdManifest: manifest,
  };
}

function completeEvidence(sourceId = "source-local"): TrustedScanProgressEvidence {
  return completeEvidenceForPlan(plan([sourceId]), sourceId);
}

describe("receipt-derived V1 progress", () => {
  it("derives all four complete dimensions from receipts and the active QMD manifest", () => {
    const result = calculateScanProgress(deriveScanProgress(completeEvidence()));

    expect(result.sourceIds).toEqual(["source-local"]);
    expect(result.discovery).toEqual({ completed: 2, total: 2, percent: 100, complete: true });
    expect(result.summarization).toEqual({ completed: 1, total: 1, percent: 100, complete: true });
    expect(result.selectedScan).toEqual({ completed: 2, total: 2, percent: 100, complete: true });
    expect(result.committedIndex).toEqual({ completed: 2, total: 2, percent: 100, complete: true });
    expect(result.complete).toBe(true);
  });

  it("rejects caller-authored progress snapshots and missing trusted receipts", () => {
    const derived = deriveScanProgress(completeEvidence());
    const untrustedSnapshot = JSON.parse(JSON.stringify(derived));
    expect(() => calculateScanProgress(untrustedSnapshot)).toThrow(/derived from trusted receipts/i);

    const evidence = completeEvidence();
    expect(() => deriveScanProgress({
      ...evidence,
      trustedReceiptHashes: evidence.trustedReceiptHashes.filter(
        (hash) => hash !== evidence.enumerationPages[0]!.receiptHash,
      ),
    })).toThrow(/trusted receipt ledger/i);
  });

  it("requires exactly one authorized-root intent and one intent per exact target version", () => {
    const evidence = completeEvidence();
    const root = evidence.enumerationIntents[0]!;
    const duplicateRoot = createEnumerationIntent({
      plan: evidence.plan,
      trustedDecisionReceiptHashes: [],
      decisionReceipt: null,
      intent: {
        schema: "openlifewiki.enumeration-intent/v1",
        intentId: "intent-duplicate-root",
        sourceId: root.sourceId,
        targetNodeId: root.targetNodeId,
        targetNodeVersion: root.targetNodeVersion,
        authorizationHash: root.authorizationHash,
        origin: "authorized-root",
        parentLayerNodeId: null,
        childSetHash: null,
        inputSetHash: root.inputSetHash,
        createdAt: AT,
      },
    });
    expect(() => deriveScanProgress({
      ...evidence,
      trustedReceiptHashes: [...evidence.trustedReceiptHashes, duplicateRoot.receiptHash],
      enumerationIntents: [...evidence.enumerationIntents, duplicateRoot],
    })).toThrow(/exactly one authorized-root|target.*unique/i);

    const scanPlan = plan(["source-local"]);
    const intent = rootIntent(scanPlan, "source-local");
    const folderDecision = decision(scanPlan, "source-local", "folder", "container");
    const childIntent = (intentId: string) => createEnumerationIntent({
      plan: scanPlan,
      trustedDecisionReceiptHashes: [folderDecision.receiptHash],
      decisionReceipt: folderDecision,
      intent: {
        schema: "openlifewiki.enumeration-intent/v1",
        intentId,
        sourceId: "source-local",
        targetNodeId: "folder",
        targetNodeVersion: "folder-v1",
        authorizationHash: scanPlan.authorizationHashes[0]!,
        origin: "container-descend",
        parentLayerNodeId: "root",
        childSetHash: HASH_C,
        inputSetHash: HASH_A,
        createdAt: AT,
      },
    });
    const firstChild = childIntent("intent-folder-1");
    const secondChild = childIntent("intent-folder-2");
    const rootPage = page(scanPlan, intent, ["folder"]);
    expect(() => deriveScanProgress({
      plan: scanPlan,
      trustedReceiptHashes: [
        intent.receiptHash,
        firstChild.receiptHash,
        secondChild.receiptHash,
        rootPage.receiptHash,
        folderDecision.receiptHash,
      ],
      enumerationIntents: [intent, firstChild, secondChild],
      enumerationPages: [rootPage],
      layerSummaries: [],
      decisions: [folderDecision],
      leafSelections: [],
      checkpoints: [],
      systemOutcomes: [],
      activeQmdManifest: null,
    })).toThrow(/descend target|target.*unique/i);
  });

  it("withholds percentage while pagination leaves the discovery denominator open", () => {
    const scanPlan = plan(["source-github"]);
    const intent = rootIntent(scanPlan, "source-github");
    const firstPage = page(scanPlan, intent, ["A", "B"], {
      knownUnenumeratedSlotIds: ["slot-3", "slot-4"],
      nextCursor: "cursor-2",
      childCountKind: "estimated",
      state: "open",
      childSetHash: null,
    });
    const evidence: TrustedScanProgressEvidence = {
      plan: scanPlan,
      trustedReceiptHashes: [intent.receiptHash, firstPage.receiptHash],
      enumerationIntents: [intent],
      enumerationPages: [firstPage],
      layerSummaries: [],
      decisions: [],
      leafSelections: [],
      checkpoints: [],
      systemOutcomes: [],
      activeQmdManifest: null,
    };
    const result = calculateScanProgress(deriveScanProgress(evidence));
    expect(result.discovery).toEqual({ completed: 2, total: 4, percent: null, complete: false });
    expect(result.denominatorChanges).toHaveLength(1);
    expect(result.denominatorChanges[0]).toMatchObject({ from: 0, to: 4 });
  });

  it("fails closed on stale manifests and terminal outcomes that overlap selected work", () => {
    const stale = completeEvidence();
    expect(() => deriveScanProgress({
      ...stale,
      activeQmdManifest: {
        ...stale.activeQmdManifest!,
        generationId: "generation-replayed",
      },
    })).toThrow(/receiptHash mismatch/i);

    const overlap = completeEvidence();
    const { receiptHash: _decisionHash, ...decisionPayload } = overlap.decisions[0]!;
    const skipped = receipt({
      ...decisionPayload,
      decision: "skip" as const,
      estimatedCost: { nodes: 0, bodyBytes: 0, agentCalls: 0 },
    } as Omit<ScanDecision, "receiptHash">);
    expect(() => deriveScanProgress({
      ...overlap,
      trustedReceiptHashes: [
        ...overlap.trustedReceiptHashes,
        skipped.receiptHash,
      ],
      decisions: [skipped, ...overlap.decisions],
    })).toThrow(/Terminal outcome/i);
  });

  it("rejects an active QMD manifest entry from outside the ScanPlan", () => {
    const evidence = completeEvidence();
    const current = evidence.activeQmdManifest!;
    const entries = [...current.entries, {
      sourceId: "source-off-plan",
      nodeId: "leaf-injected",
      nodeVersion: "leaf-injected-v1",
      bodyCheckpointReceiptHash: sha256Canonical("off-plan-checkpoint"),
    }];
    const { receiptHash: _oldReceipt, manifestHash: _oldManifest, ...base } = current;
    const payload = {
      ...base,
      entries,
      manifestHash: sha256Canonical({ generationId: current.generationId, entries }),
    };
    const injected = receipt(payload);
    expect(() => deriveScanProgress({
      ...evidence,
      trustedReceiptHashes: [...evidence.trustedReceiptHashes, injected.receiptHash],
      activeQmdManifest: injected,
    })).toThrow(/outside.*ScanPlan|off-plan/i);
  });

  it("reports a completed empty root separately without inventing 100 percent", () => {
    const scanPlan = plan(["source-empty"]);
    const intent = rootIntent(scanPlan, "source-empty");
    const emptyPage = page(scanPlan, intent, []);
    const layerSummary = summary(scanPlan, intent);
    const progress = calculateScanProgress(deriveScanProgress({
      plan: scanPlan,
      trustedReceiptHashes: [intent.receiptHash, emptyPage.receiptHash, layerSummary.receiptHash],
      enumerationIntents: [intent],
      enumerationPages: [emptyPage],
      layerSummaries: [layerSummary],
      decisions: [],
      leafSelections: [],
      checkpoints: [],
      systemOutcomes: [],
      activeQmdManifest: null,
    }));
    expect(progress.discovery).toEqual({ completed: 0, total: 0, percent: null, complete: false });
    expect(progress.selectedScan.percent).toBeNull();
    expect(progress.committedIndex.percent).toBeNull();
    expect(progress.complete).toBe(false);
    expect(progress.scanOutcome).toBe("completed-no-selected-work");

    const skippedPage = page(scanPlan, intent, ["leaf-skipped"]);
    const skippedSummary = summary(scanPlan, intent);
    const skipDecision = decision(scanPlan, "source-empty", "leaf-skipped", "leaf", "skip");
    const skipped = calculateScanProgress(deriveScanProgress({
      plan: scanPlan,
      trustedReceiptHashes: [
        intent.receiptHash,
        skippedPage.receiptHash,
        skippedSummary.receiptHash,
        skipDecision.receiptHash,
      ],
      enumerationIntents: [intent],
      enumerationPages: [skippedPage],
      layerSummaries: [skippedSummary],
      decisions: [skipDecision],
      leafSelections: [],
      checkpoints: [],
      systemOutcomes: [],
      activeQmdManifest: null,
    }));
    expect(skipped.discovery.percent).toBe(100);
    expect(skipped.selectedScan.percent).toBeNull();
    expect(skipped.scanOutcome).toBe("completed-no-selected-work");
  });

  it("rolls up the global union and rejects plan, generation and Source overlap", () => {
    const sharedPlan = plan(["source-local", "source-github"]);
    const localEvidence = completeEvidenceForPlan(sharedPlan, "source-local");
    const githubEvidence = completeEvidenceForPlan(sharedPlan, "source-github");
    const { manifest } = activeManifest(sharedPlan, [
      ...localEvidence.checkpoints,
      ...githubEvidence.checkpoints,
    ]);
    const withGlobalManifest = (evidence: TrustedScanProgressEvidence): TrustedScanProgressEvidence => ({
      ...evidence,
      trustedReceiptHashes: [
        ...evidence.trustedReceiptHashes,
        manifest.receiptHash,
      ],
      activeQmdManifest: manifest,
    });
    const local = deriveScanProgress(withGlobalManifest(localEvidence));
    const github = deriveScanProgress(withGlobalManifest(githubEvidence));
    const rollup = calculateScanProgressRollup(sharedPlan, [local, github]);
    expect(rollup.sourceIds).toEqual(["source-github", "source-local"]);
    expect(rollup.discovery).toMatchObject({ completed: 4, total: 4, percent: 100 });
    expect(() => calculateScanProgressRollup(sharedPlan, [local, local])).toThrow(/overlap/i);
    expect(() => calculateScanProgressRollup(sharedPlan, [local])).toThrow(/Source membership/i);
    expect(() => calculateScanProgressRollup(sharedPlan, [
      local,
      deriveScanProgress(completeEvidence("source-other")),
    ])).toThrow(/scanPlanHash/i);
  });
});
