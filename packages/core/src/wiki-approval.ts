import type { WikiApproval, WikiProposal } from "@openlifewiki/protocol";

import { sha256Canonical } from "./hashing.js";

export interface WikiPublicationGateInput {
  readonly proposal: WikiProposal;
  readonly approval: WikiApproval;
  readonly expectedOwnerId: string;
  readonly trustedApprovalReceiptHashes: readonly string[];
  readonly recomputedProposalHash: string;
  readonly currentWikiHash: string;
}

export function assertWikiPublicationAllowed(
  input: WikiPublicationGateInput,
): { readonly allowed: true } {
  const { approval, proposal } = input;
  if (approval.actor.role !== "owner") {
    throw new Error("Wiki publication requires an Owner approval receipt");
  }
  if (approval.actor.id !== input.expectedOwnerId) {
    throw new Error("Wiki approval receipt does not match the expected Owner");
  }
  const { receiptHash, ...approvalPayload } = approval;
  if (sha256Canonical(approvalPayload) !== receiptHash) {
    throw new Error(`Wiki approval receipt ${receiptHash} failed integrity verification`);
  }
  if (!input.trustedApprovalReceiptHashes.includes(receiptHash)) {
    throw new Error(`Wiki approval receipt ${receiptHash} is absent from the trusted ledger`);
  }
  if (approval.proposalId !== proposal.proposalId) throw new Error("proposalId mismatch");
  if (
    approval.proposalHash !== proposal.proposalHash
    || input.recomputedProposalHash !== proposal.proposalHash
  ) {
    throw new Error("proposalHash mismatch");
  }
  if (
    approval.baseWikiHash !== proposal.baseWikiHash
    || input.currentWikiHash !== proposal.baseWikiHash
  ) {
    throw new Error("baseWikiHash compare-and-swap mismatch");
  }
  if (approval.receiptHash.length === 0 || approval.approvedAt.length === 0) {
    throw new Error("Wiki approval receipt is incomplete");
  }

  return { allowed: true };
}
