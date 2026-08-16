import { createHash, randomUUID } from "node:crypto";

import type { Model } from "@openai/agents";
import {
  digestToken,
  type Database,
} from "@openlifewiki/adapters";
import {
  knowledgeGraphResponseSchema,
  type KnowledgeGraphResponse,
} from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import { createA2AServer } from "../src/a2a-server.js";
import { readServerConfig } from "../src/config.js";
import type { GraphRequestLog } from "../src/graph-route.js";
import type { KnowledgeModelRuntime } from "../src/model-runtime.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;
const NOW = new Date("2026-08-17T04:00:00.000Z");

describePostgres("graph REST API PostgreSQL permission journey", () => {
  it("serves only the authorized graph without model or task side effects", async () => {
    const config = readServerConfig(testEnvironment());
    let modelCallCount = 0;
    const model: Model = {
      async getResponse() {
        modelCallCount += 1;
        throw new Error("Graph HTTP must never call the model runtime");
      },
      async *getStreamedResponse() {
        modelCallCount += 1;
        throw new Error("Graph HTTP must never call the model runtime");
      },
    };
    const graphLogs: GraphRequestLog[] = [];
    const runtime: KnowledgeModelRuntime = { model, modelSettings: {}, async close() {} };
    const server = await createA2AServer(config, {
      modelRuntime: runtime,
      now: () => NOW,
      graphLogger: (entry) => graphLogs.push(entry),
    });
    const fixture = await seedGraphFixture(server.database, config.tokenHmacSecret);
    const binding = await server.start();
    let graphRequestCount = 0;
    const graphFetch = async (path: string, init?: RequestInit): Promise<Response> => {
      graphRequestCount += 1;
      return await fetch(`${binding.url}${path}`, init);
    };

    try {
      const taskCountBefore = await agentTaskCount(server.database, fixture.orgId);

      const invalidLogStart = graphLogs.length;
      const invalidToken = `invalid-token-${fixture.suffix}`;
      const invalidAuthentication = await graphFetch("/api/v1/graph", {
        headers: bearer(invalidToken),
      });
      expect(invalidAuthentication.status).toBe(401);
      expect(await invalidAuthentication.json()).toMatchObject({ error: "unauthorized" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(graphLogs.slice(invalidLogStart)).toEqual([
        expect.objectContaining({ status: 401, errorCode: null }),
      ]);

      const infrastructureDetail =
        `select principal_tokens /Users/private/${fixture.suffix} token-prefix locator`;
      const infrastructureLogStart = graphLogs.length;
      const originalAuthenticate = server.store.authenticate;
      server.store.authenticate = async () => { throw new Error(infrastructureDetail); };
      let infrastructureAuthentication: Response;
      try {
        infrastructureAuthentication = await graphFetch("/api/v1/graph", {
          headers: bearer(fixture.tokens.owner),
        });
      } finally {
        server.store.authenticate = originalAuthenticate;
      }
      const infrastructureBody = await infrastructureAuthentication.text();
      expect(infrastructureAuthentication.status).toBe(503);
      expect(infrastructureAuthentication.headers.get("x-request-id")).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(JSON.parse(infrastructureBody)).toEqual({
        error: {
          code: "GRAPH_UNAVAILABLE",
          message: "The knowledge graph is temporarily unavailable.",
          requestId: infrastructureAuthentication.headers.get("x-request-id"),
        },
      });
      expect(infrastructureAuthentication.headers.get("cache-control")).toBe(
        "private, max-age=0, must-revalidate",
      );
      expect(varyValues(infrastructureAuthentication)).toEqual(["Authorization", "Origin"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const infrastructureLogs = graphLogs.slice(infrastructureLogStart);
      expect(infrastructureLogs).toEqual([
        expect.objectContaining({ status: 503, errorCode: "GRAPH_UNAVAILABLE" }),
      ]);
      for (const secret of [infrastructureDetail, invalidToken, fixture.tokens.owner]) {
        expect(infrastructureBody).not.toContain(secret);
        expect(JSON.stringify(infrastructureLogs)).not.toContain(secret);
      }

      const ownerResponse = await graphFetch(
        "/api/v1/graph?include=tags%2Clocations%2Cversions%2Cprincipals%2Cconnectors",
        { headers: bearer(fixture.tokens.owner) },
      );
      expect(ownerResponse.status).toBe(200);
      expect(ownerResponse.headers.get("content-type")).toMatch(/^application\/json\b/u);
      const ownerGraph = knowledgeGraphResponseSchema.parse(await ownerResponse.json());
      expect(ownerGraph.elements.nodes.some(
        (node) => node.data.id === `item:${fixture.ids.sharedItem}`,
      )).toBe(true);

      const memberResponse = await graphFetch(
        "/api/v1/graph?include=connectors%2Cprincipals%2Cversions%2Clocations%2Ctags",
        { headers: bearer(fixture.tokens.member) },
      );
      expect(memberResponse.status).toBe(200);
      const memberText = await memberResponse.text();
      const memberGraph = knowledgeGraphResponseSchema.parse(JSON.parse(memberText));
      expect(nodeIdsByType(memberGraph, "knowledge")).toEqual([`item:${fixture.ids.sharedItem}`]);
      expect(nodeIdsByType(memberGraph, "collection")).toEqual([
        `collection:${fixture.ids.childCollection}`,
        `collection:${fixture.ids.rootCollection}`,
      ]);
      expect(edgeTriples(memberGraph)).toEqual(expect.arrayContaining([
        `CONTAINS|collection:${fixture.ids.rootCollection}|collection:${fixture.ids.childCollection}`,
        `CONTAINS|collection:${fixture.ids.childCollection}|item:${fixture.ids.sharedItem}`,
      ]));
      for (const forbidden of [
        "bodyMarkdown",
        "body_markdown",
        "locator",
        fixture.ids.hiddenItem,
        fixture.tokens.owner,
        fixture.tokens.member,
        fixture.secrets.localPath,
        fixture.secrets.body,
        fixture.secrets.secretReference,
      ]) {
        expect(memberText).not.toContain(forbidden);
      }

      const noGrant = await graphFetch("/api/v1/graph", {
        headers: bearer(fixture.tokens.noGrant),
      });
      expect(noGrant.status).toBe(403);
      expect(await noGrant.json()).toMatchObject({ error: { code: "GRAPH_FORBIDDEN" } });

      await server.database.query(
        "update principal_tokens set revoked_at = $1 where token_digest = $2",
        [NOW.toISOString(), digestToken(config.tokenHmacSecret, fixture.tokens.noGrant)],
      );
      const revokedToken = await graphFetch("/api/v1/graph", {
        headers: bearer(fixture.tokens.noGrant),
      });
      expect(revokedToken.status).toBe(401);
      expect(await revokedToken.json()).toMatchObject({ error: "unauthorized" });

      for (const token of [fixture.tokens.agent, fixture.tokens.relay]) {
        const response = await graphFetch("/api/v1/graph", { headers: bearer(token) });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "GRAPH_PRINCIPAL_NOT_SUPPORTED" },
        });
      }

      const hiddenRoot = await graphFetch(
        `/api/v1/graph?root=${encodeURIComponent(`item:${fixture.ids.hiddenItem}`)}`,
        { headers: bearer(fixture.tokens.member) },
      );
      const unknownRoot = await graphFetch(
        `/api/v1/graph?root=${encodeURIComponent(`item:unknown_${fixture.suffix}`)}`,
        { headers: bearer(fixture.tokens.member) },
      );
      expect(hiddenRoot.status).toBe(404);
      expect(unknownRoot.status).toBe(404);
      expect(normalizeRequestId(await hiddenRoot.json())).toEqual(
        normalizeRequestId(await unknownRoot.json()),
      );

      const allowedCors = await graphFetch("/api/v1/graph", {
        headers: { ...bearer(fixture.tokens.owner), Origin: "https://graph.example" },
      });
      expect(allowedCors.headers.get("access-control-allow-origin")).toBe(
        "https://graph.example",
      );
      const rejectedCors = await graphFetch("/api/v1/graph", {
        headers: { ...bearer(fixture.tokens.owner), Origin: "https://other.example" },
      });
      expect(rejectedCors.headers.get("access-control-allow-origin")).toBeNull();

      const preflight = await graphFetch("/api/v1/graph", {
        method: "OPTIONS",
        headers: {
          Origin: "https://graph.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, If-None-Match",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://graph.example");
      expect(await preflight.text()).toBe("");

      const rejectedWrite = await graphFetch("/api/v1/graph", {
        method: "POST",
        headers: {
          ...bearer(fixture.tokens.owner),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "must-not-run", method: "message/send" }),
      });
      expect(rejectedWrite.status).toBe(405);
      expect(rejectedWrite.headers.get("allow")).toBe("GET, OPTIONS");
      expect(await rejectedWrite.text()).toBe("");

      const etagFirst = await graphFetch("/api/v1/graph?depth=2&include=tags&limit=500", {
        headers: bearer(fixture.tokens.owner),
      });
      const etag = etagFirst.headers.get("etag");
      expect(etag).toMatch(/^"sha256:[a-f0-9]{64}"$/u);
      const notModified = await graphFetch("/api/v1/graph?limit=500&include=tags&depth=2", {
        headers: { ...bearer(fixture.tokens.owner), "If-None-Match": etag! },
      });
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe("");

      const firstPage = await graphFetch("/api/v1/graph?limit=1&include=tags", {
        headers: bearer(fixture.tokens.owner),
      });
      const firstPageGraph = knowledgeGraphResponseSchema.parse(await firstPage.json());
      expect(firstPageGraph.nextCursor).not.toBeNull();
      await server.database.query(
        "update organizations set registry_revision = registry_revision + 1 where org_id = $1",
        [fixture.orgId],
      );
      const expired = await graphFetch(
        `/api/v1/graph?include=tags&limit=1&cursor=${encodeURIComponent(firstPageGraph.nextCursor!)}`,
        { headers: bearer(fixture.tokens.owner) },
      );
      expect(expired.status).toBe(409);
      expect(await expired.json()).toMatchObject({ error: { code: "GRAPH_SNAPSHOT_EXPIRED" } });

      expect(modelCallCount).toBe(0);
      expect(await agentTaskCount(server.database, fixture.orgId)).toBe(taskCountBefore);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(graphLogs).toHaveLength(graphRequestCount);
      expect(graphLogs.every((entry) => Object.keys(entry).length === 11)).toBe(true);
      const serializedLogs = JSON.stringify(graphLogs);
      for (const forbidden of [
        fixture.ids.hiddenItem,
        ...Object.values(fixture.tokens),
        invalidToken,
        infrastructureDetail,
        fixture.secrets.localPath,
        fixture.secrets.body,
        fixture.secrets.secretReference,
        "body_markdown",
        "locator",
      ]) {
        expect(serializedLogs).not.toContain(forbidden);
      }
    } finally {
      await cleanup(server.database, fixture.orgId);
      await server.close();
    }
  });
});

interface GraphFixture {
  readonly suffix: string;
  readonly orgId: string;
  readonly ids: {
    readonly rootCollection: string;
    readonly childCollection: string;
    readonly sharedItem: string;
    readonly hiddenItem: string;
  };
  readonly tokens: {
    readonly owner: string;
    readonly member: string;
    readonly noGrant: string;
    readonly agent: string;
    readonly relay: string;
  };
  readonly secrets: {
    readonly localPath: string;
    readonly body: string;
    readonly secretReference: string;
  };
}

async function seedGraphFixture(database: Database, hmacSecret: string): Promise<GraphFixture> {
  await assertSafeTestDatabase(database);
  const suffix = randomUUID().replaceAll("-", "");
  const orgId = `org_graph_http_${suffix}`;
  const principals = {
    owner: `owner_${suffix}`,
    member: `member_${suffix}`,
    noGrant: `no_grant_${suffix}`,
    agent: `agent_${suffix}`,
    relay: `relay_${suffix}`,
  };
  const ids = {
    rootCollection: `root_${suffix}`,
    childCollection: `child_${suffix}`,
    sharedItem: `shared_${suffix}`,
    hiddenItem: `hidden_${suffix}`,
  };
  const tokens = {
    owner: `owner-token-${suffix}`,
    member: `member-token-${suffix}`,
    noGrant: `no-grant-token-${suffix}`,
    agent: `agent-token-${suffix}`,
    relay: `relay-token-${suffix}`,
  };
  const secrets = {
    localPath: `/Users/private/${suffix}/knowledge.md`,
    body: `BODY-SECRET-${suffix}`,
    secretReference: `vault://graph-http/${suffix}`,
  };
  const locationId = `location_${suffix}`;
  const versionId = `version_${suffix}`;
  const connectorId = `connector_${suffix}`;
  const tagId = `tag_${suffix}`;

  await database.transaction(async (client) => {
    await client.query(
      "insert into organizations(org_id, name, registry_revision) values ($1, 'Graph HTTP fixture', 30)",
      [orgId],
    );
    for (const [key, principalId] of Object.entries(principals)) {
      const type = key === "agent" ? "agent" : key === "relay" ? "relay" : "user";
      const role = key === "owner" ? "owner" : type === "user" ? "member" : null;
      await client.query(
        `insert into principals(
           principal_id, org_id, principal_type, display_name,
           organization_role, capabilities, status
         ) values ($1, $2, $3, $4, $5, $6, 'active')`,
        [principalId, orgId, type, `Graph ${key}`, role,
          type === "user" ? [] : ["knowledge.query"]],
      );
      const token = tokens[key as keyof typeof tokens];
      await client.query(
        `insert into principal_tokens(token_id, org_id, principal_id, token_prefix, token_digest)
         values ($1, $2, $3, $4, $5)`,
        [`token_${key}_${suffix}`, orgId, principalId, token.slice(0, 8), digestToken(hmacSecret, token)],
      );
    }
    await client.query(
      `insert into resource_grants(
         grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
       ) values
         ($1, $3, $4, 'organization', $3, '{knowledge.query}'),
         ($2, $3, $5, 'item', $6, '{knowledge.query}')`,
      [`grant_owner_${suffix}`, `grant_member_${suffix}`, orgId, principals.owner,
        principals.member, ids.sharedItem],
    );
    await client.query(
      `insert into knowledge_collections(
         collection_id, org_id, parent_collection_id, name, description, revision,
         created_by_principal_id
       ) values
         ($1, $3, null, 'Root', '', 1, $4),
         ($2, $3, $1, 'Child', '', 1, $4)`,
      [ids.rootCollection, ids.childCollection, orgId, principals.owner],
    );
    await client.query(
      `insert into knowledge_items(
         item_id, org_id, owner_principal_id, title, status, revision, updated_at
       ) values
         ($1, $3, $4, 'Shared safe title', 'stable', 2, $5),
         ($2, $3, $4, 'Hidden confidential title', 'stable', 2, $5)`,
      [ids.sharedItem, ids.hiddenItem, orgId, principals.owner, NOW.toISOString()],
    );
    await client.query(
      `insert into knowledge_collection_items(
         item_id, org_id, collection_id, placed_by_principal_id
       ) values
         ($1, $3, $4, $5),
         ($2, $3, $4, $5)`,
      [ids.sharedItem, ids.hiddenItem, orgId, ids.childCollection, principals.owner],
    );
    await client.query(
      `insert into connector_instances(
         connector_instance_id, org_id, connector_type, display_name, secret_reference, status
       ) values ($1, $2, 'github', 'Safe connector', $3, 'active')`,
      [connectorId, orgId, secrets.secretReference],
    );
    await client.query(
      `insert into knowledge_locations(
         location_id, org_id, item_id, location_kind, location_role, locator,
         connector_instance_id, owner_principal_id, metadata, availability, last_verified_at
       ) values ($1, $2, $3, 'github', 'canonical', $4, $5, $6, '{}', 'available', $7)`,
      [locationId, orgId, ids.sharedItem, secrets.localPath, connectorId, principals.owner,
        NOW.toISOString()],
    );
    const bodyHash = `sha256:${createHash("sha256").update(secrets.body).digest("hex")}`;
    await client.query(
      `insert into knowledge_versions(
         version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
         provenance, created_by_principal_id, created_at
       ) values ($1, $2, $3, $4, 1, $5, $6, '{}', $7, $8)`,
      [versionId, orgId, ids.sharedItem, locationId, bodyHash, secrets.body, principals.owner,
        NOW.toISOString()],
    );
    await client.query(
      "update knowledge_items set current_version_id = $1 where item_id = $2",
      [versionId, ids.sharedItem],
    );
    await client.query(
      "insert into tags(tag_id, org_id, name, description) values ($1, $2, 'shared', '')",
      [tagId, orgId],
    );
    await client.query(
      "insert into knowledge_tags(org_id, item_id, tag_id, version_id) values ($1, $2, $3, $4)",
      [orgId, ids.sharedItem, tagId, versionId],
    );
  });

  return { suffix, orgId, ids, tokens, secrets };
}

function testEnvironment(): NodeJS.ProcessEnv {
  const databaseUrl = process.env.OPENLIFEWIKI_TEST_DATABASE_URL
    ?? "postgres://postgres@127.0.0.1:55432/openlifewiki_test";
  assertSafeTestDatabaseUrl(databaseUrl);
  return {
    DATABASE_URL: databaseUrl,
    OPENLIFEWIKI_TOKEN_HMAC_SECRET: "integration-token-secret-with-at-least-32-bytes",
    OPENLIFEWIKI_MODEL: "never-called-model",
    OPENLIFEWIKI_PUBLIC_URL: "http://127.0.0.1:0",
    OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "https://graph.example,http://127.0.0.1:5173",
    OPENAI_API_KEY: "never-used-api-key",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    PORT: "0",
  };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function varyValues(response: Response): string[] {
  return (response.headers.get("vary") ?? "").split(",").map((value) => value.trim()).sort();
}

function nodeIdsByType(
  graph: KnowledgeGraphResponse,
  type: "knowledge" | "collection",
): string[] {
  return graph.elements.nodes
    .filter((node) => node.data.type === type)
    .map((node) => node.data.id)
    .sort();
}

function edgeTriples(graph: KnowledgeGraphResponse): string[] {
  return graph.elements.edges.map(
    (edge) => `${edge.data.type}|${edge.data.source}|${edge.data.target}`,
  );
}

function normalizeRequestId(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("error" in value)) return value;
  const error = (value as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return value;
  return { ...value, error: { ...error, requestId: "<request-id>" } };
}

async function agentTaskCount(database: Database, orgId: string): Promise<number> {
  const result = await database.query<{ count: string }>(
    "select count(*)::text as count from agent_tasks where org_id = $1",
    [orgId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function cleanup(database: Database, orgId: string): Promise<void> {
  await assertSafeTestDatabase(database);
  await database.transaction(async (client) => {
    await client.query("delete from audit_events where org_id = $1", [orgId]);
    await client.query("delete from agent_tasks where org_id = $1", [orgId]);
    await client.query("delete from agent_sessions where org_id = $1", [orgId]);
    await client.query("delete from presence_leases where org_id = $1", [orgId]);
    await client.query("delete from resource_grants where org_id = $1", [orgId]);
    await client.query("update knowledge_items set current_version_id = null where org_id = $1", [orgId]);
    await client.query("delete from knowledge_collection_items where org_id = $1", [orgId]);
    await client.query("delete from knowledge_tags where org_id = $1", [orgId]);
    await client.query("delete from tags where org_id = $1", [orgId]);
    await client.query("delete from knowledge_versions where org_id = $1", [orgId]);
    await client.query("delete from knowledge_locations where org_id = $1", [orgId]);
    await client.query("delete from source_authorizations where org_id = $1", [orgId]);
    await client.query("delete from connector_instances where org_id = $1", [orgId]);
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
  if (databaseName !== "openlifewiki_test") {
    throw new Error("Graph HTTP integration tests require openlifewiki_test");
  }
}

async function assertSafeTestDatabase(database: Database): Promise<void> {
  const result = await database.query<{ name: string }>("select current_database() as name");
  if (result.rows[0]?.name !== "openlifewiki_test") {
    throw new Error("Refusing destructive graph HTTP test against a non-test database");
  }
}
