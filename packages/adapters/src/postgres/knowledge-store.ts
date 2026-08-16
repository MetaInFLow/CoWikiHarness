import { createHash, randomUUID } from "node:crypto";

import {
  authorizeKnowledgeOperation,
  sha256Canonical,
  type KnowledgeResource,
} from "@openlifewiki/core";
import {
  accessContextSchema,
  delegationSchema,
  knowledgeCitationSchema,
  knowledgeEvidenceSchema,
  knowledgeItemSchema,
  knowledgeLocationInputSchema,
  knowledgeLocationSchema,
  knowledgeOperationSchema,
  knowledgeVersionSchema,
  managedMarkdownInputSchema,
  principalSchema,
  resourceGrantSchema,
  type AccessContext,
  type Delegation,
  type KnowledgeCapability,
  type KnowledgeCitation,
  type KnowledgeErrorCode,
  type KnowledgeEvidence,
  type KnowledgeItem,
  type KnowledgeLocation,
  type KnowledgeLocationInput,
  type KnowledgeOperation,
  type KnowledgeSearchCandidate,
  type KnowledgeVersion,
  type Principal,
  type ResourceGrant,
  type ResourceScope,
} from "@openlifewiki/protocol";
import { z } from "zod";

import { AdapterError } from "../errors.js";
import type { Database } from "./database.js";
import { digestToken, issuePrincipalToken, type IssuedToken } from "./token-service.js";

type SqlRow = Record<string, any>;

const ALL_CAPABILITIES: readonly KnowledgeCapability[] = [
  "knowledge.query",
  "knowledge.register",
  "knowledge.store",
  "knowledge.organize",
  "knowledge.share",
  "principal.manage",
  "relay.serve",
];

export interface BootstrapInput {
  readonly organizationName: string;
  readonly ownerDisplayName: string;
  readonly agentDisplayName: string;
  readonly delegationExpiresAt: string;
}

export interface BootstrapResult {
  readonly orgId: string;
  readonly ownerPrincipalId: string;
  readonly agentPrincipalId: string;
  readonly delegationId: string;
  readonly ownerToken: string;
  readonly agentToken: string;
}

export interface IssuedPrincipal {
  readonly principal: Principal;
  readonly tokenId: string;
  readonly token: string;
}
export interface IssuedDelegatedAgent extends IssuedPrincipal {
  readonly delegation: Delegation;
}
export interface CreateMemberInput {
  readonly ownerContext: AccessContext;
  readonly displayName: string;
}
export interface CreateDelegatedAgentInput {
  readonly ownerContext: AccessContext;
  readonly userPrincipalId: string;
  readonly displayName: string;
  readonly capabilities: readonly KnowledgeCapability[];
  readonly resourceScopes: readonly ResourceScope[];
  readonly expiresAt: string;
}
export interface GrantResourceInput {
  readonly ownerContext: AccessContext;
  readonly principalId: string;
  readonly scope: ResourceScope;
  readonly capabilities: readonly KnowledgeCapability[];
  readonly expiresAt: string | null;
}
export interface RotateTokenInput {
  readonly ownerContext: AccessContext;
  readonly principalId: string;
  readonly expiresAt: string | null;
}
export interface RevokeTokenInput {
  readonly ownerContext: AccessContext;
  readonly tokenId: string;
}
export interface IssuedTokenRecord {
  readonly tokenId: string;
  readonly principalId: string;
  readonly token: string;
}
export interface CreateManagedKnowledgeInput {
  readonly context: AccessContext;
  readonly content: z.infer<typeof managedMarkdownInputSchema>;
}
export interface ManagedKnowledgeResult {
  readonly item: KnowledgeItem;
  readonly location: KnowledgeLocation;
  readonly version: KnowledgeVersion;
}
export interface RegisterLocationsInput {
  readonly context: AccessContext;
  readonly itemId: string | null;
  readonly expectedRevision: number | null;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly locations: readonly KnowledgeLocationInput[];
}
export interface RegisterLocationsResult {
  readonly item: KnowledgeItem;
  readonly locations: readonly KnowledgeLocation[];
}
export interface ReplaceManagedKnowledgeInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly expectedRevision: number;
  readonly previewHash: string;
  readonly content: z.infer<typeof managedMarkdownInputSchema>;
}
export interface SearchAuthorizedInput {
  readonly context: AccessContext;
  readonly query: string;
  readonly limit: number;
}
export interface GetAuthorizedInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly locationId: string;
  readonly versionId: string | null;
}
export interface ShareItemInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly targetPrincipalId: string;
  readonly capabilities: readonly KnowledgeCapability[];
}
export interface CreateTaskInput {
  readonly taskId: string;
  readonly contextId: string;
  readonly principal: Principal;
  readonly input: KnowledgeOperation;
}
export interface EnsureAgentSessionInput {
  readonly sessionId: string;
  readonly orgId: string;
  readonly ownerPrincipalId: string;
}
export interface AppendAgentSessionInput extends EnsureAgentSessionInput {
  readonly items: readonly unknown[];
}
export interface PauseTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly runState: string;
  readonly errorCode: "APPROVAL_REQUIRED" | "LOCAL_SOURCE_OFFLINE";
}
export interface CompleteTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly output: unknown;
}
export interface FailTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly code: KnowledgeErrorCode;
}
export interface StoredAgentTask {
  readonly taskId: string;
  readonly contextId: string;
  readonly orgId: string;
  readonly ownerPrincipalId: string;
  readonly actorAgentId: string | null;
  readonly delegationId: string | null;
  readonly state: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
  readonly input: KnowledgeOperation;
  readonly output: unknown | null;
  readonly runState: string | null;
  readonly errorCode: KnowledgeErrorCode | null;
  readonly revision: number;
}

export class PostgresKnowledgeStore {
  constructor(
    private readonly database: Database,
    private readonly tokenHmacSecret: string,
    private readonly ids: () => string = randomUUID,
  ) {}

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const orgId = this.id("org");
    const ownerPrincipalId = this.id("principal");
    const agentPrincipalId = this.id("principal");
    const delegationId = this.id("delegation");
    const ownerTokenId = this.id("token");
    const agentTokenId = this.id("token");
    const ownerToken = issuePrincipalToken(this.tokenHmacSecret);
    const agentToken = issuePrincipalToken(this.tokenHmacSecret);
    const owner = principalSchema.parse({
      schema: "openlifewiki.principal/v1",
      principalId: ownerPrincipalId,
      orgId,
      type: "user",
      displayName: input.ownerDisplayName,
      organizationRole: "owner",
      capabilities: [...ALL_CAPABILITIES],
      status: "active",
    });
    const agent = principalSchema.parse({
      schema: "openlifewiki.principal/v1",
      principalId: agentPrincipalId,
      orgId,
      type: "agent",
      displayName: input.agentDisplayName,
      organizationRole: null,
      capabilities: ["knowledge.query", "knowledge.register", "knowledge.store", "knowledge.organize"],
      status: "active",
    });
    const delegation = delegationSchema.parse({
      schema: "openlifewiki.delegation/v1",
      delegationId,
      orgId,
      agentPrincipalId,
      userPrincipalId: ownerPrincipalId,
      capabilities: agent.capabilities,
      resourceScopes: [{ kind: "organization", id: orgId }],
      expiresAt: input.delegationExpiresAt,
      revokedAt: null,
    });
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", ["openlifewiki:bootstrap"]);
      const existing = await client.query<{ org_id: string }>("select org_id from organizations limit 1");
      if (existing.rows[0] !== undefined) {
        throw new AdapterError("CONFIG_CONFLICT", "The cloud registry is already bootstrapped");
      }
      await client.query("insert into organizations(org_id, name) values ($1, $2)", [orgId, input.organizationName]);
      await insertPrincipal(client, owner);
      await insertPrincipal(client, agent);
      await client.query(
        `insert into delegations(
          delegation_id, org_id, agent_principal_id, user_principal_id,
          capabilities, resource_scopes, expires_at, revoked_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [delegation.delegationId, delegation.orgId, delegation.agentPrincipalId, delegation.userPrincipalId,
          delegation.capabilities, JSON.stringify(delegation.resourceScopes), delegation.expiresAt, delegation.revokedAt],
      );
      await insertToken(client, ownerTokenId, orgId, ownerPrincipalId, ownerToken, null);
      await insertToken(client, agentTokenId, orgId, agentPrincipalId, agentToken, null);
      await insertGrant(client, {
        schema: "openlifewiki.resource-grant/v1",
        grantId: this.id("grant"),
        orgId,
        principalId: ownerPrincipalId,
        scope: { kind: "organization", id: orgId },
        capabilities: [...ALL_CAPABILITIES],
        expiresAt: null,
        revokedAt: null,
      });
      await this.audit(client, {
        context: humanContext(orgId, ownerPrincipalId, this.id("task")),
        action: "organization.bootstrap",
        targetKind: "organization",
        targetId: orgId,
        decision: "completed",
      });
    });
    return {
      orgId,
      ownerPrincipalId,
      agentPrincipalId,
      delegationId,
      ownerToken: ownerToken.value,
      agentToken: agentToken.value,
    };
  }

  async authenticate(token: string, now: Date): Promise<Principal | null> {
    const result = await this.database.query<SqlRow>(
      `select p.*
       from principal_tokens pt
       join principals p on p.principal_id = pt.principal_id
       where pt.token_digest = $1
         and pt.revoked_at is null
         and (pt.expires_at is null or pt.expires_at > $2)
         and p.status = 'active'`,
      [digestToken(this.tokenHmacSecret, token), now.toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapPrincipal(row);
  }

  async createMember(input: CreateMemberInput): Promise<IssuedPrincipal> {
    return await this.database.transaction(async (client) => {
      await this.assertOwner(client, input.ownerContext);
      const principal = principalSchema.parse({
        schema: "openlifewiki.principal/v1",
        principalId: this.id("principal"),
        orgId: input.ownerContext.orgId,
        type: "user",
        displayName: input.displayName,
        organizationRole: "member",
        capabilities: [],
        status: "active",
      });
      const tokenId = this.id("token");
      const token = issuePrincipalToken(this.tokenHmacSecret);
      await insertPrincipal(client, principal);
      await insertToken(client, tokenId, principal.orgId, principal.principalId, token, null);
      await this.audit(client, {
        context: input.ownerContext,
        action: "principal.create-member",
        targetKind: "principal",
        targetId: principal.principalId,
        decision: "completed",
      });
      return { principal, tokenId, token: token.value };
    });
  }

  async createDelegatedAgent(input: CreateDelegatedAgentInput): Promise<IssuedDelegatedAgent> {
    return await this.database.transaction(async (client) => {
      await this.assertOwner(client, input.ownerContext);
      await this.assertPrincipalInOrganization(client, input.ownerContext.orgId, input.userPrincipalId, "user");
      const principal = principalSchema.parse({
        schema: "openlifewiki.principal/v1",
        principalId: this.id("principal"),
        orgId: input.ownerContext.orgId,
        type: "agent",
        displayName: input.displayName,
        organizationRole: null,
        capabilities: [...input.capabilities],
        status: "active",
      });
      const delegation = delegationSchema.parse({
        schema: "openlifewiki.delegation/v1",
        delegationId: this.id("delegation"),
        orgId: input.ownerContext.orgId,
        agentPrincipalId: principal.principalId,
        userPrincipalId: input.userPrincipalId,
        capabilities: [...input.capabilities],
        resourceScopes: [...input.resourceScopes],
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      const tokenId = this.id("token");
      const token = issuePrincipalToken(this.tokenHmacSecret);
      await insertPrincipal(client, principal);
      await client.query(
        `insert into delegations(
          delegation_id, org_id, agent_principal_id, user_principal_id,
          capabilities, resource_scopes, expires_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [delegation.delegationId, delegation.orgId, delegation.agentPrincipalId, delegation.userPrincipalId,
          delegation.capabilities, JSON.stringify(delegation.resourceScopes), delegation.expiresAt],
      );
      await insertToken(client, tokenId, principal.orgId, principal.principalId, token, null);
      await this.audit(client, {
        context: input.ownerContext,
        action: "principal.create-agent",
        targetKind: "principal",
        targetId: principal.principalId,
        decision: "completed",
      });
      return { principal, delegation, tokenId, token: token.value };
    });
  }

  async grantResource(input: GrantResourceInput): Promise<ResourceGrant> {
    return await this.database.transaction(async (client) => {
      await this.assertOwner(client, input.ownerContext);
      await this.assertPrincipalInOrganization(client, input.ownerContext.orgId, input.principalId);
      const grant = resourceGrantSchema.parse({
        schema: "openlifewiki.resource-grant/v1",
        grantId: this.id("grant"),
        orgId: input.ownerContext.orgId,
        principalId: input.principalId,
        scope: input.scope,
        capabilities: [...input.capabilities],
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      await insertGrant(client, grant);
      await incrementRegistryRevision(client, grant.orgId);
      await this.audit(client, {
        context: input.ownerContext,
        action: "resource.grant",
        targetKind: "principal",
        targetId: grant.principalId,
        decision: "completed",
      });
      return grant;
    });
  }

  async rotateToken(input: RotateTokenInput): Promise<IssuedTokenRecord> {
    return await this.database.transaction(async (client) => {
      await this.assertOwner(client, input.ownerContext);
      await this.assertPrincipalInOrganization(client, input.ownerContext.orgId, input.principalId);
      const tokenId = this.id("token");
      const token = issuePrincipalToken(this.tokenHmacSecret);
      await client.query(
        `update principal_tokens set revoked_at = now()
         where principal_id = $1 and revoked_at is null`,
        [input.principalId],
      );
      await insertToken(client, tokenId, input.ownerContext.orgId, input.principalId, token, input.expiresAt);
      await this.audit(client, {
        context: input.ownerContext,
        action: "token.rotate",
        targetKind: "principal",
        targetId: input.principalId,
        decision: "completed",
      });
      return { tokenId, principalId: input.principalId, token: token.value };
    });
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.assertOwner(client, input.ownerContext);
      const result = await client.query<{ token_id: string }>(
        "update principal_tokens set revoked_at = now() where token_id = $1 and org_id = $2 returning token_id",
        [input.tokenId, input.ownerContext.orgId],
      );
      if (result.rows[0] === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Token was not found");
      await this.audit(client, {
        context: input.ownerContext,
        action: "token.revoke",
        targetKind: "token",
        targetId: input.tokenId,
        decision: "completed",
      });
    });
  }

  async resolveAccessContext(input: {
    readonly token: string;
    readonly taskId: string;
    readonly now: Date;
  }): Promise<{
    readonly context: AccessContext;
    readonly principal: Principal;
    readonly delegation: Delegation | null;
    readonly grants: readonly ResourceGrant[];
  }> {
    const principal = await this.authenticate(input.token, input.now);
    if (principal === null) throw new AdapterError("AUTHENTICATION_REQUIRED", "Authentication is required");
    let delegation: Delegation | null = null;
    if (principal.type === "agent") {
      const result = await this.database.query<SqlRow>(
        `select * from delegations
         where agent_principal_id = $1 and org_id = $2 and revoked_at is null and expires_at > $3
         order by expires_at asc limit 1`,
        [principal.principalId, principal.orgId, input.now.toISOString()],
      );
      if (result.rows[0] !== undefined) delegation = mapDelegation(result.rows[0]);
      if (delegation === null) throw new AdapterError("DELEGATION_DENIED", "No active delegation is available");
    }
    const userPrincipalId = delegation?.userPrincipalId ?? principal.principalId;
    const context = accessContextSchema.parse({
      schema: "openlifewiki.access-context/v1",
      orgId: principal.orgId,
      actorPrincipalId: principal.principalId,
      actorAgentId: principal.type === "agent" ? principal.principalId : null,
      onBehalfOfUserId: userPrincipalId,
      delegationId: delegation?.delegationId ?? null,
      taskId: input.taskId,
    });
    const grants = await this.loadGrants(context);
    return { context, principal, delegation, grants };
  }

  async createManagedKnowledge(input: CreateManagedKnowledgeInput): Promise<ManagedKnowledgeResult> {
    const content = managedMarkdownInputSchema.parse(input.content);
    if (Buffer.byteLength(content.bodyMarkdown, "utf8") > 1_048_576) {
      throw new AdapterError("BODY_TOO_LARGE", "Managed Markdown exceeds the 1 MiB limit");
    }
    return await this.database.transaction(async (client) => {
      await this.assertAuthorized(client, input.context, "knowledge.store", {
        orgId: input.context.orgId, itemId: null, sourceId: null, tags: content.tags,
      });
      const itemId = this.id("item");
      const locationId = this.id("location");
      const versionId = this.id("version");
      const now = new Date().toISOString();
      const bodyHash = sha256Body(content.bodyMarkdown);
      await client.query(
        `insert into knowledge_items(item_id, org_id, owner_principal_id, title, aliases, status)
         values ($1, $2, $3, $4, $5, 'stable')`,
        [itemId, input.context.orgId, input.context.onBehalfOfUserId, content.title, content.aliases],
      );
      await client.query(
        `insert into knowledge_locations(
          location_id, org_id, item_id, location_kind, location_role, locator,
          connector_instance_id, owner_principal_id, availability, last_verified_at
        ) values ($1, $2, $3, 'managed-markdown', 'canonical', $4, $5, $6, 'available', $7)`,
        [locationId, input.context.orgId, itemId, `openlifewiki-managed://${itemId}`, null,
          input.context.onBehalfOfUserId, now],
      );
      await client.query(
        `insert into knowledge_versions(
          version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
          provenance, created_by_principal_id
        ) values ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8)`,
        [versionId, input.context.orgId, itemId, locationId, bodyHash, content.bodyMarkdown,
          JSON.stringify({ kind: "managed-markdown", actorPrincipalId: input.context.actorPrincipalId }),
          input.context.onBehalfOfUserId],
      );
      await client.query(
        "update knowledge_items set current_version_id = $1, updated_at = $2 where item_id = $3",
        [versionId, now, itemId],
      );
      await this.addTags(client, input.context.orgId, itemId, content.tags);
      await incrementRegistryRevision(client, input.context.orgId);
      await this.audit(client, {
        context: input.context,
        action: "knowledge.store",
        targetKind: "item",
        targetId: itemId,
        decision: "completed",
      });
      const rows = await readManagedResult(client, input.context.orgId, itemId, locationId, versionId);
      if (rows === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Created knowledge could not be loaded");
      return rows;
    });
  }

  async registerLocations(input: RegisterLocationsInput): Promise<RegisterLocationsResult> {
    const locations = input.locations.map((location) => knowledgeLocationInputSchema.parse(location));
    return await this.database.transaction(async (client) => {
      const resource: KnowledgeResource = {
        orgId: input.context.orgId,
        itemId: input.itemId,
        sourceId: null,
        tags: input.tags,
      };
      await this.assertAuthorized(client, input.context, "knowledge.register", resource);
      let itemId = input.itemId;
      if (itemId === null) {
        const existing = await client.query<SqlRow>(
          `select distinct item_id
           from knowledge_locations
           where org_id = $1 and locator = any($2::text[])`,
          [input.context.orgId, locations.map((location) => location.locator)],
        );
        const existingItemIds = new Set(existing.rows.map((row) => String(row.item_id)));
        if (existingItemIds.size > 1) {
          throw new AdapterError("KNOWLEDGE_CONFLICT", "The locators are already registered to different items");
        }
        const existingItemId = existingItemIds.values().next().value as string | undefined;
        if (existingItemId !== undefined) {
          itemId = existingItemId;
          await this.assertAuthorized(client, input.context, "knowledge.register", {
            ...resource,
            itemId,
          });
        }
      }
      if (itemId === null) {
        itemId = this.id("item");
        await client.query(
          `insert into knowledge_items(item_id, org_id, owner_principal_id, title, aliases, status)
           values ($1, $2, $3, $4, $5, 'draft')`,
          [itemId, input.context.orgId, input.context.onBehalfOfUserId, input.title, input.aliases],
        );
      } else {
        const current = await client.query<SqlRow>(
          "select * from knowledge_items where item_id = $1 and org_id = $2 for update",
          [itemId, input.context.orgId],
        );
        const row = current.rows[0];
        if (row === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Knowledge item was not found");
        if (input.expectedRevision !== null && Number(row.revision) !== input.expectedRevision) {
          throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed after preview");
        }
        await client.query(
          `update knowledge_items set title = $1, aliases = $2, revision = revision + 1, updated_at = now()
           where item_id = $3 and org_id = $4 and revision = $5`,
          [input.title, input.aliases, itemId, input.context.orgId, Number(row.revision)],
        );
      }
      const storedLocations: KnowledgeLocation[] = [];
      for (const location of locations) {
        const locationId = this.id("location");
        await client.query(
          `insert into knowledge_locations(
            location_id, org_id, item_id, location_kind, location_role, locator,
            connector_instance_id, owner_principal_id, metadata, availability
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
          on conflict (org_id, locator) do nothing`,
          [locationId, input.context.orgId, itemId, location.kind, location.role, location.locator,
            location.connectorInstanceId, location.ownerPrincipalId, JSON.stringify(location.metadata),
            location.kind === "person-local" ? "offline" : "unknown"],
        );
        const found = await client.query<SqlRow>(
          "select * from knowledge_locations where org_id = $1 and locator = $2",
          [input.context.orgId, location.locator],
        );
        const row = found.rows[0];
        if (row === undefined || String(row.item_id) !== itemId) {
          throw new AdapterError("KNOWLEDGE_CONFLICT", "The locator is already registered to another item");
        }
        storedLocations.push(mapLocation(row));
      }
      await this.addTags(client, input.context.orgId, itemId, input.tags);
      await incrementRegistryRevision(client, input.context.orgId);
      await this.audit(client, {
        context: input.context,
        action: "knowledge.register",
        targetKind: "item",
        targetId: itemId,
        decision: "completed",
      });
      const item = await readItem(client, itemId, input.context.orgId);
      if (item === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Registered knowledge could not be loaded");
      return { item, locations: storedLocations };
    });
  }

  async replaceManagedKnowledge(input: ReplaceManagedKnowledgeInput): Promise<ManagedKnowledgeResult> {
    const content = managedMarkdownInputSchema.parse(input.content);
    return await this.database.transaction(async (client) => {
      await this.assertAuthorized(client, input.context, "knowledge.store", {
        orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: content.tags,
      });
      const current = await client.query<SqlRow>(
        `select ki.*, kl.location_id, kv.version_id, kv.body_hash, kv.ordinal
         from knowledge_items ki
         join knowledge_locations kl on kl.item_id = ki.item_id and kl.location_kind = 'managed-markdown'
         join knowledge_versions kv on kv.version_id = ki.current_version_id
         where ki.item_id = $1 and ki.org_id = $2 for update`,
        [input.itemId, input.context.orgId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Managed knowledge was not found");
      if (Number(row.revision) !== input.expectedRevision) throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed after preview");
      const preview = {
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        oldBodyHash: String(row.body_hash),
        newBodyHash: sha256Body(content.bodyMarkdown),
        oldTitle: String(row.title),
        newTitle: content.title,
      };
      if (sha256Canonical(preview) !== input.previewHash) {
        throw new AdapterError("APPROVAL_REQUIRED", "Managed knowledge preview does not match the requested write");
      }
      const versionId = this.id("version");
      await client.query(
        `insert into knowledge_versions(
          version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
          provenance, created_by_principal_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [versionId, input.context.orgId, input.itemId, String(row.location_id), Number(row.ordinal) + 1,
          preview.newBodyHash, content.bodyMarkdown, JSON.stringify({ kind: "managed-markdown", replaced: String(row.version_id) }),
          input.context.onBehalfOfUserId],
      );
      const updated = await client.query<SqlRow>(
        `update knowledge_items set title = $1, aliases = $2, current_version_id = $3,
         revision = revision + 1, updated_at = now()
         where item_id = $4 and org_id = $5 and revision = $6 returning *`,
        [content.title, content.aliases, versionId, input.itemId, input.context.orgId, input.expectedRevision],
      );
      if (updated.rows[0] === undefined) throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed during write");
      await this.addTags(client, input.context.orgId, input.itemId, content.tags);
      await incrementRegistryRevision(client, input.context.orgId);
      await this.audit(client, {
        context: input.context,
        action: "knowledge.store.replace",
        targetKind: "item",
        targetId: input.itemId,
        decision: "completed",
      });
      const result = await readManagedResult(client, input.context.orgId, input.itemId, String(row.location_id), versionId);
      if (result === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Replaced knowledge could not be loaded");
      return result;
    });
  }

  async searchAuthorized(input: SearchAuthorizedInput): Promise<readonly KnowledgeSearchCandidate[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 50);
    const now = new Date();
    await this.assertAgentAuthority(input.context, "knowledge.query", now);
    const result = await this.database.query<SqlRow>(
      `with authorized_items as (
        select distinct ki.*
        from knowledge_items ki
        join resource_grants rg on rg.org_id = ki.org_id
          and rg.principal_id = $1
          and rg.revoked_at is null
          and (rg.expires_at is null or rg.expires_at > $2)
          and 'knowledge.query' = any(rg.capabilities)
          and (
            (rg.scope_kind = 'organization' and rg.scope_id = ki.org_id)
            or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
            or (rg.scope_kind = 'tag' and exists (
              select 1 from knowledge_tags kt join tags t on t.tag_id = kt.tag_id
              where kt.item_id = ki.item_id and t.name = rg.scope_id
            ))
          )
          and (
            $5::text is null
            or exists (
              select 1
              from delegations d
              join principals ap on ap.principal_id = d.agent_principal_id
                and ap.org_id = d.org_id and ap.status = 'active'
              where d.delegation_id = $5
                and d.org_id = ki.org_id
                and d.agent_principal_id = $6
                and d.user_principal_id = $1
                and d.revoked_at is null
                and d.expires_at > $2
                and 'knowledge.query' = any(d.capabilities)
                and 'knowledge.query' = any(ap.capabilities)
                and exists (
                  select 1
                  from jsonb_array_elements(d.resource_scopes) as delegated_scope
                  where (delegated_scope->>'kind' = 'organization' and delegated_scope->>'id' = ki.org_id)
                     or (delegated_scope->>'kind' = 'item' and delegated_scope->>'id' = ki.item_id)
                     or (delegated_scope->>'kind' = 'tag' and exists (
                       select 1 from knowledge_tags delegated_tag
                       join tags delegated_tag_name on delegated_tag_name.tag_id = delegated_tag.tag_id
                       where delegated_tag.item_id = ki.item_id
                         and delegated_tag_name.name = delegated_scope->>'id'
                     ))
                )
            )
          )
      )
      select ai.item_id, kl.location_id, kv.version_id, ai.title, kl.locator,
             coalesce(array(
               select distinct t.name from knowledge_tags kt join tags t on t.tag_id = kt.tag_id
               where kt.item_id = ai.item_id
             ), '{}') as tags,
             case when kv.body_markdown is null then null else left(kv.body_markdown, 500) end as snippet,
             case when kv.version_id is null then 'unknown' when kl.availability = 'available' then 'current' else 'stale' end as freshness,
             kl.availability
      from authorized_items ai
      join knowledge_locations kl on kl.item_id = ai.item_id
      left join knowledge_versions kv on kv.version_id = ai.current_version_id
      where ai.item_id = $3 or kl.locator = $3 or ai.title ilike '%' || $3 || '%'
         or coalesce(kv.body_markdown, '') ilike '%' || $3 || '%'
         or to_tsvector('simple', ai.title || ' ' || coalesce(kv.body_markdown, ''))
            @@ websearch_to_tsquery('simple', $3)
      order by ai.updated_at desc
      limit $4`,
      [input.context.onBehalfOfUserId, now.toISOString(), input.query, limit,
        input.context.delegationId, input.context.actorAgentId],
    );
    return result.rows.map((row) => ({
      itemId: String(row.item_id),
      locationId: String(row.location_id),
      versionId: row.version_id === null ? null : String(row.version_id),
      title: String(row.title),
      locator: String(row.locator),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      snippet: row.snippet === null ? null : String(row.snippet),
      freshness: row.freshness as "current" | "stale" | "unknown",
      availability: row.availability as "available" | "offline" | "unknown" | "revoked",
    }));
  }

  async getAuthorized(input: GetAuthorizedInput): Promise<KnowledgeEvidence | null> {
    const now = new Date();
    await this.assertAgentAuthority(input.context, "knowledge.query", now);
    const result = await this.database.query<SqlRow>(
      `select ki.item_id, ki.title, kl.location_id, kl.locator, kl.availability,
              kv.version_id, kv.body_hash, kv.body_markdown, kv.provider_version,
              exists (
                select 1 from resource_grants rg
                where rg.org_id = ki.org_id and rg.principal_id = $1
                  and rg.revoked_at is null and (rg.expires_at is null or rg.expires_at > $2)
                  and 'knowledge.query' = any(rg.capabilities)
                  and (
                    (rg.scope_kind = 'organization' and rg.scope_id = ki.org_id)
                    or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
                    or (rg.scope_kind = 'tag' and exists (
                      select 1 from knowledge_tags kt join tags t on t.tag_id = kt.tag_id
                      where kt.item_id = ki.item_id and t.name = rg.scope_id
                    ))
                  )
              ) as authorized
       from knowledge_items ki
       join knowledge_locations kl on kl.item_id = ki.item_id
       left join knowledge_versions kv on kv.version_id = coalesce($4, ki.current_version_id)
         and kv.item_id = ki.item_id and kv.location_id = kl.location_id
       where ki.org_id = $6 and ki.item_id = $3 and kl.location_id = $5
         and (
           $7::text is null
           or exists (
             select 1
             from delegations d
             join principals ap on ap.principal_id = d.agent_principal_id
               and ap.org_id = d.org_id and ap.status = 'active'
             where d.delegation_id = $7
               and d.org_id = ki.org_id
               and d.agent_principal_id = $8
               and d.user_principal_id = $1
               and d.revoked_at is null
               and d.expires_at > $2
               and 'knowledge.query' = any(d.capabilities)
               and 'knowledge.query' = any(ap.capabilities)
               and exists (
                 select 1
                 from jsonb_array_elements(d.resource_scopes) as delegated_scope
                 where (delegated_scope->>'kind' = 'organization' and delegated_scope->>'id' = ki.org_id)
                    or (delegated_scope->>'kind' = 'item' and delegated_scope->>'id' = ki.item_id)
                    or (delegated_scope->>'kind' = 'tag' and exists (
                      select 1 from knowledge_tags delegated_tag
                      join tags delegated_tag_name on delegated_tag_name.tag_id = delegated_tag.tag_id
                      where delegated_tag.item_id = ki.item_id
                        and delegated_tag_name.name = delegated_scope->>'id'
                    ))
               )
           )
         )
       limit 1`,
      [input.context.onBehalfOfUserId, now.toISOString(), input.itemId, input.versionId, input.locationId,
        input.context.orgId, input.context.delegationId, input.context.actorAgentId],
    );
    const row = result.rows[0];
    if (row === undefined || row.authorized !== true || row.body_markdown === null || row.version_id === null) return null;
    const citation: KnowledgeCitation = knowledgeCitationSchema.parse({
      citationId: this.id("citation"),
      itemId: String(row.item_id),
      locationId: String(row.location_id),
      versionId: String(row.version_id),
      locator: String(row.locator),
      title: String(row.title),
      bodyHash: String(row.body_hash),
    });
    return knowledgeEvidenceSchema.parse({
      citation,
      bodyMarkdown: String(row.body_markdown),
      providerVersion: row.provider_version === null ? null : String(row.provider_version),
    });
  }

  async shareItem(input: ShareItemInput): Promise<ResourceGrant> {
    return await this.database.transaction(async (client) => {
      await this.assertAuthorized(client, input.context, "knowledge.share", {
        orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: [],
      });
      await this.assertPrincipalInOrganization(client, input.context.orgId, input.targetPrincipalId);
      const grant = resourceGrantSchema.parse({
        schema: "openlifewiki.resource-grant/v1",
        grantId: this.id("grant"),
        orgId: input.context.orgId,
        principalId: input.targetPrincipalId,
        scope: { kind: "item", id: input.itemId },
        capabilities: [...input.capabilities],
        expiresAt: null,
        revokedAt: null,
      });
      await insertGrant(client, grant);
      await incrementRegistryRevision(client, input.context.orgId);
      await this.audit(client, {
        context: input.context,
        action: "knowledge.share",
        targetKind: "item",
        targetId: input.itemId,
        decision: "completed",
      });
      return grant;
    });
  }

  async createTaskForAuthenticatedPrincipal(input: CreateTaskInput): Promise<StoredAgentTask> {
    const parsed = knowledgeOperationSchema.parse(input.input);
    await this.database.query(
      `insert into agent_tasks(
        task_id, context_id, org_id, owner_principal_id, actor_agent_id, delegation_id,
        state, input_json
      ) values ($1, $2, $3, $4, $5, $6, 'submitted', $7::jsonb)`,
      [input.taskId, input.contextId, input.principal.orgId, input.principal.type === "agent" ? input.principal.principalId : input.principal.principalId,
        input.principal.type === "agent" ? input.principal.principalId : null, null, JSON.stringify(parsed)],
    );
    const task = await this.loadTask(input.taskId, input.principal.principalId);
    if (task === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Created task could not be loaded");
    return task;
  }

  async ensureAgentSession(input: EnsureAgentSessionInput): Promise<void> {
    await this.database.transaction(async (client) => {
      const owner = await client.query<{ principal_id: string }>(
        `select principal_id
         from principals
         where principal_id = $1
           and org_id = $2
           and principal_type = 'user'
           and organization_role = 'owner'
           and status = 'active'
         for share`,
        [input.ownerPrincipalId, input.orgId],
      );
      if (owner.rows[0] === undefined) {
        throw new AdapterError("DELEGATION_DENIED", "Agent session owner is not authorized");
      }
      await client.query(
        `insert into agent_sessions(session_id, org_id, owner_principal_id)
         values ($1, $2, $3)
         on conflict (session_id) do nothing`,
        [input.sessionId, input.orgId, input.ownerPrincipalId],
      );
      const result = await client.query<SqlRow>(
        `select org_id, owner_principal_id
         from agent_sessions
         where session_id = $1
         for update`,
        [input.sessionId],
      );
      const row = result.rows[0];
      if (row === undefined
        || row.org_id !== input.orgId
        || row.owner_principal_id !== input.ownerPrincipalId) {
        throw new AdapterError("DELEGATION_DENIED", "Agent session ownership does not match");
      }
    });
  }

  async readAgentSession(input: EnsureAgentSessionInput): Promise<readonly unknown[]> {
    const result = await this.database.query<SqlRow>(
      `select org_id, owner_principal_id, history_json
       from agent_sessions
       where session_id = $1`,
      [input.sessionId],
    );
    const row = result.rows[0];
    assertAgentSessionScope(row, input);
    return parseAgentSessionHistory(row.history_json);
  }

  async appendAgentSession(input: AppendAgentSessionInput): Promise<void> {
    const items = safeSerializeSessionHistory(input.items);
    await this.database.transaction(async (client) => {
      const row = await lockAgentSession(client, input);
      if (items.length === 0) return;
      const history = parseAgentSessionHistory(row.history_json);
      await client.query(
        `update agent_sessions
         set history_json = $1::jsonb, revision = revision + 1, updated_at = now()
         where session_id = $2`,
        [JSON.stringify([...history, ...items]), input.sessionId],
      );
    });
  }

  async popAgentSession(input: EnsureAgentSessionInput): Promise<unknown | undefined> {
    return await this.database.transaction(async (client) => {
      const row = await lockAgentSession(client, input);
      const history = parseAgentSessionHistory(row.history_json);
      if (history.length === 0) return undefined;
      const item = history.at(-1);
      await client.query(
        `update agent_sessions
         set history_json = $1::jsonb, revision = revision + 1, updated_at = now()
         where session_id = $2`,
        [JSON.stringify(history.slice(0, -1)), input.sessionId],
      );
      return item;
    });
  }

  async clearAgentSession(input: EnsureAgentSessionInput): Promise<void> {
    await this.database.transaction(async (client) => {
      await lockAgentSession(client, input);
      await client.query(
        `update agent_sessions
         set history_json = '[]'::jsonb, revision = revision + 1, updated_at = now()
         where session_id = $1`,
        [input.sessionId],
      );
    });
  }

  async markTaskWorking(taskId: string, expectedRevision: number): Promise<StoredAgentTask> {
    return await this.updateTask(taskId, expectedRevision, { state: "working" });
  }

  async pauseTask(input: PauseTaskInput): Promise<StoredAgentTask> {
    return await this.updateTask(input.taskId, input.expectedRevision, {
      state: "input-required", runState: input.runState, errorCode: input.errorCode,
    });
  }

  async completeTask(input: CompleteTaskInput): Promise<StoredAgentTask> {
    return await this.updateTask(input.taskId, input.expectedRevision, {
      state: "completed", output: input.output, runState: null, errorCode: null,
    });
  }

  async failTask(input: FailTaskInput): Promise<StoredAgentTask> {
    return await this.updateTask(input.taskId, input.expectedRevision, {
      state: "failed", runState: null, errorCode: input.code,
    });
  }

  async requestTaskCancellation(taskId: string): Promise<void> {
    await this.database.query("update agent_tasks set cancel_requested = true, updated_at = now() where task_id = $1", [taskId]);
  }

  async settleCanceledTask(taskId: string): Promise<StoredAgentTask> {
    const result = await this.database.query<SqlRow>(
      `update agent_tasks set state = 'canceled', revision = revision + 1, updated_at = now()
       where task_id = $1 returning *`,
      [taskId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Task was not found");
    return mapTask(row);
  }

  async loadTask(taskId: string, principalId: string): Promise<StoredAgentTask | null> {
    const result = await this.database.query<SqlRow>(
      `select * from agent_tasks where task_id = $1 and (owner_principal_id = $2 or actor_agent_id = $2)`,
      [taskId, principalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTask(row);
  }

  async listRecoverableTasks(): Promise<readonly StoredAgentTask[]> {
    const result = await this.database.query<SqlRow>(
      "select * from agent_tasks where state in ('submitted', 'working', 'input-required') order by created_at",
    );
    return result.rows.map(mapTask);
  }

  private async updateTask(
    taskId: string,
    expectedRevision: number,
    patch: { readonly state: StoredAgentTask["state"]; readonly output?: unknown; readonly runState?: string | null; readonly errorCode?: KnowledgeErrorCode | null },
  ): Promise<StoredAgentTask> {
    const result = await this.database.query<SqlRow>(
      `update agent_tasks set state = $1, output_json = coalesce($2::jsonb, output_json),
       run_state = $3, error_code = $4, revision = revision + 1, updated_at = now()
       where task_id = $5 and revision = $6 returning *`,
      [patch.state, patch.output === undefined ? null : JSON.stringify(patch.output), patch.runState ?? null,
        patch.errorCode ?? null, taskId, expectedRevision],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AdapterError("REVISION_CONFLICT", "Task revision changed after preview");
    return mapTask(row);
  }

  private async loadGrants(context: AccessContext): Promise<readonly ResourceGrant[]> {
    const result = await this.database.query<SqlRow>(
      `select * from resource_grants
       where org_id = $1 and principal_id = $2 and revoked_at is null
       and (expires_at is null or expires_at > now())`,
      [context.orgId, context.onBehalfOfUserId],
    );
    return result.rows.map(mapGrant);
  }

  private async assertOwner(client: import("pg").PoolClient, context: AccessContext): Promise<void> {
    if (context.actorAgentId !== null) throw new AdapterError("DELEGATION_DENIED", "Only a human Owner may perform this operation");
    const result = await client.query<SqlRow>(
      "select organization_role from principals where principal_id = $1 and org_id = $2 and status = 'active'",
      [context.onBehalfOfUserId, context.orgId],
    );
    if (result.rows[0]?.organization_role !== "owner") throw new AdapterError("DELEGATION_DENIED", "Owner authority is required");
  }

  private async assertPrincipalInOrganization(
    client: import("pg").PoolClient,
    orgId: string,
    principalId: string,
    expectedType?: Principal["type"],
  ): Promise<void> {
    const result = await client.query<SqlRow>(
      `select principal_type
       from principals
       where principal_id = $1 and org_id = $2 and status = 'active'`,
      [principalId, orgId],
    );
    if (result.rows[0] === undefined
      || (expectedType !== undefined && result.rows[0].principal_type !== expectedType)) {
      throw new AdapterError("DELEGATION_DENIED", "The target principal is not active in this organization");
    }
  }

  private async assertAuthorized(
    client: import("pg").PoolClient,
    context: AccessContext,
    capability: KnowledgeCapability,
    resource: KnowledgeResource,
  ): Promise<void> {
    const grantsResult = await client.query<SqlRow>(
      "select * from resource_grants where org_id = $1 and principal_id = $2",
      [context.orgId, context.onBehalfOfUserId],
    );
    const grants = grantsResult.rows.map(mapGrant);
    let delegation: Delegation | null = null;
    if (context.delegationId !== null) {
      const delegationResult = await client.query<SqlRow>(
        "select * from delegations where delegation_id = $1 and org_id = $2",
        [context.delegationId, context.orgId],
      );
      const row = delegationResult.rows[0];
      if (row !== undefined) delegation = mapDelegation(row);
    }
    const principalResult = await client.query<SqlRow>(
      "select capabilities from principals where principal_id = $1 and org_id = $2 and status = 'active'",
      [context.actorPrincipalId, context.orgId],
    );
    const agentCapabilities = (principalResult.rows[0]?.capabilities ?? []) as KnowledgeCapability[];
    const decision = authorizeKnowledgeOperation({
      context,
      capability,
      resource,
      userGrants: grants,
      agentCapabilities,
      delegation,
      now: new Date(),
    });
    if (!decision.allowed) throw new AdapterError(decision.code, "Knowledge operation is not authorized");
  }

  private async assertAgentAuthority(
    context: AccessContext,
    capability: KnowledgeCapability,
    now: Date,
  ): Promise<void> {
    if (context.actorAgentId === null) return;
    if (context.delegationId === null) throw new AdapterError("DELEGATION_DENIED", "Agent delegation is required");
    const result = await this.database.query<SqlRow>(
      `select d.*, ap.capabilities as agent_capabilities
       from delegations d
       join principals ap on ap.principal_id = d.agent_principal_id
         and ap.org_id = d.org_id and ap.status = 'active'
       where d.delegation_id = $1
         and d.org_id = $2
         and d.agent_principal_id = $3
         and d.user_principal_id = $4
         and d.revoked_at is null
         and d.expires_at > $5`,
      [context.delegationId, context.orgId, context.actorAgentId, context.onBehalfOfUserId, now.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AdapterError("DELEGATION_DENIED", "Agent delegation is not active");
    const delegation = mapDelegation(row);
    const agentCapabilities = Array.isArray(row.agent_capabilities)
      ? row.agent_capabilities.map(String)
      : [];
    if (delegation.revokedAt !== null
      || Date.parse(delegation.expiresAt) <= now.getTime()
      || !delegation.capabilities.includes(capability)
      || !agentCapabilities.includes(capability)) {
      throw new AdapterError("DELEGATION_DENIED", "Agent delegation does not allow this operation");
    }
  }

  private async addTags(client: import("pg").PoolClient, orgId: string, itemId: string, tags: readonly string[]): Promise<void> {
    for (const name of new Set(tags)) {
      const tagId = this.id("tag");
      await client.query(
        `insert into tags(tag_id, org_id, name) values ($1, $2, $3)
         on conflict (org_id, name) do nothing`,
        [tagId, orgId, name],
      );
      const tag = await client.query<SqlRow>("select tag_id from tags where org_id = $1 and name = $2", [orgId, name]);
      if (tag.rows[0] !== undefined) {
        await client.query(
          `insert into knowledge_tags(org_id, item_id, tag_id) values ($1, $2, $3)
           on conflict (org_id, item_id, tag_id) do nothing`,
          [orgId, itemId, String(tag.rows[0].tag_id)],
        );
      }
    }
  }

  private async audit(
    client: import("pg").PoolClient,
    input: { readonly context: AccessContext; readonly action: string; readonly targetKind: string; readonly targetId: string; readonly decision: "allowed" | "denied" | "completed" | "failed" },
  ): Promise<void> {
    await client.query(
      `insert into audit_events(
        audit_event_id, org_id, task_id, actor_principal_id, on_behalf_of_user_id,
        action, target_kind, target_id, decision
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [this.id("audit"), input.context.orgId, input.context.taskId, input.context.actorPrincipalId,
        input.context.onBehalfOfUserId, input.action, input.targetKind, input.targetId, input.decision],
    );
  }

  private id(prefix: string): string {
    return `${prefix}_${this.ids()}`;
  }
}

async function insertPrincipal(client: import("pg").PoolClient, principal: Principal): Promise<void> {
  await client.query(
    `insert into principals(
      principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
    ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [principal.principalId, principal.orgId, principal.type, principal.displayName,
      principal.organizationRole, principal.capabilities, principal.status],
  );
}

async function insertToken(
  client: import("pg").PoolClient,
  tokenId: string,
  orgId: string,
  principalId: string,
  token: IssuedToken,
  expiresAt: string | null,
): Promise<void> {
  await client.query(
    `insert into principal_tokens(token_id, org_id, principal_id, token_prefix, token_digest, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [tokenId, orgId, principalId, token.prefix, token.digest, expiresAt],
  );
}

async function insertGrant(client: import("pg").PoolClient, grant: ResourceGrant): Promise<void> {
  await client.query(
    `insert into resource_grants(
      grant_id, org_id, principal_id, scope_kind, scope_id, capabilities, expires_at, revoked_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [grant.grantId, grant.orgId, grant.principalId, grant.scope.kind, grant.scope.id,
      grant.capabilities, grant.expiresAt, grant.revokedAt],
  );
}

async function incrementRegistryRevision(client: import("pg").PoolClient, orgId: string): Promise<void> {
  await client.query("update organizations set registry_revision = registry_revision + 1 where org_id = $1", [orgId]);
}

async function readItem(client: import("pg").PoolClient, itemId: string, orgId: string): Promise<KnowledgeItem | null> {
  const result = await client.query<SqlRow>("select * from knowledge_items where item_id = $1 and org_id = $2", [itemId, orgId]);
  return result.rows[0] === undefined ? null : mapItem(result.rows[0]);
}

async function readManagedResult(
  client: import("pg").PoolClient,
  orgId: string,
  itemId: string,
  locationId: string,
  versionId: string,
): Promise<ManagedKnowledgeResult | null> {
  const item = await readItem(client, itemId, orgId);
  const locationResult = await client.query<SqlRow>(
    "select * from knowledge_locations where org_id = $1 and item_id = $2 and location_id = $3",
    [orgId, itemId, locationId],
  );
  const versionResult = await client.query<SqlRow>(
    "select * from knowledge_versions where org_id = $1 and item_id = $2 and location_id = $3 and version_id = $4",
    [orgId, itemId, locationId, versionId],
  );
  const location = locationResult.rows[0];
  const version = versionResult.rows[0];
  if (item === null || location === undefined || version === undefined) return null;
  return {
    item,
    location: mapLocation(location),
    version: mapVersion(version),
  };
}

function mapPrincipal(row: SqlRow): Principal {
  return principalSchema.parse({
    schema: "openlifewiki.principal/v1",
    principalId: String(row.principal_id),
    orgId: String(row.org_id),
    type: row.principal_type,
    displayName: String(row.display_name),
    organizationRole: row.organization_role,
    capabilities: row.capabilities ?? [],
    status: row.status,
  });
}

function mapDelegation(row: SqlRow): Delegation {
  return delegationSchema.parse({
    schema: "openlifewiki.delegation/v1",
    delegationId: String(row.delegation_id),
    orgId: String(row.org_id),
    agentPrincipalId: String(row.agent_principal_id),
    userPrincipalId: String(row.user_principal_id),
    capabilities: row.capabilities ?? [],
    resourceScopes: row.resource_scopes,
    expiresAt: toTimestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toTimestamp(row.revoked_at),
  });
}

function mapGrant(row: SqlRow): ResourceGrant {
  return resourceGrantSchema.parse({
    schema: "openlifewiki.resource-grant/v1",
    grantId: String(row.grant_id),
    orgId: String(row.org_id),
    principalId: String(row.principal_id),
    scope: { kind: row.scope_kind, id: String(row.scope_id) },
    capabilities: row.capabilities ?? [],
    expiresAt: row.expires_at === null ? null : toTimestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toTimestamp(row.revoked_at),
  });
}

function mapItem(row: SqlRow): KnowledgeItem {
  return knowledgeItemSchema.parse({
    schema: "openlifewiki.knowledge-item/v1",
    itemId: String(row.item_id),
    orgId: String(row.org_id),
    ownerPrincipalId: String(row.owner_principal_id),
    title: String(row.title),
    aliases: row.aliases ?? [],
    status: row.status,
    currentVersionId: row.current_version_id === null ? null : String(row.current_version_id),
    revision: Number(row.revision),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  });
}

function mapLocation(row: SqlRow): KnowledgeLocation {
  return knowledgeLocationSchema.parse({
    schema: "openlifewiki.knowledge-location/v1",
    locationId: String(row.location_id),
    itemId: String(row.item_id),
    kind: row.location_kind,
    role: row.location_role,
    locator: String(row.locator),
    connectorInstanceId: row.connector_instance_id === null ? null : String(row.connector_instance_id),
    ownerPrincipalId: String(row.owner_principal_id),
    metadata: row.metadata ?? {},
    observedProviderVersion: row.observed_provider_version === null ? null : String(row.observed_provider_version),
    availability: row.availability,
    revision: Number(row.revision),
    lastVerifiedAt: row.last_verified_at === null ? null : toTimestamp(row.last_verified_at),
  });
}

function mapVersion(row: SqlRow): KnowledgeVersion {
  return knowledgeVersionSchema.parse({
    schema: "openlifewiki.knowledge-version/v1",
    versionId: String(row.version_id),
    itemId: String(row.item_id),
    locationId: String(row.location_id),
    ordinal: Number(row.ordinal),
    bodyHash: String(row.body_hash),
    bodyMarkdown: row.body_markdown === null ? null : String(row.body_markdown),
    providerVersion: row.provider_version === null ? null : String(row.provider_version),
    provenance: row.provenance ?? {},
    createdByPrincipalId: String(row.created_by_principal_id),
    createdAt: toTimestamp(row.created_at),
  });
}

function mapTask(row: SqlRow): StoredAgentTask {
  return {
    taskId: String(row.task_id),
    contextId: String(row.context_id),
    orgId: String(row.org_id),
    ownerPrincipalId: String(row.owner_principal_id),
    actorAgentId: row.actor_agent_id === null ? null : String(row.actor_agent_id),
    delegationId: row.delegation_id === null ? null : String(row.delegation_id),
    state: row.state,
    input: knowledgeOperationSchema.parse(row.input_json),
    output: row.output_json ?? null,
    runState: row.run_state === null ? null : String(row.run_state),
    errorCode: row.error_code === null ? null : row.error_code,
    revision: Number(row.revision),
  };
}

async function lockAgentSession(
  client: import("pg").PoolClient,
  input: EnsureAgentSessionInput,
): Promise<SqlRow> {
  const result = await client.query<SqlRow>(
    `select org_id, owner_principal_id, history_json
     from agent_sessions
     where session_id = $1
     for update`,
    [input.sessionId],
  );
  const row = result.rows[0];
  assertAgentSessionScope(row, input);
  return row;
}

function assertAgentSessionScope(
  row: SqlRow | undefined,
  input: EnsureAgentSessionInput,
): asserts row is SqlRow {
  if (row === undefined
    || row.org_id !== input.orgId
    || row.owner_principal_id !== input.ownerPrincipalId) {
    throw new AdapterError("DELEGATION_DENIED", "Agent session ownership does not match");
  }
}

function parseAgentSessionHistory(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
  }
  try {
    assertNoSensitiveKeys(value, new WeakSet<object>());
    assertAgentInputItemShapes(value);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
  }
  return value;
}

function safeSerializeSessionHistory(items: readonly unknown[]): unknown[] {
  try {
    assertNoSensitiveKeys(items, new WeakSet<object>());
    assertAgentInputItemShapes(items);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(items);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is not durable JSON");
  }
  let clone: unknown;
  try {
    clone = JSON.parse(serialized);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is not durable JSON");
  }
  if (!Array.isArray(clone)) {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
  }
  try {
    assertNoSensitiveKeys(clone, new WeakSet<object>());
    assertAgentInputItemShapes(clone);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
  }
  return clone;
}

function assertNoSensitiveKeys(value: unknown, ancestors: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    throw new AdapterError("INVALID_OPERATION", "Agent session items contain a cycle");
  }
  ancestors.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      if (/api[_-]?key|authorization|token|credential|password/iu.test(key)) {
        throw new AdapterError("INVALID_OPERATION", "Agent session items contain sensitive data");
      }
      assertNoSensitiveKeys(nested, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

const AGENT_INPUT_ITEM_TYPES = new Set([
  "apply_patch_call",
  "apply_patch_call_output",
  "compaction",
  "computer_call",
  "computer_call_result",
  "function_call",
  "function_call_result",
  "hosted_tool_call",
  "program",
  "program_output",
  "reasoning",
  "shell_call",
  "shell_call_output",
  "tool_search_call",
  "tool_search_output",
  "unknown",
]);

function assertAgentInputItemShapes(items: readonly unknown[]): void {
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
    }
    const record = item as Record<string, unknown>;
    if (record.type === undefined || record.type === "message") {
      if ((record.role !== "user" && record.role !== "assistant" && record.role !== "system")
        || (typeof record.content !== "string" && !Array.isArray(record.content))) {
        throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
      }
      continue;
    }
    if (typeof record.type !== "string" || !AGENT_INPUT_ITEM_TYPES.has(record.type)) {
      throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
    }
  }
}

function toTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sha256Body(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function humanContext(orgId: string, principalId: string, taskId: string): AccessContext {
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
