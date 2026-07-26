import {
  assertEnumerationIntent,
  assertScanPlan,
  type ActiveQmdManifestReceipt,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanDiscoveryNode,
  type ScanDiscoverySlot,
  type ScanPlan,
  type ScanProgress,
  type ScanProgressMember,
  type ScanSystemOutcomeReceipt,
} from "@openlifewiki/protocol";

import { sha256Canonical } from "./hashing.js";

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
  readonly sourceIds: readonly string[];
  readonly discovery: CalculatedProgressDimension;
  readonly summarization: CalculatedProgressDimension;
  readonly selectedScan: CalculatedProgressDimension;
  readonly committedIndex: CalculatedProgressDimension;
  readonly denominatorChanges: ScanProgress["denominatorChanges"];
  readonly scanOutcome:
    | "in-progress"
    | "completed-with-indexed-work"
    | "completed-no-selected-work";
  readonly complete: boolean;
}

const DERIVED_PROGRESS = Symbol("openlifewiki.derived-scan-progress");

export type DerivedScanProgress = ScanProgress & {
  readonly [DERIVED_PROGRESS]: true;
};

export interface TrustedScanProgressEvidence {
  readonly plan: ScanPlan;
  readonly trustedReceiptHashes: readonly string[];
  readonly enumerationIntents: readonly EnumerationIntent[];
  readonly enumerationPages: readonly EnumerationPageReceipt[];
  readonly layerSummaries: readonly LayerSummaryReceipt[];
  readonly decisions: readonly ScanDecision[];
  readonly leafSelections: readonly LeafSelectionReceipt[];
  readonly checkpoints: readonly ScanCheckpoint[];
  readonly systemOutcomes: readonly ScanSystemOutcomeReceipt[];
  readonly activeQmdManifest: ActiveQmdManifestReceipt | null;
}

function assertReceiptIntegrity<T extends { readonly receiptHash: string }>(
  receipt: T,
  trustedReceiptHashes: ReadonlySet<string>,
  label: string,
): void {
  if (!trustedReceiptHashes.has(receipt.receiptHash)) {
    throw new Error(`${label} is outside the trusted receipt ledger`);
  }
  const { receiptHash, ...payload } = receipt;
  if (sha256Canonical(payload) !== receiptHash) throw new Error(`${label} receiptHash mismatch`);
}

function assertPlanBinding(
  receipt: {
    readonly scanId: string;
    readonly scanPlanHash: string;
    readonly skeletonVersion: string;
  },
  plan: ScanPlan,
  label: string,
): void {
  if (receipt.scanId !== plan.scanId
    || receipt.scanPlanHash !== plan.scanPlanHash
    || receipt.skeletonVersion !== plan.skeletonVersion) {
    throw new Error(`${label} does not bind the active ScanPlan`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function asDerivedProgress(progress: ScanProgress): DerivedScanProgress {
  Object.defineProperty(progress, DERIVED_PROGRESS, { value: true, enumerable: false });
  return deepFreeze(progress) as DerivedScanProgress;
}

function memberKey(member: ScanProgressMember): string {
  return `${member.sourceId}\0${member.id}`;
}

function memberSet(
  members: readonly ScanProgressMember[],
  label: string,
  sourceIds: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const member of members) {
    if (!sourceIds.has(member.sourceId)) {
      throw new Error(`${label} member is outside sourceIds`);
    }
    const key = memberKey(member);
    if (result.has(key)) throw new Error(`${label} contains a duplicate member`);
    result.add(key);
  }
  return result;
}

function discoveryNodeSet(
  nodes: readonly ScanDiscoveryNode[],
  sourceIds: ReadonlySet<string>,
  enumerationIntents: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    if (!sourceIds.has(node.sourceId)) {
      throw new Error("completePageNodes member is outside sourceIds");
    }
    if (!enumerationIntents.has(memberKey({ sourceId: node.sourceId, id: node.intentId }))) {
      throw new Error("completePageNodes must belong to a declared EnumerationIntent");
    }
    const key = memberKey(node);
    if (result.has(key)) throw new Error("completePageNodes contains a duplicate member");
    result.add(key);
  }
  return result;
}

function discoverySlotSet(
  slots: readonly ScanDiscoverySlot[],
  sourceIds: ReadonlySet<string>,
  enumerationIntents: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const slot of slots) {
    if (!sourceIds.has(slot.sourceId)) {
      throw new Error("knownUnenumeratedChildSlots member is outside sourceIds");
    }
    if (!enumerationIntents.has(memberKey({ sourceId: slot.sourceId, id: slot.intentId }))) {
      throw new Error("knownUnenumeratedChildSlots must belong to a declared EnumerationIntent");
    }
    const key = `${slot.sourceId}\0${slot.intentId}\0${slot.slotId}`;
    if (result.has(key)) {
      throw new Error("knownUnenumeratedChildSlots contains a duplicate member");
    }
    result.add(key);
  }
  return result;
}

function assertSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>, label: string): void {
  for (const value of subset) {
    if (!superset.has(value)) throw new Error(`${label} must be a subset`);
  }
}

function assertSameSet(left: ReadonlySet<string>, right: ReadonlySet<string>, label: string): void {
  if (left.size !== right.size) throw new Error(`${label} must use the same exact set`);
  assertSubset(left, right, label);
}

function calculateDimension(
  completed: number,
  total: number,
  completionAllowed: boolean,
): CalculatedProgressDimension {
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 0) {
    throw new Error("Progress counters must be non-negative integers");
  }
  if (completed > total) throw new Error("Progress completed count cannot exceed its denominator");
  if (total === 0) return { completed, total, percent: null, complete: false };
  if (!completionAllowed) return { completed, total, percent: null, complete: false };

  const rawPercent = Math.round((completed / total) * 10_000) / 100;
  return { completed, total, percent: rawPercent, complete: rawPercent === 100 };
}

function validateProgress(progress: ScanProgress): {
  readonly sets: {
    readonly completePageNodes: Set<string>;
    readonly knownUnenumeratedChildSlots: Set<string>;
    readonly enumerationIntents: Set<string>;
    readonly summarizedIntents: Set<string>;
    readonly selectedLeaves: Set<string>;
    readonly processedLeaves: Set<string>;
    readonly processedQmdCurrentLeaves: Set<string>;
    readonly committedLeaves: Set<string>;
  };
  readonly unresolvedPhases: Set<ScanProgress["outcomes"]["unresolvedPhases"][number]>;
} {
  const sourceIds = new Set(progress.sourceIds);
  if (sourceIds.size !== progress.sourceIds.length) throw new Error("sourceIds must be unique");
  if (sourceIds.size === 0) throw new Error("sourceIds cannot be empty");
  const enumerationIntents = memberSet(
    progress.discovery.enumerationIntents,
    "discovery.enumerationIntents",
    sourceIds,
  );
  const completePageNodes = discoveryNodeSet(
    progress.discovery.completePageNodes,
    sourceIds,
    enumerationIntents,
  );
  const knownUnenumeratedChildSlots = discoverySlotSet(
    progress.discovery.knownUnenumeratedChildSlots,
    sourceIds,
    enumerationIntents,
  );
  for (const [label, members] of [
    ["openIntents", progress.discovery.openIntents],
    ["unknownIntents", progress.discovery.unknownIntents],
    ["estimatedIntents", progress.discovery.estimatedIntents],
    ["blockedIntents", progress.discovery.blockedIntents],
    ["pendingLayerIntents", progress.discovery.pendingLayerIntents],
  ] as const) {
    assertSubset(memberSet(members, label, sourceIds), enumerationIntents, label);
  }

  const summaryEnumerationIntents = memberSet(
    progress.summarization.enumerationIntents,
    "summarization.enumerationIntents",
    sourceIds,
  );
  assertSameSet(summaryEnumerationIntents, enumerationIntents, "enumerationIntents");
  const summarizedIntents = memberSet(
    progress.summarization.summarizedIntents,
    "summarizedIntents",
    sourceIds,
  );
  assertSubset(summarizedIntents, enumerationIntents, "summarizedIntents");

  const selectedLeaves = memberSet(progress.selectedScan.selectedLeaves, "selectedLeaves", sourceIds);
  const processedLeaves = memberSet(progress.selectedScan.processedLeaves, "processedLeaves", sourceIds);
  assertSubset(processedLeaves, selectedLeaves, "processedLeaves");
  const processedQmdCurrentLeaves = memberSet(
    progress.committedIndex.processedQmdCurrentLeaves,
    "processedQmdCurrentLeaves",
    sourceIds,
  );
  assertSubset(processedQmdCurrentLeaves, processedLeaves, "processedQmdCurrentLeaves");
  const committedLeaves = memberSet(
    progress.committedIndex.committedLeaves,
    "committedLeaves",
    sourceIds,
  );
  assertSubset(committedLeaves, processedQmdCurrentLeaves, "committedLeaves");
  const generationBound = progress.committedIndex.generation !== null
    && progress.committedIndex.manifestHash !== null
    && progress.committedIndex.activeManifestReceiptHash !== null;
  const generationAbsent = progress.committedIndex.generation === null
    && progress.committedIndex.manifestHash === null
    && progress.committedIndex.activeManifestReceiptHash === null;
  if (!generationBound && !generationAbsent) {
    throw new Error("Active generation, manifest and receipt hashes must be bound together");
  }
  if (progress.committedIndex.generationPublished !== generationBound
    || progress.committedIndex.publicProbesPassed !== generationBound
    || progress.committedIndex.previousGenerationDeleted !== generationBound) {
    throw new Error("QMD publication state must be derived from one active manifest receipt");
  }
  if (committedLeaves.size > 0 && (
    progress.committedIndex.generation === null
    || progress.committedIndex.manifestHash === null
    || progress.committedIndex.activeManifestReceiptHash === null
    || !progress.committedIndex.generationPublished
    || !progress.committedIndex.publicProbesPassed
    || !progress.committedIndex.previousGenerationDeleted
  )) {
    throw new Error("Committed leaves require one fully published active generation");
  }

  const outcomeSets = [
    ["skippedTargets", progress.outcomes.skippedTargets],
    ["deferredTargets", progress.outcomes.deferredTargets],
    ["blockedTargets", progress.outcomes.blockedTargets],
    ["failedTargets", progress.outcomes.failedTargets],
    ["unknownTargets", progress.outcomes.unknownTargets],
    ["askUserTargets", progress.outcomes.askUserTargets],
  ] as const;
  const outcomeKeys = new Set<string>();
  for (const [label, members] of outcomeSets) {
    for (const key of memberSet(members, label, sourceIds)) {
      if (outcomeKeys.has(key)) throw new Error("Outcome target sets must be disjoint");
      outcomeKeys.add(key);
    }
  }
  for (const terminalKey of outcomeKeys) {
    if (selectedLeaves.has(terminalKey)
      || processedLeaves.has(terminalKey)
      || committedLeaves.has(terminalKey)) {
      throw new Error("Terminal outcome targets cannot also be selected, processed or committed");
    }
  }

  const unresolvedCount = progress.outcomes.blockedTargets.length
    + progress.outcomes.failedTargets.length
    + progress.outcomes.unknownTargets.length
    + progress.outcomes.askUserTargets.length;
  const unresolvedPhases = new Set(progress.outcomes.unresolvedPhases);
  if (unresolvedPhases.size !== progress.outcomes.unresolvedPhases.length) {
    throw new Error("Unresolved phase attribution must be unique");
  }
  if ([...unresolvedPhases].some((phase) => !PROGRESS_PHASES.has(phase))) {
    throw new Error("Unresolved outcomes contain an unknown phase attribution");
  }
  if (unresolvedCount > 0 && unresolvedPhases.size === 0) {
    throw new Error("Unresolved outcomes require phase attribution");
  }
  if (unresolvedCount === 0 && unresolvedPhases.size > 0) {
    throw new Error("Phase attribution requires an unresolved outcome");
  }

  return {
    sets: {
      completePageNodes,
      knownUnenumeratedChildSlots,
      enumerationIntents,
      summarizedIntents,
      selectedLeaves,
      processedLeaves,
      processedQmdCurrentLeaves,
      committedLeaves,
    },
    unresolvedPhases,
  };
}

export function deriveScanProgress(
  evidence: TrustedScanProgressEvidence,
): DerivedScanProgress {
  assertScanPlan(evidence.plan);
  const trusted = new Set(evidence.trustedReceiptHashes);
  if (trusted.size !== evidence.trustedReceiptHashes.length) {
    throw new Error("trustedReceiptHashes must be unique");
  }
  const sourceIds = new Set<string>();
  const intentById = new Map<string, EnumerationIntent>();
  const intentTargets = new Set<string>();
  const descendTargets = new Set<string>();
  for (const intent of evidence.enumerationIntents) {
    assertReceiptIntegrity(intent, trusted, "EnumerationIntent");
    assertEnumerationIntent(intent, {
      plan: evidence.plan,
      trustedDecisionReceipts: evidence.decisions,
    });
    const key = `${intent.sourceId}\0${intent.intentId}`;
    if (intentById.has(key)) throw new Error("EnumerationIntent IDs must be unique per Source");
    const targetKey = `${intent.sourceId}\0${intent.targetNodeId}\0${intent.targetNodeVersion}`;
    if (intentTargets.has(targetKey)) {
      throw new Error("EnumerationIntent target and version must be unique per Source");
    }
    intentTargets.add(targetKey);
    if (intent.origin === "container-descend") {
      const descendKey = `${intent.sourceId}\0${intent.decisionReceiptHash ?? intent.targetNodeId}`;
      if (descendTargets.has(descendKey)) {
        throw new Error("Each trusted descend target can create only one EnumerationIntent");
      }
      descendTargets.add(descendKey);
    }
    intentById.set(key, intent);
    sourceIds.add(intent.sourceId);
  }
  if (sourceIds.size === 0) throw new Error("Progress requires at least one EnumerationIntent");
  for (const sourceId of sourceIds) {
    const rootIntentCount = evidence.enumerationIntents.filter((intent) =>
      intent.sourceId === sourceId && intent.origin === "authorized-root").length;
    if (rootIntentCount !== 1) {
      throw new Error(`Source ${sourceId} requires exactly one authorized-root EnumerationIntent`);
    }
  }

  const decisionByHash = new Map<string, ScanDecision>();
  const discoveredKeys = new Set<string>();
  const pagesByIntent = new Map<string, EnumerationPageReceipt[]>();
  const eventSequences = new Set<number>();
  for (const page of evidence.enumerationPages) {
    assertReceiptIntegrity(page, trusted, "EnumerationPageReceipt");
    assertPlanBinding(page, evidence.plan, "EnumerationPageReceipt");
    const intentKey = `${page.sourceId}\0${page.intentId}`;
    if (!intentById.has(intentKey)) throw new Error("Enumeration page has no trusted intent");
    if (!Number.isSafeInteger(page.pageSequence) || page.pageSequence < 1
      || !Number.isSafeInteger(page.eventSequence) || page.eventSequence < 1) {
      throw new Error("Enumeration page sequences must be positive integers");
    }
    if (eventSequences.has(page.eventSequence)) {
      throw new Error("Enumeration eventSequence must be globally unique");
    }
    eventSequences.add(page.eventSequence);
    const pageNodeIds = new Set(page.discoveredNodeIds);
    const pageSlotIds = new Set(page.knownUnenumeratedSlotIds);
    if (pageNodeIds.size !== page.discoveredNodeIds.length
      || pageSlotIds.size !== page.knownUnenumeratedSlotIds.length) {
      throw new Error("Enumeration page node and slot IDs must be unique");
    }
    if (page.state === "complete" && (
      page.nextCursor !== null
      || page.childCountKind !== "known"
      || page.childSetHash === null
      || page.knownUnenumeratedSlotIds.length > 0
    )) {
      throw new Error("Complete enumeration requires known child set and closed cursor");
    }
    if (page.state !== "complete" && page.childSetHash !== null) {
      throw new Error("Incomplete enumeration cannot claim a final childSetHash");
    }
    const pages = pagesByIntent.get(intentKey) ?? [];
    pages.push(page);
    pagesByIntent.set(intentKey, pages);
  }

  for (const [intentKey, pages] of pagesByIntent) {
    pages.sort((left, right) => left.pageSequence - right.pageSequence);
    let previousHash: string | null = null;
    let previousEventSequence = 0;
    pages.forEach((page, index) => {
      if (page.pageSequence !== index + 1
        || page.previousPageReceiptHash !== previousHash
        || page.eventSequence <= previousEventSequence) {
        throw new Error("Enumeration page receipt chain is not contiguous");
      }
      for (const nodeId of page.discoveredNodeIds) {
        const nodeKey = `${page.sourceId}\0${nodeId}`;
        if (discoveredKeys.has(nodeKey)) throw new Error("Enumeration rediscovered a node");
        discoveredKeys.add(nodeKey);
      }
      previousHash = page.receiptHash;
      previousEventSequence = page.eventSequence;
    });
    if (!intentById.has(intentKey)) throw new Error("Enumeration page has no intent");
  }

  for (const decision of evidence.decisions) {
    assertReceiptIntegrity(decision, trusted, "ScanDecision");
    assertPlanBinding(decision, evidence.plan, "ScanDecision");
    const sourceIndex = evidence.plan.sourceIds.indexOf(decision.sourceId);
    if (sourceIndex < 0
      || evidence.plan.authorizationHashes[sourceIndex] !== decision.authorizationHash) {
      throw new Error("ScanDecision authorization is outside the active ScanPlan");
    }
    if (!discoveredKeys.has(`${decision.sourceId}\0${decision.nodeId}`)) {
      throw new Error("ScanDecision target was not discovered");
    }
    if (decisionByHash.has(decision.receiptHash)) throw new Error("ScanDecision receipt is duplicated");
    decisionByHash.set(decision.receiptHash, decision);
  }

  const summaryByIntent = new Map<string, LayerSummaryReceipt>();
  for (const summary of evidence.layerSummaries) {
    assertReceiptIntegrity(summary, trusted, "LayerSummaryReceipt");
    assertPlanBinding(summary, evidence.plan, "LayerSummaryReceipt");
    const key = `${summary.sourceId}\0${summary.intentId}`;
    const pages = pagesByIntent.get(key);
    const lastPage = pages?.at(-1);
    if (lastPage?.state !== "complete" || lastPage.childSetHash !== summary.childSetHash) {
      throw new Error("Layer summary requires the completed Enumeration child set");
    }
    if (summaryByIntent.has(key)) throw new Error("Layer summary receipt is duplicated");
    summaryByIntent.set(key, summary);
  }

  const selectedKeys = new Set<string>();
  const selectionByKey = new Map<string, LeafSelectionReceipt>();
  for (const selection of evidence.leafSelections) {
    assertReceiptIntegrity(selection, trusted, "LeafSelectionReceipt");
    assertPlanBinding(selection, evidence.plan, "LeafSelectionReceipt");
    const sourceIndex = evidence.plan.sourceIds.indexOf(selection.sourceId);
    if (sourceIndex < 0
      || evidence.plan.authorizationHashes[sourceIndex] !== selection.authorizationHash) {
      throw new Error("Leaf selection authorization is outside the active ScanPlan");
    }
    const decision = decisionByHash.get(selection.decisionReceiptHash);
    if (decision === undefined
      || decision.decision !== "descend"
      || decision.targetKind !== "leaf"
      || decision.sourceId !== selection.sourceId
      || decision.nodeId !== selection.nodeId
      || decision.nodeVersion !== selection.nodeVersion
      || decision.inputSetHash !== selection.inputSetHash) {
      throw new Error("Leaf selection does not bind its trusted leaf descend decision");
    }
    const key = `${selection.sourceId}\0${selection.nodeId}`;
    if (!discoveredKeys.has(key)) throw new Error("Selected leaf was not discovered");
    if (selectedKeys.has(key)) throw new Error("Leaf selection is duplicated");
    selectedKeys.add(key);
    selectionByKey.set(key, selection);
  }

  const processedKeys = new Set<string>();
  const processedQmdKeys = new Set<string>();
  const checkpointByHash = new Map<string, ScanCheckpoint>();
  for (const checkpoint of evidence.checkpoints) {
    assertReceiptIntegrity(checkpoint, trusted, "ScanCheckpoint");
    assertPlanBinding(checkpoint, evidence.plan, "ScanCheckpoint");
    const sourceIndex = evidence.plan.sourceIds.indexOf(checkpoint.sourceId);
    const key = `${checkpoint.sourceId}\0${checkpoint.nodeId}`;
    const selection = selectionByKey.get(key);
    if (sourceIndex < 0
      || evidence.plan.authorizationHashes[sourceIndex] !== checkpoint.authorizationHash
      || selection === undefined
      || selection.nodeVersion !== checkpoint.nodeVersion
      || selection.inputSetHash !== checkpoint.inputSetHash) {
      throw new Error("Scan checkpoint does not bind a selected leaf");
    }
    if (checkpointByHash.has(checkpoint.receiptHash)) throw new Error("Scan checkpoint is duplicated");
    checkpointByHash.set(checkpoint.receiptHash, checkpoint);
    if (checkpoint.phase === "body-processed" || checkpoint.phase === "qmd-committed") {
      processedKeys.add(key);
      if (checkpoint.indexingDisposition === "qmd-current") processedQmdKeys.add(key);
    }
  }

  const committedKeys = new Set<string>();
  let generation: string | null = null;
  let manifestHash: string | null = null;
  let activeManifestReceiptHash: string | null = null;
  let generationPublished = false;
  let publicProbesPassed = false;
  let previousGenerationDeleted = false;
  if (evidence.activeQmdManifest !== null) {
    const manifest = evidence.activeQmdManifest;
    assertReceiptIntegrity(manifest, trusted, "ActiveQmdManifestReceipt");
    assertPlanBinding(manifest, evidence.plan, "ActiveQmdManifestReceipt");
    for (const receiptHash of [
      manifest.activePointerReceiptHash,
      manifest.publicProbeReceiptHash,
      manifest.previousGenerationDeletionReceiptHash,
    ]) {
      if (!trusted.has(receiptHash)) throw new Error("QMD publication receipt is not trusted");
    }
    if (manifest.manifestHash !== sha256Canonical({
      generationId: manifest.generationId,
      entries: manifest.entries,
    })) {
      throw new Error("Active QMD manifestHash mismatch");
    }
    const planSourceIds = new Set(evidence.plan.sourceIds);
    const manifestEntryKeys = new Set<string>();
    for (const entry of manifest.entries) {
      if (!planSourceIds.has(entry.sourceId)) {
        throw new Error(`Active QMD manifest Source ${entry.sourceId} is outside the ScanPlan`);
      }
      const key = `${entry.sourceId}\0${entry.nodeId}`;
      if (manifestEntryKeys.has(key)) throw new Error("Active QMD entry is duplicated");
      manifestEntryKeys.add(key);
      if (!sourceIds.has(entry.sourceId)) continue;
      const checkpoint = checkpointByHash.get(entry.bodyCheckpointReceiptHash);
      if (checkpoint === undefined
        || checkpoint.phase !== "qmd-committed"
        || checkpoint.indexingDisposition !== "qmd-current"
        || checkpoint.sourceId !== entry.sourceId
        || checkpoint.nodeId !== entry.nodeId
        || checkpoint.nodeVersion !== entry.nodeVersion
        || checkpoint.qmdGenerationId !== manifest.generationId) {
        throw new Error("Active QMD entry does not bind a committed body checkpoint");
      }
      if (committedKeys.has(key)) throw new Error("Active QMD entry is duplicated");
      committedKeys.add(key);
    }
    generation = manifest.generationId;
    manifestHash = manifest.manifestHash;
    activeManifestReceiptHash = manifest.receiptHash;
    generationPublished = true;
    publicProbesPassed = true;
    previousGenerationDeleted = true;
  }

  const skippedTargets: ScanProgressMember[] = [];
  const deferredTargets: ScanProgressMember[] = [];
  const askUserTargets: ScanProgressMember[] = [];
  for (const decision of evidence.decisions) {
    const member = { sourceId: decision.sourceId, id: decision.nodeId };
    if (decision.decision === "skip") skippedTargets.push(member);
    if (decision.decision === "defer") deferredTargets.push(member);
    if (decision.decision === "ask-user") askUserTargets.push(member);
  }
  const blockedTargets: ScanProgressMember[] = [];
  const failedTargets: ScanProgressMember[] = [];
  const unknownTargets: ScanProgressMember[] = [];
  const unresolvedPhases = new Set<ScanProgress["outcomes"]["unresolvedPhases"][number]>();
  for (const outcome of evidence.systemOutcomes) {
    assertReceiptIntegrity(outcome, trusted, "ScanSystemOutcomeReceipt");
    assertPlanBinding(outcome, evidence.plan, "ScanSystemOutcomeReceipt");
    const knownTarget = discoveredKeys.has(`${outcome.sourceId}\0${outcome.nodeId}`)
      || evidence.enumerationIntents.some((intent) =>
        intent.sourceId === outcome.sourceId && intent.targetNodeId === outcome.nodeId);
    if (!sourceIds.has(outcome.sourceId) || !knownTarget) {
      throw new Error("System outcome target is outside the trusted scan skeleton");
    }
    const member = { sourceId: outcome.sourceId, id: outcome.nodeId };
    if (outcome.outcome === "blocked") blockedTargets.push(member);
    if (outcome.outcome === "failed") failedTargets.push(member);
    if (outcome.outcome === "unknown") unknownTargets.push(member);
    unresolvedPhases.add(outcome.phase);
  }
  if (askUserTargets.length > 0) unresolvedPhases.add("discovery");

  const completePageNodes: ScanDiscoveryNode[] = [];
  const knownUnenumeratedChildSlots: ScanDiscoverySlot[] = [];
  const openIntents: ScanProgressMember[] = [];
  const unknownIntents: ScanProgressMember[] = [];
  const estimatedIntents: ScanProgressMember[] = [];
  const blockedIntents: ScanProgressMember[] = [];
  const pendingLayerIntents: ScanProgressMember[] = [];
  for (const intent of evidence.enumerationIntents) {
    const key = `${intent.sourceId}\0${intent.intentId}`;
    const pages = pagesByIntent.get(key) ?? [];
    for (const page of pages) {
      for (const nodeId of page.discoveredNodeIds) {
        completePageNodes.push({ sourceId: intent.sourceId, intentId: intent.intentId, id: nodeId });
      }
    }
    const lastPage = pages.at(-1);
    const member = { sourceId: intent.sourceId, id: intent.intentId };
    if (lastPage === undefined || lastPage.state === "open" || lastPage.nextCursor !== null) {
      openIntents.push(member);
    }
    if (lastPage?.childCountKind === "unknown") unknownIntents.push(member);
    if (lastPage?.childCountKind === "estimated") estimatedIntents.push(member);
    if (lastPage?.state === "blocked") blockedIntents.push(member);
    if (lastPage?.state === "complete" && !summaryByIntent.has(key)) pendingLayerIntents.push(member);
    for (const slotId of lastPage?.knownUnenumeratedSlotIds ?? []) {
      knownUnenumeratedChildSlots.push({
        sourceId: intent.sourceId,
        intentId: intent.intentId,
        slotId,
      });
    }
  }

  const denominatorChanges: ScanProgress["denominatorChanges"][number][] = [];
  const eventPages = [...evidence.enumerationPages].sort(
    (left, right) => left.eventSequence - right.eventSequence,
  );
  const eventNodes = new Set<string>();
  const slotsByIntent = new Map<string, Set<string>>();
  for (const page of eventPages) {
    const from = eventNodes.size + [...slotsByIntent.values()].reduce((sum, slots) => sum + slots.size, 0);
    for (const nodeId of page.discoveredNodeIds) eventNodes.add(`${page.sourceId}\0${nodeId}`);
    slotsByIntent.set(
      `${page.sourceId}\0${page.intentId}`,
      new Set(page.knownUnenumeratedSlotIds),
    );
    const to = eventNodes.size + [...slotsByIntent.values()].reduce((sum, slots) => sum + slots.size, 0);
    if (from !== to) denominatorChanges.push({
      sequence: page.eventSequence,
      at: page.observedAt,
      dimension: "discovery",
      from,
      to,
      reason: `Enumeration receipt ${page.receiptHash} changed the known discovery set`,
    });
  }

  const members = (keys: ReadonlySet<string>): ScanProgressMember[] => [...keys]
    .map((key) => {
      const [sourceId, id] = key.split("\0");
      return { sourceId: sourceId!, id: id! };
    })
    .sort((left, right) => memberKey(left).localeCompare(memberKey(right)));
  const enumerationMembers = evidence.enumerationIntents.map((intent) => ({
    sourceId: intent.sourceId,
    id: intent.intentId,
  }));
  const snapshot: ScanProgress = {
    schema: "openlifewiki.scan-progress/v1",
    scanId: evidence.plan.scanId,
    scanPlanHash: evidence.plan.scanPlanHash,
    skeletonVersion: evidence.plan.skeletonVersion,
    sourceIds: [...sourceIds].sort(),
    discovery: {
      completePageNodes,
      knownUnenumeratedChildSlots,
      enumerationIntents: enumerationMembers,
      openIntents,
      unknownIntents,
      estimatedIntents,
      blockedIntents,
      pendingLayerIntents,
    },
    summarization: {
      summarizedIntents: evidence.layerSummaries.map((summary) => ({
        sourceId: summary.sourceId,
        id: summary.intentId,
      })),
      enumerationIntents: enumerationMembers,
    },
    selectedScan: {
      selectedLeaves: members(selectedKeys),
      processedLeaves: members(processedKeys),
    },
    committedIndex: {
      processedQmdCurrentLeaves: members(processedQmdKeys),
      committedLeaves: members(committedKeys),
      generation,
      manifestHash,
      activeManifestReceiptHash,
      generationPublished,
      publicProbesPassed,
      previousGenerationDeleted,
    },
    outcomes: {
      skippedTargets,
      deferredTargets,
      blockedTargets,
      failedTargets,
      unknownTargets,
      askUserTargets,
      unresolvedPhases: [...unresolvedPhases],
    },
    current: null,
    denominatorChanges,
  };
  validateProgress(snapshot);
  return asDerivedProgress(snapshot);
}

export function calculateScanProgress(progress: DerivedScanProgress): CalculatedScanProgress {
  if (progress[DERIVED_PROGRESS] !== true) {
    throw new Error("Progress must be derived from trusted receipts and the active QMD manifest");
  }
  const { sets, unresolvedPhases } = validateProgress(progress);
  const discoveryOpen = progress.discovery.openIntents.length > 0
    || progress.discovery.unknownIntents.length > 0
    || progress.discovery.estimatedIntents.length > 0
    || progress.discovery.blockedIntents.length > 0
    || progress.discovery.pendingLayerIntents.length > 0
    || unresolvedPhases.has("discovery");
  const discovery = calculateDimension(
    sets.completePageNodes.size,
    sets.completePageNodes.size + sets.knownUnenumeratedChildSlots.size,
    !discoveryOpen,
  );
  const summarization = calculateDimension(
    sets.summarizedIntents.size,
    sets.enumerationIntents.size,
    !unresolvedPhases.has("summarization"),
  );
  const selectedScan = calculateDimension(
    sets.processedLeaves.size,
    sets.selectedLeaves.size,
    !unresolvedPhases.has("selectedScan"),
  );
  const committedIndex = calculateDimension(
    sets.committedLeaves.size,
    sets.processedQmdCurrentLeaves.size,
    !unresolvedPhases.has("committedIndex")
      && progress.committedIndex.generation !== null
      && progress.committedIndex.generationPublished
      && progress.committedIndex.publicProbesPassed
      && progress.committedIndex.previousGenerationDeleted,
  );
  const completedWithWork = discovery.complete
    && summarization.complete
    && selectedScan.complete
    && committedIndex.complete;
  const completedNoSelectedWork = !discoveryOpen
    && summarization.complete
    && sets.selectedLeaves.size === 0
    && sets.processedQmdCurrentLeaves.size === 0
    && unresolvedPhases.size === 0;

  return {
    scanPlanHash: progress.scanPlanHash,
    skeletonVersion: progress.skeletonVersion,
    sourceIds: [...progress.sourceIds].sort(),
    discovery,
    summarization,
    selectedScan,
    committedIndex,
    denominatorChanges: progress.denominatorChanges,
    scanOutcome: completedWithWork
      ? "completed-with-indexed-work"
      : completedNoSelectedWork
        ? "completed-no-selected-work"
        : "in-progress",
    complete: completedWithWork,
  };
}

export function calculateScanProgressRollup(
  plan: ScanPlan,
  connectorProgress: readonly DerivedScanProgress[],
): CalculatedScanProgress {
  assertScanPlan(plan);
  if (connectorProgress.length === 0) throw new Error("Progress rollup requires Connector inputs");
  const first = connectorProgress[0]!;
  if (first.scanId !== plan.scanId
    || first.scanPlanHash !== plan.scanPlanHash
    || first.skeletonVersion !== plan.skeletonVersion) {
    throw new Error("Progress rollup does not bind the trusted ScanPlan");
  }
  const sourceIds = new Set<string>();
  const generationKeys = new Set<string>();
  const denominatorSequences = new Set<number>();
  for (const progress of connectorProgress) {
    if (progress[DERIVED_PROGRESS] !== true) {
      throw new Error("Progress rollup requires receipt-derived Connector inputs");
    }
    if (progress.scanId !== first.scanId) throw new Error("Progress rollup scanId mismatch");
    if (progress.scanPlanHash !== first.scanPlanHash) throw new Error("Progress rollup scanPlanHash mismatch");
    if (progress.skeletonVersion !== first.skeletonVersion) {
      throw new Error("Progress rollup skeletonVersion mismatch");
    }
    validateProgress(progress);
    for (const sourceId of progress.sourceIds) {
      if (sourceIds.has(sourceId)) throw new Error("Progress rollup Source membership overlap");
      sourceIds.add(sourceId);
    }
    generationKeys.add(JSON.stringify([
      progress.committedIndex.generation,
      progress.committedIndex.manifestHash,
      progress.committedIndex.activeManifestReceiptHash,
    ]));
    for (const change of progress.denominatorChanges) {
      if (denominatorSequences.has(change.sequence)) {
        throw new Error("Progress rollup denominator eventSequence overlap");
      }
      denominatorSequences.add(change.sequence);
    }
  }
  assertSameSet(sourceIds, new Set(plan.sourceIds), "Progress rollup Source membership");
  if (generationKeys.size > 1) throw new Error("Progress rollup active generation mismatch");

  const join = <K extends keyof ScanProgress["outcomes"]>(key: K) => connectorProgress.flatMap(
    (progress) => progress.outcomes[key] as readonly ScanProgressMember[],
  );
  const rolled: ScanProgress = {
    schema: "openlifewiki.scan-progress/v1",
    scanId: first.scanId,
    scanPlanHash: first.scanPlanHash,
    skeletonVersion: first.skeletonVersion,
    sourceIds: [...sourceIds].sort(),
    discovery: {
      completePageNodes: connectorProgress.flatMap(({ discovery }) => discovery.completePageNodes),
      knownUnenumeratedChildSlots: connectorProgress.flatMap(
        ({ discovery }) => discovery.knownUnenumeratedChildSlots,
      ),
      enumerationIntents: connectorProgress.flatMap(({ discovery }) => discovery.enumerationIntents),
      openIntents: connectorProgress.flatMap(({ discovery }) => discovery.openIntents),
      unknownIntents: connectorProgress.flatMap(({ discovery }) => discovery.unknownIntents),
      estimatedIntents: connectorProgress.flatMap(({ discovery }) => discovery.estimatedIntents),
      blockedIntents: connectorProgress.flatMap(({ discovery }) => discovery.blockedIntents),
      pendingLayerIntents: connectorProgress.flatMap(({ discovery }) => discovery.pendingLayerIntents),
    },
    summarization: {
      summarizedIntents: connectorProgress.flatMap(({ summarization }) => summarization.summarizedIntents),
      enumerationIntents: connectorProgress.flatMap(({ summarization }) => summarization.enumerationIntents),
    },
    selectedScan: {
      processedLeaves: connectorProgress.flatMap(({ selectedScan }) => selectedScan.processedLeaves),
      selectedLeaves: connectorProgress.flatMap(({ selectedScan }) => selectedScan.selectedLeaves),
    },
    committedIndex: {
      committedLeaves: connectorProgress.flatMap(({ committedIndex }) => committedIndex.committedLeaves),
      processedQmdCurrentLeaves: connectorProgress.flatMap(
        ({ committedIndex }) => committedIndex.processedQmdCurrentLeaves,
      ),
      generation: first.committedIndex.generation,
      manifestHash: first.committedIndex.manifestHash,
      activeManifestReceiptHash: first.committedIndex.activeManifestReceiptHash,
      generationPublished: connectorProgress.every(({ committedIndex }) => committedIndex.generationPublished),
      publicProbesPassed: connectorProgress.every(({ committedIndex }) => committedIndex.publicProbesPassed),
      previousGenerationDeleted: connectorProgress.every(
        ({ committedIndex }) => committedIndex.previousGenerationDeleted,
      ),
    },
    outcomes: {
      skippedTargets: join("skippedTargets"),
      deferredTargets: join("deferredTargets"),
      blockedTargets: join("blockedTargets"),
      failedTargets: join("failedTargets"),
      unknownTargets: join("unknownTargets"),
      askUserTargets: join("askUserTargets"),
      unresolvedPhases: [...new Set(connectorProgress.flatMap(
        ({ outcomes }) => outcomes.unresolvedPhases,
      ))],
    },
    current: null,
    denominatorChanges: connectorProgress.flatMap(({ denominatorChanges }) => denominatorChanges)
      .sort((left, right) => left.sequence - right.sequence),
  };
  return calculateScanProgress(asDerivedProgress(rolled));
}
