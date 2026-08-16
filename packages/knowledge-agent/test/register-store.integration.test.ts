import { randomUUID } from "node:crypto";

import { RunContext, Runner } from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import {
  createDatabase,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import {
  knowledgeAgentResultSchema,
  knowledgeRegistrationResultSchema,
  managedKnowledgeResultSchema,
  storePreviewSchema,
  type AccessContext,
  type KnowledgeEvidence,
  type KnowledgeLocation,
  type KnowledgeRegistrationResult,
  type KnowledgeSearchCandidate,
  type ManagedKnowledgeResult,
  type ResourceGrant,
  type StorePreview,
} from "@openlifewiki/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createKnowledgeAgent,
  createKnowledgeTools,
  KnowledgeOperationError,
  KnowledgeOperations,
  type KnowledgeAgentContext,
  type KnowledgeToolOperations,
} from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe.sequential : describe.skip;
const SECRET = "test-token-secret-with-at-least-32-bytes";

describePostgres("registered and managed knowledge write boundary", () => {
  let database: Database;
  let store: PostgresKnowledgeStore;
  let owner: AccessContext;
  let member: AccessContext;
  let ownerPrincipalId: string;
  let memberPrincipalId: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
    await runMigrations(database, { migrationsDir: "../adapters/migrations" });
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const orgId = `org_write_${suffix}`;
    ownerPrincipalId = `principal_owner_${suffix}`;
    memberPrincipalId = `principal_member_${suffix}`;
    const capabilities = [
      "knowledge.query",
      "knowledge.register",
      "knowledge.store",
      "knowledge.organize",
      "knowledge.share",
      "principal.manage",
    ];
    await database.transaction(async (client) => {
      await client.query("insert into organizations(org_id, name) values ($1, $2)", [orgId, "Task 3.1a Test"]);
      await client.query(
        `insert into principals(
          principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
        ) values
          ($1, $2, 'user', 'Owner', 'owner', $4, 'active'),
          ($3, $2, 'user', 'Member', 'member', '{}', 'active')`,
        [ownerPrincipalId, orgId, memberPrincipalId, capabilities],
      );
      await client.query(
        `insert into resource_grants(
          grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
        ) values ($1, $2, $3, 'organization', $2, $4)`,
        [`grant_owner_${suffix}`, orgId, ownerPrincipalId, capabilities],
      );
    });
    store = new PostgresKnowledgeStore(database, SECRET);
    owner = humanAccess(orgId, ownerPrincipalId, `task_owner_${suffix}`);
    member = humanAccess(orgId, memberPrincipalId, `task_member_${suffix}`);
  });

  afterEach(async () => {
    if (owner === undefined) return;
    await database.transaction(async (client) => {
      await client.query("update knowledge_items set current_version_id = null where org_id = $1", [owner.orgId]);
      for (const table of [
        "audit_events", "agent_tasks", "agent_sessions", "presence_leases",
        "knowledge_tags", "knowledge_versions", "knowledge_locations", "knowledge_items",
        "resource_grants", "source_authorizations", "connector_instances", "tags",
        "delegations", "principal_tokens", "principals", "organizations",
      ]) {
        await client.query(`delete from ${table} where org_id = $1`, [owner.orgId]);
      }
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  it("creates a private managed draft and exposes it only after an explicit query share", async () => {
    const operations = new KnowledgeOperations(store);
    const managed = await operations.storeManaged(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Private draft", bodyMarkdown: "# Private", aliases: [], tags: ["private"] },
    });

    expect(managedKnowledgeResultSchema.parse(managed)).toEqual(managed);
    expect(managed.taskId).toBe(owner.taskId);
    expect(managed.item.status).toBe("draft");
    await store.grantResource({
      ownerContext: owner,
      principalId: memberPrincipalId,
      scope: { kind: "organization", id: owner.orgId },
      capabilities: ["knowledge.query"],
      expiresAt: null,
    });
    expect(await store.searchAuthorized({ context: member, query: "Private", limit: 10 })).toEqual([]);
    expect(await store.getAuthorized({
      context: member,
      itemId: managed.item.itemId,
      locationId: managed.location.locationId,
      versionId: managed.version.versionId,
    })).toBeNull();
    await expect(operations.listLocations(member, { itemId: managed.item.itemId }))
      .rejects.toMatchObject({ code: "DELEGATION_DENIED" });

    const shared = await operations.share(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.share",
      itemId: managed.item.itemId,
      targetPrincipalId: memberPrincipalId,
      capabilities: ["knowledge.query"],
    });

    expect(knowledgeRegistrationResultSchema.parse(shared)).toEqual(shared);
    expect(shared.taskId).toBe(owner.taskId);
    expect(await store.searchAuthorized({ context: member, query: "Private", limit: 10 })).toHaveLength(1);
    expect(await operations.listLocations(member, { itemId: managed.item.itemId })).toEqual([managed.location]);
  });

  it("treats an identical locator registration as a zero-revision idempotent replay and rejects cross-item reuse", async () => {
    const operations = new KnowledgeOperations(store);
    const firstLocation = {
      kind: "person-local" as const,
      role: "original" as const,
      locator: "file:///authorized/decision.md",
      connectorInstanceId: null,
      ownerPrincipalId,
      metadata: { device: "owner-mac" },
    };
    const firstInput = {
      schema: "openlifewiki.operation/v1" as const,
      kind: "knowledge.register" as const,
      itemId: null,
      expectedRevision: null,
      title: "External source",
      aliases: [],
      tags: ["external"],
      locations: [firstLocation],
    };
    const first = await operations.register(owner, {
      ...firstInput,
      locations: [firstLocation, firstLocation],
    });
    expect(first.locations).toHaveLength(1);
    await store.grantResource({
      ownerContext: owner,
      principalId: memberPrincipalId,
      scope: { kind: "item", id: first.item.itemId },
      capabilities: ["knowledge.register"],
      expiresAt: null,
    });
    const registryBefore = await scalar("select registry_revision from organizations where org_id = $1", [owner.orgId]);
    const memberReplay = await operations.register(member, firstInput);
    const replay = await operations.register(owner, firstInput);

    expect(memberReplay.item.itemId).toBe(first.item.itemId);
    expect(replay.item).toEqual(first.item);
    expect(replay.locations).toEqual(first.locations);
    expect(await scalar("select count(*) from knowledge_locations where item_id = $1", [first.item.itemId])).toBe("1");
    expect(await scalar("select registry_revision from organizations where org_id = $1", [owner.orgId])).toBe(registryBefore);

    const second = await operations.register(owner, {
      ...firstInput,
      title: "Second source",
      tags: [],
      locations: [{
        kind: "person-local",
        role: "original",
        locator: "file:///authorized/second.md",
        connectorInstanceId: null,
        ownerPrincipalId,
        metadata: { device: "owner-mac" },
      }],
    });
    await expect(operations.register(owner, {
      ...firstInput,
      itemId: second.item.itemId,
      expectedRevision: second.item.revision,
    })).rejects.toMatchObject({ code: "KNOWLEDGE_CONFLICT" });
    expect(await scalar("select revision from knowledge_items where item_id = $1", [second.item.itemId]))
      .toBe(String(second.item.revision));
    expect(await scalar(
      "select count(*) from audit_events where target_id = $1 and action = 'knowledge.register' and decision = 'failed'",
      [second.item.itemId],
    )).toBe("1");
  });

  it("accepts exactly 1 MiB UTF-8 and rejects larger Markdown before another version is written", async () => {
    const operations = new KnowledgeOperations(store);
    const exact = "a".repeat(1_048_576);
    const managed = await operations.storeManaged(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Boundary", bodyMarkdown: exact, aliases: [], tags: [] },
    });
    expect(managed.version.bodyMarkdown?.length).toBe(1_048_576);

    const before = await scalar("select count(*) from knowledge_versions", []);
    const oversized = "界".repeat(349_526);
    await expect(operations.storeManaged(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Too large", bodyMarkdown: oversized, aliases: [], tags: [] },
    })).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(await scalar("select count(*) from knowledge_versions", [])).toBe(before);
    expect(await scalar(
      "select count(*) from audit_events where target_id = $1 and action = 'knowledge.store' and decision = 'failed'",
      [owner.orgId],
    )).toBe("1");
    expect(await auditText()).not.toContain(exact);
    expect(await auditText()).not.toContain(oversized.slice(0, 100));
  });

  it("previews without registry writes and applies only the exact revision, hash and body", async () => {
    const operations = new KnowledgeOperations(store);
    const managed = await operations.storeManaged(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Old title", bodyMarkdown: "# Old body", aliases: [], tags: [] },
    });
    const replacement = { title: "New title", bodyMarkdown: "# New body", aliases: ["new"], tags: ["changed"] };
    const beforeVersions = await scalar("select count(*) from knowledge_versions where item_id = $1", [managed.item.itemId]);
    const beforeRegistry = await scalar("select registry_revision from organizations where org_id = $1", [owner.orgId]);
    const preview = await operations.previewManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.preview-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      content: replacement,
    });

    expect(storePreviewSchema.parse(preview)).toEqual(preview);
    expect(preview.taskId).toBe(owner.taskId);
    expect(await scalar("select count(*) from knowledge_versions where item_id = $1", [managed.item.itemId])).toBe(beforeVersions);
    expect(await scalar("select registry_revision from organizations where org_id = $1", [owner.orgId])).toBe(beforeRegistry);
    expect(await scalar("select revision from knowledge_items where item_id = $1", [managed.item.itemId]))
      .toBe(String(managed.item.revision));

    await expect(operations.applyManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      previewHash: preview.previewHash,
      content: { ...replacement, bodyMarkdown: "# Tampered body" },
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await scalar("select count(*) from knowledge_versions where item_id = $1", [managed.item.itemId])).toBe(beforeVersions);
    expect(await scalar("select revision from knowledge_items where item_id = $1", [managed.item.itemId]))
      .toBe(String(managed.item.revision));
    await expect(operations.applyManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      previewHash: `sha256:${"0".repeat(64)}`,
      content: replacement,
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await scalar("select count(*) from knowledge_versions where item_id = $1", [managed.item.itemId])).toBe(beforeVersions);
    expect(await scalar("select revision from knowledge_items where item_id = $1", [managed.item.itemId]))
      .toBe(String(managed.item.revision));

    const applied = await operations.applyManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      previewHash: preview.previewHash,
      content: replacement,
    });
    expect(managedKnowledgeResultSchema.parse(applied)).toEqual(applied);
    expect(applied.item.revision).toBe(managed.item.revision + 1);
    expect(applied.version.ordinal).toBe(2);

    await expect(operations.applyManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      previewHash: preview.previewHash,
      content: replacement,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await scalar("select count(*) from knowledge_versions where item_id = $1", [managed.item.itemId])).toBe("2");
    expect(await scalar("select revision from knowledge_items where item_id = $1", [managed.item.itemId]))
      .toBe(String(managed.item.revision + 1));
  });

  it("records successful and rejected writes without persisting Markdown in audit JSON", async () => {
    const operations = new KnowledgeOperations(store);
    const secretBody = `# secret-${randomUUID()}`;
    const managed = await operations.storeManaged(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title: "Audit", bodyMarkdown: secretBody, aliases: [], tags: [] },
    });
    const preview = await operations.previewManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.preview-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      content: { title: "Audit 2", bodyMarkdown: `${secretBody}\nchanged`, aliases: [], tags: [] },
    });
    await expect(operations.applyManagedReplacement(owner, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: managed.item.itemId,
      expectedRevision: managed.item.revision,
      previewHash: `sha256:${"0".repeat(64)}`,
      content: { title: "Audit 2", bodyMarkdown: `${secretBody}\nchanged`, aliases: [], tags: [] },
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(operations.share(member, {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.share",
      itemId: managed.item.itemId,
      targetPrincipalId: memberPrincipalId,
      capabilities: ["knowledge.query"],
    })).rejects.toMatchObject({ code: "DELEGATION_DENIED" });

    const audits = await database.query<{ action: string; decision: string; body: string }>(
      "select action, decision, row_to_json(audit_events)::text as body from audit_events where target_id = $1 order by created_at, audit_event_id",
      [managed.item.itemId],
    );
    expect(audits.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "knowledge.store", decision: "completed" }),
      expect.objectContaining({ action: "knowledge.store.replace", decision: "failed" }),
      expect.objectContaining({ action: "knowledge.share", decision: "failed" }),
    ]));
    expect(JSON.stringify(audits.rows)).not.toContain(secretBody);
    expect(JSON.stringify(audits.rows)).not.toContain("bodyMarkdown");
  });

  async function scalar(sql: string, values: readonly unknown[]): Promise<string> {
    const result = await database.query<Record<string, unknown>>(sql, values);
    return String(Object.values(result.rows[0] ?? {})[0]);
  }

  async function auditText(): Promise<string> {
    const result = await database.query<{ body: string }>("select row_to_json(audit_events)::text as body from audit_events");
    return result.rows.map(({ body }) => body).join("\n");
  }
});

describe("knowledge write Agent tools", () => {
  it("uses strict typed tools, approval on replace, and one operations boundary for natural language", async () => {
    const calls: string[] = [];
    const managed = managedResult("task_tools");
    const operations: KnowledgeToolOperations = {
      async query(): Promise<readonly KnowledgeSearchCandidate[]> { calls.push("query"); return []; },
      async get(): Promise<KnowledgeEvidence> { calls.push("get"); throw new KnowledgeOperationError("KNOWLEDGE_NOT_FOUND"); },
      async register(): Promise<KnowledgeRegistrationResult> { calls.push("register"); return registrationResult("task_tools"); },
      async storeManaged(): Promise<ManagedKnowledgeResult> { calls.push("storeManaged"); return managed; },
      async previewManagedReplacement(): Promise<StorePreview> { calls.push("preview"); return previewResult("task_tools"); },
      async applyManagedReplacement(): Promise<ManagedKnowledgeResult> { calls.push("apply"); return managed; },
      async share(): Promise<KnowledgeRegistrationResult> { calls.push("share"); return registrationResult("task_tools"); },
      async listLocations(): Promise<readonly KnowledgeLocation[]> { calls.push("list"); return [managed.location]; },
    };
    const tools = createKnowledgeTools(operations);
    expect(tools.map(({ name }) => name)).toEqual([
      "knowledge_search",
      "knowledge_get",
      "knowledge_register",
      "knowledge_store_draft",
      "knowledge_store_replace",
      "knowledge_list_locations",
      "knowledge_share",
    ]);
    const replace = tools[4];
    await expect(replace.needsApproval(new RunContext(toolContext()), {
      itemId: "item_tools",
      expectedRevision: 0,
      previewHash: `sha256:${"c".repeat(64)}`,
      content: { title: "New", bodyMarkdown: "# New", aliases: [], tags: [] },
    }))
      .resolves.toBe(true);

    const draft = tools[3];
    await expect(draft.invoke(
      new RunContext(toolContext()),
      JSON.stringify({ content: { title: "Draft", bodyMarkdown: "# Draft", aliases: [], tags: [] }, extra: true }),
    )).rejects.toBeDefined();
    expect(calls).toEqual([]);

    const model = new ScriptedModel([
      [functionCall("knowledge_store_draft", {
        content: { title: "Draft", bodyMarkdown: "# Draft", aliases: [], tags: [] },
      }, { callId: "call_store" })],
      [assistantMessage(JSON.stringify(managed))],
    ]);
    const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
    const outcome = await runner.run(createKnowledgeAgent({ model, operations }), "请保存一个私有 Markdown 草案", {
      context: toolContext(),
      maxTurns: 3,
    });
    expect(knowledgeAgentResultSchema.parse(outcome.finalOutput)).toEqual(managed);
    expect(calls).toEqual(["storeManaged"]);
    expect(model.firstCall?.request.systemInstructions).toContain("knowledge_store_draft");
    expect(model.firstCall?.request.systemInstructions).toContain("knowledge_share");
    expect(model.firstCall?.request.systemInstructions).toContain("preview");
  });
});

function toolContext(): KnowledgeAgentContext {
  const access: AccessContext = {
    schema: "openlifewiki.access-context/v1",
    orgId: "org_tools",
    actorPrincipalId: "principal_tools",
    actorAgentId: null,
    onBehalfOfUserId: "principal_tools",
    delegationId: null,
    taskId: "task_tools",
  };
  return {
    access,
    operation: { schema: "openlifewiki.agent-message/v1", text: "请保存草案" },
    taskId: "task_tools",
    retrievedCitations: [],
  };
}

function humanAccess(orgId: string, principalId: string, taskId: string): AccessContext {
  return {
    schema: "openlifewiki.access-context/v1",
    orgId,
    actorPrincipalId: principalId,
    actorAgentId: null,
    onBehalfOfUserId: principalId,
    delegationId: null,
    taskId,
  };
}

function managedResult(taskId: string): ManagedKnowledgeResult {
  const item = {
    schema: "openlifewiki.knowledge-item/v1" as const,
    itemId: "item_tools",
    orgId: "org_tools",
    ownerPrincipalId: "principal_tools",
    title: "Draft",
    aliases: [],
    status: "draft" as const,
    currentVersionId: "version_tools",
    revision: 0,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
  const location = {
    schema: "openlifewiki.knowledge-location/v1" as const,
    locationId: "location_tools",
    itemId: item.itemId,
    kind: "managed-markdown" as const,
    role: "canonical" as const,
    locator: "openlifewiki-managed://item_tools",
    connectorInstanceId: null,
    ownerPrincipalId: item.ownerPrincipalId,
    metadata: {},
    observedProviderVersion: null,
    availability: "available" as const,
    revision: 0,
    lastVerifiedAt: "2026-08-16T00:00:00.000Z",
  };
  return {
    schema: "openlifewiki.managed-knowledge-result/v1",
    taskId,
    item,
    location,
    version: {
      schema: "openlifewiki.knowledge-version/v1",
      versionId: item.currentVersionId,
      itemId: item.itemId,
      locationId: location.locationId,
      ordinal: 1,
      bodyHash: `sha256:${"a".repeat(64)}`,
      bodyMarkdown: "# Draft",
      providerVersion: null,
      provenance: {},
      createdByPrincipalId: item.ownerPrincipalId,
      createdAt: "2026-08-16T00:00:00.000Z",
    },
  };
}

function registrationResult(taskId: string): KnowledgeRegistrationResult {
  const managed = managedResult(taskId);
  return {
    schema: "openlifewiki.knowledge-registration-result/v1",
    taskId,
    item: managed.item,
    locations: [managed.location],
  };
}

function previewResult(taskId: string): StorePreview {
  return {
    schema: "openlifewiki.store-preview/v1",
    taskId,
    itemId: "item_tools",
    expectedRevision: 0,
    oldBodyHash: `sha256:${"a".repeat(64)}`,
    newBodyHash: `sha256:${"b".repeat(64)}`,
    oldTitle: "Old",
    newTitle: "New",
    previewHash: `sha256:${"c".repeat(64)}`,
  };
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  const databaseName = new URL(value).pathname.slice(1);
  if (!/(?:^|_)test$/u.test(databaseName)) {
    throw new Error("PostgreSQL integration tests require a *_test database");
  }
  return value;
}
