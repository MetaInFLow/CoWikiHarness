import { createHash, randomUUID } from "node:crypto";

import {
  authorizeKnowledgeOperation,
  canonicalJson,
  sha256Canonical,
  type KnowledgeResource,
} from "@openlifewiki/core";
import {
  KNOWLEDGE_ERROR_CODES,
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
  storePreviewSchema,
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
  type StorePreview,
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

const STORED_TASK_STATE_SCHEMA = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
]);
const STORED_TASK_ERROR_CODE_SCHEMA = z.enum(KNOWLEDGE_ERROR_CODES);
const MAX_A2A_TASK_JSON_BYTES = 1_048_576;
const MAX_A2A_HISTORY = 100;
const MAX_A2A_ARTIFACTS = 50;
const MAX_A2A_PARTS = 50;
const MAX_A2A_PART_BYTES = 65_536;
const MAX_A2A_ARTIFACT_BYTES = 262_144;
const SHAREABLE_CAPABILITIES = new Set<KnowledgeCapability>([
  "knowledge.query",
  "knowledge.store",
  "knowledge.organize",
]);

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
  readonly approvalTaskId?: string;
  readonly itemId: string;
  readonly expectedRevision: number;
  readonly previewHash: string;
  readonly content: z.infer<typeof managedMarkdownInputSchema>;
}
export interface PreviewManagedKnowledgeInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly expectedRevision: number;
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
  readonly capabilities: readonly ("knowledge.query" | "knowledge.store" | "knowledge.organize")[];
}
export interface ShareItemResult {
  readonly grant: ResourceGrant;
  readonly item: KnowledgeItem;
  readonly locations: readonly KnowledgeLocation[];
}
export interface ListKnowledgeLocationsInput {
  readonly context: AccessContext;
  readonly itemId: string;
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
export interface TaskRevisionInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly principalId: string;
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
  readonly cancelRequested: boolean;
  readonly revision: number;
}
export interface SaveA2ATaskInput {
  readonly taskId: string;
  readonly principalId: string;
  readonly expectedA2ARevision: number | null;
  readonly taskJson: unknown;
}
export interface SavedA2ATask {
  readonly taskJson: unknown;
  readonly a2aRevision: number;
}
export interface ListA2ATasksInput {
  readonly principalId: string;
  readonly contextId: string | null;
  readonly status: number | null;
  readonly statusTimestampAfter: string | null;
  readonly afterUpdatedAt: string | null;
  readonly afterTaskId: string | null;
  readonly limit: number;
}
export interface StoredA2ATaskRow {
  readonly taskId: string;
  readonly taskJson: unknown;
  readonly updatedAt: string;
}
export interface StoredA2ATaskPage {
  readonly rows: readonly StoredA2ATaskRow[];
  readonly totalSize: number;
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
    let targetId = input.context.orgId;
    try {
      assertManagedBodyBudget(input.content.bodyMarkdown);
      const content = managedMarkdownInputSchema.parse(input.content);
      return await this.database.transaction(async (client) => {
        await this.assertAuthorized(client, input.context, "knowledge.store", {
          orgId: input.context.orgId, itemId: null, sourceId: null, tags: content.tags,
        });
        const itemId = this.id("item");
        targetId = itemId;
        const locationId = this.id("location");
        const versionId = this.id("version");
        const now = new Date().toISOString();
        const bodyHash = sha256Body(content.bodyMarkdown);
        await client.query(
          `insert into knowledge_items(item_id, org_id, owner_principal_id, title, aliases, status)
           values ($1, $2, $3, $4, $5, 'draft')`,
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
        await this.ensureOwnerItemGrant(client, input.context, itemId);
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
    } catch (error) {
      const normalized = normalizeKnowledgeWriteError(error);
      await this.auditRejectedWrite(input.context, "knowledge.store", targetId, normalized.code);
      throw normalized;
    }
  }

  async registerLocations(input: RegisterLocationsInput): Promise<RegisterLocationsResult> {
    let targetId = input.itemId ?? input.context.orgId;
    try {
      const locations = deduplicateLocationInputs(
        input.locations.map((location) => knowledgeLocationInputSchema.parse(location)),
      );
      return await this.database.transaction(async (client) => {
        for (const location of locations) {
          await this.assertPrincipalInOrganization(client, input.context.orgId, location.ownerPrincipalId);
          if (location.connectorInstanceId !== null) {
            const connector = await client.query(
              `select 1 from connector_instances
               where connector_instance_id = $1 and org_id = $2 and status = 'active'`,
              [location.connectorInstanceId, input.context.orgId],
            );
            if (connector.rows[0] === undefined) {
              throw new AdapterError("DELEGATION_DENIED", "The connector is not active in this organization");
            }
          }
        }
        const resource: KnowledgeResource = {
          orgId: input.context.orgId,
          itemId: input.itemId,
          sourceId: null,
          tags: input.tags,
        };
        const existingLocations = await client.query<SqlRow>(
          `select * from knowledge_locations
           where org_id = $1 and locator = any($2::text[])
           for update`,
          [input.context.orgId, locations.map((location) => location.locator)],
        );
        const existingByLocator = new Map(existingLocations.rows.map((row) => [String(row.locator), row]));
        const existingItemIds = new Set(existingLocations.rows.map((row) => String(row.item_id)));
        if (existingItemIds.size > 1) {
          for (const existingItemId of [...existingItemIds].sort()) {
            await this.assertAuthorized(client, input.context, "knowledge.register", {
              ...resource,
              itemId: existingItemId,
            });
          }
          throw new AdapterError("KNOWLEDGE_CONFLICT", "The locators are already registered to different items");
        }

        let itemId = input.itemId;
        const locatedItemId = existingItemIds.values().next().value as string | undefined;
        const implicitReplay = itemId === null
          && input.expectedRevision === null
          && locatedItemId !== undefined;
        if (itemId === null && locatedItemId !== undefined) itemId = locatedItemId;
        if (itemId !== null && locatedItemId !== undefined && itemId !== locatedItemId) {
          await this.assertAuthorized(client, input.context, "knowledge.register", { ...resource, itemId });
          await this.assertAuthorized(client, input.context, "knowledge.register", {
            ...resource,
            itemId: locatedItemId,
          });
          throw new AdapterError("KNOWLEDGE_CONFLICT", "The locator is already registered to another item");
        }
        await this.assertAuthorized(client, input.context, "knowledge.register", { ...resource, itemId });

        let created = false;
        let changed = false;
        let currentRevision = 0;
        if (itemId === null) {
          itemId = this.id("item");
          targetId = itemId;
          created = true;
          changed = true;
          await client.query(
            `insert into knowledge_items(item_id, org_id, owner_principal_id, title, aliases, status)
             values ($1, $2, $3, $4, $5, 'draft')`,
            [itemId, input.context.orgId, input.context.onBehalfOfUserId, input.title, input.aliases],
          );
          await this.ensureOwnerItemGrant(client, input.context, itemId);
        } else {
          targetId = itemId;
          const current = await client.query<SqlRow>(
            "select * from knowledge_items where item_id = $1 and org_id = $2 for update",
            [itemId, input.context.orgId],
          );
          const row = current.rows[0];
          if (row === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Knowledge item was not found");
          currentRevision = Number(row.revision);
          if (input.expectedRevision !== null && currentRevision !== input.expectedRevision) {
            throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed after preview");
          }
          changed = String(row.title) !== input.title
            || !sameStringSet(row.aliases ?? [], input.aliases);
        }

        const storedLocations: KnowledgeLocation[] = [];
        for (const location of locations) {
          let row = existingByLocator.get(location.locator);
          if (row === undefined) {
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
              "select * from knowledge_locations where org_id = $1 and locator = $2 for update",
              [input.context.orgId, location.locator],
            );
            row = found.rows[0];
            changed = true;
          }
          if (row === undefined || String(row.item_id) !== itemId) {
            throw new AdapterError("KNOWLEDGE_CONFLICT", "The locator is already registered to another item");
          }
          if (!sameLocationRegistration(row, location)) {
            throw new AdapterError("KNOWLEDGE_CONFLICT", "The locator registration does not match the existing location");
          }
          storedLocations.push(mapLocation(row));
        }

        const existingTags = await readTagNames(client, input.context.orgId, itemId);
        const missingTags = [...new Set(input.tags)].filter((tag) => !existingTags.has(tag));
        if (implicitReplay && (changed || !sameStringSet([...existingTags], input.tags))) {
          throw new AdapterError("KNOWLEDGE_CONFLICT", "The locator registration metadata does not match the existing item");
        }
        if (missingTags.length > 0) changed = true;
        await this.addTags(client, input.context.orgId, itemId, missingTags);

        if (!created && changed) {
          const updated = await client.query<SqlRow>(
            `update knowledge_items
             set title = $1, aliases = $2, revision = revision + 1, updated_at = now()
             where item_id = $3 and org_id = $4 and revision = $5 returning item_id`,
            [input.title, input.aliases, itemId, input.context.orgId, currentRevision],
          );
          if (updated.rows[0] === undefined) {
            throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed during registration");
          }
        }
        if (changed) {
          await incrementRegistryRevision(client, input.context.orgId);
          await this.audit(client, {
            context: input.context,
            action: "knowledge.register",
            targetKind: "item",
            targetId: itemId,
            decision: "completed",
          });
        }
        const item = await readItem(client, itemId, input.context.orgId);
        if (item === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Registered knowledge could not be loaded");
        return { item, locations: storedLocations };
      });
    } catch (error) {
      const normalized = normalizeKnowledgeWriteError(error);
      await this.auditRejectedWrite(input.context, "knowledge.register", targetId, normalized.code);
      throw normalized;
    }
  }

  async previewManagedKnowledge(input: PreviewManagedKnowledgeInput): Promise<StorePreview> {
    try {
      assertManagedBodyBudget(input.content.bodyMarkdown);
      const content = managedMarkdownInputSchema.parse(input.content);
      return await this.database.transaction(async (client) => {
        await this.assertAuthorized(client, input.context, "knowledge.store", {
          orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: content.tags,
        });
        const row = await readCurrentManagedRow(client, input.context.orgId, input.itemId, "for share of ki");
        if (Number(row.revision) !== input.expectedRevision) {
          throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed after preview");
        }
        return buildStorePreview(input.context.taskId, input.itemId, input.expectedRevision, row, content);
      });
    } catch (error) {
      const normalized = normalizeKnowledgeWriteError(error);
      await this.auditRejectedWrite(input.context, "knowledge.store.preview-replace", input.itemId, normalized.code);
      throw normalized;
    }
  }

  async replaceManagedKnowledge(input: ReplaceManagedKnowledgeInput): Promise<ManagedKnowledgeResult> {
    try {
      assertManagedBodyBudget(input.content.bodyMarkdown);
      const content = managedMarkdownInputSchema.parse(input.content);
      return await this.database.transaction(async (client) => {
        await this.assertAuthorized(client, input.context, "knowledge.store", {
          orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: content.tags,
        });
        const row = await readCurrentManagedRow(client, input.context.orgId, input.itemId, "for update of ki");
        if (Number(row.revision) !== input.expectedRevision) {
          throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed after preview");
        }
        const preview = buildStorePreview(
          input.approvalTaskId ?? input.context.taskId,
          input.itemId,
          input.expectedRevision,
          row,
          content,
        );
        if (preview.previewHash !== input.previewHash) {
          throw new AdapterError("APPROVAL_REQUIRED", "Managed knowledge preview does not match the requested write");
        }
        const versionId = this.id("version");
        await client.query(
          `insert into knowledge_versions(
            version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
            provenance, created_by_principal_id
          ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [versionId, input.context.orgId, input.itemId, String(row.location_id), Number(row.ordinal) + 1,
            preview.newBodyHash, content.bodyMarkdown,
            JSON.stringify({ kind: "managed-markdown", replaced: String(row.version_id) }),
            input.context.onBehalfOfUserId],
        );
        const updated = await client.query<SqlRow>(
          `update knowledge_items set title = $1, aliases = $2, current_version_id = $3,
           revision = revision + 1, updated_at = now()
           where item_id = $4 and org_id = $5 and revision = $6 returning *`,
          [content.title, content.aliases, versionId, input.itemId, input.context.orgId, input.expectedRevision],
        );
        if (updated.rows[0] === undefined) {
          throw new AdapterError("REVISION_CONFLICT", "Knowledge revision changed during write");
        }
        await this.addTags(client, input.context.orgId, input.itemId, content.tags);
        await incrementRegistryRevision(client, input.context.orgId);
        await this.audit(client, {
          context: input.context,
          action: "knowledge.store.replace",
          targetKind: "item",
          targetId: input.itemId,
          decision: "completed",
        });
        const result = await readManagedResult(
          client,
          input.context.orgId,
          input.itemId,
          String(row.location_id),
          versionId,
        );
        if (result === null) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Replaced knowledge could not be loaded");
        return result;
      });
    } catch (error) {
      const normalized = normalizeKnowledgeWriteError(error);
      await this.auditRejectedWrite(input.context, "knowledge.store.replace", input.itemId, normalized.code);
      throw normalized;
    }
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
            ki.status <> 'draft'
            or ki.owner_principal_id = $1
            or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
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
                  and (
                    ki.status <> 'draft'
                    or ki.owner_principal_id = $1
                    or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
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

  async listLocationsAuthorized(input: ListKnowledgeLocationsInput): Promise<readonly KnowledgeLocation[]> {
    return await this.database.transaction(async (client) => {
      await this.assertAuthorized(client, input.context, "knowledge.query", {
        orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: [],
      });
      const item = await client.query<{ item_id: string; owner_principal_id: string; status: string }>(
        "select item_id, owner_principal_id, status from knowledge_items where item_id = $1 and org_id = $2",
        [input.itemId, input.context.orgId],
      );
      const itemRow = item.rows[0];
      if (itemRow === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Knowledge item was not found");
      if (itemRow.status === "draft" && itemRow.owner_principal_id !== input.context.onBehalfOfUserId) {
        const explicitItemGrant = await client.query(
          `select 1 from resource_grants
           where org_id = $1 and principal_id = $2
             and scope_kind = 'item' and scope_id = $3
             and 'knowledge.query' = any(capabilities)
             and revoked_at is null and (expires_at is null or expires_at > now())
           limit 1`,
          [input.context.orgId, input.context.onBehalfOfUserId, input.itemId],
        );
        if (explicitItemGrant.rows[0] === undefined) {
          throw new AdapterError("DELEGATION_DENIED", "Knowledge access is denied");
        }
      }
      const result = await client.query<SqlRow>(
        `select * from knowledge_locations
         where org_id = $1 and item_id = $2
         order by location_id`,
        [input.context.orgId, input.itemId],
      );
      return result.rows.map(mapLocation);
    });
  }

  async shareItem(input: ShareItemInput): Promise<ShareItemResult> {
    try {
      const capabilities = [...new Set(input.capabilities)].sort();
      if (capabilities.length === 0 || capabilities.some((capability) => !SHAREABLE_CAPABILITIES.has(capability))) {
        throw new AdapterError("INVALID_OPERATION", "Knowledge share capabilities are invalid");
      }
      return await this.database.transaction(async (client) => {
        await this.assertAuthorized(client, input.context, "knowledge.share", {
          orgId: input.context.orgId, itemId: input.itemId, sourceId: null, tags: [],
        });
        const itemResult = await client.query<SqlRow>(
          "select * from knowledge_items where item_id = $1 and org_id = $2 for share",
          [input.itemId, input.context.orgId],
        );
        if (itemResult.rows[0] === undefined) {
          throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Knowledge item was not found");
        }
        await this.assertPrincipalInOrganization(client, input.context.orgId, input.targetPrincipalId);
        const existing = await client.query<SqlRow>(
          `select * from resource_grants
           where org_id = $1 and principal_id = $2
             and scope_kind = 'item' and scope_id = $3
             and revoked_at is null and expires_at is null
           for update`,
          [input.context.orgId, input.targetPrincipalId, input.itemId],
        );
        let grantRow = existing.rows.find((row) => sameStringSet(row.capabilities ?? [], capabilities));
        if (grantRow === undefined) {
          const grant = resourceGrantSchema.parse({
            schema: "openlifewiki.resource-grant/v1",
            grantId: this.id("grant"),
            orgId: input.context.orgId,
            principalId: input.targetPrincipalId,
            scope: { kind: "item", id: input.itemId },
            capabilities,
            expiresAt: null,
            revokedAt: null,
          });
          await insertGrant(client, grant);
          grantRow = {
            grant_id: grant.grantId,
            org_id: grant.orgId,
            principal_id: grant.principalId,
            scope_kind: grant.scope.kind,
            scope_id: grant.scope.id,
            capabilities: grant.capabilities,
            expires_at: grant.expiresAt,
            revoked_at: grant.revokedAt,
          };
          await incrementRegistryRevision(client, input.context.orgId);
          await this.audit(client, {
            context: input.context,
            action: "knowledge.share",
            targetKind: "item",
            targetId: input.itemId,
            decision: "completed",
          });
        }
        const locations = await client.query<SqlRow>(
          "select * from knowledge_locations where org_id = $1 and item_id = $2 order by location_id",
          [input.context.orgId, input.itemId],
        );
        return {
          grant: mapGrant(grantRow),
          item: mapItem(itemResult.rows[0]),
          locations: locations.rows.map(mapLocation),
        };
      });
    } catch (error) {
      const normalized = normalizeKnowledgeWriteError(error);
      await this.auditRejectedWrite(input.context, "knowledge.share", input.itemId, normalized.code);
      throw normalized;
    }
  }

  async createTaskForAuthenticatedPrincipal(input: CreateTaskInput): Promise<StoredAgentTask> {
    let parsed: KnowledgeOperation;
    try {
      parsed = knowledgeOperationSchema.parse(input.input);
    } catch {
      throw new AdapterError("INVALID_OPERATION", "Task input is invalid");
    }
    try {
      return await this.database.transaction(async (client) => {
        const authority = await lockTaskCreationAuthority(
          client,
          input.principal,
          capabilityForOperation(parsed),
        );

        const result = await client.query<SqlRow>(
          `insert into agent_tasks(
            task_id, context_id, org_id, owner_principal_id, actor_agent_id, delegation_id,
            state, input_json
          ) values ($1, $2, $3, $4, $5, $6, 'submitted', $7::jsonb)
          returning *`,
          [input.taskId, input.contextId, input.principal.orgId, authority.ownerPrincipalId,
            authority.actorAgentId, authority.delegationId, JSON.stringify(parsed)],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AdapterError("INVALID_OPERATION", "Task could not be created");
        const task = mapTask(row);
        await this.auditTaskTransition(client, task, "submitted");
        return task;
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "Task could not be created");
    }
  }

  async ensureAgentSession(input: EnsureAgentSessionInput): Promise<void> {
    await this.database.transaction(async (client) => {
      await lockActiveSessionOwner(client, input);
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
    return await this.database.transaction(async (client) => {
      const row = await lockAgentSession(client, input);
      return parseAgentSessionHistory(row.history_json);
    });
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

  async popAgentSession(
    input: EnsureAgentSessionInput,
    validateItem?: (item: unknown) => void,
  ): Promise<unknown | undefined> {
    return await this.database.transaction(async (client) => {
      const row = await lockAgentSession(client, input);
      const history = parseAgentSessionHistory(row.history_json);
      if (history.length === 0) return undefined;
      const item = history.at(-1);
      validateItem?.(item);
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
    return await this.updateTask(taskId, expectedRevision, ["submitted"], { state: "working" });
  }

  async markTaskWorkingAuthorized(input: {
    readonly task: StoredAgentTask;
    readonly access: AccessContext;
  }): Promise<StoredAgentTask> {
    try {
      return await this.database.transaction(async (client) => {
        const currentResult = await client.query<SqlRow>(
          "select * from agent_tasks where task_id = $1 for update",
          [input.task.taskId],
        );
        const row = currentResult.rows[0];
        if (row === undefined) throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
        const current = mapTask(row);
        assertTaskSnapshotBinding(current, input.task);
        await assertCurrentTaskAuthority(client, current, input.access);
        const updated = await client.query<SqlRow>(
          `update agent_tasks
           set state = 'working', revision = revision + 1, updated_at = now()
           where task_id = $1 and revision = $2 and state = 'submitted' and cancel_requested = false
           returning *`,
          [current.taskId, current.revision],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
        const working = mapTask(updatedRow);
        await this.auditTaskTransition(client, working, "working");
        return working;
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "Task authorization could not be verified");
    }
  }

  async pauseTask(input: PauseTaskInput): Promise<StoredAgentTask> {
    assertSafeAgentRunState(input.runState);
    return await this.updateTask(input.taskId, input.expectedRevision, ["working"], {
      state: "input-required", runState: input.runState, errorCode: input.errorCode,
    });
  }

  async completeTask(input: CompleteTaskInput): Promise<StoredAgentTask> {
    const output = safeSerializeTaskJson(input.output);
    return await this.updateTask(input.taskId, input.expectedRevision, ["working"], {
      state: "completed", output, runState: null, errorCode: null,
    });
  }

  async failTask(input: FailTaskInput): Promise<StoredAgentTask> {
    return await this.updateTask(input.taskId, input.expectedRevision, ["submitted", "working", "input-required"], {
      state: "failed", runState: null, errorCode: input.code,
    });
  }

  async failInterruptedTask(taskId: string, expectedRevision: number): Promise<StoredAgentTask> {
    return await this.failTask({ taskId, expectedRevision, code: "TASK_INTERRUPTED" });
  }

  async requestTaskCancellation(input: TaskRevisionInput): Promise<StoredAgentTask> {
    return await this.updateCancellation(input, "request");
  }

  async settleCanceledTask(input: TaskRevisionInput): Promise<StoredAgentTask> {
    return await this.updateCancellation(input, "settle");
  }

  async loadTask(taskId: string, principalId: string): Promise<StoredAgentTask | null> {
    const result = await this.database.query<SqlRow>(
      `select * from agent_tasks where task_id = $1 and (owner_principal_id = $2 or actor_agent_id = $2)`,
      [taskId, principalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTask(row);
  }

  async resolveTaskAccessContext(input: {
    readonly taskId: string;
    readonly principalId: string;
  }): Promise<AccessContext> {
    try {
      return await this.database.transaction(async (client) => {
        const result = await client.query<SqlRow>(
          `select * from agent_tasks where task_id = $1
           and (actor_agent_id = $2 or (actor_agent_id is null and owner_principal_id = $2))
           for share`,
          [input.taskId, input.principalId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AdapterError("DELEGATION_DENIED", "Task access is not authorized");
        const task = mapTask(row);
        const context = taskAccessContext(task);
        await assertCurrentTaskAuthority(client, task, context);
        return context;
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "Task access could not be resolved");
    }
  }

  async saveA2ATask(input: SaveA2ATaskInput): Promise<SavedA2ATask> {
    const serialized = safeSerializeTaskJson(input.taskJson);
    assertSafeA2ATaskJson(serialized);
    if (!isPlainRecord(serialized) || serialized.id !== input.taskId) {
      throw new AdapterError("INVALID_OPERATION", "A2A task is invalid");
    }
    try {
      return await this.database.transaction(async (client) => {
        const result = await client.query<SqlRow>(
          `select a2a_task_json from agent_tasks
           where task_id = $1
             and (actor_agent_id = $2 or (actor_agent_id is null and owner_principal_id = $2))
           for update`,
          [input.taskId, input.principalId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AdapterError("DELEGATION_DENIED", "A2A task is not accessible");
        const currentRevision = a2aRevision(row.a2a_task_json);
        if (currentRevision !== input.expectedA2ARevision) {
          throw new AdapterError("REVISION_CONFLICT", "A2A task revision changed");
        }
        const nextRevision = (currentRevision ?? -1) + 1;
        const taskJson = {
          ...serialized,
          metadata: {
            ...(isPlainRecord(serialized.metadata) ? serialized.metadata : {}),
            openlifewikiA2ARevision: nextRevision,
          },
        };
        const updated = await client.query<SqlRow>(
          `update agent_tasks set a2a_task_json = $1::jsonb, updated_at = now()
           where task_id = $2
             and (actor_agent_id = $3 or (actor_agent_id is null and owner_principal_id = $3))
           returning task_id`,
          [JSON.stringify(taskJson), input.taskId, input.principalId],
        );
        if (updated.rows[0] === undefined) {
          throw new AdapterError("DELEGATION_DENIED", "A2A task is not accessible");
        }
        return { taskJson, a2aRevision: nextRevision };
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "A2A task could not be saved");
    }
  }

  async loadA2ATask(taskId: string, principalId: string): Promise<unknown | null> {
    const result = await this.database.query<SqlRow>(
      `select a2a_task_json from agent_tasks
       where task_id = $1
         and (actor_agent_id = $2 or (actor_agent_id is null and owner_principal_id = $2))`,
      [taskId, principalId],
    );
    const value = result.rows[0]?.a2a_task_json ?? null;
    if (value !== null) assertSafeA2ATaskJson(value);
    return value;
  }

  async listA2ATasks(input: ListA2ATasksInput): Promise<StoredA2ATaskPage> {
    const values = [
      input.principalId,
      input.contextId,
      input.status === null ? null : String(input.status),
      input.statusTimestampAfter,
      input.afterUpdatedAt,
      input.afterTaskId,
      input.limit,
    ] as const;
    const predicate = `a2a_task_json is not null
      and (actor_agent_id = $1 or (actor_agent_id is null and owner_principal_id = $1))
      and ($2::text is null or context_id = $2)
      and ($3::text is null or a2a_task_json #>> '{status,state}' = $3)
      and ($4::timestamptz is null or
        case
          when pg_input_is_valid(a2a_task_json #>> '{status,timestamp}', 'timestamp with time zone')
          then (a2a_task_json #>> '{status,timestamp}')::timestamptz
          else null
        end >= $4)
      and ($5::timestamptz is null
        or (date_trunc('milliseconds', updated_at), task_id) > ($5, $6))`;
    const [rows, total] = await Promise.all([
      this.database.query<SqlRow>(
        `select task_id, a2a_task_json,
           date_trunc('milliseconds', updated_at) as cursor_updated_at
         from agent_tasks
         where ${predicate}
         order by date_trunc('milliseconds', updated_at), task_id limit $7`,
        values,
      ),
      this.database.query<{ count: string }>(
        `select count(*)::text as count from agent_tasks
         where a2a_task_json is not null
           and (actor_agent_id = $1 or (actor_agent_id is null and owner_principal_id = $1))
           and ($2::text is null or context_id = $2)
           and ($3::text is null or a2a_task_json #>> '{status,state}' = $3)
           and ($4::timestamptz is null or
             case
               when pg_input_is_valid(a2a_task_json #>> '{status,timestamp}', 'timestamp with time zone')
               then (a2a_task_json #>> '{status,timestamp}')::timestamptz
               else null
             end >= $4)`,
        values.slice(0, 4),
      ),
    ]);
    return {
      rows: rows.rows.map((row) => {
        assertSafeA2ATaskJson(row.a2a_task_json);
        return {
          taskId: String(row.task_id),
          taskJson: row.a2a_task_json,
          updatedAt: toTimestamp(row.cursor_updated_at),
        };
      }),
      totalSize: Number(total.rows[0]?.count ?? 0),
    };
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
    allowedStates: readonly StoredAgentTask["state"][],
    patch: { readonly state: StoredAgentTask["state"]; readonly output?: unknown; readonly runState?: string | null; readonly errorCode?: KnowledgeErrorCode | null },
  ): Promise<StoredAgentTask> {
    try {
      return await this.database.transaction(async (client) => {
        const result = await client.query<SqlRow>(
          `update agent_tasks set state = $1, output_json = coalesce($2::jsonb, output_json),
           run_state = $3, error_code = $4, revision = revision + 1, updated_at = now()
           where task_id = $5 and revision = $6 and state = any($7::text[]) returning *`,
          [patch.state, patch.output === undefined ? null : JSON.stringify(patch.output), patch.runState ?? null,
            patch.errorCode ?? null, taskId, expectedRevision, allowedStates],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
        const task = mapTask(row);
        await this.auditTaskTransition(client, task, patch.state);
        return task;
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "Task state could not be updated");
    }
  }

  private async updateCancellation(
    input: TaskRevisionInput,
    mode: "request" | "settle",
  ): Promise<StoredAgentTask> {
    try {
      return await this.database.transaction(async (client) => {
        const currentResult = await client.query<SqlRow>(
          "select * from agent_tasks where task_id = $1 for update",
          [input.taskId],
        );
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined) {
          throw new AdapterError("DELEGATION_DENIED", "Task cancellation is not authorized");
        }
        const current = mapTask(currentRow);
        await assertCancellationPrincipal(client, current, input.principalId);
        const legalState = current.state === "submitted"
          || current.state === "working"
          || current.state === "input-required";
        const legalFlag = mode === "request" ? !current.cancelRequested : current.cancelRequested;
        if (current.revision !== input.expectedRevision || !legalState || !legalFlag) {
          throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
        }
        const result = await client.query<SqlRow>(
          mode === "request"
            ? `update agent_tasks
               set cancel_requested = true, revision = revision + 1, updated_at = now()
               where task_id = $1 and revision = $2
                 and state = any($3::text[]) and cancel_requested = false
               returning *`
            : `update agent_tasks
               set state = 'canceled', revision = revision + 1, updated_at = now()
               where task_id = $1 and revision = $2
                 and state = any($3::text[]) and cancel_requested = true
               returning *`,
          [input.taskId, input.expectedRevision, ["submitted", "working", "input-required"]],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
        const task = mapTask(row);
        if (mode === "request") {
          await this.auditTaskAction(client, task, "cancel-requested", "allowed");
        } else {
          await this.auditTaskTransition(client, task, "canceled");
        }
        return task;
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_OPERATION", "Task cancellation could not be updated");
    }
  }

  private async auditTaskTransition(
    client: import("pg").PoolClient,
    task: StoredAgentTask,
    state: StoredAgentTask["state"],
  ): Promise<void> {
    await this.auditTaskAction(
      client,
      task,
      state,
      state === "failed" ? "failed" : state === "completed" || state === "canceled" ? "completed" : "allowed",
    );
  }

  private async auditTaskAction(
    client: import("pg").PoolClient,
    task: StoredAgentTask,
    action: string,
    decision: "allowed" | "completed" | "failed",
  ): Promise<void> {
    await this.audit(client, {
      context: taskAccessContext(task),
      action: `agent.task.${action}`,
      targetKind: "task",
      targetId: task.taskId,
      decision,
    });
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

  private async ensureOwnerItemGrant(
    client: import("pg").PoolClient,
    context: AccessContext,
    itemId: string,
  ): Promise<void> {
    const grant = resourceGrantSchema.parse({
      schema: "openlifewiki.resource-grant/v1",
      grantId: this.id("grant"),
      orgId: context.orgId,
      principalId: context.onBehalfOfUserId,
      scope: { kind: "item", id: itemId },
      capabilities: ["knowledge.query", "knowledge.store", "knowledge.organize", "knowledge.share"],
      expiresAt: null,
      revokedAt: null,
    });
    await insertGrant(client, grant);
  }

  private async auditRejectedWrite(
    context: AccessContext,
    action: string,
    targetId: string,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.database.transaction(async (client) => {
        await this.audit(client, {
          context,
          action,
          targetKind: targetId === context.orgId ? "organization" : "item",
          targetId,
          decision: "failed",
          receiptMetadata: { errorCode },
        });
      });
    } catch {
      // A failed best-effort security audit must never replace the stable domain error.
    }
  }

  private async audit(
    client: import("pg").PoolClient,
    input: {
      readonly context: AccessContext;
      readonly action: string;
      readonly targetKind: string;
      readonly targetId: string;
      readonly decision: "allowed" | "denied" | "completed" | "failed";
      readonly receiptMetadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `insert into audit_events(
        audit_event_id, org_id, task_id, actor_principal_id, on_behalf_of_user_id,
        action, target_kind, target_id, decision, receipt_metadata
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [this.id("audit"), input.context.orgId, input.context.taskId, input.context.actorPrincipalId,
        input.context.onBehalfOfUserId, input.action, input.targetKind, input.targetId, input.decision,
        JSON.stringify(input.receiptMetadata ?? {})],
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
  try {
    return {
      taskId: String(row.task_id),
      contextId: String(row.context_id),
      orgId: String(row.org_id),
      ownerPrincipalId: String(row.owner_principal_id),
      actorAgentId: row.actor_agent_id === null ? null : String(row.actor_agent_id),
      delegationId: row.delegation_id === null ? null : String(row.delegation_id),
      state: STORED_TASK_STATE_SCHEMA.parse(row.state),
      input: knowledgeOperationSchema.parse(row.input_json),
      output: row.output_json ?? null,
      runState: row.run_state === null ? null : String(row.run_state),
      errorCode: row.error_code === null ? null : STORED_TASK_ERROR_CODE_SCHEMA.parse(row.error_code),
      cancelRequested: row.cancel_requested === true,
      revision: z.int().nonnegative().parse(Number(row.revision)),
    };
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Persisted task is invalid");
  }
}

async function lockTaskCreationAuthority(
  client: import("pg").PoolClient,
  principal: Principal,
  capability: KnowledgeCapability,
): Promise<{
  readonly ownerPrincipalId: string;
  readonly actorAgentId: string | null;
  readonly delegationId: string | null;
}> {
  if (principal.type === "user") {
    const owner = await client.query<{ principal_id: string }>(
      `select principal_id from principals
       where principal_id = $1 and org_id = $2 and principal_type = 'user' and status = 'active'
       for share`,
      [principal.principalId, principal.orgId],
    );
    if (owner.rows[0] === undefined) {
      throw new AdapterError("AUTHENTICATION_REQUIRED", "Authenticated principal is not active");
    }
    return { ownerPrincipalId: principal.principalId, actorAgentId: null, delegationId: null };
  }

  const candidate = await client.query<{ delegation_id: string; user_principal_id: string }>(
    `select delegation_id, user_principal_id from delegations
     where agent_principal_id = $1 and org_id = $2
       and revoked_at is null and expires_at > now() and $3 = any(capabilities)
     order by expires_at asc, delegation_id asc limit 1`,
    [principal.principalId, principal.orgId, capability],
  );
  const delegation = candidate.rows[0];
  if (delegation === undefined) {
    throw new AdapterError("DELEGATION_DENIED", "No active delegation is available for this task");
  }
  await lockActivePrincipal(client, delegation.user_principal_id, principal.orgId, "user", capability, false);
  await lockActivePrincipal(client, principal.principalId, principal.orgId, "agent", capability, true);
  const lockedDelegation = await client.query<{ delegation_id: string }>(
    `select delegation_id from delegations
     where delegation_id = $1 and org_id = $2
       and agent_principal_id = $3 and user_principal_id = $4
       and revoked_at is null and expires_at > now() and $5 = any(capabilities)
     for share`,
    [delegation.delegation_id, principal.orgId, principal.principalId,
      delegation.user_principal_id, capability],
  );
  if (lockedDelegation.rows[0] === undefined) {
    throw new AdapterError("DELEGATION_DENIED", "No active delegation is available for this task");
  }
  return {
    ownerPrincipalId: delegation.user_principal_id,
    actorAgentId: principal.principalId,
    delegationId: delegation.delegation_id,
  };
}

async function lockActivePrincipal(
  client: import("pg").PoolClient,
  principalId: string,
  orgId: string,
  type: Principal["type"],
  capability: KnowledgeCapability,
  requireCapability: boolean,
): Promise<void> {
  const result = await client.query<{ principal_id: string }>(
    `select principal_id from principals
     where principal_id = $1 and org_id = $2 and principal_type = $3 and status = 'active'
       and ($4::boolean = false or $5 = any(capabilities))
     for share`,
    [principalId, orgId, type, requireCapability, capability],
  );
  if (result.rows[0] === undefined) {
    throw new AdapterError("DELEGATION_DENIED", "Task principal is not active or capable");
  }
}

async function assertCancellationPrincipal(
  client: import("pg").PoolClient,
  task: StoredAgentTask,
  principalId: string,
): Promise<void> {
  const principal = await client.query<{ principal_type: Principal["type"] }>(
    `select principal_type from principals
     where principal_id = $1 and org_id = $2 and status = 'active'
     for share`,
    [principalId, task.orgId],
  );
  const type = principal.rows[0]?.principal_type;
  const authorized = type === "user"
    ? task.actorAgentId === null && task.ownerPrincipalId === principalId
    : type === "agent" && task.actorAgentId === principalId;
  if (!authorized) throw new AdapterError("DELEGATION_DENIED", "Task cancellation is not authorized");
}

function assertTaskSnapshotBinding(current: StoredAgentTask, supplied: StoredAgentTask): void {
  if (current.revision !== supplied.revision || current.state !== supplied.state) {
    throw new AdapterError("REVISION_CONFLICT", "Task revision or state changed");
  }
  if (current.taskId !== supplied.taskId
    || current.contextId !== supplied.contextId
    || current.orgId !== supplied.orgId
    || current.ownerPrincipalId !== supplied.ownerPrincipalId
    || current.actorAgentId !== supplied.actorAgentId
    || current.delegationId !== supplied.delegationId
    || sha256Canonical(current.input) !== sha256Canonical(supplied.input)) {
    throw new AdapterError("INVALID_OPERATION", "Task binding is invalid");
  }
}

async function assertCurrentTaskAuthority(
  client: import("pg").PoolClient,
  task: StoredAgentTask,
  access: AccessContext,
): Promise<void> {
  if (access.taskId !== task.taskId
    || access.orgId !== task.orgId
    || access.onBehalfOfUserId !== task.ownerPrincipalId
    || access.actorPrincipalId !== (task.actorAgentId ?? task.ownerPrincipalId)
    || access.actorAgentId !== task.actorAgentId
    || access.delegationId !== task.delegationId) {
    throw new AdapterError("DELEGATION_DENIED", "Task access binding is not authorized");
  }
  await lockActivePrincipal(client, task.ownerPrincipalId, task.orgId, "user", "knowledge.query", false);
  if (task.actorAgentId === null) {
    if (task.delegationId !== null) throw new AdapterError("DELEGATION_DENIED", "Human task delegation is invalid");
    return;
  }
  if (task.delegationId === null) throw new AdapterError("DELEGATION_DENIED", "Agent delegation is required");
  await lockActivePrincipal(client, task.actorAgentId, task.orgId, "agent", "knowledge.query", true);
  const authority = await client.query<{ delegation_id: string }>(
    `select delegation_id from delegations
     where delegation_id = $1 and org_id = $2
       and agent_principal_id = $3 and user_principal_id = $4
       and revoked_at is null and expires_at > now()
       and 'knowledge.query' = any(capabilities)
     for share`,
    [task.delegationId, task.orgId, task.actorAgentId, task.ownerPrincipalId],
  );
  if (authority.rows[0] === undefined) {
    throw new AdapterError("DELEGATION_DENIED", "Agent delegation is not active");
  }
}

function capabilityForOperation(operation: KnowledgeOperation): KnowledgeCapability {
  switch (operation.kind) {
    case "knowledge.query": return "knowledge.query";
    case "knowledge.register": return "knowledge.register";
    case "knowledge.store": return "knowledge.store";
    case "knowledge.store.preview-replace": return "knowledge.store";
    case "knowledge.store.apply-replace": return "knowledge.store";
    case "knowledge.share": return "knowledge.share";
    case "knowledge.organize": return "knowledge.organize";
  }
}

function taskAccessContext(task: StoredAgentTask): AccessContext {
  return accessContextSchema.parse({
    schema: "openlifewiki.access-context/v1",
    orgId: task.orgId,
    actorPrincipalId: task.actorAgentId ?? task.ownerPrincipalId,
    actorAgentId: task.actorAgentId,
    onBehalfOfUserId: task.ownerPrincipalId,
    delegationId: task.delegationId,
    taskId: task.taskId,
  });
}

function safeSerializeTaskJson(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Task output is not durable JSON");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Task output is not durable JSON");
  }
}

function a2aRevision(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value) || !isPlainRecord(value.metadata)) {
    throw new AdapterError("INVALID_OPERATION", "Persisted A2A task is invalid");
  }
  const revision = value.metadata.openlifewikiA2ARevision;
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new AdapterError("INVALID_OPERATION", "Persisted A2A task revision is invalid");
  }
  return Number(revision);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeA2ATaskJson(value: unknown): void {
  try {
    if (!isPlainRecord(value) || !isPlainRecord(value.status)
      || !Array.isArray(value.history) || !Array.isArray(value.artifacts)
      || value.history.length > MAX_A2A_HISTORY || value.artifacts.length > MAX_A2A_ARTIFACTS) {
      throw new Error();
    }
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_A2A_TASK_JSON_BYTES) throw new Error();
    if (value.status.message !== undefined && value.status.message !== null) {
      assertA2AParts(value.status.message);
    }
    for (const message of value.history) {
      assertA2AParts(message);
    }
    for (const artifact of value.artifacts) {
      if (!isPlainRecord(artifact)
        || Buffer.byteLength(canonicalJson(artifact), "utf8") > MAX_A2A_ARTIFACT_BYTES) {
        throw new Error();
      }
      assertA2AParts(artifact);
    }
  } catch {
    throw new AdapterError("INVALID_OPERATION", "A2A task exceeds persistence limits");
  }
}

function assertA2AParts(container: unknown): void {
  if (!isPlainRecord(container) || !Array.isArray(container.parts)
    || container.parts.length > MAX_A2A_PARTS) throw new Error();
  for (const part of container.parts) {
    if (!isPlainRecord(part) || !isPlainRecord(part.content)) throw new Error();
    const kind = part.content.$case;
    const partValue = part.content.value;
    if (kind === "text") {
      if (typeof partValue !== "string"
        || Buffer.byteLength(partValue, "utf8") > MAX_A2A_PART_BYTES) throw new Error();
    } else if (kind === "data"
      && Buffer.byteLength(canonicalJson(partValue), "utf8") > MAX_A2A_PART_BYTES) {
      throw new Error();
    }
  }
}

export function assertSafeAgentRunState(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent run state is invalid");
  }
  try {
    assertNoSensitiveRunStateMaterial(parsed, new WeakSet<object>());
  } catch {
    throw new AdapterError("INVALID_OPERATION", "Agent run state contains sensitive data");
  }
}

function assertNoSensitiveRunStateMaterial(value: unknown, ancestors: WeakSet<object>): void {
  if (typeof value === "string") {
    // Ordinary knowledge text remains valid; only high-confidence credential material is rejected.
    if (/\bbearer\s+\S+/iu.test(value) || /\bsk-[A-Za-z0-9_-]{8,}/u.test(value)) {
      throw new AdapterError("INVALID_OPERATION", "Agent run state contains sensitive data");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new AdapterError("INVALID_OPERATION", "Agent run state contains a cycle");
  ancestors.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveRunStateKey(key, nested)) {
        throw new AdapterError("INVALID_OPERATION", "Agent run state contains sensitive data");
      }
      assertNoSensitiveRunStateMaterial(nested, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveRunStateKey(key: string, value: unknown): boolean {
  if (/api[_-]?key|authorization|credential|password/iu.test(key)) return true;
  if (!/token/iu.test(key)) return false;
  if (typeof value === "number" && Number.isFinite(value)) return false;
  return !/^(?:input|output)TokensDetails$/u.test(key) || !isNumericUsageTree(value);
}

function isNumericUsageTree(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isNumericUsageTree);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).every(isNumericUsageTree);
}

async function lockAgentSession(
  client: import("pg").PoolClient,
  input: EnsureAgentSessionInput,
): Promise<SqlRow> {
  await lockActiveSessionOwner(client, input);
  const result = await client.query<SqlRow>(
    `select org_id, owner_principal_id, history_json
     from agent_sessions
     where session_id = $1
       and org_id = $2
       and owner_principal_id = $3
     for update`,
    [input.sessionId, input.orgId, input.ownerPrincipalId],
  );
  const row = result.rows[0];
  assertAgentSessionScope(row, input);
  return row;
}

async function lockActiveSessionOwner(
  client: import("pg").PoolClient,
  input: EnsureAgentSessionInput,
): Promise<void> {
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

function assertManagedBodyBudget(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new AdapterError("INVALID_OPERATION", "Managed Markdown body is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > 1_048_576) {
    throw new AdapterError("BODY_TOO_LARGE", "Managed Markdown exceeds the 1 MiB limit");
  }
}

function normalizeKnowledgeWriteError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError("INVALID_OPERATION", "Knowledge write could not be completed");
}

function sameStringSet(left: readonly unknown[], right: readonly unknown[]): boolean {
  const leftValues = [...new Set(left.map(String))].sort();
  const rightValues = [...new Set(right.map(String))].sort();
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function sameLocationRegistration(row: SqlRow, location: KnowledgeLocationInput): boolean {
  return row.location_kind === location.kind
    && row.location_role === location.role
    && (row.connector_instance_id === null ? null : String(row.connector_instance_id)) === location.connectorInstanceId
    && String(row.owner_principal_id) === location.ownerPrincipalId
    && canonicalJson(row.metadata ?? {}) === canonicalJson(location.metadata);
}

function deduplicateLocationInputs(
  locations: readonly KnowledgeLocationInput[],
): readonly KnowledgeLocationInput[] {
  const unique = new Map<string, KnowledgeLocationInput>();
  for (const location of locations) {
    const existing = unique.get(location.locator);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(location)) {
      throw new AdapterError("KNOWLEDGE_CONFLICT", "Duplicate locator inputs do not match");
    }
    if (existing === undefined) unique.set(location.locator, location);
  }
  return [...unique.values()];
}

async function readTagNames(
  client: import("pg").PoolClient,
  orgId: string,
  itemId: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ name: string }>(
    `select t.name
     from knowledge_tags kt join tags t on t.tag_id = kt.tag_id
     where kt.org_id = $1 and kt.item_id = $2`,
    [orgId, itemId],
  );
  return new Set(result.rows.map(({ name }) => name));
}

async function readCurrentManagedRow(
  client: import("pg").PoolClient,
  orgId: string,
  itemId: string,
  lockClause: "for share of ki" | "for update of ki",
): Promise<SqlRow> {
  const current = await client.query<SqlRow>(
    `select ki.*, kl.location_id, kv.version_id, kv.body_hash, kv.ordinal
     from knowledge_items ki
     join knowledge_versions kv on kv.version_id = ki.current_version_id and kv.item_id = ki.item_id
     join knowledge_locations kl on kl.location_id = kv.location_id
       and kl.item_id = ki.item_id and kl.location_kind = 'managed-markdown'
     where ki.item_id = $1 and ki.org_id = $2
     ${lockClause}`,
    [itemId, orgId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new AdapterError("KNOWLEDGE_NOT_FOUND", "Managed knowledge was not found");
  return row;
}

function buildStorePreview(
  taskId: string,
  itemId: string,
  expectedRevision: number,
  current: SqlRow,
  content: z.infer<typeof managedMarkdownInputSchema>,
): StorePreview {
  const base = {
    schema: "openlifewiki.store-preview/v1" as const,
    taskId,
    itemId,
    expectedRevision,
    oldBodyHash: String(current.body_hash),
    newBodyHash: sha256Body(content.bodyMarkdown),
    oldTitle: String(current.title),
    newTitle: content.title,
  };
  const hashMaterial = {
    ...base,
    newAliases: [...new Set(content.aliases)].sort(),
    newTags: [...new Set(content.tags)].sort(),
  };
  return storePreviewSchema.parse({
    ...base,
    previewHash: sha256Canonical(hashMaterial),
  });
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
