import type {
  AuthorizedSourceV1,
  MetadataSample,
  ScanDecision,
  ScanPlan,
  SkeletonNode,
} from "@openlifewiki/protocol";

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
  readonly trustedReceiptHashes: readonly string[];
  readonly metadataSamples?: readonly MetadataSample[];
}

export function assertBodyReadAllowed(input: BodyReadGateInput): { readonly allowed: true } {
  const { authorization, plan, request } = input;
  if (
    request.authorizationHash !== authorization.authorizationHash
    || !plan.authorizationHashes.includes(request.authorizationHash)
  ) {
    throw new Error("authorizationHash mismatch");
  }
  if (request.scanPlanHash !== plan.scanPlanHash) throw new Error("scanPlanHash mismatch");
  if (request.skeletonVersion !== plan.skeletonVersion) throw new Error("skeletonVersion mismatch");
  if (
    request.sourceId !== authorization.sourceId
    || !plan.sourceIds.includes(request.sourceId)
  ) {
    throw new Error("sourceId mismatch");
  }

  if (input.path.length < 2) {
    throw new Error("Persisted descend decision receipt path is required");
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

  for (let index = 0; index < input.path.length - 1; index += 1) {
    const node = input.path[index];
    const child = input.path[index + 1];
    if (node === undefined || child === undefined || child.parentId !== node.nodeId) {
      throw new Error("body read path mismatch");
    }

    const receipt = input.decisionReceipts.find((candidate) =>
      candidate.nodeId === node.nodeId
      && candidate.nodeVersion === node.nodeVersion
      && candidate.scanId === plan.scanId
      && candidate.scanPlanHash === plan.scanPlanHash
      && candidate.skeletonVersion === plan.skeletonVersion
      && candidate.authorizationHash === authorization.authorizationHash
      && candidate.decision === "descend"
      && candidate.persistedAt.length > 0
      && candidate.receiptHash.length > 0
    );
    if (receipt === undefined) {
      throw new Error(`Persisted descend decision receipt missing for ${node.nodeId}`);
    }
    if (!input.trustedReceiptHashes.includes(receipt.receiptHash)) {
      throw new Error(`Descend receipt ${receipt.receiptHash} is absent from the trusted ledger`);
    }
  }

  return { allowed: true };
}
