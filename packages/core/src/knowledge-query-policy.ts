import {
  sha256Canonical,
  type KnowledgeCitation,
  type KnowledgeQueryResult,
} from "@openlifewiki/protocol";

export function assertGroundedKnowledgeResult(input: {
  readonly taskId: string;
  readonly result: KnowledgeQueryResult;
  readonly retrievedCitations: readonly KnowledgeCitation[];
}): void {
  if (input.result.taskId !== input.taskId) {
    throw new Error("Knowledge result task binding changed");
  }

  const evidence = new Map(input.retrievedCitations.map((citation) => [
    citation.citationId,
    sha256Canonical(citation),
  ]));
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

  if (input.result.evidenceMode === "grounded" && returnedIds.size === 0) {
    throw new Error("Grounded knowledge requires cited evidence");
  }
  if (
    input.result.evidenceMode === "no-evidence"
    && (returnedIds.size !== 0 || input.result.gaps.length === 0)
  ) {
    throw new Error("No-evidence result requires only explicit gaps");
  }
}
