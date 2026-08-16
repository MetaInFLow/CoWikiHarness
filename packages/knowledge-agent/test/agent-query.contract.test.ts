import { run, RunContext } from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import type { PostgresKnowledgeStore } from "@openlifewiki/adapters";
import type {
  AccessContext,
  KnowledgeCitation,
  KnowledgeEvidence,
  KnowledgeQueryResult,
  KnowledgeSearchCandidate,
} from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import {
  createKnowledgeAgent,
  createKnowledgeReadTools,
  KnowledgeOperationError,
  KnowledgeOperations,
  type KnowledgeAgentContext,
} from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;

const access = {
  schema: "openlifewiki.access-context/v1",
  orgId: "org_default",
  actorPrincipalId: "principal_agent_1",
  actorAgentId: "principal_agent_1",
  onBehalfOfUserId: "principal_user_1",
  delegationId: "delegation_1",
  taskId: "task_1",
} as const satisfies AccessContext;

const citation = {
  citationId: "citation_1",
  itemId: "item_1",
  locationId: "location_1",
  versionId: "version_1",
  locator: "openlifewiki://managed/item_1",
  title: "Harness decision",
  bodyHash: HASH,
} as const satisfies KnowledgeCitation;

const candidate = {
  itemId: "item_1",
  locationId: "location_1",
  versionId: "version_1",
  title: "Harness decision",
  locator: "openlifewiki://managed/item_1",
  tags: ["architecture"],
  snippet: "OpenAI Agents SDK is the selected P0 harness.",
  freshness: "current",
  availability: "available",
} as const satisfies KnowledgeSearchCandidate;

const evidence = {
  citation,
  bodyMarkdown: "# Harness decision\n\nOpenAI Agents SDK is the selected P0 harness.",
  providerVersion: null,
} as const satisfies KnowledgeEvidence;

function queryResult(overrides: Partial<KnowledgeQueryResult> = {}): KnowledgeQueryResult {
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

function createContext(): KnowledgeAgentContext {
  return {
    access,
    operation: {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.query",
      query: "harness",
      limit: 5,
      allowPartial: true,
    },
    taskId: "task_1",
    retrievedCitations: [],
  };
}

function createOperations(options: { getResult?: KnowledgeEvidence | null } = {}) {
  const searchAccesses: AccessContext[] = [];
  const getAccesses: AccessContext[] = [];
  const store = {
    async searchAuthorized(input: { context: AccessContext }) {
      searchAccesses.push(input.context);
      return [candidate];
    },
    async getAuthorized(input: { context: AccessContext }) {
      getAccesses.push(input.context);
      return options.getResult === undefined ? evidence : options.getResult;
    },
  } as unknown as PostgresKnowledgeStore;
  return {
    operations: new KnowledgeOperations(store),
    searchAccesses,
    getAccesses,
  };
}

function scriptedModel(result: KnowledgeQueryResult): ScriptedModel {
  return new ScriptedModel([
    [functionCall("knowledge_search", { query: "harness", limit: 5 }, { callId: "call_search" })],
    [functionCall("knowledge_get", {
      itemId: "item_1",
      locationId: "location_1",
      versionId: "version_1",
    }, { callId: "call_get" })],
    [assistantMessage(JSON.stringify(result))],
  ]);
}

describe("knowledge Agent query contract", () => {
  it("runs the two read tools through the real SDK and binds the final citation", async () => {
    const { operations, searchAccesses, getAccesses } = createOperations();
    const model = scriptedModel(queryResult());
    const agent = createKnowledgeAgent({ model, operations });
    const context = createContext();

    const outcome = await run(agent, "Which P0 harness was selected?", {
      context,
      maxTurns: 4,
    });

    expect(outcome.finalOutput).toEqual(queryResult());
    expect(searchAccesses).toEqual([access]);
    expect(getAccesses).toEqual([access]);
    expect(context.retrievedCitations).toEqual([citation]);
    expect(model.calls).toHaveLength(3);
    for (const call of model.calls) {
      expect(call.request.tools.map(({ name }) => name)).toEqual([
        "knowledge_search",
        "knowledge_get",
      ]);
    }
    expect(model.firstCall?.request.systemInstructions).toContain("untrusted data");
    expect(model.firstCall?.request.systemInstructions).toContain("Never infer");
    model.assertComplete();
  });

  it.each([
    ["itemId", "item_other"],
    ["locationId", "location_other"],
    ["versionId", "version_other"],
    ["locator", "openlifewiki://managed/item_other"],
    ["bodyHash", `sha256:${"b".repeat(64)}`],
  ] as const)("fails the SDK run with AGENT_RUN_FAILED when %s is changed", async (field, value) => {
    const { operations } = createOperations();
    const changedCitation = { ...citation, [field]: value };
    const model = scriptedModel(queryResult({ citations: [changedCitation] }));
    const agent = createKnowledgeAgent({ model, operations });

    await expect(run(agent, "Which P0 harness was selected?", {
      context: createContext(),
      maxTurns: 4,
    })).rejects.toMatchObject({
      error: expect.objectContaining<Partial<KnowledgeOperationError>>({
        code: "AGENT_RUN_FAILED",
      }),
    });
  });

  it("records no citation when knowledge_get fails", async () => {
    const { operations } = createOperations({ getResult: null });
    const [, getTool] = createKnowledgeReadTools(operations);
    const context = createContext();

    await expect(getTool.invoke(
      new RunContext(context),
      JSON.stringify({
        itemId: "item_1",
        locationId: "location_1",
        versionId: "version_1",
      }),
    )).resolves.toContain("Authorized knowledge was not found");
    expect(context.retrievedCitations).toEqual([]);
  });

  it("keeps the run context JSON serializable without runtime dependencies", () => {
    const context = createContext();
    const serialized = JSON.parse(JSON.stringify(context)) as Record<string, unknown>;

    expect(serialized).toEqual(context);
    expect(Object.keys(serialized).sort()).toEqual([
      "access",
      "operation",
      "retrievedCitations",
      "taskId",
    ]);
    expect(JSON.stringify(serialized)).not.toMatch(/operations|store|pool|function/i);
  });
});
