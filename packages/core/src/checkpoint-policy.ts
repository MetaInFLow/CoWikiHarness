import {
  assertScanPlan,
  sha256Canonical,
  type BodyObservationReceipt,
  type LeafSelectionReceipt,
  type ScanCheckpoint,
  type ScanPhysicalIoCounters,
  type ScanPlan,
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

export interface CurrentLeafObservation extends BranchMember {
  readonly nodeVersion: string;
  readonly contentHash: string;
  readonly bytes: number;
}

export interface QmdRematerializationAuthorization {
  readonly schema: "openlifewiki.qmd-rematerialization-authorization/v1";
  readonly allowed: true;
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly leaves: readonly CurrentLeafObservation[];
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
  readonly observation: BodyObservationReceipt | null;
  readonly expected: CheckpointReuseExpected;
  readonly trustedReceiptHashes: readonly string[];
}): boolean {
  assertReceiptIntegrity(
    input.checkpoint as unknown as Readonly<Record<string, unknown>>,
    "Scan checkpoint",
  );
  const { checkpoint, expected, observation } = input;
  const trusted = new Set(input.trustedReceiptHashes);
  if (!trusted.has(checkpoint.receiptHash)) return false;
  if (checkpoint.scanId !== expected.scanId
    || checkpoint.sourceId !== expected.sourceId
    || checkpoint.nodeId !== expected.nodeId
    || checkpoint.scanPlanHash !== expected.scanPlanHash
    || checkpoint.skeletonVersion !== expected.skeletonVersion
    || checkpoint.authorizationHash !== expected.authorizationHash
    || checkpoint.inputSetHash !== expected.inputSetHash
    || checkpoint.nodeVersion !== expected.nodeVersion) {
    return false;
  }
  if (expected.contentHash === null) return observation === null;
  if (observation === null) return false;
  assertReceiptIntegrity(
    observation as unknown as Readonly<Record<string, unknown>>,
    "Body observation",
  );
  if (!trusted.has(observation.receiptHash)) return false;
  return observation.scanId === checkpoint.scanId
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
  readonly currentLeaves: readonly CurrentLeafObservation[];
  readonly failedTemporaryGenerationDeleted: boolean;
  readonly trustedReceiptHashes: readonly string[];
}): QmdRematerializationAuthorization {
  assertScanPlan(input.plan);
  if (!input.failedTemporaryGenerationDeleted) {
    throw new Error("Failed temporary QMD generation must be deleted before rematerialization");
  }
  if (input.selections.length === 0) throw new Error("QMD rematerialization requires selected leaves");
  if (input.bodyObservations.length !== input.selections.length) {
    throw new Error("QMD rematerialization requires one complete prior body observation per selection");
  }
  if (input.currentLeaves.length !== input.selections.length) {
    throw new Error("QMD rematerialization current leaf set must exactly cover every selection");
  }
  const trusted = new Set(input.trustedReceiptHashes);

  const observationByKey = new Map<string, BodyObservationReceipt>();
  for (const observation of input.bodyObservations) {
    assertReceiptIntegrity(
      observation as unknown as Readonly<Record<string, unknown>>,
      "Body observation",
    );
    if (!trusted.has(observation.receiptHash)) {
      throw new Error("Body observation is outside the trusted receipt ledger");
    }
    const observationKey = key(observation);
    if (observationByKey.has(observationKey)) throw new Error("Body observation is duplicated");
    observationByKey.set(observationKey, observation);
  }
  const currentByKey = new Map<string, CurrentLeafObservation>();
  for (const current of input.currentLeaves) {
    if (!Number.isSafeInteger(current.bytes) || current.bytes < 0) {
      throw new Error("Current body byte count is invalid");
    }
    const currentKey = key(current);
    if (currentByKey.has(currentKey)) throw new Error("Current leaf is duplicated");
    currentByKey.set(currentKey, current);
  }

  const priorObservationReceiptHashes: string[] = [];
  for (const selection of input.selections) {
    assertReceiptIntegrity(selection as unknown as Readonly<Record<string, unknown>>, "Leaf selection");
    if (!trusted.has(selection.receiptHash)) {
      throw new Error("Leaf selection is outside the trusted receipt ledger");
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
    if (current.nodeVersion !== selection.nodeVersion || current.nodeVersion !== observation.nodeVersion) {
      throw new Error(`Current node version changed for ${selection.nodeId}`);
    }
    if (current.contentHash !== observation.contentHash) {
      throw new Error(`Current content hash changed for ${selection.nodeId}`);
    }
    if (current.bytes !== observation.bytes) {
      throw new Error(`Current body byte count changed for ${selection.nodeId}`);
    }
    priorObservationReceiptHashes.push(observation.receiptHash);
  }

  const payload = {
    schema: "openlifewiki.qmd-rematerialization-authorization/v1" as const,
    allowed: true as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    leaves: [...input.currentLeaves],
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

export function recordPhysicalIo(
  accounting: PhysicalIoAccounting,
  observations: readonly BodyObservationReceipt[],
  rematerializationAuthorizations: readonly QmdRematerializationAuthorization[] = [],
): PhysicalIoAccounting {
  const receiptHashes = new Set(accounting.observedReceiptHashes);
  const counters = { ...accounting.counters };
  const authorizations = new Map<string, QmdRematerializationAuthorization>();
  for (const authorization of rematerializationAuthorizations) {
    const { authorizationHash, ...payload } = authorization;
    if (sha256Canonical(payload) !== authorizationHash) {
      throw new Error("Rematerialization authorization hash mismatch");
    }
    if (authorizations.has(authorizationHash)) {
      throw new Error("Rematerialization authorization is duplicated");
    }
    authorizations.set(authorizationHash, authorization);
  }
  for (const observation of observations) {
    assertReceiptIntegrity(
      observation as unknown as Readonly<Record<string, unknown>>,
      "Body observation",
    );
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
        && leaf.nodeVersion === observation.nodeVersion
        && leaf.contentHash === observation.contentHash
        && leaf.bytes === observation.bytes
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
  }
  return Object.freeze({
    schema: accounting.schema,
    observedReceiptHashes: [...receiptHashes],
    counters: Object.freeze(counters),
  });
}
