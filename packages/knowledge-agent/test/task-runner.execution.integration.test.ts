import { randomUUID } from "node:crypto";

import {
  Agent,
  tool,
  type AgentInputItem,
} from "@openai/agents";
import {
  assistantMessage,
  functionCall,
  modelError,
  modelResponder,
  ScriptedModel,
} from "@openai/agents/testing";
import {
  AdapterError,
  createDatabase,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import {
  knowledgeQueryResultSchema,
  type AccessContext,
  type KnowledgeOperation,
  type Principal,
} from "@openlifewiki/protocol";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createKnowledgeAgent,
  KnowledgeTaskRunner,
  PostgresAgentSession,
  type KnowledgeAgentContext,
  type KnowledgeReadOperations,
} from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("KnowledgeTaskRunner PostgreSQL execution", () => {
  let database: Database;
  let store: PostgresKnowledgeStore;
  let orgId: string;
  let otherOrgId: string;
  let owner: Principal;
  let outsider: Principal;
  let agent: Principal;
  let revokedAgent: Principal;
  let delegationId: string;
  let revokedDelegationId: string;

  beforeEach(async () => {
    database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
    const databaseName = await database.query<{ name: string }>("select current_database() as name");
    expect(["cowikiharness_test", "openlifewiki_test"]).toContain(databaseName.rows[0]?.name);
    await runMigrations(database, { migrationsDir: "../adapters/migrations" });

    const suffix = randomUUID();
    orgId = `org_runner_${suffix}`;
    otherOrgId = `org_runner_other_${suffix}`;
    owner = principal(`principal_owner_${suffix}`, "user", "owner");
    outsider = { ...principal(`principal_outsider_${suffix}`, "user", "owner"), orgId: otherOrgId };
    agent = principal(`principal_agent_${suffix}`, "agent", null);
    revokedAgent = principal(`principal_revoked_agent_${suffix}`, "agent", null);
    delegationId = `delegation_${suffix}`;
    revokedDelegationId = `delegation_revoked_${suffix}`;
    await database.transaction(async (client) => {
      await client.query(
        "insert into organizations(org_id, name) values ($1, $2), ($3, $4)",
        [orgId, "Runner test", otherOrgId, "Other runner test"],
      );
      for (const value of [owner, outsider, agent, revokedAgent]) {
        await client.query(
          `insert into principals(
            principal_id, org_id, principal_type, display_name,
            organization_role, capabilities, status
          ) values ($1, $2, $3, $4, $5, $6, 'active')`,
          [value.principalId, value.orgId, value.type, value.displayName,
            value.organizationRole, value.capabilities],
        );
      }
      await client.query(
        `insert into delegations(
          delegation_id, org_id, agent_principal_id, user_principal_id,
          capabilities, resource_scopes, expires_at, revoked_at
        ) values
          ($1, $2, $3, $4, $5, $6::jsonb, now() + interval '1 day', null),
          ($7, $2, $8, $4, $5, $6::jsonb, now() + interval '1 day', now())`,
        [delegationId, orgId, agent.principalId, owner.principalId,
          ["knowledge.query"], JSON.stringify([{ kind: "organization", id: orgId }]),
          revokedDelegationId, revokedAgent.principalId],
      );
    });
    store = new PostgresKnowledgeStore(database, "test-token-secret-with-at-least-32-bytes");
  });

  afterEach(async () => {
    if (database === undefined) return;
    try {
      await database.transaction(async (client) => {
        const orgIds = [orgId, otherOrgId];
        await client.query("delete from audit_events where org_id = any($1::text[])", [orgIds]);
        await client.query("delete from agent_tasks where org_id = any($1::text[])", [orgIds]);
        await client.query("delete from agent_sessions where org_id = any($1::text[])", [orgIds]);
        await client.query("delete from delegations where org_id = any($1::text[])", [orgIds]);
        await client.query("delete from principals where org_id = any($1::text[])", [orgIds]);
        await client.query("delete from organizations where org_id = any($1::text[])", [orgIds]);
      });
    } finally {
      await database.close();
    }
  });

  it("binds human and agent tasks to the exact current owner, actor and delegation", async () => {
    const human = await createTask(owner, `context_human_${randomUUID()}`);
    const delegated = await createTask(agent, `context_agent_${randomUUID()}`);

    expect(human).toMatchObject({
      ownerPrincipalId: owner.principalId,
      actorAgentId: null,
      delegationId: null,
    });
    expect(delegated).toMatchObject({
      ownerPrincipalId: owner.principalId,
      actorAgentId: agent.principalId,
      delegationId,
    });
    await expect(createTask(revokedAgent, `context_revoked_${randomUUID()}`))
      .rejects.toMatchObject({ code: "DELEGATION_DENIED" });
  });

  it("revalidates the exact delegation immediately before Runner execution", async () => {
    const task = await createTask(agent, `context_revoked_before_run_${randomUUID()}`, "revoked");
    const model = new ScriptedModel([[
      assistantMessage(JSON.stringify(noEvidence(task.taskId))),
    ]]);
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model,
      operations: noReadOperations(),
    }));
    await database.query(
      "update delegations set revoked_at = now() where delegation_id = $1",
      [delegationId],
    );

    await expect(runner.runQuery({
      task,
      access: agentAccess(task.taskId),
      query: "revoked",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "DELEGATION_DENIED" });
    expect(model.calls).toHaveLength(0);
    expect(await store.loadTask(task.taskId, agent.principalId)).toMatchObject({
      state: "submitted",
      revision: task.revision,
    });
  });

  it("uses the same owner-agent-delegation lock order for concurrent create and execution", async () => {
    for (let index = 0; index < 12; index += 1) {
      const existing = await createTask(agent, `context_lock_existing_${index}_${randomUUID()}`, "lock");
      const [created, working] = await Promise.all([
        createTask(agent, `context_lock_create_${index}_${randomUUID()}`, "lock"),
        store.markTaskWorkingAuthorized({
          task: existing,
          access: agentAccess(existing.taskId),
        }),
      ]);
      expect(created.delegationId).toBe(delegationId);
      expect(working.state).toBe("working");
    }
  });

  it("reuses official Session history for two turns in the same context and commits task audits", async () => {
    const first = await createTask(owner, `context_shared_${randomUUID()}`, "first question");
    const second = await createTask(owner, first.contextId, "second question");
    const model = new ScriptedModel([
      [assistantMessage(JSON.stringify(noEvidence(first.taskId)))],
      [assistantMessage(JSON.stringify(noEvidence(second.taskId)))],
    ]);
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model,
      operations: noReadOperations(),
    }));

    const firstOutcome = await runner.runQuery({
      task: first,
      access: humanAccess(first.taskId),
      query: "first question",
      signal: new AbortController().signal,
    });
    const secondOutcome = await runner.runQuery({
      task: second,
      access: humanAccess(second.taskId),
      query: "second question",
      signal: new AbortController().signal,
    });

    expect(firstOutcome).toMatchObject({ kind: "completed", result: noEvidence(first.taskId) });
    expect(secondOutcome).toMatchObject({ kind: "completed", result: noEvidence(second.taskId) });
    expect(model.calls).toHaveLength(2);
    expect(model.calls.every(({ streamed }) => streamed === false)).toBe(true);
    expect(JSON.stringify(model.calls[1]?.request.input)).toContain("first question");
    expect(JSON.stringify(model.calls[1]?.request.input)).toContain(first.taskId);
    expect(model.calls.every(({ request }) => request.tracing === false)).toBe(true);

    const persisted = new PostgresAgentSession(store, first.contextId, orgId, owner.principalId);
    const history = await persisted.getItems();
    expect(JSON.stringify(history)).toContain("first question");
    expect(JSON.stringify(history)).toContain("second question");
    expect((await store.loadTask(first.taskId, owner.principalId))?.state).toBe("completed");
    const audits = await database.query<{ count: string }>(
      "select count(*)::text as count from audit_events where task_id = $1",
      [first.taskId],
    );
    expect(Number(audits.rows[0]?.count)).toBeGreaterThanOrEqual(3);
  });

  it("preserves a running AbortSignal cancellation and leaves cancellation settlement to the caller", async () => {
    const task = await createTask(owner, `context_abort_${randomUUID()}`, "wait");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      modelResponder(async (call) => {
        markStarted?.();
        return await new Promise<never>((_resolve, reject) => {
          const signal = call.request.signal;
          if (signal?.aborted === true) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    ]);
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model,
      operations: noReadOperations(),
    }));
    const controller = new AbortController();
    const reason = new DOMException("Task canceled", "AbortError");
    const running = runner.runQuery({
      task,
      access: humanAccess(task.taskId),
      query: "wait",
      signal: controller.signal,
    });
    await started;
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect((await store.loadTask(task.taskId, owner.principalId))?.state).toBe("working");
  });

  it("persists an SDK interruption without tracing credentials and validates it during recovery", async () => {
    const secret = `sk-test-${randomUUID()}`;
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const task = await createTask(owner, `context_interrupt_${randomUUID()}`, "approve");
      const approvalTool = tool({
        name: "approval_probe",
        description: "Test-only approval boundary",
        parameters: z.strictObject({ value: z.string() }),
        needsApproval: true,
        async execute() { return "approved"; },
      });
      const model = new ScriptedModel([[
        functionCall("approval_probe", { value: "safe" }, { callId: "approval_call" }),
      ]]);
      const approvalAgent = new Agent<KnowledgeAgentContext, typeof knowledgeQueryResultSchema>({
        name: "approval test agent",
        model,
        instructions: "Request approval.",
        tools: [approvalTool],
        outputType: knowledgeQueryResultSchema,
      });
      const runner = new KnowledgeTaskRunner(store, approvalAgent);

      const outcome = await runner.runQuery({
        task,
        access: humanAccess(task.taskId),
        query: "approve",
        signal: new AbortController().signal,
      });
      const paused = await store.loadTask(task.taskId, owner.principalId);

      expect(outcome).toMatchObject({ kind: "input-required", interruptionCount: 1 });
      expect(paused).toMatchObject({ state: "input-required", errorCode: "APPROVAL_REQUIRED" });
      expect(paused?.runState).not.toBeNull();
      expect(paused?.runState).not.toContain(secret);
      expect(paused?.runState).not.toMatch(/tracing_api_key|api[_-]?key|authorization|credential|password/iu);

      await runner.recoverInterruptedTask(paused as StoredAgentTask);
      expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
        state: "input-required",
        output: null,
        revision: paused?.revision,
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("fails null and invalid recoverable states as TASK_INTERRUPTED without completing them", async () => {
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model: new ScriptedModel(),
      operations: noReadOperations(),
    }));
    const submitted = await createTask(owner, `context_submitted_${randomUUID()}`, "submitted");
    const workingBase = await createTask(owner, `context_working_${randomUUID()}`, "working");
    const working = await store.markTaskWorking(workingBase.taskId, workingBase.revision);
    const invalidBase = await createTask(owner, `context_invalid_${randomUUID()}`, "invalid");
    const invalidWorking = await store.markTaskWorking(invalidBase.taskId, invalidBase.revision);
    await database.query(
      "update agent_tasks set state = 'input-required', run_state = $1 where task_id = $2",
      ["not-valid-run-state", invalidWorking.taskId],
    );
    const invalid = await store.loadTask(invalidWorking.taskId, owner.principalId);

    await runner.recoverInterruptedTask(submitted);
    await runner.recoverInterruptedTask(working);
    await runner.recoverInterruptedTask(invalid as StoredAgentTask);

    for (const taskId of [submitted.taskId, working.taskId, invalidWorking.taskId]) {
      expect(await store.loadTask(taskId, owner.principalId)).toMatchObject({
        state: "failed",
        errorCode: "TASK_INTERRUPTED",
        output: null,
      });
    }
  });

  it("fails closed on task revision CAS conflicts", async () => {
    const task = await createTask(owner, `context_cas_${randomUUID()}`, "cas");
    await store.markTaskWorking(task.taskId, task.revision);

    const error = await capturedError(store.markTaskWorking(task.taskId, task.revision));

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(String(error)).not.toMatch(/update agent_tasks|constraint|postgres/iu);
  });

  it("uses revision CAS and atomic audit for cancellation request and settlement", async () => {
    const task = await createTask(owner, `context_cancel_${randomUUID()}`, "cancel");

    await expect(store.requestTaskCancellation({
      taskId: task.taskId,
      expectedRevision: task.revision,
      principalId: outsider.principalId,
    })).rejects.toMatchObject({ code: "DELEGATION_DENIED" });
    expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
      state: "submitted",
      cancelRequested: false,
      revision: task.revision,
    });

    const requested = await store.requestTaskCancellation({
      taskId: task.taskId,
      expectedRevision: task.revision,
      principalId: owner.principalId,
    });
    expect(requested).toMatchObject({
      state: "submitted",
      cancelRequested: true,
      revision: task.revision + 1,
    });

    await expect(store.settleCanceledTask({
      taskId: task.taskId,
      expectedRevision: task.revision,
      principalId: owner.principalId,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
      state: "submitted",
      cancelRequested: true,
      revision: requested.revision,
    });
    expect((await database.query<{ action: string }>(
      "select action from audit_events where task_id = $1 order by created_at, audit_event_id",
      [task.taskId],
    )).rows.map(({ action }) => action)).toEqual([
      "agent.task.submitted",
      "agent.task.cancel-requested",
    ]);

    await expect(store.settleCanceledTask({
      taskId: task.taskId,
      expectedRevision: requested.revision,
      principalId: outsider.principalId,
    })).rejects.toMatchObject({ code: "DELEGATION_DENIED" });

    const canceled = await store.settleCanceledTask({
      taskId: task.taskId,
      expectedRevision: requested.revision,
      principalId: owner.principalId,
    });
    expect(canceled).toMatchObject({
      state: "canceled",
      cancelRequested: true,
      revision: requested.revision + 1,
    });
    expect((await database.query<{ action: string }>(
      "select action from audit_events where task_id = $1 order by created_at, audit_event_id",
      [task.taskId],
    )).rows.map(({ action }) => action)).toEqual([
      "agent.task.submitted",
      "agent.task.cancel-requested",
      "agent.task.canceled",
    ]);
  });

  it("allows only the exact actor agent to cancel an agent-owned task", async () => {
    const task = await createTask(agent, `context_agent_cancel_${randomUUID()}`, "cancel agent");

    await expect(store.requestTaskCancellation({
      taskId: task.taskId,
      expectedRevision: task.revision,
      principalId: owner.principalId,
    })).rejects.toMatchObject({ code: "DELEGATION_DENIED" });
    const requested = await store.requestTaskCancellation({
      taskId: task.taskId,
      expectedRevision: task.revision,
      principalId: agent.principalId,
    });
    const canceled = await store.settleCanceledTask({
      taskId: task.taskId,
      expectedRevision: requested.revision,
      principalId: agent.principalId,
    });

    expect(canceled.state).toBe("canceled");
  });

  it("fails closed when a persisted task error code is outside the runtime enum", async () => {
    const task = await createTask(owner, `context_invalid_error_${randomUUID()}`, "invalid error");
    await database.query(
      "update agent_tasks set error_code = 'NOT_A_KNOWLEDGE_ERROR' where task_id = $1",
      [task.taskId],
    );

    await expect(store.loadTask(task.taskId, owner.principalId)).rejects.toMatchObject({
      code: "INVALID_OPERATION",
    });
  });

  it("commits a stable failed state when the model run fails", async () => {
    const task = await createTask(owner, `context_model_failure_${randomUUID()}`, "fail");
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model: new ScriptedModel([modelError(new Error("provider internals must stay private"))]),
      operations: noReadOperations(),
    }));

    const error = await capturedError(runner.runQuery({
      task,
      access: humanAccess(task.taskId),
      query: "fail",
      signal: new AbortController().signal,
    }));

    expect(error).toMatchObject({ code: "AGENT_RUN_FAILED" });
    expect(String(error)).not.toContain("provider internals");
    expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
      state: "failed",
      errorCode: "AGENT_RUN_FAILED",
      runState: null,
    });
  });

  it("rejects a mismatched AccessContext before changing task state", async () => {
    const task = await createTask(owner, `context_binding_${randomUUID()}`, "binding");
    const model = new ScriptedModel([[assistantMessage(JSON.stringify(noEvidence(task.taskId)))]]);
    const runner = new KnowledgeTaskRunner(store, createKnowledgeAgent({
      model,
      operations: noReadOperations(),
    }));

    await expect(runner.runQuery({
      task,
      access: humanAccess(`task_other_${randomUUID()}`),
      query: "binding",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
      state: "submitted",
      revision: task.revision,
    });
    expect(model.calls).toHaveLength(0);
  });

  it.each([
    ["sensitive key", { nested: { authorization: "must-not-persist" } }],
    ["bearer material", { nested: { value: "Bearer must-not-persist" } }],
  ])("rejects %s in persisted run state without changing the task", async (_kind, state) => {
    const task = await createTask(owner, `context_sensitive_state_${randomUUID()}`, "state");
    const working = await store.markTaskWorking(task.taskId, task.revision);

    await expect(store.pauseTask({
      taskId: working.taskId,
      expectedRevision: working.revision,
      runState: JSON.stringify(state),
      errorCode: "APPROVAL_REQUIRED",
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect(await store.loadTask(task.taskId, owner.principalId)).toMatchObject({
      state: "working",
      revision: working.revision,
      runState: null,
    });
  });

  it("allows numeric SDK token-usage metrics while keeping credential-shaped values blocked", async () => {
    const task = await createTask(owner, `context_usage_state_${randomUUID()}`, "usage");
    const working = await store.markTaskWorking(task.taskId, task.revision);

    const paused = await store.pauseTask({
      taskId: working.taskId,
      expectedRevision: working.revision,
      runState: JSON.stringify({
        originalInput: "Compare ordinary token budgets and password policies as knowledge content.",
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        inputTokensDetails: { cachedTokens: 2 },
        outputTokensDetails: { reasoningTokens: 1 },
      }),
      errorCode: "APPROVAL_REQUIRED",
    });

    expect(paused).toMatchObject({ state: "input-required", errorCode: "APPROVAL_REQUIRED" });
  });

  async function createTask(
    taskPrincipal: Principal,
    contextId: string,
    query = "question",
  ): Promise<StoredAgentTask> {
    return await store.createTaskForAuthenticatedPrincipal({
      taskId: `task_${randomUUID()}`,
      contextId,
      principal: taskPrincipal,
      input: queryOperation(query),
    });
  }

  function principal(
    principalId: string,
    type: "user" | "agent",
    organizationRole: "owner" | null,
  ): Principal {
    return {
      schema: "openlifewiki.principal/v1",
      principalId,
      orgId,
      type,
      displayName: principalId,
      organizationRole,
      capabilities: ["knowledge.query"],
      status: "active",
    };
  }

  function humanAccess(taskId: string): AccessContext {
    return {
      schema: "openlifewiki.access-context/v1",
      orgId,
      actorPrincipalId: owner.principalId,
      actorAgentId: null,
      onBehalfOfUserId: owner.principalId,
      delegationId: null,
      taskId,
    };
  }

  function agentAccess(taskId: string): AccessContext {
    return {
      schema: "openlifewiki.access-context/v1",
      orgId,
      actorPrincipalId: agent.principalId,
      actorAgentId: agent.principalId,
      onBehalfOfUserId: owner.principalId,
      delegationId,
      taskId,
    };
  }
});

function queryOperation(query: string): KnowledgeOperation {
  return {
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.query",
    query,
    limit: 10,
    allowPartial: true,
  };
}

function noEvidence(taskId: string) {
  return {
    schema: "openlifewiki.knowledge-query-result/v1" as const,
    taskId,
    evidenceMode: "no-evidence" as const,
    answer: "",
    citations: [],
    gaps: [{ code: "NO_MATCH", description: "No authorized evidence matched." }],
  };
}

function noReadOperations(): KnowledgeReadOperations {
  return {
    async query() { return []; },
    async get() { throw new Error("Unexpected knowledge_get call"); },
  };
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  const databaseName = new URL(value).pathname.slice(1);
  if (databaseName !== "cowikiharness_test" && databaseName !== "openlifewiki_test") {
    throw new Error(`Refusing to use non-test PostgreSQL database: ${databaseName}`);
  }
  return value;
}

async function capturedError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}
