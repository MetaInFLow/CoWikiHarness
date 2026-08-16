import { RunContext } from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
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
  runKnowledgeAgentQuery,
  type KnowledgeAgentContext,
  type KnowledgeReadOperations,
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

function createContext(options: {
  readonly accessTaskId?: string;
  readonly allowPartial?: boolean;
} = {}): KnowledgeAgentContext {
  return {
    access: { ...access, taskId: options.accessTaskId ?? "task_1" },
    operation: {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.query",
      query: "harness",
      limit: 5,
      allowPartial: options.allowPartial ?? true,
    },
    taskId: "task_1",
    retrievedCitations: [],
  };
}

function createOperations(options: {
  readonly getResult?: KnowledgeEvidence;
  readonly queryError?: unknown;
  readonly getError?: unknown;
} = {}) {
  const searches: Array<{
    readonly access: AccessContext;
    readonly input: { readonly query: string; readonly limit: number };
  }> = [];
  const gets: Array<{
    readonly access: AccessContext;
    readonly input: {
      readonly itemId: string;
      readonly locationId: string;
      readonly versionId: string | null;
    };
  }> = [];
  const operations: KnowledgeReadOperations = {
    async query(operationAccess, input) {
      searches.push({ access: operationAccess, input });
      if (options.queryError !== undefined) throw options.queryError;
      return [candidate];
    },
    async get(operationAccess, input) {
      gets.push({ access: operationAccess, input });
      if (options.getError !== undefined) throw options.getError;
      return options.getResult ?? evidence;
    },
  };
  return { operations, searches, gets };
}

function scriptedModel(
  result: KnowledgeQueryResult,
  versionId: string | null = "version_1",
): ScriptedModel {
  return new ScriptedModel([
    [functionCall("knowledge_search", { query: "harness", limit: 5 }, { callId: "call_search" })],
    [functionCall("knowledge_get", {
      itemId: "item_1",
      locationId: "location_1",
      versionId,
    }, { callId: "call_get" })],
    [assistantMessage(JSON.stringify(result))],
  ]);
}

async function runQuery(input: {
  readonly model: ScriptedModel;
  readonly operations: KnowledgeReadOperations;
  readonly context?: KnowledgeAgentContext;
  readonly signal?: AbortSignal;
}): Promise<KnowledgeQueryResult> {
  return await runKnowledgeAgentQuery({
    agent: createKnowledgeAgent({ model: input.model, operations: input.operations }),
    input: "Which P0 harness was selected?",
    context: input.context ?? createContext(),
    maxTurns: 4,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function capturedError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectEvidenceInstructions(
  instructions: string | null | undefined,
  allowPartial: boolean,
): void {
  expect(instructions?.split("\n")).toEqual(expect.arrayContaining([
    `Current operation allowPartial=${String(allowPartial)}.`,
    "grounded: requires at least 1 bound citation.",
    "partial: requires allowPartial=true, at least 1 bound citation, and at least 1 explicit gap.",
    "conflicting: requires at least 2 bound citations and an explicit gap with code EVIDENCE_CONFLICT.",
    "no-evidence: requires 0 citations, at least 1 explicit gap, and an empty answer.",
  ]));
}

describe("knowledge Agent query contract", () => {
  it("runs only the two read tools through the hardened SDK entry and binds the final citation", async () => {
    const { operations, searches, gets } = createOperations();
    const model = scriptedModel(queryResult());
    const context = createContext();

    const outcome = await runQuery({ model, operations, context });

    expect(outcome).toEqual(queryResult());
    expect(searches).toEqual([{ access, input: { query: "harness", limit: 5 } }]);
    expect(gets).toEqual([{
      access,
      input: { itemId: "item_1", locationId: "location_1", versionId: "version_1" },
    }]);
    expect(context.retrievedCitations).toEqual([citation]);
    expect(model.calls).toHaveLength(3);
    for (const call of model.calls) {
      expect(call.request.tools.map(({ name }) => name)).toEqual([
        "knowledge_search",
        "knowledge_get",
      ]);
      expect(call.request.tracing).toBe(false);
    }
    const tracePath = JSON.stringify(model.calls.map(({ request }) => request.tracing));
    expect(tracePath).not.toContain(candidate.snippet);
    expect(tracePath).not.toContain(evidence.bodyMarkdown);
    expect(tracePath).not.toMatch(/bodyMarkdown|snippet|正文/);
    expect(model.firstCall?.request.systemInstructions).toContain("untrusted data");
    expect(model.firstCall?.request.systemInstructions).toContain("Never infer");
    expectEvidenceInstructions(model.firstCall?.request.systemInstructions, true);
    model.assertComplete();
  });

  it("renders the complete evidence matrix with allowPartial=false in system instructions", async () => {
    const { operations } = createOperations();
    const model = scriptedModel(queryResult());

    await runQuery({
      model,
      operations,
      context: createContext({ allowPartial: false }),
    });

    expectEvidenceInstructions(model.firstCall?.request.systemInstructions, false);
    model.assertComplete();
  });

  it.each([
    ["itemId", "item_other"],
    ["locationId", "location_other"],
    ["versionId", "version_other"],
    ["locator", "openlifewiki://managed/item_other"],
    ["bodyHash", `sha256:${"b".repeat(64)}`],
  ] as const)("returns a top-level AGENT_RUN_FAILED when %s is changed", async (field, value) => {
    const { operations } = createOperations();
    const model = scriptedModel(queryResult({
      citations: [{ ...citation, [field]: value }],
    }));

    const error = await capturedError(runQuery({ model, operations }));

    expect(error).toBeInstanceOf(KnowledgeOperationError);
    expect(error).toMatchObject({ code: "AGENT_RUN_FAILED" });
  });

  it("preserves a top-level DELEGATION_DENIED through the SDK tool boundary", async () => {
    const expected = new KnowledgeOperationError("DELEGATION_DENIED");
    const { operations } = createOperations({
      queryError: expected,
    });
    const model = new ScriptedModel([
      [functionCall("knowledge_search", { query: "harness", limit: 5 }, { callId: "call_search" })],
    ]);

    const error = await capturedError(runQuery({ model, operations }));

    expect(error).toBeInstanceOf(KnowledgeOperationError);
    expect(error).toBe(expected);
    expect(error).toMatchObject({ code: "DELEGATION_DENIED" });
  });

  it("preserves an aborted run as a recognizable cancellation", async () => {
    const { operations } = createOperations();
    const model = scriptedModel(queryResult());
    const controller = new AbortController();
    const reason = new DOMException("Knowledge query cancelled", "AbortError");
    controller.abort(reason);

    const error = await capturedError(runQuery({
      model,
      operations,
      signal: controller.signal,
    }));

    expect(error).toBe(reason);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(model.calls).toHaveLength(0);
  });

  it("refuses to run when the trusted context task IDs differ", async () => {
    const { operations } = createOperations();
    const model = scriptedModel(queryResult());

    const error = await capturedError(runQuery({
      model,
      operations,
      context: createContext({ accessTaskId: "task_other" }),
    }));

    expect(error).toBeInstanceOf(KnowledgeOperationError);
    expect(error).toMatchObject({ code: "AGENT_RUN_FAILED" });
    expect(model.calls).toHaveLength(0);
  });

  it("passes a null version through as current-location lookup and binds the concrete version", async () => {
    const { operations, gets } = createOperations();
    const model = scriptedModel(queryResult(), null);

    const outcome = await runQuery({ model, operations });

    expect(gets[0]?.input.versionId).toBeNull();
    expect(outcome.citations).toEqual([citation]);
    expect(model.firstCall?.request.tools).toContainEqual(expect.objectContaining({
      type: "function",
      name: "knowledge_get",
      description: expect.stringContaining("current version"),
    }));
  });

  it("allows a strict no-evidence result with an empty answer and explicit gap", async () => {
    const { operations } = createOperations({
      getError: new KnowledgeOperationError("KNOWLEDGE_NOT_FOUND"),
    });
    const noEvidence = queryResult({
      evidenceMode: "no-evidence",
      answer: "",
      citations: [],
      gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
    });
    const model = new ScriptedModel([
      [functionCall("knowledge_search", { query: "missing", limit: 5 }, { callId: "call_search" })],
      [functionCall("knowledge_get", {
        itemId: "item_1",
        locationId: "location_1",
        versionId: null,
      }, { callId: "call_get" })],
      [assistantMessage(JSON.stringify(noEvidence))],
    ]);

    await expect(runQuery({ model, operations })).resolves.toEqual(noEvidence);
  });

  it("propagates DELEGATION_DENIED from knowledge_search instead of returning model evidence", async () => {
    const expected = new KnowledgeOperationError("DELEGATION_DENIED");
    const { operations } = createOperations({ queryError: expected });
    const [searchTool] = createKnowledgeReadTools(operations);

    const error = await capturedError(searchTool.invoke(
      new RunContext(createContext()),
      JSON.stringify({ query: "harness", limit: 5 }),
    ));

    expect(error).toBe(expected);
  });

  it("propagates INVALID_OPERATION from knowledge_get without recording a citation", async () => {
    const expected = new KnowledgeOperationError("INVALID_OPERATION");
    const { operations } = createOperations({ getError: expected });
    const [, getTool] = createKnowledgeReadTools(operations);
    const context = createContext();

    const error = await capturedError(getTool.invoke(
      new RunContext(context),
      JSON.stringify({ itemId: "item_1", locationId: "location_1", versionId: null }),
    ));

    expect(error).toBe(expected);
    expect(context.retrievedCitations).toEqual([]);
  });

  it("propagates unexpected tool errors without converting them into model evidence", async () => {
    const expected = new Error("database connection failed");
    const { operations } = createOperations({ queryError: expected });
    const [searchTool] = createKnowledgeReadTools(operations);

    const error = await capturedError(searchTool.invoke(
      new RunContext(createContext()),
      JSON.stringify({ query: "harness", limit: 5 }),
    ));

    expect(error).toBe(expected);
  });

  it("returns structured no-evidence for KNOWLEDGE_NOT_FOUND without recording a citation", async () => {
    const expected = new KnowledgeOperationError("KNOWLEDGE_NOT_FOUND");
    const { operations } = createOperations({ getError: expected });
    const [, getTool] = createKnowledgeReadTools(operations);
    const context = createContext();

    const outcome = await getTool.invoke(
      new RunContext(context),
      JSON.stringify({ itemId: "item_1", locationId: "location_1", versionId: null }),
    );

    expect(outcome).toEqual({
      status: "no-evidence",
      code: "KNOWLEDGE_NOT_FOUND",
      citation: null,
    });
    expect(context.retrievedCitations).toEqual([]);
  });

  it("does not accept a structurally spoofed KNOWLEDGE_NOT_FOUND error", async () => {
    const expected = Object.assign(new Error("spoofed not found"), {
      code: "KNOWLEDGE_NOT_FOUND",
    });
    const { operations } = createOperations({ getError: expected });
    const [, getTool] = createKnowledgeReadTools(operations);
    const context = createContext();

    const error = await capturedError(getTool.invoke(
      new RunContext(context),
      JSON.stringify({ itemId: "item_1", locationId: "location_1", versionId: null }),
    ));

    expect(error).toBe(expected);
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
