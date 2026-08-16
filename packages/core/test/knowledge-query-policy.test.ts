import { describe, expect, it } from "vitest";

import type { KnowledgeCitation, KnowledgeQueryResult } from "@openlifewiki/protocol";

import { assertGroundedKnowledgeResult } from "../src/knowledge-query-policy.js";

const HASH = `sha256:${"a".repeat(64)}`;

const citation = {
  citationId: "citation_1",
  itemId: "item_1",
  locationId: "location_1",
  versionId: "version_1",
  locator: "openlifewiki://managed/item_1",
  title: "Harness decision",
  bodyHash: HASH,
} as const satisfies KnowledgeCitation;

const secondCitation = {
  citationId: "citation_2",
  itemId: "item_2",
  locationId: "location_2",
  versionId: "version_2",
  locator: "openlifewiki://managed/item_2",
  title: "Alternative harness evidence",
  bodyHash: `sha256:${"b".repeat(64)}`,
} as const satisfies KnowledgeCitation;

function result(overrides: Partial<KnowledgeQueryResult> = {}): KnowledgeQueryResult {
  return {
    schema: "openlifewiki.knowledge-query-result/v1",
    taskId: "task_1",
    evidenceMode: "grounded",
    answer: "The selected P0 harness is OpenAI Agents SDK.",
    citations: [citation],
    gaps: [],
    ...overrides,
  };
}

function assertResult(input: {
  readonly result?: KnowledgeQueryResult;
  readonly retrievedCitations?: readonly KnowledgeCitation[];
  readonly allowPartial?: boolean;
  readonly taskId?: string;
} = {}): void {
  assertGroundedKnowledgeResult({
    taskId: input.taskId ?? "task_1",
    result: input.result ?? result(),
    retrievedCitations: input.retrievedCitations ?? [citation],
    allowPartial: input.allowPartial ?? true,
  });
}

describe("grounded knowledge query policy", () => {
  it("accepts a grounded result bound to the task and exact retrieved citation", () => {
    expect(() => assertResult()).not.toThrow();
  });

  it("rejects a changed task binding", () => {
    expect(() => assertResult({ taskId: "task_other" })).toThrow("task binding");
  });

  it.each([
    ["itemId", "item_other"],
    ["locationId", "location_other"],
    ["versionId", "version_other"],
    ["locator", "openlifewiki://managed/item_other"],
    ["bodyHash", `sha256:${"c".repeat(64)}`],
  ] as const)("rejects a citation with a changed %s", (field, value) => {
    expect(() => assertResult({
      result: result({ citations: [{ ...citation, [field]: value }] }),
    })).toThrow("unbound citation");
  });

  it("requires unique returned citation IDs", () => {
    expect(() => assertResult({
      result: result({ citations: [citation, citation] }),
    })).toThrow("unbound citation");
  });

  it.each([
    ["identical", [citation, citation]],
    ["conflicting", [citation, { ...citation, itemId: "item_other" }]],
  ] as const)("rejects %s duplicate citation IDs in the retrieval ledger", (_kind, ledger) => {
    expect(() => assertResult({ retrievedCitations: ledger })).toThrow("retrieval ledger");
  });

  it("requires grounded results to contain bound evidence", () => {
    expect(() => assertResult({
      result: result({ citations: [] }),
      retrievedCitations: [],
    })).toThrow("requires cited evidence");
  });

  it("accepts partial evidence only when it is allowed and includes evidence plus a gap", () => {
    const partial = result({
      evidenceMode: "partial",
      gaps: [{ code: "COVERAGE_GAP", description: "Only one source was available." }],
    });

    expect(() => assertResult({ result: partial, allowPartial: true })).not.toThrow();
    expect(() => assertResult({ result: partial, allowPartial: false })).toThrow("not allowed");
    expect(() => assertResult({
      result: result({ evidenceMode: "partial", citations: [], gaps: partial.gaps }),
      retrievedCitations: [],
    })).toThrow("requires cited evidence and an explicit gap");
    expect(() => assertResult({
      result: result({ evidenceMode: "partial", gaps: [] }),
    })).toThrow("requires cited evidence and an explicit gap");
  });

  it("accepts conflicting evidence only with two bound citations and an explicit conflict gap", () => {
    const conflicting = result({
      evidenceMode: "conflicting",
      citations: [citation, secondCitation],
      gaps: [{ code: "EVIDENCE_CONFLICT", description: "The sources disagree." }],
    });

    expect(() => assertResult({
      result: conflicting,
      retrievedCitations: [citation, secondCitation],
    })).not.toThrow();
    expect(() => assertResult({
      result: result({ evidenceMode: "conflicting", gaps: conflicting.gaps }),
    })).toThrow("two cited sources");
    expect(() => assertResult({
      result: result({
        evidenceMode: "conflicting",
        citations: [citation, secondCitation],
        gaps: [{ code: "COVERAGE_GAP", description: "Coverage is incomplete." }],
      }),
      retrievedCitations: [citation, secondCitation],
    })).toThrow("conflict gap");
    expect(() => assertResult({
      result: result({
        evidenceMode: "conflicting",
        citations: [citation, secondCitation],
        gaps: [{ code: "NO_CONFLICT", description: "No conflict was identified." }],
      }),
      retrievedCitations: [citation, secondCitation],
    })).toThrow("conflict gap");
  });

  it("accepts no-evidence only with an empty answer, no citations and an explicit gap", () => {
    expect(() => assertResult({
      result: result({
        evidenceMode: "no-evidence",
        answer: "",
        citations: [],
        gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
      }),
      retrievedCitations: [],
    })).not.toThrow();

    expect(() => assertResult({
      result: result({ evidenceMode: "no-evidence", answer: "", citations: [], gaps: [] }),
      retrievedCitations: [],
    })).toThrow("explicit gap");
    expect(() => assertResult({
      result: result({
        evidenceMode: "no-evidence",
        answer: "No matching evidence exists.",
        citations: [],
        gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
      }),
      retrievedCitations: [],
    })).toThrow("empty answer");
    expect(() => assertResult({
      result: result({
        evidenceMode: "no-evidence",
        answer: "",
        gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
      }),
    })).toThrow("cannot cite evidence");
  });
});
