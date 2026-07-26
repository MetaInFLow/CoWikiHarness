import {
  assertScanPlan,
  type AuthorizedSourceV1,
  type LeafSelectionReceipt,
  type MetadataSample,
  type ScanDecision,
  type ScanPlan,
  type SkeletonNode,
} from "@openlifewiki/protocol";

import { sha256Canonical } from "./hashing.js";

export interface BodyReadGateInput {
  readonly request: {
    readonly sourceId: string;
    readonly nodeId: string;
    readonly authorizationHash: string;
    readonly scanPlanHash: string;
    readonly skeletonVersion: string;
    readonly nodeVersion: string;
  };
  readonly authorization: AuthorizedSourceV1;
  readonly plan: ScanPlan;
  readonly path: readonly SkeletonNode[];
  readonly decisionReceipts: readonly ScanDecision[];
  readonly leafSelectionReceipts: readonly LeafSelectionReceipt[];
  readonly trustedReceiptHashes: readonly string[];
  readonly metadataSamples?: readonly MetadataSample[];
}

function assertTrustedReceipt(
  receipt: ScanDecision | LeafSelectionReceipt,
  trustedReceiptHashes: readonly string[],
  label: string,
): void {
  const { receiptHash, ...receiptPayload } = receipt;
  if (sha256Canonical(receiptPayload) !== receiptHash) {
    throw new Error(`${label} ${receiptHash} failed integrity verification`);
  }
  if (!trustedReceiptHashes.includes(receiptHash)) {
    throw new Error(`${label} ${receiptHash} is absent from the trusted ledger`);
  }
}

export function assertBodyReadAllowed(input: BodyReadGateInput): { readonly allowed: true } {
  const { authorization, plan, request } = input;
  assertScanPlan(plan);
  const sourceIndex = plan.sourceIds.indexOf(request.sourceId);
  if (sourceIndex < 0 || request.sourceId !== authorization.sourceId) {
    throw new Error("sourceId mismatch");
  }
  if (
    request.authorizationHash !== authorization.authorizationHash
    || plan.authorizationHashes[sourceIndex] !== request.authorizationHash
  ) {
    throw new Error("authorizationHash mismatch");
  }
  if (request.scanPlanHash !== plan.scanPlanHash) throw new Error("scanPlanHash mismatch");
  if (request.skeletonVersion !== plan.skeletonVersion) throw new Error("skeletonVersion mismatch");
  if (plan.rootNodeIds[sourceIndex] !== authorization.rootNodeId) {
    throw new Error("ScanPlan rootNodeId mismatch");
  }

  const root = input.path[0];
  if (
    root === undefined
    || root.nodeId !== authorization.rootNodeId
    || root.parentId !== null
  ) {
    throw new Error("Body read path root mismatch");
  }

  for (const node of input.path) {
    if (node.sourceId !== request.sourceId) throw new Error("Body read path Source mismatch");
    if (node.permission !== "readable") throw new Error(`Body read permission denied for ${node.nodeId}`);
  }

  const target = input.path.at(-1);
  if (target === undefined || target.nodeId !== request.nodeId || target.sourceId !== request.sourceId) {
    throw new Error("body read path mismatch");
  }
  if (target.nodeVersion !== request.nodeVersion) throw new Error("nodeVersion mismatch");
  if (target.scanability !== "metadata-and-body") throw new Error("Target does not permit body reads");

  let targetDecision: ScanDecision | undefined;
  if (input.path.length === 1) {
    targetDecision = input.decisionReceipts.find((candidate) =>
      candidate.sourceId === request.sourceId
      && candidate.parentNodeId === target.nodeId
      && candidate.parentNodeVersion === target.nodeVersion
      && candidate.nodeId === target.nodeId
      && candidate.nodeVersion === target.nodeVersion
      && candidate.targetKind === "leaf"
      && candidate.scanId === plan.scanId
      && candidate.scanPlanHash === plan.scanPlanHash
      && candidate.skeletonVersion === plan.skeletonVersion
      && candidate.authorizationHash === authorization.authorizationHash
      && candidate.decision === "descend"
      && candidate.persistedAt.length > 0
      && candidate.receiptHash.length > 0
    );
    if (targetDecision !== undefined) {
      assertTrustedReceipt(targetDecision, input.trustedReceiptHashes, "Root leaf decision receipt");
    }
  }
  for (let index = 0; index < input.path.length - 1; index += 1) {
    const parent = input.path[index];
    const child = input.path[index + 1];
    if (parent === undefined || child === undefined || child.parentId !== parent.nodeId) {
      throw new Error("body read path mismatch");
    }

    const receipt = input.decisionReceipts.find((candidate) =>
      candidate.sourceId === request.sourceId
      && candidate.parentNodeId === parent.nodeId
      && candidate.parentNodeVersion === parent.nodeVersion
      && candidate.nodeId === child.nodeId
      && candidate.nodeVersion === child.nodeVersion
      && candidate.targetKind === (index === input.path.length - 2 ? "leaf" : "container")
      && candidate.scanId === plan.scanId
      && candidate.scanPlanHash === plan.scanPlanHash
      && candidate.skeletonVersion === plan.skeletonVersion
      && candidate.authorizationHash === authorization.authorizationHash
      && candidate.decision === "descend"
      && candidate.persistedAt.length > 0
      && candidate.receiptHash.length > 0
    );
    if (receipt === undefined) {
      throw new Error(`Persisted descend decision receipt missing for ${child.nodeId}`);
    }
    assertTrustedReceipt(receipt, input.trustedReceiptHashes, "Descend receipt");
    if (index === input.path.length - 2) {
      targetDecision = receipt;
    }
  }

  if (targetDecision === undefined) {
    throw new Error(`Persisted descend decision receipt missing for ${target.nodeId}`);
  }

  const selection = input.leafSelectionReceipts.find((candidate) =>
    candidate.scanId === plan.scanId
    && candidate.sourceId === request.sourceId
    && candidate.nodeId === target.nodeId
    && candidate.nodeVersion === target.nodeVersion
    && candidate.scanPlanHash === plan.scanPlanHash
    && candidate.skeletonVersion === plan.skeletonVersion
    && candidate.authorizationHash === authorization.authorizationHash
    && candidate.persistedAt.length > 0
    && candidate.receiptHash.length > 0
  );
  if (selection === undefined) {
    throw new Error(`Target leaf selection receipt missing for ${target.nodeId}`);
  }
  assertTrustedReceipt(selection, input.trustedReceiptHashes, "Leaf selection receipt");

  const decisionReceiptHash = selection.decisionReceiptHash;
  if (
    typeof decisionReceiptHash !== "string"
    || decisionReceiptHash.length === 0
    || decisionReceiptHash !== targetDecision.receiptHash
  ) {
    throw new Error("Leaf selection decision receipt binding mismatch");
  }
  if (selection.inputSetHash !== targetDecision.inputSetHash) {
    throw new Error("Leaf selection inputSetHash mismatch");
  }

  return { allowed: true };
}
