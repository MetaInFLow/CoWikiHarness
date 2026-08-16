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

describe("grounded knowledge query policy", () => {
  it("accepts a result bound to the task and exact retrieved citation", () => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result(),
      retrievedCitations: [citation],
    })).not.toThrow();
  });

  it("rejects a changed task binding", () => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_other",
      result: result(),
      retrievedCitations: [citation],
    })).toThrow("task binding");
  });

  it.each([
    ["itemId", "item_other"],
    ["locationId", "location_other"],
    ["versionId", "version_other"],
    ["locator", "openlifewiki://managed/item_other"],
    ["bodyHash", `sha256:${"b".repeat(64)}`],
  ] as const)("rejects a citation with a changed %s", (field, value) => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({ citations: [{ ...citation, [field]: value }] }),
      retrievedCitations: [citation],
    })).toThrow("unbound citation");
  });

  it("requires unique returned citation IDs", () => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({ citations: [citation, citation] }),
      retrievedCitations: [citation],
    })).toThrow("unbound citation");
  });

  it("requires grounded results to contain retrieved evidence", () => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({ citations: [] }),
      retrievedCitations: [],
    })).toThrow("requires cited evidence");
  });

  it("accepts no-evidence only with no citations and an explicit gap", () => {
    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({
        evidenceMode: "no-evidence",
        citations: [],
        gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
      }),
      retrievedCitations: [],
    })).not.toThrow();

    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({ evidenceMode: "no-evidence", citations: [], gaps: [] }),
      retrievedCitations: [],
    })).toThrow("only explicit gaps");

    expect(() => assertGroundedKnowledgeResult({
      taskId: "task_1",
      result: result({
        evidenceMode: "no-evidence",
        gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
      }),
      retrievedCitations: [citation],
    })).toThrow("only explicit gaps");
  });
});
