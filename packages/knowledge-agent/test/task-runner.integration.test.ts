import { randomUUID } from "node:crypto";

import {
  createDatabase,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import type { AgentInputItem } from "@openai/agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresAgentSession } from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("knowledge task runner PostgreSQL integration", () => {
  let database: Database;
  let store: PostgresKnowledgeStore;
  let orgId: string;
  let otherOrgId: string;
  let ownerPrincipalId: string;
  let otherOwnerPrincipalId: string;

  beforeEach(async () => {
    const connectionString = requiredTestDatabaseUrl();
    database = createDatabase({ connectionString });
    const databaseName = await database.query<{ name: string }>(
      "select current_database() as name",
    );
    expect(databaseName.rows[0]?.name).toBe("cowikiharness_test");
    await runMigrations(database, { migrationsDir: "../adapters/migrations" });

    const suffix = randomUUID();
    orgId = `org_session_${suffix}`;
    otherOrgId = `org_session_other_${suffix}`;
    ownerPrincipalId = `principal_owner_${suffix}`;
    otherOwnerPrincipalId = `principal_other_${suffix}`;
    await database.transaction(async (client) => {
      await client.query(
        "insert into organizations(org_id, name) values ($1, $2), ($3, $4)",
        [orgId, "Session test", otherOrgId, "Other session test"],
      );
      await client.query(
        `insert into principals(
          principal_id, org_id, principal_type, display_name,
          organization_role, capabilities, status
        ) values
          ($1, $2, 'user', 'Owner', 'owner', $5, 'active'),
          ($3, $4, 'user', 'Other owner', 'owner', $5, 'active')`,
        [ownerPrincipalId, orgId, otherOwnerPrincipalId, otherOrgId, ["knowledge.query"]],
      );
    });
    store = new PostgresKnowledgeStore(
      database,
      "test-token-secret-with-at-least-32-bytes",
    );
  });

  afterEach(async () => {
    if (database === undefined) return;
    try {
      await database.transaction(async (client) => {
        await client.query(
          "delete from agent_sessions where org_id = any($1::text[])",
          [[orgId, otherOrgId]],
        );
        await client.query(
          "delete from principals where org_id = any($1::text[])",
          [[orgId, otherOrgId]],
        );
        await client.query(
          "delete from organizations where org_id = any($1::text[])",
          [[orgId, otherOrgId]],
        );
      });
    } finally {
      await database.close();
    }
  });

  it("fails closed when a session is opened by another owner or organization", async () => {
    const sessionId = `context_${randomUUID()}`;
    const session = new PostgresAgentSession(
      store,
      sessionId,
      orgId,
      ownerPrincipalId,
    );
    await expect(session.getSessionId()).resolves.toBe(sessionId);

    const otherOwner = new PostgresAgentSession(
      store,
      sessionId,
      otherOrgId,
      otherOwnerPrincipalId,
    );
    await expect(otherOwner.getSessionId()).rejects.toMatchObject({
      code: "DELEGATION_DENIED",
    });

    const otherOrganization = new PostgresAgentSession(
      store,
      sessionId,
      otherOrgId,
      ownerPrincipalId,
    );
    await expect(otherOrganization.getSessionId()).rejects.toMatchObject({
      code: "DELEGATION_DENIED",
    });

    const wrongScope = {
      sessionId,
      orgId: otherOrgId,
      ownerPrincipalId,
    };
    await expect(store.readAgentSession(wrongScope)).rejects.toMatchObject({
      code: "DELEGATION_DENIED",
    });
    await expect(store.appendAgentSession({ ...wrongScope, items: [message("denied")] }))
      .rejects.toMatchObject({ code: "DELEGATION_DENIED" });
    await expect(store.popAgentSession(wrongScope)).rejects.toMatchObject({
      code: "DELEGATION_DENIED",
    });
    await expect(store.clearAgentSession(wrongScope)).rejects.toMatchObject({
      code: "DELEGATION_DENIED",
    });
  });

  it("atomically appends, pops, limits and clears durable history", async () => {
    const session = new PostgresAgentSession(
      store,
      `context_${randomUUID()}`,
      orgId,
      ownerPrincipalId,
    );
    await session.getSessionId();

    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      await session.addItems([
        message(`batch-${index}-first`),
        message(`batch-${index}-second`),
      ]);
    }));

    const items = await session.getItems();
    expect(items).toHaveLength(24);
    expect(new Set(items.map(messageText))).toEqual(new Set(
      Array.from({ length: 12 }, (_, index) => [
        `batch-${index}-first`,
        `batch-${index}-second`,
      ]).flat(),
    ));
    for (let index = 0; index < 12; index += 1) {
      const first = items.findIndex((item) => messageText(item) === `batch-${index}-first`);
      expect(messageText(items[first + 1])).toBe(`batch-${index}-second`);
    }
    expect(await session.getItems(3)).toEqual(items.slice(-3));

    const popped = await Promise.all([
      session.popItem(),
      session.popItem(),
      session.popItem(),
    ]);
    expect(new Set(
      popped.map((item) => item === undefined ? undefined : messageText(item)).filter(Boolean),
    ).size).toBe(3);
    expect(await session.getItems()).toHaveLength(21);

    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
  });

  it("returns no items for limit zero and rejects invalid limits", async () => {
    const session = new PostgresAgentSession(
      store,
      `context_${randomUUID()}`,
      orgId,
      ownerPrincipalId,
    );
    await session.getSessionId();

    await expect(session.getItems(0)).resolves.toEqual([]);
    await expect(session.getItems(-1)).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    await expect(session.getItems(1.5)).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it.each([
    "apiKey",
    "api_key",
    "api-key",
    "Authorization",
    "accessToken",
    "credential",
    "password",
  ])("rejects nested sensitive key %s without a partial history write", async (sensitiveKey) => {
    const session = new PostgresAgentSession(
      store,
      `context_${randomUUID()}`,
      orgId,
      ownerPrincipalId,
    );
    await session.getSessionId();
    await session.addItems([message("existing")]);
    const sensitive = {
      ...message("sensitive"),
      providerData: { nested: [{ [sensitiveKey]: "must-not-persist" }] },
    } as unknown as AgentInputItem;

    await expect(session.addItems([message("partial"), sensitive])).rejects.toMatchObject({
      code: "INVALID_OPERATION",
    });
    expect((await session.getItems()).map(messageText)).toEqual(["existing"]);
  });

  it("rejects a sensitive key introduced by toJSON without changing history", async () => {
    const session = new PostgresAgentSession(
      store,
      `context_${randomUUID()}`,
      orgId,
      ownerPrincipalId,
    );
    await session.getSessionId();
    await session.addItems([message("existing")]);
    const sensitive = {
      ...message("sensitive"),
      providerData: {
        toJSON() {
          return { nested: { accessToken: "must-not-persist" } };
        },
      },
    } as unknown as AgentInputItem;

    await expect(session.addItems([message("partial"), sensitive])).rejects.toMatchObject({
      code: "INVALID_OPERATION",
    });
    expect((await session.getItems()).map(messageText)).toEqual(["existing"]);
  });
});

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  const databaseName = new URL(value).pathname.slice(1);
  if (databaseName !== "cowikiharness_test") {
    throw new Error(`Refusing to use non-test PostgreSQL database: ${databaseName}`);
  }
  return value;
}

function message(text: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function messageText(item: AgentInputItem | undefined): string | undefined {
  if (item?.type !== "message" || typeof item.content === "string") return undefined;
  const content = item.content[0];
  return content !== undefined && "text" in content ? content.text : undefined;
}
