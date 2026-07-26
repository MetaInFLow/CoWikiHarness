import type { WikiApproval, WikiProposal } from "@openlifewiki/protocol";

export interface WikiPublicationGateInput {
  readonly proposal: WikiProposal;
  readonly approval: WikiApproval;
  readonly recomputedProposalHash: string;
  readonly currentWikiHash: string;
}

export function assertWikiPublicationAllowed(
  input: WikiPublicationGateInput,
): { readonly allowed: true } {
  const { approval, proposal } = input;
  if (approval.actor.role !== "owner" && approval.actor.role !== "admin") {
    throw new Error("Wiki approval actor must be owner or admin");
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
