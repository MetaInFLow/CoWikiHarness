import { createHash, randomUUID } from "node:crypto";

import {
  ClientFactory,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type Message,
  type ListTasksRequest,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import {
  assistantMessage,
  functionCall,
  modelResponder,
  modelStreamResponder,
  ScriptedModel,
} from "@openai/agents/testing";
import {
  createDatabase,
  digestToken,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import {
  knowledgeQueryResultSchema,
  type KnowledgeCitation,
  type Principal,
} from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import { PostgresA2ATaskStore } from "../src/a2a-task-store.js";
import { buildKnowledgeAgentCard } from "../src/agent-card.js";
import { parseA2AOperation } from "../src/agent-executor.js";
import { createA2AServer, type A2AServer } from "../src/a2a-server.js";
import { AuthenticatedA2AUser } from "../src/authentication.js";
import { readServerConfig } from "../src/config.js";
import { createKnowledgeModelRuntime, type KnowledgeModelRuntime } from "../src/model-runtime.js";

describe("A2A Knowledge Server contracts", () => {
  it("fails fast on incomplete configuration and keeps secrets non-enumerable", () => {
    expect(() => readServerConfig({})).toThrow();
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_TOKEN_HMAC_SECRET: "短密钥",
    })).toThrow();
    const config = readServerConfig(testEnvironment());

    expect(config).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "xhigh",
      disableResponseStorage: true,
      publicUrl: "http://127.0.0.1:0",
      port: 0,
    });
    expect(JSON.stringify(config)).not.toContain("unit-test-api-key");
    expect(JSON.stringify(config)).not.toContain("unit-test-token-secret");
  });

  it("publishes a protocol 1.0 JSON-RPC card with only knowledge.query", () => {
    const card = buildKnowledgeAgentCard("http://127.0.0.1:8080");

    expect(card.supportedInterfaces).toEqual([
      expect.objectContaining({ protocolBinding: "JSONRPC", protocolVersion: "1.0" }),
    ]);
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(card.skills.map(({ id }) => id)).toEqual(["knowledge.query"]);
    expect(card.securitySchemes.Bearer?.scheme?.$case).toBe("httpAuthSecurityScheme");
  });

  it("accepts one JSON operation or one text query and rejects ambiguous or oversized input", () => {
    const query = {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.query",
      query: "where is the architecture?",
      limit: 10,
      allowPartial: true,
    } as const;
    expect(parseA2AOperation(message([{ content: { $case: "data", value: query }, mediaType: "application/json" }]))).toEqual(query);
    expect(parseA2AOperation(message([{ content: { $case: "text", value: "find architecture" }, mediaType: "text/plain" }]))).toMatchObject({
      kind: "knowledge.query",
      query: "find architecture",
    });
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: "one" }, mediaType: "text/plain" },
      { content: { $case: "text", value: "two" }, mediaType: "text/plain" },
    ]))).toThrow();
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: "x".repeat(65_537) }, mediaType: "text/plain" },
    ]))).toThrow();
  });

  it("builds an explicit Responses model runtime with xhigh reasoning and response storage disabled", async () => {
    const config = readServerConfig(testEnvironment());
    const model = new ScriptedModel();
    let providerOptions: unknown;
    const runtime = await createKnowledgeModelRuntime(config, (options) => {
      providerOptions = options;
      return {
        async getModel(name?: string) {
          expect(name).toBe("gpt-5.5");
          return model;
        },
      };
    });

    expect(providerOptions).toEqual({
      apiKey: "unit-test-api-key",
      baseURL: "https://agent108.work/",
      useResponses: true,
    });
    expect(runtime.modelSettings).toEqual({
      reasoning: { effort: "xhigh" },
      store: false,
    });
  });
});

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("A2A Knowledge Server PostgreSQL journeys", () => {
  it("serves a public card and isolates grounded delegated-agent and no-evidence human journeys", async () => {
    const model = groundedThenNoEvidenceModel();
    const fixture = await startFixture(model);
    try {
      const cardResponse = await fetch(`${fixture.url}/${AGENT_CARD_PATH}`);
      expect(cardResponse.status).toBe(200);
      const card = await cardResponse.json() as { skills: Array<{ id: string }>; supportedInterfaces: Array<{ protocolVersion: string }> };
      expect(card.skills.map(({ id }) => id)).toEqual(["knowledge.query"]);
      expect(card.supportedInterfaces[0]?.protocolVersion).toBe("1.0");
      expect(await (await fetch(`${fixture.url}/healthz`)).json()).toEqual({ status: "ready" });

      const client = await createClient(fixture.url);
      const events = await collect(client.sendMessageStream(
        request("architecture"),
        authorization(fixture.seed.agentToken),
      ));
      expect(model.calls).toHaveLength(3);
      expect(statuses(events)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      expect(eventKinds(events)).toEqual(["task", "statusUpdate", "artifactUpdate", "statusUpdate"]);
      const result = artifactResult(events);
      expect(result).toMatchObject({ evidenceMode: "grounded", answer: "The central architecture is registered." });
      expect(result.citations).toEqual([expect.objectContaining(fixture.seed.citation)]);

      const hiddenEvents = await collect(client.sendMessageStream(
        request("anything"),
        authorization(fixture.seed.otherUserToken),
      ));
      expect(statusMessages(hiddenEvents)).toEqual([]);
      expect(statuses(hiddenEvents)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      expect(model.calls).toHaveLength(4);
      const hiddenResult = artifactResult(hiddenEvents);
      expect(hiddenResult).toMatchObject({ evidenceMode: "no-evidence", answer: "", citations: [] });
      const hiddenWire = JSON.stringify(hiddenEvents);
      for (const secret of [fixture.seed.itemId, fixture.seed.locationId, fixture.seed.locator, fixture.seed.title, fixture.seed.body]) {
        expect(hiddenWire).not.toContain(secret);
      }

      await expect(collect(client.sendMessageStream(
        request("invalid"),
        authorization("invalid-token"),
      ))).rejects.toBeDefined();
      const unauthorized = await fetch(fixture.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer invalid-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "invalid", method: "SendMessage", params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

      const taskId = taskIdFrom(events);
      await expect(client.getTask(
        { tenant: "", id: taskId },
        authorization(fixture.seed.otherUserToken),
      )).rejects.toBeDefined();
      await expect(client.cancelTask(
        { tenant: "", id: taskId, metadata: {} },
        authorization(fixture.seed.otherUserToken),
      )).rejects.toBeDefined();

      const rows = await fixture.server.database.query<{ owner_principal_id: string; actor_agent_id: string | null }>(
        "select owner_principal_id, actor_agent_id from agent_tasks where task_id = $1",
        [taskId],
      );
      expect(rows.rows[0]).toEqual({
        owner_principal_id: fixture.seed.owner.principalId,
        actor_agent_id: fixture.seed.agent.principalId,
      });
      const otherTaskId = taskIdFrom(hiddenEvents);
      const otherRows = await fixture.server.database.query<{ owner_principal_id: string; actor_agent_id: string | null }>(
        "select owner_principal_id, actor_agent_id from agent_tasks where task_id = $1",
        [otherTaskId],
      );
      expect(otherRows.rows[0]).toEqual({
        owner_principal_id: fixture.seed.otherUser.principalId,
        actor_agent_id: null,
      });

      const scopedStore = new PostgresA2ATaskStore(fixture.server.store);
      const agentContext = new ServerCallContext({
        user: new AuthenticatedA2AUser(fixture.seed.agent),
        requestedVersion: "1.0",
      });
      const otherContext = new ServerCallContext({
        user: new AuthenticatedA2AUser(fixture.seed.otherUser),
        requestedVersion: "1.0",
      });
      expect(await scopedStore.load(taskId, otherContext)).toBeUndefined();
      await expect(scopedStore.save(finalTask(events), otherContext)).rejects.toMatchObject({ code: "DELEGATION_DENIED" });

      const loaded = await scopedStore.load(taskId, agentContext);
      if (loaded === undefined) throw new Error("Agent task missing");
      const stale = structuredClone(loaded);
      await scopedStore.save(loaded, agentContext);
      await expect(scopedStore.save(stale, agentContext)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

      const extraTaskId = `task_page_${randomUUID()}`;
      const extraContextId = `context_page_${randomUUID()}`;
      await fixture.server.store.createTaskForAuthenticatedPrincipal({
        taskId: extraTaskId,
        contextId: extraContextId,
        principal: fixture.seed.agent,
        input: queryOperation("pagination"),
      });
      await scopedStore.save(a2aTask(extraTaskId, extraContextId, TaskState.TASK_STATE_SUBMITTED), agentContext);
      const firstPage = await scopedStore.list(listRequest({ pageSize: 1 }), agentContext);
      expect(firstPage.pageSize).toBe(1);
      expect(firstPage.totalSize).toBeGreaterThanOrEqual(2);
      expect(firstPage.nextPageToken).not.toBe("");
      const secondPage = await scopedStore.list(listRequest({
        pageSize: 1,
        pageToken: firstPage.nextPageToken,
      }), agentContext);
      expect(secondPage.tasks[0]?.id).not.toBe(firstPage.tasks[0]?.id);
      expect((await scopedStore.list(listRequest({ contextId: extraContextId }), agentContext)).tasks.map(({ id }) => id))
        .toEqual([extraTaskId]);
      await expect(scopedStore.list(listRequest({ pageSize: 101 }), agentContext))
        .rejects.toMatchObject({ code: "INVALID_OPERATION" });

      const durable = await fixture.server.database.query<{ value: string }>(
        `select coalesce(a2a_task_json::text, '') || coalesce(run_state, '')
           || coalesce(output_json::text, '') as value from agent_tasks where org_id = $1`,
        [fixture.seed.orgId],
      );
      const audits = await fixture.server.database.query<{ value: string }>(
        "select receipt_metadata::text as value from audit_events where org_id = $1",
        [fixture.seed.orgId],
      );
      expect(JSON.stringify([...durable.rows, ...audits.rows])).not.toContain("unit-test-api-key");
      expect(JSON.stringify([...durable.rows, ...audits.rows])).not.toContain("unit-test-token-secret");
    } finally {
      await fixture.close();
    }
  });

  it("cancels a running task with authenticated revision CAS and persists canceled state", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      modelStreamResponder((call) => (async function* () {
        markStarted?.();
        await new Promise<never>((_resolve, reject) => {
          const signal = call.request.signal;
          if (signal?.aborted === true) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })()),
    ]);
    const fixture = await startFixture(model);
    try {
      const client = await createClient(fixture.url);
      const submitted = await client.sendMessage(
        request("wait", true),
        authorization(fixture.seed.agentToken),
      );
      const task = requireTask(submitted);
      await started;
      const canceled = await client.cancelTask(
        { tenant: "", id: task.id, metadata: {} },
        authorization(fixture.seed.agentToken),
      );

      expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(await fixture.server.store.loadTask(task.id, fixture.seed.agent.principalId)).toMatchObject({
        state: "canceled",
        cancelRequested: true,
      });
    } finally {
      await fixture.close();
    }
  });

  it("recovers an orphan working task to failed TASK_INTERRUPTED before listening", async () => {
    const config = readServerConfig(testEnvironment());
    const database = createDatabase({ connectionString: config.databaseUrl });
    await runMigrations(database, { migrationsDir: "../../packages/adapters/migrations" });
    const seed = await seedDatabase(database, config.tokenHmacSecret);
    const store = new PostgresKnowledgeStore(database, config.tokenHmacSecret);
    const task = await store.createTaskForAuthenticatedPrincipal({
      taskId: `task_orphan_${randomUUID()}`,
      contextId: `context_orphan_${randomUUID()}`,
      principal: seed.owner,
      input: queryOperation("orphan"),
    });
    await store.markTaskWorking(task.taskId, task.revision);
    await database.close();

    const server = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    try {
      expect(await server.store.loadTask(task.taskId, seed.owner.principalId)).toMatchObject({
        state: "failed",
        errorCode: "TASK_INTERRUPTED",
      });
    } finally {
      await cleanup(server.database, seed.orgId);
      await server.close();
    }
  });
});

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://cowikiharness@127.0.0.1:55432/cowikiharness_test",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET: "unit-test-token-secret-with-at-least-32-bytes",
    OPENLIFEWIKI_MODEL: "gpt-5.5",
    OPENLIFEWIKI_PUBLIC_URL: "http://127.0.0.1:0",
    OPENAI_API_KEY: "unit-test-api-key",
    OPENAI_BASE_URL: "https://agent108.work/",
    OPENLIFEWIKI_MODEL_REASONING_EFFORT: "xhigh",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    PORT: "0",
  };
}

function message(parts: Array<{ readonly content: { readonly $case: "text"; readonly value: string } | { readonly $case: "data"; readonly value: unknown }; readonly mediaType: string }>): Message {
  return {
    messageId: randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: parts.map((part) => ({ ...part, filename: "", metadata: {} })),
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

interface SeedData {
  readonly orgId: string;
  readonly owner: Principal;
  readonly otherUser: Principal;
  readonly agent: Principal;
  readonly ownerToken: string;
  readonly otherUserToken: string;
  readonly agentToken: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly versionId: string;
  readonly title: string;
  readonly locator: string;
  readonly body: string;
  readonly citation: Omit<KnowledgeCitation, "citationId">;
}

interface Fixture {
  readonly server: A2AServer;
  readonly seed: SeedData;
  readonly url: string;
  close(): Promise<void>;
}

async function startFixture(model: ScriptedModel): Promise<Fixture> {
  const config = readServerConfig(testEnvironment());
  const server = await createA2AServer(config, { modelRuntime: runtime(model) });
  const seed = await seedDatabase(server.database, config.tokenHmacSecret);
  const binding = await server.start();
  return {
    server,
    seed,
    url: binding.url,
    async close() {
      await cleanup(server.database, seed.orgId);
      await server.close();
    },
  };
}

function runtime(model: ScriptedModel): KnowledgeModelRuntime {
  return {
    model,
    modelSettings: {},
    async close() {},
  };
}

function groundedThenNoEvidenceModel(): ScriptedModel {
  return new ScriptedModel([
    [functionCall("knowledge_search", { query: "architecture", limit: 10 }, { callId: "search_call" })],
    modelResponder((call) => {
      const candidate = findRecord(call.request.input, (value) =>
        typeof value.itemId === "string"
        && typeof value.locationId === "string"
        && typeof value.versionId === "string"
        && !("citationId" in value));
      if (candidate === undefined) throw new Error("Search candidate missing");
      return [functionCall("knowledge_get", {
        itemId: candidate.itemId,
        locationId: candidate.locationId,
        versionId: candidate.versionId,
      }, { callId: "get_call" })];
    }),
    modelResponder((call) => {
      const citation = findRecord(call.request.input, (value) =>
        typeof value.citationId === "string"
        && typeof value.bodyHash === "string") as KnowledgeCitation | undefined;
      if (citation === undefined) throw new Error("Evidence citation missing");
      return [assistantMessage(JSON.stringify({
        schema: "openlifewiki.knowledge-query-result/v1",
        taskId: taskIdFromInstructions(call.request.systemInstructions),
        evidenceMode: "grounded",
        answer: "The central architecture is registered.",
        citations: [citation],
        gaps: [],
      }))];
    }),
    modelResponder((call) => [assistantMessage(JSON.stringify({
      schema: "openlifewiki.knowledge-query-result/v1",
      taskId: taskIdFromInstructions(call.request.systemInstructions),
      evidenceMode: "no-evidence",
      answer: "",
      citations: [],
      gaps: [{ code: "KNOWLEDGE_NOT_FOUND", description: "No authorized evidence was available." }],
    }))]),
  ]);
}

function findRecord(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, any> | undefined {
  if (typeof value === "string" && /^[\[{]/u.test(value.trim())) {
    try {
      return findRecord(JSON.parse(value), predicate);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (!Array.isArray(value) && predicate(value as Record<string, unknown>)) {
    return value as Record<string, any>;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRecord(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function taskIdFromInstructions(value: string | null | undefined): string {
  const match = /Current taskId=([A-Za-z0-9._:-]+)\./u.exec(value ?? "");
  if (match?.[1] === undefined) throw new Error("Task id missing from instructions");
  return match[1];
}

async function seedDatabase(database: Database, hmacSecret: string): Promise<SeedData> {
  const suffix = randomUUID();
  const orgId = `org_a2a_${suffix}`;
  const owner = principal(`principal_owner_${suffix}`, orgId, "user", "owner", ["knowledge.query"]);
  const otherUser = principal(`principal_other_${suffix}`, orgId, "user", "owner", []);
  const agent = principal(`principal_agent_${suffix}`, orgId, "agent", null, ["knowledge.query"]);
  const ownerToken = `owner-token-${suffix}`;
  const otherUserToken = `other-token-${suffix}`;
  const agentToken = `agent-token-${suffix}`;
  const delegationId = `delegation_${suffix}`;
  const itemId = `item_${suffix}`;
  const locationId = `location_${suffix}`;
  const versionId = `version_${suffix}`;
  const title = "Confidential central architecture";
  const locator = `openlifewiki://managed/${itemId}`;
  const body = "The central architecture uses an authorized Knowledge Agent.";
  const bodyHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;

  await database.transaction(async (client) => {
    await client.query("insert into organizations(org_id, name) values ($1, $2)", [orgId, "A2A test"]);
    for (const value of [owner, otherUser, agent]) {
      await client.query(
        `insert into principals(
          principal_id, org_id, principal_type, display_name,
          organization_role, capabilities, status
        ) values ($1, $2, $3, $4, $5, $6, 'active')`,
        [value.principalId, value.orgId, value.type, value.displayName,
          value.organizationRole, value.capabilities],
      );
    }
    for (const [tokenId, token, value] of [
      [`token_owner_${suffix}`, ownerToken, owner],
      [`token_other_${suffix}`, otherUserToken, otherUser],
      [`token_agent_${suffix}`, agentToken, agent],
    ] as const) {
      await client.query(
        `insert into principal_tokens(
          token_id, org_id, principal_id, token_prefix, token_digest
        ) values ($1, $2, $3, $4, $5)`,
        [tokenId, orgId, value.principalId, token.slice(0, 8), digestToken(hmacSecret, token)],
      );
    }
    await client.query(
      `insert into delegations(
        delegation_id, org_id, agent_principal_id, user_principal_id,
        capabilities, resource_scopes, expires_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, now() + interval '1 day')`,
      [delegationId, orgId, agent.principalId, owner.principalId,
        ["knowledge.query"], JSON.stringify([{ kind: "organization", id: orgId }])],
    );
    await client.query(
      `insert into resource_grants(
        grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
      ) values ($1, $2, $3, 'organization', $2, $4)`,
      [`grant_${suffix}`, orgId, owner.principalId, ["knowledge.query"]],
    );
    await client.query(
      `insert into knowledge_items(
        item_id, org_id, owner_principal_id, title, aliases, status
      ) values ($1, $2, $3, $4, '{}', 'stable')`,
      [itemId, orgId, owner.principalId, title],
    );
    await client.query(
      `insert into knowledge_locations(
        location_id, org_id, item_id, location_kind, location_role,
        locator, owner_principal_id, metadata, availability
      ) values ($1, $2, $3, 'managed-markdown', 'canonical', $4, $5, '{}', 'available')`,
      [locationId, orgId, itemId, locator, owner.principalId],
    );
    await client.query(
      `insert into knowledge_versions(
        version_id, org_id, item_id, location_id, ordinal, body_hash,
        body_markdown, provenance, created_by_principal_id
      ) values ($1, $2, $3, $4, 1, $5, $6, '{}', $7)`,
      [versionId, orgId, itemId, locationId, bodyHash, body, owner.principalId],
    );
    await client.query(
      "update knowledge_items set current_version_id = $1 where item_id = $2",
      [versionId, itemId],
    );
  });
  return {
    orgId,
    owner,
    otherUser,
    agent,
    ownerToken,
    otherUserToken,
    agentToken,
    itemId,
    locationId,
    versionId,
    title,
    locator,
    body,
    citation: { itemId, locationId, versionId, locator, title, bodyHash },
  };
}

function principal(
  principalId: string,
  orgId: string,
  type: "user" | "agent",
  organizationRole: "owner" | "member" | null,
  capabilities: Principal["capabilities"],
): Principal {
  return {
    schema: "openlifewiki.principal/v1",
    principalId,
    orgId,
    type,
    displayName: principalId,
    organizationRole,
    capabilities,
    status: "active",
  };
}

function queryOperation(query: string) {
  return {
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.query",
    query,
    limit: 10,
    allowPartial: true,
  } as const;
}

async function createClient(url: string) {
  return await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
    preferredTransports: ["JSONRPC"],
  }).createFromUrl(url);
}

function authorization(token: string) {
  return { serviceParameters: { Authorization: `Bearer ${token}` } };
}

function request(query: string, returnImmediately = false): SendMessageRequest {
  return {
    tenant: "",
    message: message([{
      content: { $case: "text", value: query },
      mediaType: "text/plain",
    }]),
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      returnImmediately,
    },
    metadata: {},
  };
}

function a2aTask(taskId: string, contextId: string, state: TaskState): Task {
  return {
    id: taskId,
    contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: {},
  };
}

function listRequest(overrides: Partial<ListTasksRequest> = {}): ListTasksRequest {
  return {
    tenant: "",
    contextId: "",
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: "",
    statusTimestampAfter: undefined,
    includeArtifacts: false,
    historyLength: 0,
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<StreamResponse, void, undefined>): Promise<StreamResponse[]> {
  const values: StreamResponse[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function eventKinds(events: readonly StreamResponse[]): string[] {
  return events.flatMap((event) => event.payload?.$case === undefined ? [] : [event.payload.$case]);
}

function statuses(events: readonly StreamResponse[]): TaskState[] {
  return events.flatMap((event) => {
    if (event.payload?.$case === "task") return [event.payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED];
    if (event.payload?.$case === "statusUpdate") return [event.payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED];
    return [];
  });
}

function statusMessages(events: readonly StreamResponse[]): string[] {
  return events.flatMap((event) => {
    if (event.payload?.$case !== "statusUpdate") return [];
    const part = event.payload.value.status?.message?.parts[0];
    return part?.content?.$case === "text" ? [part.content.value] : [];
  });
}

function artifactResult(events: readonly StreamResponse[]) {
  const event = events.find((value) => value.payload?.$case === "artifactUpdate");
  if (event?.payload?.$case !== "artifactUpdate") throw new Error("Artifact event missing");
  const part = event.payload.value.artifact?.parts[0];
  if (part?.content?.$case !== "data") throw new Error("Artifact data missing");
  return knowledgeQueryResultSchema.parse(part.content.value);
}

function taskIdFrom(events: readonly StreamResponse[]): string {
  const event = events.find((value) => value.payload?.$case === "task");
  if (event?.payload?.$case !== "task") throw new Error("Task event missing");
  return event.payload.value.id;
}

function finalTask(events: readonly StreamResponse[]): Task {
  const event = events.find((value) => value.payload?.$case === "task");
  if (event?.payload?.$case !== "task") throw new Error("Task event missing");
  return event.payload.value;
}

function requireTask(value: Message | Task): Task {
  if (!("id" in value)) throw new Error("Expected task result");
  return value;
}

async function cleanup(database: Database, orgId: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query("delete from audit_events where org_id = $1", [orgId]);
    await client.query("delete from agent_tasks where org_id = $1", [orgId]);
    await client.query("delete from agent_sessions where org_id = $1", [orgId]);
    await client.query("delete from resource_grants where org_id = $1", [orgId]);
    await client.query("update knowledge_items set current_version_id = null where org_id = $1", [orgId]);
    await client.query("delete from knowledge_versions where org_id = $1", [orgId]);
    await client.query("delete from knowledge_locations where org_id = $1", [orgId]);
    await client.query("delete from knowledge_items where org_id = $1", [orgId]);
    await client.query("delete from delegations where org_id = $1", [orgId]);
    await client.query("delete from principal_tokens where org_id = $1", [orgId]);
    await client.query("delete from principals where org_id = $1", [orgId]);
    await client.query("delete from organizations where org_id = $1", [orgId]);
  });
}
