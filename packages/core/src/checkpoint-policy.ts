import {
  assertScanPlan,
  sha256Canonical,
  type BodyObservationReceipt,
  type CurrentLeafVersionReceipt,
  type LeafSelectionReceipt,
  type ScanCheckpoint,
  type ScanPhysicalIoCounters,
  type ScanPlan,
  type TemporaryQmdGenerationDeletionReceipt,
  type TemporaryQmdGenerationFailureReceipt,
} from "@openlifewiki/protocol";

export interface CheckpointReuseExpected {
  readonly scanId: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly inputSetHash: string;
  readonly nodeVersion: string;
  readonly contentHash: string | null;
  readonly phase: ScanCheckpoint["phase"];
  readonly indexingDisposition: ScanCheckpoint["indexingDisposition"];
  readonly selectionReceiptHash: string | null;
  readonly bodyObservationReceiptHash: string | null;
  readonly qmdGenerationId: string | null;
}

export interface BranchNode {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly parentNodeId: string | null;
}

export interface BranchMember {
  readonly sourceId: string;
  readonly nodeId: string;
}

export interface RematerializationExpectedLeaf extends BranchMember {
  readonly expectedNodeVersion: string;
  readonly expectedPriorContentHash: string;
  readonly expectedPriorBytes: number;
  readonly priorBodyObservationReceiptHash: string;
  readonly currentVersionReceiptHash: string;
}

export interface QmdRematerializationAuthorization {
  readonly schema: "openlifewiki.qmd-rematerialization-authorization/v1";
  readonly allowed: true;
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly temporaryGenerationFailureReceiptHash: string;
  readonly temporaryGenerationDeletionReceiptHash: string;
  readonly leaves: readonly RematerializationExpectedLeaf[];
  readonly priorObservationReceiptHashes: readonly string[];
  readonly logicalCompletionsAdded: 0;
  readonly authorizationHash: string;
}

export interface PhysicalIoAccounting {
  readonly schema: "openlifewiki.scan-physical-io/v1";
  readonly observedReceiptHashes: readonly string[];
  readonly counters: ScanPhysicalIoCounters;
}

function key(member: BranchMember): string {
  return `${member.sourceId}\0${member.nodeId}`;
}

function assertReceiptIntegrity(receipt: Readonly<Record<string, unknown>>, label: string): void {
  const { receiptHash, ...payload } = receipt;
  if (typeof receiptHash !== "string" || sha256Canonical(payload) !== receiptHash) {
    throw new Error(`${label} receiptHash mismatch`);
  }
}

export function isCheckpointReusable(input: {
  readonly checkpoint: ScanCheckpoint;
  readonly selection: LeafSelectionReceipt | null;
  readonly observation: BodyObservationReceipt | null;
  readonly expected: CheckpointReuseExpected;
  readonly trustedReceiptHashes: readonly string[];
}): boolean {
  assertReceiptIntegrity(
    input.checkpoint as unknown as Readonly<Record<string, unknown>>,
    "Scan checkpoint",
  );
  const { checkpoint, expected, selection, observation } = input;
  const trusted = new Set(input.trustedReceiptHashes);
  if (!trusted.has(checkpoint.receiptHash)) return false;
  if (checkpoint.scanId !== expected.scanId
    || checkpoint.sourceId !== expected.sourceId
    || checkpoint.nodeId !== expected.nodeId
    || checkpoint.scanPlanHash !== expected.scanPlanHash
    || checkpoint.skeletonVersion !== expected.skeletonVersion
    || checkpoint.authorizationHash !== expected.authorizationHash
    || checkpoint.inputSetHash !== expected.inputSetHash
    || checkpoint.nodeVersion !== expected.nodeVersion
    || checkpoint.phase !== expected.phase
    || checkpoint.indexingDisposition !== expected.indexingDisposition
    || (checkpoint.selectionReceiptHash ?? null) !== expected.selectionReceiptHash
    || (checkpoint.bodyObservationReceiptHash ?? null) !== expected.bodyObservationReceiptHash
    || (checkpoint.qmdGenerationId ?? null) !== expected.qmdGenerationId) {
    return false;
  }
  const bodyPhase = expected.phase === "body-processed" || expected.phase === "qmd-committed";
  if (!bodyPhase) {
    return expected.contentHash === null
      && expected.selectionReceiptHash === null
      && expected.bodyObservationReceiptHash === null
      && expected.qmdGenerationId === null
      && selection === null
      && observation === null;
  }
  if (expected.contentHash === null
    || expected.selectionReceiptHash === null
    || expected.bodyObservationReceiptHash === null
    || selection === null
    || observation === null) return false;
  if (expected.phase === "qmd-committed") {
    if (expected.qmdGenerationId === null || expected.indexingDisposition !== "qmd-current") return false;
  } else if (expected.qmdGenerationId !== null) return false;
  assertReceiptIntegrity(selection as unknown as Readonly<Record<string, unknown>>, "Leaf selection");
  assertReceiptIntegrity(
    observation as unknown as Readonly<Record<string, unknown>>,
    "Body observation",
  );
  if (!trusted.has(selection.receiptHash) || !trusted.has(observation.receiptHash)) return false;
  return selection.schema === "openlifewiki.leaf-selection/v1"
    && observation.schema === "openlifewiki.body-observation-receipt/v1"
    && selection.receiptHash === expected.selectionReceiptHash
    && selection.scanId === checkpoint.scanId
    && selection.scanPlanHash === checkpoint.scanPlanHash
    && selection.skeletonVersion === checkpoint.skeletonVersion
    && selection.authorizationHash === checkpoint.authorizationHash
    && selection.sourceId === checkpoint.sourceId
    && selection.nodeId === checkpoint.nodeId
    && selection.nodeVersion === checkpoint.nodeVersion
    && selection.inputSetHash === checkpoint.inputSetHash
    && observation.receiptHash === expected.bodyObservationReceiptHash
    && observation.selectionReceiptHash === selection.receiptHash
    && observation.scanId === checkpoint.scanId
    && observation.scanPlanHash === checkpoint.scanPlanHash
    && observation.skeletonVersion === checkpoint.skeletonVersion
    && observation.authorizationHash === checkpoint.authorizationHash
    && observation.sourceId === checkpoint.sourceId
    && observation.nodeId === checkpoint.nodeId
    && observation.nodeVersion === checkpoint.nodeVersion
    && observation.inputSetHash === checkpoint.inputSetHash
    && observation.contentHash === expected.contentHash;
}

export function deriveBranchInvalidation(input: {
  readonly nodes: readonly BranchNode[];
  readonly changed: readonly BranchMember[];
}): readonly BranchMember[] {
  const nodeByKey = new Map(input.nodes.map((node) => [key(node), node]));
  const children = new Map<string, BranchNode[]>();
  for (const node of input.nodes) {
    if (node.parentNodeId === null) continue;
    const parentKey = key({ sourceId: node.sourceId, nodeId: node.parentNodeId });
    const current = children.get(parentKey) ?? [];
    current.push(node);
    children.set(parentKey, current);
  }

  const result: BranchMember[] = [];
  const seen = new Set<string>();
  const add = (member: BranchMember): void => {
    const memberKey = key(member);
    if (seen.has(memberKey)) return;
    if (!nodeByKey.has(memberKey)) throw new Error(`Changed branch node is unknown: ${member.nodeId}`);
    seen.add(memberKey);
    result.push({ sourceId: member.sourceId, nodeId: member.nodeId });
  };

  for (const changed of input.changed) add(changed);
  for (let index = 0; index < result.length; index += 1) {
    const member = result[index]!;
    for (const child of children.get(key(member)) ?? []) add(child);
  }
  for (const changed of input.changed) {
    let current = nodeByKey.get(key(changed));
    while (current?.parentNodeId !== null && current?.parentNodeId !== undefined) {
      const parent = { sourceId: current.sourceId, nodeId: current.parentNodeId };
      add(parent);
      current = nodeByKey.get(key(parent));
    }
  }
  return Object.freeze(result);
}

export function authorizeQmdRematerialization(input: {
  readonly plan: ScanPlan;
  readonly selections: readonly LeafSelectionReceipt[];
  readonly bodyObservations: readonly BodyObservationReceipt[];
  readonly currentVersionReceipts: readonly CurrentLeafVersionReceipt[];
  readonly temporaryGenerationFailureReceipt: TemporaryQmdGenerationFailureReceipt;
  readonly temporaryGenerationDeletionReceipt: TemporaryQmdGenerationDeletionReceipt;
  readonly trustedReceiptHashes: readonly string[];
}): QmdRematerializationAuthorization {
  assertScanPlan(input.plan);
  if (input.selections.length === 0) throw new Error("QMD rematerialization requires selected leaves");
  if (input.bodyObservations.length !== input.selections.length) {
    throw new Error("QMD rematerialization requires one complete prior body observation per selection");
  }
  if (input.currentVersionReceipts.length !== input.selections.length) {
    throw new Error("QMD rematerialization current version set must exactly cover every selection");
  }
  const trusted = new Set(input.trustedReceiptHashes);
  const failure = input.temporaryGenerationFailureReceipt;
  assertReceiptIntegrity(
    failure as unknown as Readonly<Record<string, unknown>>,
    "Temporary QMD generation failure",
  );
  if (!trusted.has(failure.receiptHash)) {
    throw new Error("Temporary QMD generation failure is outside the trusted receipt ledger");
  }
  if (failure.schema !== "openlifewiki.temporary-qmd-generation-failure-receipt/v1"
    || failure.phase !== "build"
    || failure.scanId !== input.plan.scanId
    || failure.scanPlanHash !== input.plan.scanPlanHash
    || failure.skeletonVersion !== input.plan.skeletonVersion) {
    throw new Error("Temporary QMD generation failure does not bind the active plan");
  }
  const deletion = input.temporaryGenerationDeletionReceipt;
  assertReceiptIntegrity(
    deletion as unknown as Readonly<Record<string, unknown>>,
    "Temporary QMD generation deletion",
  );
  if (!trusted.has(deletion.receiptHash)) {
    throw new Error("Temporary QMD generation deletion is outside the trusted receipt ledger");
  }
  if (deletion.schema !== "openlifewiki.temporary-qmd-generation-deletion-receipt/v1"
    || deletion.scanId !== input.plan.scanId
    || deletion.scanPlanHash !== input.plan.scanPlanHash
    || deletion.skeletonVersion !== input.plan.skeletonVersion
    || deletion.failureReceiptHash !== failure.receiptHash
    || deletion.generationId !== failure.generationId) {
    throw new Error("Temporary QMD generation deletion does not bind the active plan");
  }

  const observationByKey = new Map<string, BodyObservationReceipt>();
  for (const observation of input.bodyObservations) {
    assertReceiptIntegrity(
      observation as unknown as Readonly<Record<string, unknown>>,
      "Body observation",
    );
    if (!trusted.has(observation.receiptHash)) {
      throw new Error("Body observation is outside the trusted receipt ledger");
    }
    if (observation.schema !== "openlifewiki.body-observation-receipt/v1") {
      throw new Error("Body observation schema is invalid");
    }
    const observationKey = key(observation);
    if (observationByKey.has(observationKey)) throw new Error("Body observation is duplicated");
    observationByKey.set(observationKey, observation);
  }
  const currentByKey = new Map<string, CurrentLeafVersionReceipt>();
  for (const current of input.currentVersionReceipts) {
    assertReceiptIntegrity(
      current as unknown as Readonly<Record<string, unknown>>,
      "Current leaf version",
    );
    if (!trusted.has(current.receiptHash)) {
      throw new Error("Current leaf version is outside the trusted receipt ledger");
    }
    if (current.schema !== "openlifewiki.current-leaf-version-receipt/v1") {
      throw new Error("Current leaf version schema is invalid");
    }
    const currentKey = key(current);
    if (currentByKey.has(currentKey)) throw new Error("Current leaf is duplicated");
    currentByKey.set(currentKey, current);
  }

  const priorObservationReceiptHashes: string[] = [];
  const leaves: RematerializationExpectedLeaf[] = [];
  for (const selection of input.selections) {
    assertReceiptIntegrity(selection as unknown as Readonly<Record<string, unknown>>, "Leaf selection");
    if (!trusted.has(selection.receiptHash)) {
      throw new Error("Leaf selection is outside the trusted receipt ledger");
    }
    if (selection.schema !== "openlifewiki.leaf-selection/v1") {
      throw new Error("Leaf selection schema is invalid");
    }
    const sourceIndex = input.plan.sourceIds.indexOf(selection.sourceId);
    if (sourceIndex < 0
      || selection.scanId !== input.plan.scanId
      || selection.scanPlanHash !== input.plan.scanPlanHash
      || selection.skeletonVersion !== input.plan.skeletonVersion
      || selection.authorizationHash !== input.plan.authorizationHashes[sourceIndex]) {
      throw new Error("Leaf selection does not bind the active plan");
    }
    const observation = observationByKey.get(key(selection));
    if (observation === undefined
      || observation.selectionReceiptHash !== selection.receiptHash
      || observation.inputSetHash !== selection.inputSetHash) {
      throw new Error("Selected leaf is missing its exact prior body observation");
    }
    const current = currentByKey.get(key(selection));
    if (current === undefined) throw new Error("Selected leaf is missing from the current rematerialization set");
    if (current.scanId !== input.plan.scanId
      || current.scanPlanHash !== input.plan.scanPlanHash
      || current.skeletonVersion !== input.plan.skeletonVersion
      || current.authorizationHash !== selection.authorizationHash
      || current.sourceId !== selection.sourceId
      || current.nodeId !== selection.nodeId
      || current.selectionReceiptHash !== selection.receiptHash
      || current.priorBodyObservationReceiptHash !== observation.receiptHash
      || current.expectedNodeVersion !== selection.nodeVersion
      || current.expectedPriorContentHash !== observation.contentHash
      || current.expectedPriorBytes !== observation.bytes) {
      throw new Error(`Current version receipt binding mismatch for ${selection.nodeId}`);
    }
    if (current.observedNodeVersion !== selection.nodeVersion) {
      throw new Error(`Current node version changed for ${selection.nodeId}`);
    }
    priorObservationReceiptHashes.push(observation.receiptHash);
    leaves.push({
      sourceId: selection.sourceId,
      nodeId: selection.nodeId,
      expectedNodeVersion: selection.nodeVersion,
      expectedPriorContentHash: observation.contentHash,
      expectedPriorBytes: observation.bytes,
      priorBodyObservationReceiptHash: observation.receiptHash,
      currentVersionReceiptHash: current.receiptHash,
    });
  }

  const payload = {
    schema: "openlifewiki.qmd-rematerialization-authorization/v1" as const,
    allowed: true as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    temporaryGenerationFailureReceiptHash: failure.receiptHash,
    temporaryGenerationDeletionReceiptHash: deletion.receiptHash,
    leaves,
    priorObservationReceiptHashes,
    logicalCompletionsAdded: 0 as const,
  };
  return Object.freeze({ ...payload, authorizationHash: sha256Canonical(payload) });
}

export function createPhysicalIoAccounting(): PhysicalIoAccounting {
  return Object.freeze({
    schema: "openlifewiki.scan-physical-io/v1",
    observedReceiptHashes: [],
    counters: {
      initialReadItems: 0,
      initialReadBytes: 0,
      rematerializedItems: 0,
      rematerializedBytes: 0,
    },
  });
}

export function recordPhysicalIo(input: {
  readonly accounting: PhysicalIoAccounting;
  readonly priorObservations: readonly BodyObservationReceipt[];
  readonly observations: readonly BodyObservationReceipt[];
  readonly rematerializationAuthorizations: readonly QmdRematerializationAuthorization[];
  readonly trustedReceiptHashes: readonly string[];
}): PhysicalIoAccounting {
  const { accounting, priorObservations, observations, rematerializationAuthorizations } = input;
  const trusted = new Set(input.trustedReceiptHashes);
  const authorizations = new Map<string, QmdRematerializationAuthorization>();
  for (const authorization of rematerializationAuthorizations) {
    const { authorizationHash, ...payload } = authorization;
    if (sha256Canonical(payload) !== authorizationHash) {
      throw new Error("Rematerialization authorization hash mismatch");
    }
    if (authorization.schema !== "openlifewiki.qmd-rematerialization-authorization/v1") {
      throw new Error("Rematerialization authorization schema is invalid");
    }
    if (!trusted.has(authorizationHash)) {
      throw new Error("Rematerialization authorization is outside the trusted receipt ledger");
    }
    if (authorizations.has(authorizationHash)) {
      throw new Error("Rematerialization authorization is duplicated");
    }
    authorizations.set(authorizationHash, authorization);
  }

  const receiptHashes = new Set<string>();
  const counters = {
    initialReadItems: 0,
    initialReadBytes: 0,
    rematerializedItems: 0,
    rematerializedBytes: 0,
  };
  const applyObservation = (observation: BodyObservationReceipt): void => {
    assertReceiptIntegrity(
      observation as unknown as Readonly<Record<string, unknown>>,
      "Body observation",
    );
    if (!trusted.has(observation.receiptHash)) {
      throw new Error("Body observation is outside the trusted receipt ledger");
    }
    if (observation.schema !== "openlifewiki.body-observation-receipt/v1") {
      throw new Error("Body observation schema is invalid");
    }
    if (receiptHashes.has(observation.receiptHash)) {
      throw new Error("Body observation was already counted");
    }
    if (observation.purpose === "qmd-rematerialization") {
      if (observation.previousObservationReceiptHash === null
        || !receiptHashes.has(observation.previousObservationReceiptHash)) {
        throw new Error("Rematerialization must follow a counted prior observation");
      }
      if (observation.rematerializationAuthorizationHash === null) {
        throw new Error("Rematerialization observation is missing its authorization");
      }
      const authorization = authorizations.get(observation.rematerializationAuthorizationHash);
      const authorizedLeaf = authorization?.leaves.find((leaf) =>
        leaf.sourceId === observation.sourceId
        && leaf.nodeId === observation.nodeId
        && leaf.expectedNodeVersion === observation.nodeVersion
        && leaf.expectedPriorContentHash === observation.contentHash
        && leaf.expectedPriorBytes === observation.bytes
        && leaf.priorBodyObservationReceiptHash === observation.previousObservationReceiptHash
      );
      if (authorization === undefined
        || authorization.scanId !== observation.scanId
        || authorization.scanPlanHash !== observation.scanPlanHash
        || authorization.skeletonVersion !== observation.skeletonVersion
        || !authorization.priorObservationReceiptHashes
          .includes(observation.previousObservationReceiptHash)
        || authorizedLeaf === undefined) {
        throw new Error("Rematerialization observation does not match its policy authorization");
      }
      counters.rematerializedItems += 1;
      counters.rematerializedBytes += observation.bytes;
    } else {
      if (observation.previousObservationReceiptHash !== null) {
        throw new Error("Initial read cannot claim a previous observation");
      }
      if (observation.rematerializationAuthorizationHash !== null) {
        throw new Error("Initial read cannot claim rematerialization authorization");
      }
      counters.initialReadItems += 1;
      counters.initialReadBytes += observation.bytes;
    }
    receiptHashes.add(observation.receiptHash);
  };

  for (const observation of priorObservations) applyObservation(observation);
  const exactPriorHashes = priorObservations.map(({ receiptHash }) => receiptHash);
  if (accounting.schema !== "openlifewiki.scan-physical-io/v1"
    || JSON.stringify(accounting.observedReceiptHashes) !== JSON.stringify(exactPriorHashes)
    || sha256Canonical(accounting.counters) !== sha256Canonical(counters)) {
    throw new Error("Physical I/O accounting does not exactly match its trusted prior entries and counters");
  }
  for (const observation of observations) applyObservation(observation);
  return Object.freeze({
    schema: accounting.schema,
    observedReceiptHashes: [...receiptHashes],
    counters: Object.freeze(counters),
  });
}
