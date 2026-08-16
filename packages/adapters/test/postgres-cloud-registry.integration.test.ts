import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createDatabase,
  PostgresKnowledgeStore,
  runMigrations,
} from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("PostgreSQL cloud registry", () => {
  it("applies ordered migrations idempotently", async () => {
    const isolated = await createIsolatedTestDatabase();
    try {
      await runMigrations(isolated.database, { migrationsDir: "migrations" });
      await runMigrations(isolated.database, { migrationsDir: "migrations" });
      const result = await isolated.database.query<{ name: string }>(
        "select name from openlifewiki_schema_migrations order by name",
      );
      expect(result.rows).toEqual([
        { name: "0001_cloud_registry.sql" },
        { name: "0002_knowledge_collections.sql" },
        { name: "0003_a2a_task_projection.sql" },
      ]);
      const columns = await isolated.database.query<{
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }>(
        `select column_name, column_default, is_nullable
         from information_schema.columns
         where table_schema = current_schema() and table_name = 'agent_tasks'
           and column_name like 'a2a_projection_%'
         order by column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: "a2a_projection_error_code", column_default: null, is_nullable: "YES" },
        { column_name: "a2a_projection_state", column_default: "'pending'::text", is_nullable: "NO" },
        { column_name: "a2a_projection_version", column_default: "0", is_nullable: "NO" },
      ]);
    } finally {
      await isolated.cleanup();
    }
  });

  it("keeps token material private and enforces registry authorization", async () => {
    const isolated = await createIsolatedTestDatabase();
    const { database } = isolated;
    try {
      await runMigrations(database, { migrationsDir: "migrations" });
      const store = new PostgresKnowledgeStore(database, "test-token-secret-with-at-least-32-bytes");
      const bootstrap = await store.bootstrap({
        organizationName: "CoWikiHarness Test",
        ownerDisplayName: "Owner",
        agentDisplayName: "Agent",
        delegationExpiresAt: "2099-08-16T00:00:00.000Z",
      });
      expect(bootstrap.ownerToken).toHaveLength(43);
      expect(await store.authenticate(bootstrap.ownerToken, new Date("2026-08-15T00:00:00.000Z")))
        .toMatchObject({ principalId: bootstrap.ownerPrincipalId });
      expect(await store.authenticate("invalid-token", new Date("2026-08-15T00:00:00.000Z"))).toBeNull();

      const owner = await store.resolveAccessContext({
        token: bootstrap.ownerToken,
        taskId: "task_owner",
        now: new Date("2026-08-15T00:00:00.000Z"),
      });
      const managed = await store.createManagedKnowledge({
        context: owner.context,
        content: { title: "Shared decision", bodyMarkdown: "# Decision", aliases: [], tags: ["shared"] },
      });
      expect((await store.searchAuthorized({ context: owner.context, query: "Decision", limit: 10 }))).toHaveLength(1);
      expect(await store.getAuthorized({
        context: owner.context,
        itemId: managed.item.itemId,
        locationId: managed.location.locationId,
        versionId: managed.version.versionId,
      })).toMatchObject({ bodyMarkdown: "# Decision" });

      const agent = await store.resolveAccessContext({
        token: bootstrap.agentToken,
        taskId: "task_agent",
        now: new Date("2026-08-15T00:00:00.000Z"),
      });
      expect(await store.searchAuthorized({ context: agent.context, query: "Decision", limit: 10 })).toHaveLength(1);
      expect(await store.getAuthorized({
        context: agent.context,
        itemId: managed.item.itemId,
        locationId: managed.location.locationId,
        versionId: managed.version.versionId,
      })).toMatchObject({ bodyMarkdown: "# Decision" });

      const member = await store.createMember({ ownerContext: owner.context, displayName: "Member" });
      const memberAccess = await store.resolveAccessContext({
        token: member.token,
        taskId: "task_member",
        now: new Date("2026-08-15T00:00:00.000Z"),
      });
      expect(await store.searchAuthorized({ context: memberAccess.context, query: "Decision", limit: 10 })).toHaveLength(0);
      await store.shareItem({
        context: owner.context,
        itemId: managed.item.itemId,
        targetPrincipalId: member.principal.principalId,
        capabilities: ["knowledge.query"],
      });
      expect(await store.searchAuthorized({ context: memberAccess.context, query: "Decision", limit: 10 })).toHaveLength(1);

      await database.query(
        `insert into connector_instances(
          connector_instance_id, org_id, connector_type, display_name, status
        ) values ($1, $2, 'github', 'GitHub', 'active')`,
        ["connector_github", bootstrap.orgId],
      );
      const external = await store.registerLocations({
        context: owner.context,
        itemId: null,
        expectedRevision: null,
        title: "External decision",
        aliases: [],
        tags: [],
        locations: [{
          kind: "github",
          role: "original",
          locator: "https://github.com/org/repo/blob/main/decision.md",
          connectorInstanceId: "connector_github",
          ownerPrincipalId: bootstrap.ownerPrincipalId,
          metadata: {},
        }],
      });
      const body = await database.query<{ body_markdown: string | null }>(
        "select body_markdown from knowledge_versions where item_id = $1",
        [external.item.itemId],
      );
      expect(body.rows).toEqual([]);

      const duplicate = await store.registerLocations({
        context: owner.context,
        itemId: null,
        expectedRevision: null,
        title: "External decision",
        aliases: [],
        tags: [],
        locations: [{
          kind: "github",
          role: "original",
          locator: "https://github.com/org/repo/blob/main/decision.md",
          connectorInstanceId: "connector_github",
          ownerPrincipalId: bootstrap.ownerPrincipalId,
          metadata: {},
        }],
      });
      expect(duplicate.item.itemId).toBe(external.item.itemId);
      expect(duplicate.locations).toHaveLength(1);
      await expect(store.bootstrap({
        organizationName: "Second organization",
        ownerDisplayName: "Second owner",
        agentDisplayName: "Second agent",
        delegationExpiresAt: "2099-08-16T00:00:00.000Z",
      })).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
    } finally {
      await isolated.cleanup();
    }
  });

  it("tracks completed task A2A projection state with product and A2A revision CAS", async () => {
    const isolated = await createIsolatedTestDatabase();
    const { database } = isolated;
    try {
      await runMigrations(database, { migrationsDir: "migrations" });
      const store = new PostgresKnowledgeStore(database, "test-token-secret-with-at-least-32-bytes");
      const bootstrap = await store.bootstrap({
        organizationName: "Projection state test",
        ownerDisplayName: "Owner",
        agentDisplayName: "Agent",
        delegationExpiresAt: "2099-08-16T00:00:00.000Z",
      });
      const owner = await store.authenticate(bootstrap.ownerToken, new Date("2026-08-17T00:00:00.000Z"));
      if (owner === null) throw new Error("Projection test owner missing");
      const created = await store.createTaskForAuthenticatedPrincipal({
        taskId: `task_projection_${randomUUID()}`,
        contextId: `context_projection_${randomUUID()}`,
        principal: owner,
        input: {
          schema: "openlifewiki.operation/v1",
          kind: "knowledge.query",
          query: "projection state",
          limit: 10,
          allowPartial: true,
        },
      });
      const working = await store.markTaskWorking(created.taskId, created.revision);
      const completed = await store.completeTask({
        taskId: working.taskId,
        expectedRevision: working.revision,
        output: {
          schema: "openlifewiki.knowledge-query-result/v1",
          taskId: working.taskId,
          evidenceMode: "no-evidence",
          answer: "No evidence.",
          citations: [],
          gaps: [],
        },
      });
      expect((await database.query<{
        a2a_projection_state: string;
        a2a_projection_version: string;
        a2a_projection_error_code: string | null;
      }>(
        `select a2a_projection_state, a2a_projection_version::text, a2a_projection_error_code
         from agent_tasks where task_id = $1`,
        [completed.taskId],
      )).rows).toEqual([{
        a2a_projection_state: "pending",
        a2a_projection_version: "1",
        a2a_projection_error_code: null,
      }]);

      const pending = await store.listPendingCompletedA2AProjections({
        afterCreatedAt: null,
        afterTaskId: null,
        limit: 8,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        task: { taskId: completed.taskId, revision: completed.revision },
        a2aTaskJson: null,
        a2aTaskJsonValid: true,
        projectionVersion: 1,
      });
      expect(await store.loadAuthorizedPendingCompletedA2AProjection({
        taskId: completed.taskId,
        principalId: owner.principalId,
      })).toMatchObject({ task: { taskId: completed.taskId } });
      expect(await store.loadAuthorizedPendingCompletedA2AProjection({
        taskId: completed.taskId,
        principalId: bootstrap.agentPrincipalId,
      })).toBeNull();
      await expect(store.saveA2ATask({
        taskId: completed.taskId,
        principalId: owner.principalId,
        expectedA2ARevision: null,
        taskJson: {
          id: completed.taskId,
          contextId: completed.contextId,
          status: { state: 3, timestamp: "2026-08-17T00:00:00.000Z" },
          artifacts: [],
          history: [{ parts: [{ content: { $case: "text", value: { invalid: true } } }] }],
          metadata: {},
        },
      })).rejects.toMatchObject({
        code: "INVALID_OPERATION",
        name: "A2AProjectionValidationError",
      });
      const saved = await store.saveA2ATask({
        taskId: completed.taskId,
        principalId: owner.principalId,
        expectedA2ARevision: null,
        taskJson: {
          id: completed.taskId,
          contextId: completed.contextId,
          status: { state: 3, timestamp: "2026-08-17T00:00:00.000Z" },
          artifacts: [],
          history: [],
          metadata: {},
        },
      });
      expect(saved).toMatchObject({
        a2aRevision: 0,
        task: { taskId: completed.taskId, revision: completed.revision },
        projectionState: "pending",
        projectionVersion: 2,
      });
      const concurrentlySaved = await store.saveA2ATask({
        taskId: completed.taskId,
        principalId: owner.principalId,
        expectedA2ARevision: saved.a2aRevision,
        taskJson: saved.taskJson,
      });
      const fixedCursorTimestamp = "2026-08-01T00:00:00.000Z";
      await database.query(
        "update agent_tasks set updated_at = $1 where task_id = $2",
        [fixedCursorTimestamp, completed.taskId],
      );
      const beforeCompletedMarker = await store.listA2ATasks({
        principalId: owner.principalId,
        contextId: null,
        status: null,
        statusTimestampAfter: null,
        afterUpdatedAt: null,
        afterTaskId: null,
        limit: 10,
      });
      await expect(store.markA2AProjectionComplete({
        taskId: completed.taskId,
        expectedTaskRevision: completed.revision,
        expectedProjectionVersion: saved.projectionVersion,
        expectedA2ARevision: saved.a2aRevision,
      })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      await store.markA2AProjectionComplete({
        taskId: completed.taskId,
        expectedTaskRevision: completed.revision,
        expectedProjectionVersion: concurrentlySaved.projectionVersion,
        expectedA2ARevision: concurrentlySaved.a2aRevision,
      });
      expect(await store.listA2ATasks({
        principalId: owner.principalId,
        contextId: null,
        status: null,
        statusTimestampAfter: null,
        afterUpdatedAt: null,
        afterTaskId: null,
        limit: 10,
      })).toEqual(beforeCompletedMarker);
      expect((await database.query<{
        a2a_projection_state: string;
        a2a_projection_version: string;
      }>(
        `select a2a_projection_state, a2a_projection_version::text
         from agent_tasks where task_id = $1`,
        [completed.taskId],
      )).rows).toEqual([{ a2a_projection_state: "completed", a2a_projection_version: "4" }]);
      const reopened = await store.saveA2ATask({
        taskId: completed.taskId,
        principalId: owner.principalId,
        expectedA2ARevision: concurrentlySaved.a2aRevision,
        taskJson: concurrentlySaved.taskJson,
      });
      expect(reopened).toMatchObject({
        a2aRevision: 2,
        projectionState: "pending",
        projectionVersion: 5,
      });
      await database.query(
        "update agent_tasks set updated_at = $1 where task_id = $2",
        [fixedCursorTimestamp, completed.taskId],
      );
      const beforeFailedMarker = await store.listA2ATasks({
        principalId: owner.principalId,
        contextId: null,
        status: null,
        statusTimestampAfter: null,
        afterUpdatedAt: null,
        afterTaskId: null,
        limit: 10,
      });
      await store.markA2AProjectionFailed({
        taskId: completed.taskId,
        expectedTaskRevision: completed.revision,
        expectedProjectionVersion: reopened.projectionVersion,
      });
      expect(await store.listA2ATasks({
        principalId: owner.principalId,
        contextId: null,
        status: null,
        statusTimestampAfter: null,
        afterUpdatedAt: null,
        afterTaskId: null,
        limit: 10,
      })).toEqual(beforeFailedMarker);
      expect(await store.listPendingCompletedA2AProjections({
        afterCreatedAt: null,
        afterTaskId: null,
        limit: 8,
      })).toEqual([]);
    } finally {
      await isolated.cleanup();
    }
  });
});

async function createIsolatedTestDatabase() {
  const connectionString = requiredTestDatabaseUrl();
  const adminDatabase = createDatabase({ connectionString });
  const schema = `openlifewiki_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await adminDatabase.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", ["openlifewiki:migrations"]);
      await client.query("create extension if not exists pg_trgm with schema public");
    });
    await adminDatabase.query(`create schema ${schema}`);
  } catch (error) {
    await adminDatabase.close();
    throw error;
  }

  const isolatedUrl = new URL(connectionString);
  isolatedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
  const database = createDatabase({ connectionString: isolatedUrl.toString() });

  return {
    database,
    async cleanup(): Promise<void> {
      await database.close();
      try {
        await adminDatabase.query(`drop schema ${schema} cascade`);
      } finally {
        await adminDatabase.close();
      }
    },
  };
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  return value;
}
