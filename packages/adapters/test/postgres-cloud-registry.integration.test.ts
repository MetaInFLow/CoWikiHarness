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
    const database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
    await runMigrations(database, { migrationsDir: "migrations" });
    await runMigrations(database, { migrationsDir: "migrations" });
    const result = await database.query<{ count: string }>(
      "select count(*)::text as count from openlifewiki_schema_migrations",
    );
    expect(result.rows[0]?.count).toBe("1");
    await database.close();
  });

  it("keeps token material private and enforces registry authorization", async () => {
    const database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
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
    await database.close();
  });
});

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  return value;
}
