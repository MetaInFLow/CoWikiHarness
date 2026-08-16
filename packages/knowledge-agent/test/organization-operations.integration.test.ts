import { randomUUID } from "node:crypto";

import { Runner } from "@openai/agents";
import { assistantMessage, ScriptedModel } from "@openai/agents/testing";
import type {
  CreateCollectionInput,
  KnowledgeHierarchyWritePort,
  MoveCollectionInput,
  PlaceKnowledgeInput,
} from "@openlifewiki/core";
import {
  AdapterError,
  createDatabase,
  PostgresKnowledgeHierarchyStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import {
  knowledgeCollectionResultSchema,
  knowledgePlacementResultSchema,
  type AccessContext,
  type KnowledgeCollection,
  type KnowledgeCollectionPlacement,
} from "@openlifewiki/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createKnowledgeAgent,
  KnowledgeOperationError,
  KnowledgeOrganizationOperations,
  type KnowledgeAgentContext,
  type KnowledgeToolOperations,
} from "../src/index.js";

describe("KnowledgeOrganizationOperations", () => {
  it("strictly parses collection creation and forwards the exact access context", async () => {
    const port = new FakeHierarchyPort();
    const operations = new KnowledgeOrganizationOperations(port);
    const context = accessContext("task_create");
    const input = {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    } as const;

    const result = await operations.createCollection(context, input);

    expect(knowledgeCollectionResultSchema.parse(result)).toEqual(result);
    expect(result.taskId).toBe(context.taskId);
    expect(port.createInputs).toHaveLength(1);
    expect(port.createInputs[0]?.context).toBe(context);
    expect(port.createInputs[0]).toMatchObject({
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    });

    await expect(operations.createCollection(context, {
      ...input,
      unexpected: true,
    } as never)).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect(port.createInputs).toHaveLength(1);
  });

  it("moves a collection with the exact access context", async () => {
    const port = new FakeHierarchyPort();
    const operations = new KnowledgeOrganizationOperations(port);
    const context = accessContext("task_move");

    const result = await operations.moveCollection(context, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.move",
      collectionId: "collection_projects",
      expectedRevision: 0,
      parentCollectionId: "collection_archive",
      name: "Archived projects",
      description: "Archived project knowledge",
    });

    expect(knowledgeCollectionResultSchema.parse(result)).toEqual(result);
    expect(result.taskId).toBe(context.taskId);
    expect(port.moveInputs).toHaveLength(1);
    expect(port.moveInputs[0]?.context).toBe(context);
    expect(port.moveInputs[0]).toMatchObject({
      collectionId: "collection_projects",
      expectedRevision: 0,
      parentCollectionId: "collection_archive",
      name: "Archived projects",
      description: "Archived project knowledge",
    });
  });

  it("places knowledge with the exact access context", async () => {
    const port = new FakeHierarchyPort();
    const operations = new KnowledgeOrganizationOperations(port);
    const context = accessContext("task_place");

    const result = await operations.placeKnowledge(context, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.place",
      itemId: "item_architecture",
      collectionId: "collection_projects",
      expectedPlacementRevision: null,
    });

    expect(knowledgePlacementResultSchema.parse(result)).toEqual(result);
    expect(result.taskId).toBe(context.taskId);
    expect(port.placeInputs).toHaveLength(1);
    expect(port.placeInputs[0]?.context).toBe(context);
    expect(port.placeInputs[0]).toMatchObject({
      itemId: "item_architecture",
      collectionId: "collection_projects",
      expectedPlacementRevision: null,
    });
  });

  it("preserves stable knowledge adapter errors", async () => {
    const port = new FakeHierarchyPort();
    port.createError = new AdapterError("REVISION_CONFLICT", "changed");
    const operations = new KnowledgeOrganizationOperations(port);

    await expect(operations.createCollection(accessContext("task_conflict"), {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("maps unknown adapter and non-adapter failures to INVALID_OPERATION", async () => {
    const context = accessContext("task_invalid");
    const input = {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    } as const;
    for (const error of [
      new AdapterError("COMMAND_FAILED", "internal"),
      new KnowledgeOperationError("REVISION_CONFLICT"),
      new Error("internal"),
    ]) {
      const port = new FakeHierarchyPort();
      port.createError = error;
      await expect(new KnowledgeOrganizationOperations(port).createCollection(context, input))
        .rejects.toMatchObject({ code: "INVALID_OPERATION" });
    }
  });
});

describe("knowledge organization result binding", () => {
  it("accepts only the matching hierarchy result schema for each concrete operation", async () => {
    const cases = [
      {
        taskId: "task_result_create",
        operation: {
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.collection.create",
          expectedRegistryRevision: 0,
          parentCollectionId: null,
          name: "Projects",
          description: "Project knowledge",
        },
        result: {
          schema: "cowikiharness.collection-result/v1",
          taskId: "task_result_create",
          collection: collection({
            collectionId: "collection_create",
            parentCollectionId: null,
            name: "Projects",
            description: "Project knowledge",
            revision: 0,
          }),
        },
      },
      {
        taskId: "task_result_move",
        operation: {
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.collection.move",
          collectionId: "collection_move",
          expectedRevision: 0,
          parentCollectionId: null,
          name: "Moved",
          description: "Moved knowledge",
        },
        result: {
          schema: "cowikiharness.collection-result/v1",
          taskId: "task_result_move",
          collection: collection({
            collectionId: "collection_move",
            parentCollectionId: null,
            name: "Moved",
            description: "Moved knowledge",
            revision: 1,
          }),
        },
      },
      {
        taskId: "task_result_place",
        operation: {
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.place",
          itemId: "item_place",
          collectionId: "collection_place",
          expectedPlacementRevision: null,
        },
        result: {
          schema: "cowikiharness.placement-result/v1",
          taskId: "task_result_place",
          placement: {
            schema: "cowikiharness.collection-placement/v1",
            orgId: "org_test",
            itemId: "item_place",
            collectionId: "collection_place",
            placedByPrincipalId: "principal_owner",
            revision: 0,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const context: KnowledgeAgentContext = {
        access: accessContext(testCase.taskId),
        operation: testCase.operation,
        taskId: testCase.taskId,
        retrievedCitations: [],
      };
      const model = new ScriptedModel([
        [assistantMessage(JSON.stringify(testCase.result))],
      ]);
      const outcome = await new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false }).run(
        createKnowledgeAgent({ model, operations: unusedToolOperations() }),
        "return the structured result",
        { context, maxTurns: 1 },
      );

      expect(outcome.finalOutput).toEqual(testCase.result);
    }
  });
});

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe.sequential : describe.skip;

describePostgres("KnowledgeOrganizationOperations PostgreSQL results", () => {
  let database: Database;
  let orgId: string;
  let principalId: string;
  let itemId: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
    await runMigrations(database, { migrationsDir: "../adapters/migrations" });
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    orgId = `org_organization_operations_${suffix}`;
    principalId = `principal_organization_operations_${suffix}`;
    itemId = `item_organization_operations_${suffix}`;
    await database.transaction(async (client) => {
      await client.query(
        "insert into organizations(org_id, name) values ($1, 'Organization operations test')",
        [orgId],
      );
      await client.query(
        `insert into principals(
           principal_id, org_id, principal_type, display_name,
           organization_role, capabilities, status
         ) values ($1, $2, 'user', 'Owner', 'owner', '{knowledge.organize}', 'active')`,
        [principalId, orgId],
      );
      await client.query(
        `insert into resource_grants(
           grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
         ) values ($1, $2, $3, 'organization', $2, '{knowledge.organize}')`,
        [`grant_organization_operations_${suffix}`, orgId, principalId],
      );
      await client.query(
        `insert into knowledge_items(
           item_id, org_id, owner_principal_id, title, aliases, status
         ) values ($1, $2, $3, 'Architecture', '{}', 'stable')`,
        [itemId, orgId, principalId],
      );
    });
  });

  afterEach(async () => {
    if (orgId === undefined) return;
    await database.transaction(async (client) => {
      await client.query("delete from audit_events where org_id = $1", [orgId]);
      await client.query("delete from knowledge_collection_items where org_id = $1", [orgId]);
      await client.query("delete from knowledge_items where org_id = $1", [orgId]);
      await client.query("delete from knowledge_collections where org_id = $1", [orgId]);
      await client.query("delete from resource_grants where org_id = $1", [orgId]);
      await client.query("delete from principals where org_id = $1", [orgId]);
      await client.query("delete from organizations where org_id = $1", [orgId]);
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  it("returns validated create, move, and placement schemas with their task ids", async () => {
    const operations = new KnowledgeOrganizationOperations(
      new PostgresKnowledgeHierarchyStore(database),
    );
    const createContext = databaseAccessContext("task_pg_create");
    const created = await operations.createCollection(createContext, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 0,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    });
    expect(knowledgeCollectionResultSchema.parse(created)).toEqual(created);
    expect(created.taskId).toBe(createContext.taskId);

    const moveContext = databaseAccessContext("task_pg_move");
    const moved = await operations.moveCollection(moveContext, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.move",
      collectionId: created.collection.collectionId,
      expectedRevision: created.collection.revision,
      parentCollectionId: null,
      name: "Active projects",
      description: "Active project knowledge",
    });
    expect(knowledgeCollectionResultSchema.parse(moved)).toEqual(moved);
    expect(moved.taskId).toBe(moveContext.taskId);

    const placeContext = databaseAccessContext("task_pg_place");
    const placed = await operations.placeKnowledge(placeContext, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.place",
      itemId,
      collectionId: moved.collection.collectionId,
      expectedPlacementRevision: null,
    });
    expect(knowledgePlacementResultSchema.parse(placed)).toEqual(placed);
    expect(placed.taskId).toBe(placeContext.taskId);
  });

  function databaseAccessContext(taskPrefix: string): AccessContext {
    return {
      schema: "openlifewiki.access-context/v1",
      orgId,
      actorPrincipalId: principalId,
      actorAgentId: null,
      onBehalfOfUserId: principalId,
      delegationId: null,
      taskId: `${taskPrefix}_${randomUUID()}`,
    };
  }
});

class FakeHierarchyPort implements KnowledgeHierarchyWritePort {
  readonly createInputs: CreateCollectionInput[] = [];
  readonly moveInputs: MoveCollectionInput[] = [];
  readonly placeInputs: PlaceKnowledgeInput[] = [];
  createError: unknown;

  async createCollection(input: CreateCollectionInput): Promise<KnowledgeCollection> {
    if (this.createError !== undefined) throw this.createError;
    this.createInputs.push(input);
    return collection({
      collectionId: "collection_projects",
      parentCollectionId: input.parentCollectionId,
      name: input.name,
      description: input.description,
      revision: 0,
    });
  }

  async moveCollection(input: MoveCollectionInput): Promise<KnowledgeCollection> {
    this.moveInputs.push(input);
    return collection({
      collectionId: input.collectionId,
      parentCollectionId: input.parentCollectionId,
      name: input.name,
      description: input.description,
      revision: input.expectedRevision + 1,
    });
  }

  async placeKnowledge(input: PlaceKnowledgeInput): Promise<KnowledgeCollectionPlacement> {
    this.placeInputs.push(input);
    return {
      schema: "cowikiharness.collection-placement/v1",
      orgId: input.context.orgId,
      itemId: input.itemId,
      collectionId: input.collectionId,
      placedByPrincipalId: input.context.actorPrincipalId,
      revision: input.expectedPlacementRevision === null ? 0 : input.expectedPlacementRevision + 1,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
  }

  async getCollection(_orgId: string, _collectionId: string): Promise<KnowledgeCollection | null> {
    return null;
  }

  async getPlacement(_orgId: string, _itemId: string): Promise<KnowledgeCollectionPlacement | null> {
    return null;
  }
}

function accessContext(taskId: string): AccessContext {
  return {
    schema: "openlifewiki.access-context/v1",
    orgId: "org_test",
    actorPrincipalId: "principal_owner",
    actorAgentId: null,
    onBehalfOfUserId: "principal_owner",
    delegationId: null,
    taskId,
  };
}

function collection(input: {
  readonly collectionId: string;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
}): KnowledgeCollection {
  return {
    schema: "cowikiharness.collection/v1",
    collectionId: input.collectionId,
    orgId: "org_test",
    parentCollectionId: input.parentCollectionId,
    name: input.name,
    description: input.description,
    revision: input.revision,
    createdByPrincipalId: "principal_owner",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (value === undefined) throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL or DATABASE_URL is required");
  const databaseName = decodeURIComponent(new URL(value).pathname.replace(/^\//u, ""));
  if (databaseName !== "cowikiharness_test" && databaseName !== "openlifewiki_test") {
    throw new Error("Organization operations integration tests require an isolated test database");
  }
  return value;
}

function unusedToolOperations(): KnowledgeToolOperations {
  const unexpected = (): never => { throw new Error("Unexpected model tool call"); };
  return {
    async query() { return unexpected(); },
    async get() { return unexpected(); },
    async register() { return unexpected(); },
    async storeManaged() { return unexpected(); },
    async previewManagedReplacement() { return unexpected(); },
    async applyManagedReplacement() { return unexpected(); },
    async share() { return unexpected(); },
    async listLocations() { return unexpected(); },
  };
}
