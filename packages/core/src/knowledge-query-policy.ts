import {
  sha256Canonical,
  type KnowledgeCitation,
  type KnowledgeQueryResult,
} from "@openlifewiki/protocol";

export function assertGroundedKnowledgeResult(input: {
  readonly taskId: string;
  readonly result: KnowledgeQueryResult;
  readonly retrievedCitations: readonly KnowledgeCitation[];
  readonly allowPartial: boolean;
}): void {
  if (input.result.taskId !== input.taskId) {
    throw new Error("Knowledge result task binding changed");
  }

  const evidence = new Map<string, string>();
  for (const citation of input.retrievedCitations) {
    if (evidence.has(citation.citationId)) {
      throw new Error("Knowledge retrieval ledger contains a duplicate citation ID");
    }
    evidence.set(citation.citationId, sha256Canonical(citation));
  }
  const returnedIds = new Set<string>();
  for (const citation of input.result.citations) {
    if (
      returnedIds.has(citation.citationId)
      || evidence.get(citation.citationId) !== sha256Canonical(citation)
    ) {
      throw new Error("Knowledge result contains an unbound citation");
    }
    returnedIds.add(citation.citationId);
  }

  const evidenceMode = input.result.evidenceMode;
  switch (evidenceMode) {
    case "grounded":
      if (returnedIds.size === 0) {
        throw new Error("Grounded knowledge requires cited evidence");
      }
      return;
    case "partial":
      if (!input.allowPartial) {
        throw new Error("Partial knowledge is not allowed for this operation");
      }
      if (returnedIds.size === 0 || input.result.gaps.length === 0) {
        throw new Error("Partial knowledge requires cited evidence and an explicit gap");
      }
      return;
    case "conflicting":
      if (returnedIds.size < 2) {
        throw new Error("Conflicting knowledge requires two cited sources");
      }
      if (!input.result.gaps.some(({ code }) => code === "EVIDENCE_CONFLICT")) {
        throw new Error("Conflicting knowledge requires an explicit conflict gap");
      }
      return;
    case "no-evidence":
      if (returnedIds.size !== 0) {
        throw new Error("No-evidence knowledge cannot cite evidence");
      }
      if (input.result.gaps.length === 0) {
        throw new Error("No-evidence knowledge requires an explicit gap");
      }
      if (input.result.answer.trim().length !== 0) {
        throw new Error("No-evidence knowledge requires an empty answer");
      }
      return;
    default:
      assertNever(evidenceMode);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported knowledge evidence mode: ${String(value)}`);
}
