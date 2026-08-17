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
  ScriptedModel,
} from "@openai/agents/testing";
import {
  createDatabase,
  digestToken,
  PostgresKnowledgeHierarchyStore,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import {
  knowledgeCollectionResultSchema,
  knowledgePlacementResultSchema,
  knowledgeQueryResultSchema,
  knowledgeOperationSchema,
  type AccessContext,
  type KnowledgeCitation,
  type KnowledgeAgentResult,
  type KnowledgeOperation,
  type Principal,
} from "@openlifewiki/protocol";
import {
  KnowledgeOperations,
  KnowledgeOrganizationOperations,
} from "@openlifewiki/knowledge-agent";
import { describe, expect, it } from "vitest";

import { PostgresA2ATaskStore, resultArtifact } from "../src/a2a-task-store.js";
import { buildKnowledgeAgentCard } from "../src/agent-card.js";
import { bindAuthenticatedOwner, parseA2AOperation } from "../src/agent-executor.js";
import { createA2AServer, type A2AServer } from "../src/a2a-server.js";
import { AuthenticatedA2AUser } from "../src/authentication.js";
import { readServerConfig } from "../src/config.js";
import { sendA2A } from "../src/client.js";
import {
  createConfiguredKnowledgeAgent,
  createKnowledgeModelRuntime,
  type KnowledgeModelRuntime,
} from "../src/model-runtime.js";

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
      bindHost: "127.0.0.1",
      publicUrl: "http://127.0.0.1:0",
      port: 0,
    });
    expect(JSON.stringify(config)).not.toContain("unit-test-api-key");
    expect(JSON.stringify(config)).not.toContain("unit-test-token-secret");
    const defaultReasoningEnv = testEnvironment();
    delete defaultReasoningEnv.OPENLIFEWIKI_MODEL_REASONING_EFFORT;
    expect(readServerConfig(defaultReasoningEnv).modelReasoningEffort).toBe("xhigh");
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENAI_BASE_URL: "http://api.example.com/v1",
    })).toThrow();
    for (const baseUrl of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
      expect(readServerConfig({ ...testEnvironment(), OPENAI_BASE_URL: baseUrl }).openAIBaseUrl).toBe(baseUrl);
    }
  });

  it("publishes the authorized knowledge capabilities with organize last", () => {
    const card = buildKnowledgeAgentCard("http://127.0.0.1:8080");

    expect(card.supportedInterfaces).toEqual([
      expect.objectContaining({ protocolBinding: "JSONRPC", protocolVersion: "1.0" }),
    ]);
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(card.skills.map(({ id }) => id)).toEqual([
      "knowledge.query",
      "knowledge.register",
      "knowledge.store-draft",
      "knowledge.store-replace",
      "knowledge.share",
      "knowledge.organize",
    ]);
    expect(card.securitySchemes.Bearer?.scheme?.$case).toBe("httpAuthSecurityScheme");
  });

  it("accepts supported JSON operations or one generic text message and rejects unsafe input", () => {
    const query = {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.query",
      query: "where is the architecture?",
      limit: 10,
      allowPartial: true,
    } as const;
    expect(parseA2AOperation(message([{ content: { $case: "data", value: query }, mediaType: "application/json" }]))).toEqual(query);
    expect(parseA2AOperation(message([{ content: { $case: "text", value: "register this source" }, mediaType: "text/plain" }]))).toEqual({
      schema: "openlifewiki.agent-message/v1",
      text: "register this source",
    });
    for (const operation of supportedWriteOperations()) {
      expect(parseA2AOperation(message([{
        content: { $case: "data", value: operation },
        mediaType: "application/json",
      }]))).toEqual(operation);
    }
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: "one" }, mediaType: "text/plain" },
      { content: { $case: "text", value: "two" }, mediaType: "text/plain" },
    ]))).toThrow();
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: "x".repeat(65_537) }, mediaType: "text/plain" },
    ]))).toThrow();
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: " ".repeat(65_537) }, mediaType: "text/plain" },
    ]))).toThrow();
    expect(() => parseA2AOperation(message([
      { content: { $case: "text", value: "知".repeat(22_000) }, mediaType: "text/plain" },
    ]))).toThrow();
  });

  it("accepts concrete hierarchy operations and rejects generic instruction-based organize", () => {
    for (const operation of hierarchyOperations()) {
      expect(knowledgeOperationSchema.parse(operation)).toEqual(operation);
      expect(parseA2AOperation(message([{
        content: { $case: "data", value: operation },
        mediaType: "application/json",
      }]))).toEqual(operation);
    }
    const organize = genericOrganizeOperation();
    expect(knowledgeOperationSchema.parse(organize)).toEqual(organize);
    expect(() => parseA2AOperation(message([{
      content: { $case: "data", value: organize },
      mediaType: "application/json",
    }]))).toThrow(expect.objectContaining({ code: "INVALID_OPERATION" }));
  });

  it("binds client register owner=self to the authenticated principal", () => {
    const register = supportedWriteOperations()[0];
    const withSelf = {
      ...register,
      locations: register.locations.map((location) => ({ ...location, ownerPrincipalId: "self" })),
    };
    const parsed = parseA2AOperation(message([{
      content: { $case: "data", value: withSelf },
      mediaType: "application/json",
    }]));
    expect(bindAuthenticatedOwner(parsed, "principal_authenticated")).toMatchObject({
      locations: [expect.objectContaining({ ownerPrincipalId: "principal_authenticated" })],
    });
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

  it("keeps the model-facing agent read-only while structured A2A operations handle writes", () => {
    const agent = createConfiguredKnowledgeAgent({
      runtime: runtime(new ScriptedModel()),
      operations: new KnowledgeOperations({} as PostgresKnowledgeStore),
    });

    expect(agent.tools.map(({ name }) => name)).toEqual(["knowledge_search", "knowledge_get"]);
    expect(agent.outputType).toBe(knowledgeQueryResultSchema);
  });
});

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("A2A Knowledge Server PostgreSQL journeys", () => {
  it("returns internal and public gateway bindings", async () => {
    const config = readServerConfig(testEnvironment());
    const server = await createA2AServer(config, {
      modelRuntime: runtime(new ScriptedModel()),
    });
    try {
      const binding = await server.start();

      expect(binding.host).toBe("127.0.0.1");
      expect(binding.internalUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(binding.url).toBe(binding.internalUrl);
    } finally {
      await server.close();
    }
  });

  it("executes structured writes with durable tasks, exact replace approval, audit and isolation", async () => {
    const fixture = await startFixture(new ScriptedModel());
    try {
      const client = await createClient(fixture.url);
      const draftEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.store",
          itemId: null,
          expectedRevision: null,
          content: {
            title: "A2A managed draft",
            bodyMarkdown: "# Draft\n\nVersion one.",
            aliases: [],
            tags: ["a2a"],
          },
        }),
        authorization(fixture.seed.ownerToken),
      ));
      expect(eventKinds(draftEvents)).toEqual(["task", "statusUpdate", "artifactUpdate", "statusUpdate"]);
      expect(statuses(draftEvents)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      const draft = artifactData(draftEvents) as {
        schema: string;
        item: { itemId: string; revision: number; status: string };
        version: { versionId: string };
      };
      expect(draft).toMatchObject({
        schema: "openlifewiki.managed-knowledge-result/v1",
        item: { status: "draft" },
      });

      const replayRequest = operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.store",
          itemId: null,
          expectedRevision: null,
          content: {
            title: "A2A managed draft",
            bodyMarkdown: "# Draft\n\nVersion one.",
            aliases: [],
            tags: ["a2a"],
          },
        }, taskIdFrom(draftEvents));
      expect(await sendA2A({
        url: fixture.url,
        token: fixture.seed.ownerToken,
        request: replayRequest,
      })).toEqual(draft);
      expect(Number((await fixture.server.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_items where org_id = $1 and title = $2",
        [fixture.seed.orgId, "A2A managed draft"],
      )).rows[0]?.count)).toBe(1);

      const previewEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.store.preview-replace",
          itemId: draft.item.itemId,
          expectedRevision: draft.item.revision,
          content: {
            title: "A2A managed draft",
            bodyMarkdown: "# Draft\n\nVersion two.",
            aliases: [],
            tags: ["a2a"],
          },
        }),
        authorization(fixture.seed.ownerToken),
      ));
      const preview = artifactData(previewEvents) as { previewHash: string; expectedRevision: number };
      expect(preview.previewHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(statuses(previewEvents)).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);

      const beforeRejectedApply = await fixture.server.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_versions where item_id = $1",
        [draft.item.itemId],
      );
      const rejectedEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.store.apply-replace",
          itemId: draft.item.itemId,
          expectedRevision: preview.expectedRevision,
          previewHash: `sha256:${"0".repeat(64)}`,
          content: {
            title: "A2A managed draft",
            bodyMarkdown: "# Draft\n\nVersion two.",
            aliases: [],
            tags: ["a2a"],
          },
        }),
        authorization(fixture.seed.ownerToken),
      ));
      expect(statuses(rejectedEvents).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusMessages(rejectedEvents)).toEqual(["APPROVAL_REQUIRED"]);
      expect(await fixture.server.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_versions where item_id = $1",
        [draft.item.itemId],
      )).toMatchObject({ rows: beforeRejectedApply.rows });

      const appliedEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.store.apply-replace",
          itemId: draft.item.itemId,
          expectedRevision: preview.expectedRevision,
          previewHash: preview.previewHash,
          content: {
            title: "A2A managed draft",
            bodyMarkdown: "# Draft\n\nVersion two.",
            aliases: [],
            tags: ["a2a"],
          },
        }),
        authorization(fixture.seed.ownerToken),
      ));
      const applied = artifactData(appliedEvents) as { item: { itemId: string }; version: { versionId: string } };
      expect(applied.item.itemId).toBe(draft.item.itemId);
      expect(applied.version.versionId).not.toBe(draft.version.versionId);
      expect(statuses(appliedEvents)).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
      const previewTaskId = taskIdFrom(previewEvents);
      const applyTaskId = taskIdFrom(appliedEvents);
      expect(applyTaskId).not.toBe(previewTaskId);
      const replaceAudit = await fixture.server.database.query<{ task_id: string }>(
        `select task_id from audit_events
         where org_id = $1 and target_id = $2
           and action = 'knowledge.store.replace' and decision = 'completed'`,
        [fixture.seed.orgId, draft.item.itemId],
      );
      expect(replaceAudit.rows).toEqual([{ task_id: applyTaskId }]);

      const draftTaskId = taskIdFrom(draftEvents);
      expect((await fixture.server.database.query<{
        a2a_projection_state: string;
        a2a_projection_error_code: string | null;
      }>(
        `select a2a_projection_state, a2a_projection_error_code
         from agent_tasks where task_id = $1`,
        [draftTaskId],
      )).rows).toEqual([{
        a2a_projection_state: "completed",
        a2a_projection_error_code: null,
      }]);
      await expect(client.getTask(
        { tenant: "", id: draftTaskId },
        authorization(fixture.seed.otherUserToken),
      )).rejects.toBeDefined();
      const audit = await fixture.server.database.query<{ action: string; decision: string }>(
        `select action, decision from audit_events
         where org_id = $1 and (target_id = $2 or task_id = $3)
         order by audit_event_id`,
        [fixture.seed.orgId, draft.item.itemId, draftTaskId],
      );
      expect(audit.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "knowledge.store", decision: "completed" }),
        expect.objectContaining({ action: "agent.task.completed", decision: "completed" }),
      ]));
    } finally {
      await fixture.close();
    }
  });

  it("recovers a structured write committed before product task completion", async () => {
    const config = readServerConfig(testEnvironment());
    const database = createDatabase({ connectionString: config.databaseUrl });
    await runMigrations(database, { migrationsDir: "../../packages/adapters/migrations" });
    const seed = await seedDatabase(database, config.tokenHmacSecret);
    const store = new PostgresKnowledgeStore(database, config.tokenHmacSecret);
    const operation = knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Recoverable draft", bodyMarkdown: "# Durable", aliases: [], tags: [] },
    });
    if (operation.kind !== "knowledge.store") throw new Error("Store operation parse failed");
    const task = await store.createTaskForAuthenticatedPrincipal({
      taskId: `task_recover_write_${randomUUID()}`,
      contextId: `context_recover_write_${randomUUID()}`,
      principal: seed.owner,
      input: operation,
    });
    const access = await store.resolveTaskAccessContext({ taskId: task.taskId, principalId: seed.owner.principalId });
    const working = await store.markTaskWorkingAuthorized({ task, access });
    await new KnowledgeOperations(store).storeManaged(access, operation);
    await database.close();

    const server = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    try {
      expect(await server.store.loadTask(working.taskId, seed.owner.principalId)).toMatchObject({
        state: "completed",
        output: expect.objectContaining({ schema: "openlifewiki.managed-knowledge-result/v1" }),
      });
      expect(Number((await server.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_items where org_id = $1 and title = 'Recoverable draft'",
        [seed.orgId],
      )).rows[0]?.count)).toBe(1);
    } finally {
      await cleanup(server.database, seed.orgId);
      await server.close();
    }
  });

  it("recovers immutable hierarchy results and reconciles both A2A crash windows", async () => {
    const config = readServerConfig(testEnvironment());
    const firstServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    const seed = await seedDatabase(firstServer.database, config.tokenHmacSecret);
    let restartedServer: A2AServer | undefined;
    try {
      await firstServer.database.transaction(async (client) => {
        await client.query(
          `update resource_grants
           set capabilities = array_append(capabilities, 'knowledge.organize')
           where org_id = $1 and principal_id = $2 and scope_kind = 'organization'`,
          [seed.orgId, seed.owner.principalId],
        );
        await client.query(
          "update principals set capabilities = array_append(capabilities, 'knowledge.organize') where principal_id = $1",
          [seed.agent.principalId],
        );
        await client.query(
          "update delegations set capabilities = array_append(capabilities, 'knowledge.organize') where agent_principal_id = $1",
          [seed.agent.principalId],
        );
      });
      const hierarchyOperations = new KnowledgeOrganizationOperations(
        new PostgresKnowledgeHierarchyStore(firstServer.database),
      );

      const createOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Recovery projects",
        description: "Recovery project knowledge",
      } as const;
      const createTask = await firstServer.store.createTaskForAuthenticatedPrincipal({
        taskId: `task_recover_collection_create_${randomUUID()}`,
        contextId: `context_recover_collection_create_${randomUUID()}`,
        principal: seed.agent,
        input: createOperation,
      });
      const createAccess = await firstServer.store.resolveTaskAccessContext({
        taskId: createTask.taskId,
        principalId: seed.agent.principalId,
      });
      const createWorking = await firstServer.store.markTaskWorkingAuthorized({
        task: createTask,
        access: createAccess,
      });
      await firstServer.store.saveA2ATask({
        taskId: createWorking.taskId,
        principalId: seed.agent.principalId,
        expectedA2ARevision: null,
        taskJson: a2aTask(createWorking.taskId, createWorking.contextId, TaskState.TASK_STATE_WORKING),
      });
      const created = await hierarchyOperations.createCollection(createAccess, createOperation);

      const moveOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: created.collection.collectionId,
        expectedRevision: created.collection.revision,
        parentCollectionId: null,
        name: "Recovered projects",
        description: "Recovered project knowledge",
      } as const;
      const moveTask = await firstServer.store.createTaskForAuthenticatedPrincipal({
        taskId: `task_recover_collection_move_${randomUUID()}`,
        contextId: `context_recover_collection_move_${randomUUID()}`,
        principal: seed.owner,
        input: moveOperation,
      });
      const moveAccess = await firstServer.store.resolveTaskAccessContext({
        taskId: moveTask.taskId,
        principalId: seed.owner.principalId,
      });
      const moveWorking = await firstServer.store.markTaskWorkingAuthorized({
        task: moveTask,
        access: moveAccess,
      });
      await firstServer.store.saveA2ATask({
        taskId: moveWorking.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: a2aTask(moveWorking.taskId, moveWorking.contextId, TaskState.TASK_STATE_WORKING),
      });
      const moved = await hierarchyOperations.moveCollection(moveAccess, moveOperation);

      const secondCollectionOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 2,
        parentCollectionId: null,
        name: "Recovery archive",
        description: "Later placement target",
      } as const;
      const secondCollectionTask = await firstServer.store.createTaskForAuthenticatedPrincipal({
        taskId: `task_recover_collection_second_${randomUUID()}`,
        contextId: `context_recover_collection_second_${randomUUID()}`,
        principal: seed.owner,
        input: secondCollectionOperation,
      });
      const secondCollectionAccess = await firstServer.store.resolveTaskAccessContext({
        taskId: secondCollectionTask.taskId,
        principalId: seed.owner.principalId,
      });
      const secondCollectionWorking = await firstServer.store.markTaskWorkingAuthorized({
        task: secondCollectionTask,
        access: secondCollectionAccess,
      });
      const secondCollection = await hierarchyOperations.createCollection(
        secondCollectionAccess,
        secondCollectionOperation,
      );
      await firstServer.store.completeTask({
        taskId: secondCollectionWorking.taskId,
        expectedRevision: secondCollectionWorking.revision,
        output: secondCollection,
      });

      const placeOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: seed.itemId,
        collectionId: moved.collection.collectionId,
        expectedPlacementRevision: null,
      } as const;
      const placeTask = await firstServer.store.createTaskForAuthenticatedPrincipal({
        taskId: `task_recover_place_${randomUUID()}`,
        contextId: `context_recover_place_${randomUUID()}`,
        principal: seed.owner,
        input: placeOperation,
      });
      const placeAccess = await firstServer.store.resolveTaskAccessContext({
        taskId: placeTask.taskId,
        principalId: seed.owner.principalId,
      });
      const placeWorking = await firstServer.store.markTaskWorkingAuthorized({
        task: placeTask,
        access: placeAccess,
      });
      await firstServer.store.saveA2ATask({
        taskId: placeWorking.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: a2aTask(placeWorking.taskId, placeWorking.contextId, TaskState.TASK_STATE_WORKING),
      });
      const placed = await hierarchyOperations.placeKnowledge(placeAccess, placeOperation);

      const laterPlaceOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: seed.itemId,
        collectionId: secondCollection.collection.collectionId,
        expectedPlacementRevision: placed.placement.revision,
      } as const;
      const laterPlaceTask = await firstServer.store.createTaskForAuthenticatedPrincipal({
        taskId: `task_recover_place_later_${randomUUID()}`,
        contextId: `context_recover_place_later_${randomUUID()}`,
        principal: seed.owner,
        input: laterPlaceOperation,
      });
      const laterPlaceAccess = await firstServer.store.resolveTaskAccessContext({
        taskId: laterPlaceTask.taskId,
        principalId: seed.owner.principalId,
      });
      const laterPlaceWorking = await firstServer.store.markTaskWorkingAuthorized({
        task: laterPlaceTask,
        access: laterPlaceAccess,
      });
      await firstServer.store.saveA2ATask({
        taskId: laterPlaceWorking.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: a2aTask(laterPlaceWorking.taskId, laterPlaceWorking.contextId, TaskState.TASK_STATE_WORKING),
      });
      const laterPlaced = await hierarchyOperations.placeKnowledge(laterPlaceAccess, laterPlaceOperation);
      await firstServer.store.completeTask({
        taskId: laterPlaceWorking.taskId,
        expectedRevision: laterPlaceWorking.revision,
        output: laterPlaced,
      });
      const noOpPlaceOperation = {
        ...laterPlaceOperation,
        expectedPlacementRevision: laterPlaced.placement.revision,
      } as const;
      const noOpPlace = await beginStructuredTask(firstServer.store, seed.agent, noOpPlaceOperation);
      await firstServer.store.saveA2ATask({
        taskId: noOpPlace.working.taskId,
        principalId: seed.agent.principalId,
        expectedA2ARevision: null,
        taskJson: a2aTask(noOpPlace.working.taskId, noOpPlace.working.contextId, TaskState.TASK_STATE_WORKING),
      });
      const noOpPlaced = await hierarchyOperations.placeKnowledge(noOpPlace.access, noOpPlaceOperation);
      expect(noOpPlaced.placement).toEqual(laterPlaced.placement);
      expect((await firstServer.database.query<{ receipt_metadata: unknown }>(
        `select receipt_metadata from audit_events
         where task_id = $1 and action = 'knowledge.collection.create' and decision = 'completed'`,
        [createWorking.taskId],
      )).rows).toEqual([{ receipt_metadata: { snapshot: created.collection } }]);

      await firstServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      const firstRestart = await restartedServer.start();
      const client = await createClient(firstRestart.url);

      expect(await restartedServer.store.loadTask(createWorking.taskId, seed.owner.principalId))
        .toMatchObject({ state: "completed", output: created });
      expect(await restartedServer.store.loadTask(moveWorking.taskId, seed.owner.principalId))
        .toMatchObject({ state: "completed", output: moved });
      expect(await restartedServer.store.loadTask(placeWorking.taskId, seed.owner.principalId))
        .toMatchObject({ state: "completed", output: placed });
      expect(await restartedServer.store.loadTask(noOpPlace.working.taskId, seed.agent.principalId))
        .toMatchObject({ state: "completed", output: noOpPlaced });
      for (const [taskId, expected, token] of [
        [createWorking.taskId, created, seed.agentToken],
        [moveWorking.taskId, moved, seed.ownerToken],
        [placeWorking.taskId, placed, seed.ownerToken],
        [laterPlaceWorking.taskId, laterPlaced, seed.ownerToken],
        [noOpPlace.working.taskId, noOpPlaced, seed.agentToken],
      ] as const) {
        const recovered = await client.getTask(
          { tenant: "", id: taskId },
          authorization(token),
        );
        expect(recovered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(recovered.artifacts).toHaveLength(1);
        expect(taskArtifactData(recovered)).toEqual(expected);
      }
      expect((await restartedServer.database.query<{ registry_revision: string }>(
        "select registry_revision::text from organizations where org_id = $1",
        [seed.orgId],
      )).rows).toEqual([{ registry_revision: "5" }]);
      expect((await restartedServer.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_collections where org_id = $1",
        [seed.orgId],
      )).rows).toEqual([{ count: "2" }]);
      expect((await restartedServer.database.query<{ count: string }>(
        "select count(*)::text as count from knowledge_collection_items where org_id = $1",
        [seed.orgId],
      )).rows).toEqual([{ count: "1" }]);
      expect((await restartedServer.database.query<{ task_id: string; count: string }>(
        `select task_id, count(*)::text as count from audit_events
         where task_id = any($1::text[]) and decision = 'completed'
           and action = any('{knowledge.collection.create,knowledge.collection.move,knowledge.place}'::text[])
         group by task_id order by task_id`,
        [[createWorking.taskId, moveWorking.taskId, secondCollectionWorking.taskId,
          placeWorking.taskId, laterPlaceWorking.taskId, noOpPlace.working.taskId]],
      )).rows).toEqual([
        createWorking.taskId,
        moveWorking.taskId,
        secondCollectionWorking.taskId,
        placeWorking.taskId,
        laterPlaceWorking.taskId,
        noOpPlace.working.taskId,
      ].sort().map((task_id) => ({ task_id, count: "1" })));

      await restartedServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      const secondRestart = await restartedServer.start();
      const restartedClient = await createClient(secondRestart.url);
      for (const [taskId, expected, token] of [
        [createWorking.taskId, created, seed.agentToken],
        [moveWorking.taskId, moved, seed.ownerToken],
        [placeWorking.taskId, placed, seed.ownerToken],
        [laterPlaceWorking.taskId, laterPlaced, seed.ownerToken],
        [noOpPlace.working.taskId, noOpPlaced, seed.agentToken],
      ] as const) {
        const recovered = await restartedClient.getTask(
          { tenant: "", id: taskId },
          authorization(token),
        );
        expect(recovered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(recovered.artifacts).toHaveLength(1);
        expect(taskArtifactData(recovered)).toEqual(expected);
      }
      expect((await restartedServer.database.query<{ count: string }>(
        `select count(*)::text as count from audit_events
         where task_id = any($1::text[]) and decision = 'completed'
           and action = any('{knowledge.collection.create,knowledge.collection.move,knowledge.place}'::text[])`,
        [[createWorking.taskId, moveWorking.taskId, secondCollectionWorking.taskId,
          placeWorking.taskId, laterPlaceWorking.taskId, noOpPlace.working.taskId]],
      )).rows).toEqual([{ count: "6" }]);
      expect((await restartedServer.database.query<{ collection_count: string; placement_count: string }>(
        `select
           (select count(*)::text from knowledge_collections where org_id = $1) as collection_count,
           (select count(*)::text from knowledge_collection_items where org_id = $1) as placement_count`,
        [seed.orgId],
      )).rows).toEqual([{ collection_count: "2", placement_count: "1" }]);
    } finally {
      if (restartedServer === undefined) {
        const cleanupDatabase = createDatabase({ connectionString: config.databaseUrl });
        try {
          await cleanup(cleanupDatabase, seed.orgId);
        } finally {
          await cleanupDatabase.close();
        }
      } else {
        try {
          await cleanup(restartedServer.database, seed.orgId);
        } finally {
          await restartedServer.close();
        }
      }
      await firstServer.close();
    }
  });

  it("bounds startup projection pages, quarantines malformed projections, and makes retries write-free", async () => {
    const config = readServerConfig(testEnvironment());
    const firstServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    const seed = await seedDatabase(firstServer.database, config.tokenHmacSecret);
    let restartedServer: A2AServer | undefined;
    try {
      const malformed = await completeQueryTask(firstServer.store, seed.owner, "malformed");
      const malformedNested = await completeQueryTask(firstServer.store, seed.owner, "malformed_nested");
      const malformedHistory = await completeQueryTask(firstServer.store, seed.owner, "malformed_history");
      const oversizedProjection = await completeQueryTask(firstServer.store, seed.owner, "oversized");
      const valid = [];
      for (let index = 0; index < 10; index += 1) {
        valid.push(await completeQueryTask(firstServer.store, seed.owner, `valid_${index}`));
      }
      await firstServer.database.query(
        `update agent_tasks
         set input_json = '{"schema":"historical.unsupported/v0"}'::jsonb,
           output_json = $1::jsonb
         where task_id = $2`,
        [JSON.stringify({ privatePayload: "must-not-escape" }), malformed.task.taskId],
      );
      await firstServer.database.query(
        "update agent_tasks set a2a_task_json = $1::jsonb where task_id = $2",
        [JSON.stringify({
          ...a2aTask(
            malformedNested.task.taskId,
            malformedNested.task.contextId,
            TaskState.TASK_STATE_COMPLETED,
          ),
          artifacts: [{
            artifactId: `result:${malformedNested.task.taskId}`,
            parts: [{ content: { $case: "text", value: { privatePayload: "nested-secret" } } }],
          }],
        }), malformedNested.task.taskId],
      );
      await firstServer.database.query(
        "update agent_tasks set a2a_task_json = $1::jsonb where task_id = $2",
        [JSON.stringify({
          ...a2aTask(
            malformedHistory.task.taskId,
            malformedHistory.task.contextId,
            TaskState.TASK_STATE_COMPLETED,
          ),
          history: [{
            parts: [{ content: { $case: "text", value: { privatePayload: "history-secret" } } }],
          }],
        }), malformedHistory.task.taskId],
      );
      await firstServer.database.query(
        "update agent_tasks set a2a_task_json = $1::jsonb where task_id = $2",
        [JSON.stringify({
          ...a2aTask(
            oversizedProjection.task.taskId,
            oversizedProjection.task.contextId,
            TaskState.TASK_STATE_COMPLETED,
          ),
          metadata: {
            openlifewikiA2ARevision: 0,
            privatePayload: "x".repeat(1_048_576),
          },
        }), oversizedProjection.task.taskId],
      );

      const artifactOnly = a2aTask(
        valid[0]!.task.taskId,
        valid[0]!.task.contextId,
        TaskState.TASK_STATE_WORKING,
      );
      artifactOnly.artifacts = [resultArtifact(valid[0]!.result)];
      await firstServer.store.saveA2ATask({
        taskId: valid[0]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: artifactOnly,
      });

      const exactPending = a2aTask(
        valid[1]!.task.taskId,
        valid[1]!.task.contextId,
        TaskState.TASK_STATE_COMPLETED,
      );
      exactPending.artifacts = [resultArtifact(valid[1]!.result)];
      const exactPendingSaved = await firstServer.store.saveA2ATask({
        taskId: valid[1]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: exactPending,
      });

      const alreadyProjected = a2aTask(
        valid[2]!.task.taskId,
        valid[2]!.task.contextId,
        TaskState.TASK_STATE_COMPLETED,
      );
      alreadyProjected.artifacts = [resultArtifact(valid[2]!.result)];
      const alreadyProjectedSaved = await firstServer.store.saveA2ATask({
        taskId: valid[2]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: alreadyProjected,
      });
      await firstServer.store.markA2AProjectionComplete({
        taskId: valid[2]!.task.taskId,
        expectedTaskRevision: valid[2]!.task.revision,
        expectedProjectionVersion: alreadyProjectedSaved.projectionVersion,
        expectedA2ARevision: alreadyProjectedSaved.a2aRevision,
      });

      const quarantinedTaskIds = [
        malformed.task.taskId,
        malformedNested.task.taskId,
        malformedHistory.task.taskId,
        oversizedProjection.task.taskId,
      ];
      const orderedTaskIds = [...quarantinedTaskIds, ...valid.map(({ task }) => task.taskId)];
      for (const [index, taskId] of orderedTaskIds.entries()) {
        await firstServer.database.query(
          "update agent_tasks set created_at = $1 where task_id = $2",
          [new Date(Date.UTC(2026, 7, 17, 0, 0, index)).toISOString(), taskId],
        );
      }
      expect((await firstServer.database.query<{ count: string }>(
        `select count(*)::text as count from agent_tasks
         where task_id = any($1::text[]) and a2a_projection_state = 'pending'`,
        [orderedTaskIds],
      )).rows).toEqual([{ count: String(orderedTaskIds.length - 1) }]);
      const alreadyProjectedBefore = await projectionWriteSnapshot(
        firstServer.database,
        valid[2]!.task.taskId,
      );
      const quarantineCursorsBefore = await taskCursorTimestamps(
        firstServer.database,
        quarantinedTaskIds,
      );

      await firstServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      const binding = await restartedServer.start();
      const client = await createClient(binding.url);

      expect((await restartedServer.database.query<{
        task_id: string;
        a2a_projection_state: string;
        a2a_projection_error_code: string | null;
      }>(
        `select task_id, a2a_projection_state, a2a_projection_error_code
         from agent_tasks where task_id = any($1::text[]) order by task_id`,
        [orderedTaskIds],
      )).rows).toEqual(orderedTaskIds.sort().map((taskId) => quarantinedTaskIds.includes(taskId)
        ? {
            task_id: taskId,
            a2a_projection_state: "failed",
            a2a_projection_error_code: "INVALID_A2A_PROJECTION",
          }
        : {
            task_id: taskId,
            a2a_projection_state: "completed",
            a2a_projection_error_code: null,
          }));
      expect(await taskCursorTimestamps(restartedServer.database, quarantinedTaskIds))
        .toEqual(quarantineCursorsBefore);
      expect(await projectionWriteSnapshot(restartedServer.database, valid[2]!.task.taskId))
        .toEqual(alreadyProjectedBefore);
      expect((await restartedServer.database.query<{
        a2a_revision: string;
        artifact_count: string;
      }>(
        `select a2a_task_json #>> '{metadata,openlifewikiA2ARevision}' as a2a_revision,
           jsonb_array_length(a2a_task_json -> 'artifacts')::text as artifact_count
         from agent_tasks where task_id = $1`,
        [valid[1]!.task.taskId],
      )).rows).toEqual([{
        a2a_revision: String(exactPendingSaved.a2aRevision),
        artifact_count: "1",
      }]);
      for (const entry of valid) {
        const projected = await client.getTask(
          { tenant: "", id: entry.task.taskId },
          authorization(seed.ownerToken),
        );
        expect(projected.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(taskArtifactData(projected)).toEqual(entry.result);
        expect(projected.artifacts?.filter(({ artifactId }) => artifactId === `result:${entry.task.taskId}`))
          .toHaveLength(1);
      }
      const scopedStore = new PostgresA2ATaskStore(restartedServer.store);
      const ownerContext = new ServerCallContext({
        user: new AuthenticatedA2AUser(seed.owner),
        requestedVersion: "1.0",
      });
      for (const taskId of [
        malformedNested.task.taskId,
        malformedHistory.task.taskId,
        oversizedProjection.task.taskId,
      ]) {
        const error = await scopedStore.load(taskId, ownerContext).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toMatchObject({ code: "INVALID_OPERATION" });
        expect(JSON.stringify(error)).not.toContain("privatePayload");
        expect(JSON.stringify(error)).not.toContain("nested-secret");
        expect(JSON.stringify(error)).not.toContain("history-secret");
      }

      const beforeRepeatedStartup = await projectionWriteSnapshots(
        restartedServer.database,
        orderedTaskIds,
      );
      await restartedServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      await restartedServer.start();
      expect(await projectionWriteSnapshots(restartedServer.database, orderedTaskIds))
        .toEqual(beforeRepeatedStartup);
    } finally {
      if (restartedServer === undefined) {
        const cleanupDatabase = createDatabase({ connectionString: config.databaseUrl });
        try {
          await cleanup(cleanupDatabase, seed.orgId);
        } finally {
          await cleanupDatabase.close();
        }
      } else {
        try {
          await cleanup(restartedServer.database, seed.orgId);
        } finally {
          await restartedServer.close();
        }
      }
      await firstServer.close();
    }
  });

  it("demand-reconciles authorized completed projections beyond the bounded startup cap", async () => {
    const config = readServerConfig(testEnvironment());
    const firstServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    const seed = await seedDatabase(firstServer.database, config.tokenHmacSecret);
    let restartedServer: A2AServer | undefined;
    try {
      const older: Array<Awaited<ReturnType<typeof completeQueryTask>>> = [];
      for (let index = 0; index < 33; index += 1) {
        const entry = await completeQueryTask(firstServer.store, seed.owner, `older_${index}`);
        const exact = a2aTask(
          entry.task.taskId,
          entry.task.contextId,
          TaskState.TASK_STATE_COMPLETED,
        );
        exact.artifacts = [resultArtifact(entry.result)];
        await firstServer.store.saveA2ATask({
          taskId: entry.task.taskId,
          principalId: seed.owner.principalId,
          expectedA2ARevision: null,
          taskJson: exact,
        });
        older.push(entry);
      }
      const targets = [
        await completeQueryTask(firstServer.store, seed.owner, "demand_missing"),
        await completeQueryTask(firstServer.store, seed.owner, "demand_stale"),
        await completeQueryTask(firstServer.store, seed.owner, "demand_artifact"),
        await completeQueryTask(firstServer.store, seed.owner, "demand_exact"),
      ];
      const stale = a2aTask(
        targets[1]!.task.taskId,
        targets[1]!.task.contextId,
        TaskState.TASK_STATE_WORKING,
      );
      await firstServer.store.saveA2ATask({
        taskId: targets[1]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: stale,
      });
      const artifactOnly = a2aTask(
        targets[2]!.task.taskId,
        targets[2]!.task.contextId,
        TaskState.TASK_STATE_WORKING,
      );
      artifactOnly.artifacts = [resultArtifact(targets[2]!.result)];
      await firstServer.store.saveA2ATask({
        taskId: targets[2]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: artifactOnly,
      });
      const exact = a2aTask(
        targets[3]!.task.taskId,
        targets[3]!.task.contextId,
        TaskState.TASK_STATE_COMPLETED,
      );
      exact.artifacts = [resultArtifact(targets[3]!.result)];
      await firstServer.store.saveA2ATask({
        taskId: targets[3]!.task.taskId,
        principalId: seed.owner.principalId,
        expectedA2ARevision: null,
        taskJson: exact,
      });

      const ordered = [...older, ...targets];
      for (const [index, entry] of ordered.entries()) {
        await firstServer.database.query(
          "update agent_tasks set created_at = $1 where task_id = $2",
          [new Date(Date.UTC(2026, 7, 17, 0, 0, index)).toISOString(), entry.task.taskId],
        );
      }
      await firstServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      const binding = await restartedServer.start();
      const client = await createClient(binding.url);
      const targetIds = targets.map(({ task }) => task.taskId);

      expect((await restartedServer.database.query<{ task_id: string; a2a_projection_state: string }>(
        `select task_id, a2a_projection_state from agent_tasks
         where task_id = any($1::text[]) order by created_at, task_id`,
        [[older[32]!.task.taskId, ...targetIds]],
      )).rows).toEqual([older[32]!.task.taskId, ...targetIds].map((task_id) => ({
        task_id,
        a2a_projection_state: "pending",
      })));

      const scopedStore = new PostgresA2ATaskStore(restartedServer.store);
      const otherContext = new ServerCallContext({
        user: new AuthenticatedA2AUser(seed.otherUser),
        requestedVersion: "1.0",
      });
      expect(await scopedStore.load(targets[0]!.task.taskId, otherContext)).toBeUndefined();
      expect(await scopedStore.load(`task_unknown_${randomUUID()}`, otherContext)).toBeUndefined();
      await expect(client.getTask(
        { tenant: "", id: targets[0]!.task.taskId },
        authorization(seed.otherUserToken),
      )).rejects.toBeDefined();
      expect((await restartedServer.database.query<{
        a2a_projection_state: string;
        a2a_task_json: unknown | null;
      }>(
        "select a2a_projection_state, a2a_task_json from agent_tasks where task_id = $1",
        [targets[0]!.task.taskId],
      )).rows).toEqual([{ a2a_projection_state: "pending", a2a_task_json: null }]);

      const exactJsonBefore = (await restartedServer.database.query<{ a2a_task_json: string }>(
        "select a2a_task_json::text as a2a_task_json from agent_tasks where task_id = $1",
        [targets[3]!.task.taskId],
      )).rows[0]?.a2a_task_json;
      for (const entry of targets) {
        const projected = await client.getTask(
          { tenant: "", id: entry.task.taskId },
          authorization(seed.ownerToken),
        );
        expect(projected.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(taskArtifactData(projected)).toEqual(entry.result);
        expect(projected.artifacts?.filter(({ artifactId }) => artifactId === `result:${entry.task.taskId}`))
          .toHaveLength(1);
      }
      expect((await restartedServer.database.query<{ a2a_task_json: string }>(
        "select a2a_task_json::text as a2a_task_json from agent_tasks where task_id = $1",
        [targets[3]!.task.taskId],
      )).rows[0]?.a2a_task_json).toBe(exactJsonBefore);
      expect((await restartedServer.database.query<{ task_id: string; a2a_projection_state: string }>(
        `select task_id, a2a_projection_state from agent_tasks
         where task_id = any($1::text[]) order by task_id`,
        [[older[32]!.task.taskId, ...targetIds]],
      )).rows).toEqual([older[32]!.task.taskId, ...targetIds].sort().map((task_id) => ({
        task_id,
        a2a_projection_state: task_id === older[32]!.task.taskId ? "pending" : "completed",
      })));

      const beforeRepeatedGet = await projectionWriteSnapshots(restartedServer.database, targetIds);
      for (const entry of targets) {
        await client.getTask({ tenant: "", id: entry.task.taskId }, authorization(seed.ownerToken));
      }
      expect(await projectionWriteSnapshots(restartedServer.database, targetIds)).toEqual(beforeRepeatedGet);
    } finally {
      if (restartedServer === undefined) {
        const cleanupDatabase = createDatabase({ connectionString: config.databaseUrl });
        try {
          await cleanup(cleanupDatabase, seed.orgId);
        } finally {
          await cleanupDatabase.close();
        }
      } else {
        try {
          await cleanup(restartedServer.database, seed.orgId);
        } finally {
          await restartedServer.close();
        }
      }
      await firstServer.close();
    }
  });

  it("fails hierarchy recovery for mismatched or ambiguous completed receipts", async () => {
    const config = readServerConfig(testEnvironment());
    const firstServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
    const seed = await seedDatabase(firstServer.database, config.tokenHmacSecret);
    let restartedServer: A2AServer | undefined;
    try {
      await firstServer.database.query(
        `update resource_grants
         set capabilities = array_append(capabilities, 'knowledge.organize')
         where org_id = $1 and principal_id = $2 and scope_kind = 'organization'`,
        [seed.orgId, seed.owner.principalId],
      );
      const hierarchyOperations = new KnowledgeOrganizationOperations(
        new PostgresKnowledgeHierarchyStore(firstServer.database),
      );
      const firstCreateOperation = knowledgeOperationSchema.parse({
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Receipt target one",
        description: "",
      });
      if (firstCreateOperation.kind !== "knowledge.collection.create") throw new Error("Create parse failed");
      const firstCreate = await beginStructuredTask(firstServer.store, seed.owner, firstCreateOperation);
      const firstCollection = await hierarchyOperations.createCollection(firstCreate.access, firstCreateOperation);
      await firstServer.store.completeTask({
        taskId: firstCreate.working.taskId,
        expectedRevision: firstCreate.working.revision,
        output: firstCollection,
      });
      const secondCreateOperation = {
        ...firstCreateOperation,
        expectedRegistryRevision: 1,
        name: "Receipt target two",
      } as const;
      const secondCreate = await beginStructuredTask(firstServer.store, seed.owner, secondCreateOperation);
      const secondCollection = await hierarchyOperations.createCollection(secondCreate.access, secondCreateOperation);
      await firstServer.store.completeTask({
        taskId: secondCreate.working.taskId,
        expectedRevision: secondCreate.working.revision,
        output: secondCollection,
      });

      const moveOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: firstCollection.collection.collectionId,
        expectedRevision: firstCollection.collection.revision,
        parentCollectionId: null,
        name: "Moved receipt target",
        description: "",
      } as const;
      const move = await beginStructuredTask(firstServer.store, seed.owner, moveOperation);
      await hierarchyOperations.moveCollection(move.access, moveOperation);
      await firstServer.database.query(
        "update audit_events set target_id = $1 where task_id = $2 and action = 'knowledge.collection.move'",
        [secondCollection.collection.collectionId, move.working.taskId],
      );

      const ambiguousCreateOperation = {
        ...firstCreateOperation,
        expectedRegistryRevision: 3,
        name: "Ambiguous receipt",
      } as const;
      const ambiguous = await beginStructuredTask(firstServer.store, seed.owner, ambiguousCreateOperation);
      await hierarchyOperations.createCollection(ambiguous.access, ambiguousCreateOperation);
      await firstServer.database.query(
        `insert into audit_events(
           audit_event_id, org_id, task_id, actor_principal_id, on_behalf_of_user_id,
           action, target_kind, target_id, decision, receipt_metadata, created_at
         ) select $1, org_id, task_id, actor_principal_id, on_behalf_of_user_id,
                  action, target_kind, target_id, decision, receipt_metadata, created_at
           from audit_events where task_id = $2 and action = 'knowledge.collection.create'`,
        [`audit_duplicate_${randomUUID()}`, ambiguous.working.taskId],
      );

      const placeOperation = {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: seed.itemId,
        collectionId: firstCollection.collection.collectionId,
        expectedPlacementRevision: null,
      } as const;
      const place = await beginStructuredTask(firstServer.store, seed.owner, placeOperation);
      await hierarchyOperations.placeKnowledge(place.access, placeOperation);
      await firstServer.database.query(
        `update audit_events
         set actor_principal_id = $1, target_kind = 'collection'
         where task_id = $2 and action = 'knowledge.place'`,
        [seed.otherUser.principalId, place.working.taskId],
      );

      await firstServer.close();
      restartedServer = await createA2AServer(config, { modelRuntime: runtime(new ScriptedModel()) });
      for (const taskId of [move.working.taskId, ambiguous.working.taskId, place.working.taskId]) {
        expect(await restartedServer.store.loadTask(taskId, seed.owner.principalId)).toMatchObject({
          state: "failed",
          output: null,
          errorCode: "TASK_INTERRUPTED",
        });
      }
    } finally {
      if (restartedServer === undefined) {
        const cleanupDatabase = createDatabase({ connectionString: config.databaseUrl });
        try {
          await cleanup(cleanupDatabase, seed.orgId);
        } finally {
          await cleanupDatabase.close();
        }
      } else {
        try {
          await cleanup(restartedServer.database, seed.orgId);
        } finally {
          await restartedServer.close();
        }
      }
      await firstServer.close();
    }
  });

  it("executes create, move, and place through A2A with organize-only delegated authority", async () => {
    const model = new ScriptedModel();
    const fixture = await startFixture(model);
    try {
      await fixture.server.database.transaction(async (client) => {
        await client.query(
          "update principals set capabilities = '{knowledge.organize}' where principal_id = $1",
          [fixture.seed.agent.principalId],
        );
        await client.query(
          "update delegations set capabilities = '{knowledge.organize}' where agent_principal_id = $1",
          [fixture.seed.agent.principalId],
        );
        await client.query(
          `update resource_grants
           set capabilities = array_append(capabilities, 'knowledge.organize')
           where org_id = $1 and principal_id = $2 and scope_kind = 'organization'`,
          [fixture.seed.orgId, fixture.seed.owner.principalId],
        );
      });
      const client = await createClient(fixture.url);

      const createEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.collection.create",
          expectedRegistryRevision: 0,
          parentCollectionId: null,
          name: "Projects",
          description: "Project knowledge",
        }),
        authorization(fixture.seed.agentToken),
      ));
      expect(statusMessages(createEvents)).toEqual([]);
      expect(statuses(createEvents)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      const created = knowledgeCollectionResultSchema.parse(artifactData(createEvents));
      expect(created.taskId).toBe(taskIdFrom(createEvents));
      expect(created.collection).toMatchObject({ name: "Projects", revision: 0 });

      const moveEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.collection.move",
          collectionId: created.collection.collectionId,
          expectedRevision: created.collection.revision,
          parentCollectionId: null,
          name: "Active projects",
          description: "Active project knowledge",
        }),
        authorization(fixture.seed.agentToken),
      ));
      expect(statuses(moveEvents)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      const moved = knowledgeCollectionResultSchema.parse(artifactData(moveEvents));
      expect(moved.taskId).toBe(taskIdFrom(moveEvents));
      expect(moved.collection).toMatchObject({
        collectionId: created.collection.collectionId,
        name: "Active projects",
        revision: 1,
      });

      const placeEvents = await collect(client.sendMessageStream(
        operationRequest({
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.place",
          itemId: fixture.seed.itemId,
          collectionId: moved.collection.collectionId,
          expectedPlacementRevision: null,
        }),
        authorization(fixture.seed.agentToken),
      ));
      expect(statuses(placeEvents)).toEqual([
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_COMPLETED,
      ]);
      const placed = knowledgePlacementResultSchema.parse(artifactData(placeEvents));
      expect(placed.taskId).toBe(taskIdFrom(placeEvents));
      expect(placed.placement).toMatchObject({
        itemId: fixture.seed.itemId,
        collectionId: moved.collection.collectionId,
        revision: 0,
      });
      expect(model.calls).toHaveLength(0);
      expect((await fixture.server.database.query<{ owner_principal_id: string; actor_agent_id: string }>(
        `select owner_principal_id, actor_agent_id from agent_tasks
         where task_id = any($1::text[]) order by task_id`,
        [[taskIdFrom(createEvents), taskIdFrom(moveEvents), taskIdFrom(placeEvents)]],
      )).rows).toEqual(Array.from({ length: 3 }, () => ({
        owner_principal_id: fixture.seed.owner.principalId,
        actor_agent_id: fixture.seed.agent.principalId,
      })));
    } finally {
      await fixture.close();
    }
  });

  it("serves a public card and isolates grounded delegated-agent and no-evidence human journeys", async () => {
    const model = groundedThenNoEvidenceModel();
    const fixture = await startFixture(model);
    try {
      const cardResponse = await fetch(`${fixture.url}/${AGENT_CARD_PATH}`);
      expect(cardResponse.status).toBe(200);
      const card = await cardResponse.json() as { skills: Array<{ id: string }>; supportedInterfaces: Array<{ protocolVersion: string }> };
      expect(card.skills.map(({ id }) => id)).toEqual([
        "knowledge.query",
        "knowledge.register",
        "knowledge.store-draft",
        "knowledge.store-replace",
        "knowledge.share",
        "knowledge.organize",
      ]);
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
      const productBeforeContinuation = await fixture.server.store.loadTask(extraTaskId, fixture.seed.agent.principalId);
      const streamingContinuation = request("stream existing task");
      if (streamingContinuation.message === undefined) throw new Error("Continuation message missing");
      streamingContinuation.message.taskId = extraTaskId;
      streamingContinuation.message.contextId = extraContextId;
      const continuationEvents = await collect(client.sendMessageStream(
        streamingContinuation,
        authorization(fixture.seed.agentToken),
      ));
      expect(eventKinds(continuationEvents)).toEqual(["message"]);
      expect(agentMessages(continuationEvents)).toEqual(["INVALID_OPERATION"]);

      const blockingContinuation = request("block existing task");
      if (blockingContinuation.message === undefined) throw new Error("Continuation message missing");
      blockingContinuation.message.taskId = extraTaskId;
      blockingContinuation.message.contextId = extraContextId;
      const continuationResult = await client.sendMessage(
        blockingContinuation,
        authorization(fixture.seed.agentToken),
      );
      expect(responseText(continuationResult)).toBe("INVALID_OPERATION");
      expect(JSON.stringify(continuationResult)).not.toContain("pagination");
      expect(JSON.stringify(continuationResult)).not.toContain(fixture.seed.owner.principalId);
      expect(await fixture.server.store.loadTask(extraTaskId, fixture.seed.agent.principalId))
        .toEqual(productBeforeContinuation);

      const boundaryTaskId = `task_boundary_${randomUUID()}`;
      const boundaryContextId = `context_boundary_${randomUUID()}`;
      await fixture.server.store.createTaskForAuthenticatedPrincipal({
        taskId: boundaryTaskId,
        contextId: boundaryContextId,
        principal: fixture.seed.agent,
        input: queryOperation("boundary"),
      });
      const boundaryBase = a2aTask(boundaryTaskId, boundaryContextId, TaskState.TASK_STATE_SUBMITTED);
      const oversized = structuredClone(boundaryBase);
      oversized.metadata = { payload: "x".repeat(1_048_576) };
      const amplified = structuredClone(boundaryBase);
      amplified.history = Array.from({ length: 101 }, () => message([{
        content: { $case: "text", value: "x" }, mediaType: "text/plain",
      }]));
      const artifactAmplified = structuredClone(boundaryBase);
      artifactAmplified.artifacts = Array.from({ length: 51 }, (_, index) => artifact(`artifact_${index}`, "x"));
      const oversizedPart = structuredClone(boundaryBase);
      oversizedPart.artifacts = [artifact("artifact_large", "x".repeat(65_537))];
      const oversizedDataPart = structuredClone(boundaryBase);
      oversizedDataPart.history = [message([{
        content: { $case: "data", value: { payload: "x".repeat(65_537) } }, mediaType: "application/json",
      }])];
      const oversizedStatusPart = structuredClone(boundaryBase);
      if (oversizedStatusPart.status === undefined) throw new Error("Boundary task status missing");
      oversizedStatusPart.status.message = message([{
        content: { $case: "text", value: "x".repeat(65_537) }, mediaType: "text/plain",
      }]);
      for (const invalid of [
        oversized,
        amplified,
        artifactAmplified,
        oversizedPart,
        oversizedDataPart,
        oversizedStatusPart,
      ]) {
        await expect(scopedStore.save(invalid, agentContext)).rejects.toMatchObject({ code: "INVALID_OPERATION" });
        expect((await fixture.server.database.query<{ a2a_task_json: unknown | null }>(
          "select a2a_task_json from agent_tasks where task_id = $1",
          [boundaryTaskId],
        )).rows[0]?.a2a_task_json).toBeNull();
      }
      await fixture.server.database.query(
        "update agent_tasks set a2a_task_json = $1::jsonb where task_id = $2",
        [JSON.stringify(amplified), boundaryTaskId],
      );
      await expect(scopedStore.load(boundaryTaskId, agentContext))
        .rejects.toMatchObject({ code: "INVALID_OPERATION" });
      await fixture.server.database.query(
        "update agent_tasks set a2a_task_json = null where task_id = $1",
        [boundaryTaskId],
      );
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
      expect(await scopedStore.list(listRequest({
        statusTimestampAfter: "2999-01-01T00:00:00.000Z",
      }), agentContext)).toMatchObject({ tasks: [], totalSize: 0 });
      await fixture.server.database.query(
        `update agent_tasks
         set a2a_task_json = jsonb_set(a2a_task_json, '{status,timestamp}', '"not-a-timestamp"'::jsonb)
         where task_id = $1`,
        [extraTaskId],
      );
      expect(await scopedStore.list(listRequest({
        contextId: extraContextId,
        statusTimestampAfter: "2000-01-01T00:00:00.000Z",
      }), agentContext)).toMatchObject({ tasks: [], totalSize: 0 });
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

  it("lets a committed hierarchy mutation win an actual late A2A cancellation race", async () => {
    let markCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const fixture = await startFixture(new ScriptedModel(), {
      afterHierarchyMutationCommit: async () => {
        markCommitted?.();
        await completionGate;
      },
    });
    try {
      await fixture.server.database.query(
        `update resource_grants
         set capabilities = array_append(capabilities, 'knowledge.organize')
         where org_id = $1 and principal_id = $2 and scope_kind = 'organization'`,
        [fixture.seed.orgId, fixture.seed.owner.principalId],
      );
      const client = await createClient(fixture.url);
      const sendRequest = operationRequest({
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Committed before cancel",
        description: "The durable mutation wins",
      });
      if (sendRequest.configuration === undefined) throw new Error("Send configuration missing");
      sendRequest.configuration.returnImmediately = true;
      const submitted = requireTask(await client.sendMessage(
        sendRequest,
        authorization(fixture.seed.ownerToken),
      ));
      await committed;

      const cancellation = await client.cancelTask(
        { tenant: "", id: submitted.id, metadata: {} },
        authorization(fixture.seed.ownerToken),
      ).then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      expect(cancellation.kind).toBe("rejected");
      expect(JSON.stringify(cancellation)).not.toContain("select ");
      expect(JSON.stringify(cancellation)).not.toContain("unit-test-token-secret");

      releaseCompletion?.();
      await waitFor(async () => {
        const task = await client.getTask(
          { tenant: "", id: submitted.id },
          authorization(fixture.seed.ownerToken),
        );
        return task.status?.state === TaskState.TASK_STATE_COMPLETED;
      });
      const completedTask = await client.getTask(
        { tenant: "", id: submitted.id },
        authorization(fixture.seed.ownerToken),
      );
      const result = knowledgeCollectionResultSchema.parse(taskArtifactData(completedTask));
      expect(completedTask.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(completedTask.artifacts).toHaveLength(1);
      expect(result.collection).toMatchObject({ name: "Committed before cancel", revision: 0 });
      expect(await fixture.server.store.loadTask(submitted.id, fixture.seed.owner.principalId)).toMatchObject({
        state: "completed",
        cancelRequested: false,
        output: result,
      });
      expect((await fixture.server.database.query<{ mutation_count: string; audit_count: string }>(
        `select
           (select count(*)::text from knowledge_collections where org_id = $1 and name = $2) as mutation_count,
           (select count(*)::text from audit_events
             where task_id = $3 and action = 'knowledge.collection.create' and decision = 'completed') as audit_count`,
        [fixture.seed.orgId, "Committed before cancel", submitted.id],
      )).rows).toEqual([{ mutation_count: "1", audit_count: "1" }]);
    } finally {
      releaseCompletion?.();
      await fixture.close();
    }
  });

  it("cancels a running task with authenticated revision CAS and persists canceled state", async () => {
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
    let releaseSettlement: (() => void) | undefined;
    const settlementGate = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    const fixture = await startFixture(model, {
      beforeCancellationSettlement: async () => await settlementGate,
    });
    try {
      const client = await createClient(fixture.url);
      const submitted = await client.sendMessage(
        request("wait", true),
        authorization(fixture.seed.agentToken),
      );
      const task = requireTask(submitted);
      await started;
      const canceling = client.cancelTask(
        { tenant: "", id: task.id, metadata: {} },
        authorization(fixture.seed.agentToken),
      );
      await waitFor(async () => (await fixture.server.store.loadTask(
        task.id,
        fixture.seed.agent.principalId,
      ))?.cancelRequested === true);
      expect(await fixture.server.store.loadTask(task.id, fixture.seed.agent.principalId)).toMatchObject({
        state: "working",
        cancelRequested: true,
      });
      releaseSettlement?.();
      const canceled = await canceling;

      expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(await fixture.server.store.loadTask(task.id, fixture.seed.agent.principalId)).toMatchObject({
        state: "canceled",
        cancelRequested: true,
      });
      expect((await client.getTask(
        { tenant: "", id: task.id },
        authorization(fixture.seed.agentToken),
      )).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(Number((await fixture.server.database.query<{ count: string }>(
        "select count(*)::text as count from audit_events where task_id = $1 and action = 'agent.task.failed'",
        [task.id],
      )).rows[0]?.count)).toBe(0);
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
  const databaseUrl = process.env.OPENLIFEWIKI_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgres://test.invalid/openlifewiki_test";
  if (runPostgres) assertSafeTestDatabaseUrl(databaseUrl);
  return {
    DATABASE_URL: databaseUrl,
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

async function beginStructuredTask(
  store: PostgresKnowledgeStore,
  principal: Principal,
  input: KnowledgeOperation,
): Promise<{ readonly working: StoredAgentTask; readonly access: AccessContext }> {
  const task = await store.createTaskForAuthenticatedPrincipal({
    taskId: `task_${randomUUID()}`,
    contextId: `context_${randomUUID()}`,
    principal,
    input,
  });
  const access = await store.resolveTaskAccessContext({
    taskId: task.taskId,
    principalId: principal.principalId,
  });
  const working = await store.markTaskWorkingAuthorized({ task, access });
  return { working, access };
}

async function completeQueryTask(
  store: PostgresKnowledgeStore,
  principal: Principal,
  suffix: string,
): Promise<{ readonly task: StoredAgentTask; readonly result: KnowledgeAgentResult }> {
  const created = await store.createTaskForAuthenticatedPrincipal({
    taskId: `task_projection_${suffix}_${randomUUID()}`,
    contextId: `context_projection_${suffix}_${randomUUID()}`,
    principal,
    input: queryOperation(`projection ${suffix}`),
  });
  const working = await store.markTaskWorking(created.taskId, created.revision);
  const result: KnowledgeAgentResult = {
    schema: "openlifewiki.knowledge-query-result/v1",
    taskId: working.taskId,
    evidenceMode: "no-evidence",
    answer: `Projection result ${suffix}`,
    citations: [],
    gaps: [],
  };
  const task = await store.completeTask({
    taskId: working.taskId,
    expectedRevision: working.revision,
    output: result,
  });
  return { task, result };
}

async function projectionWriteSnapshot(database: Database, taskId: string) {
  return (await projectionWriteSnapshots(database, [taskId]))[0];
}

async function taskCursorTimestamps(database: Database, taskIds: readonly string[]) {
  return (await database.query<{ task_id: string; updated_at: string }>(
    `select task_id, updated_at::text as updated_at
     from agent_tasks where task_id = any($1::text[]) order by task_id`,
    [taskIds],
  )).rows;
}

async function projectionWriteSnapshots(database: Database, taskIds: readonly string[]) {
  return (await database.query<{
    task_id: string;
    row_version: string;
    projection_version: string;
    projection_state: string;
    a2a_task_json: string | null;
    updated_at: string;
  }>(
    `select task_id, xmin::text as row_version,
       a2a_projection_version::text as projection_version,
       a2a_projection_state as projection_state,
       a2a_task_json::text as a2a_task_json,
       updated_at::text as updated_at
     from agent_tasks where task_id = any($1::text[]) order by task_id`,
    [taskIds],
  )).rows;
}

async function startFixture(model: ScriptedModel, options: {
  readonly beforeCancellationSettlement?: () => Promise<void>;
  readonly afterHierarchyMutationCommit?: () => Promise<void>;
} = {}): Promise<Fixture> {
  const config = readServerConfig(testEnvironment());
  const server = await createA2AServer(config, { modelRuntime: runtime(model), ...options });
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
  await assertSafeTestDatabase(database);
  const suffix = randomUUID();
  const orgId = `org_a2a_${suffix}`;
  const owner = principal(`principal_owner_${suffix}`, orgId, "user", "owner", [
    "knowledge.query",
    "knowledge.register",
    "knowledge.store",
    "knowledge.share",
  ]);
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
      [`grant_${suffix}`, orgId, owner.principalId, [
        "knowledge.query",
        "knowledge.register",
        "knowledge.store",
        "knowledge.share",
      ]],
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

function supportedWriteOperations() {
  const content = {
    title: "Architecture",
    bodyMarkdown: "# Architecture",
    aliases: [],
    tags: ["architecture"],
  };
  return [
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.register",
      itemId: null,
      expectedRevision: null,
      title: "Architecture source",
      aliases: [],
      tags: ["architecture"],
      locations: [{
        kind: "github",
        role: "original",
        locator: "https://github.com/MetaInFlow/CoWikiHarness/blob/main/README.md",
        connectorInstanceId: null,
        ownerPrincipalId: "principal_owner",
        metadata: {},
      }],
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content,
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.preview-replace",
      itemId: "item_1",
      expectedRevision: 0,
      content,
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: "item_1",
      expectedRevision: 0,
      previewHash: `sha256:${"a".repeat(64)}`,
      content,
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.share",
      itemId: "item_1",
      targetPrincipalId: "principal_target",
      capabilities: ["knowledge.query"],
    },
  ] as const;
}

function hierarchyOperations() {
  return [
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.move",
      collectionId: "collection_1",
      expectedRevision: 0,
      parentCollectionId: null,
      name: "Architecture",
      description: "Architecture knowledge",
    },
    {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.place",
      itemId: "item_1",
      collectionId: "collection_1",
      expectedPlacementRevision: null,
    },
  ] as const;
}

function genericOrganizeOperation() {
  return {
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.organize",
    mode: "bootstrap",
    itemIds: ["item_1"],
    instruction: "organize",
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

function operationRequest(operation: unknown, taskId = ""): SendMessageRequest {
  const userMessage = message([{
    content: { $case: "data", value: operation },
    mediaType: "application/json",
  }]);
  userMessage.taskId = taskId;
  return {
    tenant: "",
    message: userMessage,
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
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

function artifact(artifactId: string, text: string) {
  return {
    artifactId,
    name: artifactId,
    description: "test artifact",
    parts: [{
      content: { $case: "text" as const, value: text },
      mediaType: "text/plain",
      filename: "",
      metadata: {},
    }],
    metadata: {},
    extensions: [],
  };
}

function responseText(value: Message | Task): string | undefined {
  const part = "id" in value ? value.status?.message?.parts[0] : value.parts[0];
  return part?.content?.$case === "text" ? part.content.value : undefined;
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for controlled cancellation state");
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

function agentMessages(events: readonly StreamResponse[]): string[] {
  return events.flatMap((event) => {
    if (event.payload?.$case !== "message") return [];
    const part = event.payload.value.parts[0];
    return part?.content?.$case === "text" ? [part.content.value] : [];
  });
}

function artifactResult(events: readonly StreamResponse[]) {
  return knowledgeQueryResultSchema.parse(artifactData(events));
}

function artifactData(events: readonly StreamResponse[]): unknown {
  const event = events.find((value) => value.payload?.$case === "artifactUpdate");
  if (event?.payload?.$case !== "artifactUpdate") throw new Error("Artifact event missing");
  const part = event.payload.value.artifact?.parts[0];
  if (part?.content?.$case !== "data") throw new Error("Artifact data missing");
  return part.content.value;
}

function taskArtifactData(task: Task): unknown {
  const artifact = task.artifacts?.find(({ artifactId }) => artifactId === `result:${task.id}`);
  const part = artifact?.parts[0];
  if (part?.content?.$case !== "data") throw new Error("Task result artifact data missing");
  return part.content.value;
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
  await assertSafeTestDatabase(database);
  await database.transaction(async (client) => {
    await client.query("delete from audit_events where org_id = $1", [orgId]);
    await client.query("delete from agent_tasks where org_id = $1", [orgId]);
    await client.query("delete from agent_sessions where org_id = $1", [orgId]);
    await client.query("delete from resource_grants where org_id = $1", [orgId]);
    await client.query("update knowledge_items set current_version_id = null where org_id = $1", [orgId]);
    await client.query("delete from knowledge_collection_items where org_id = $1", [orgId]);
    await client.query("delete from knowledge_versions where org_id = $1", [orgId]);
    await client.query("delete from knowledge_locations where org_id = $1", [orgId]);
    await client.query("delete from knowledge_tags where org_id = $1", [orgId]);
    await client.query("delete from tags where org_id = $1", [orgId]);
    await client.query("delete from knowledge_items where org_id = $1", [orgId]);
    await client.query("delete from knowledge_collections where org_id = $1", [orgId]);
    await client.query("delete from delegations where org_id = $1", [orgId]);
    await client.query("delete from principal_tokens where org_id = $1", [orgId]);
    await client.query("delete from principals where org_id = $1", [orgId]);
    await client.query("delete from organizations where org_id = $1", [orgId]);
  });
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = decodeURIComponent(new URL(value).pathname.replace(/^\//u, ""));
  if (databaseName !== "cowikiharness_test" && databaseName !== "openlifewiki_test") {
    throw new Error("A2A integration tests require cowikiharness_test or openlifewiki_test");
  }
}

async function assertSafeTestDatabase(database: Database): Promise<void> {
  const result = await database.query<{ name: string }>("select current_database() as name");
  const databaseName = result.rows[0]?.name;
  if (databaseName !== "cowikiharness_test" && databaseName !== "openlifewiki_test") {
    throw new Error("Refusing destructive A2A test against a non-test database");
  }
}
