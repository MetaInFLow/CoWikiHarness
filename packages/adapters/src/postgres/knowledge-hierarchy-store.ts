import { randomUUID } from "node:crypto";

import {
  authorizeKnowledgeOperation,
  type CreateCollectionInput,
  type KnowledgeHierarchyWritePort,
  type MoveCollectionInput,
  type PlaceKnowledgeInput,
} from "@openlifewiki/core";
import {
  accessContextSchema,
  delegationSchema,
  knowledgeCollectionPlacementSchema,
  knowledgeCollectionSchema,
  principalSchema,
  resourceGrantSchema,
  type AccessContext,
  type Delegation,
  type KnowledgeCapability,
  type KnowledgeCollection,
  type KnowledgeCollectionPlacement,
  type Principal,
  type ResourceGrant,
} from "@openlifewiki/protocol";
import type { PoolClient } from "pg";

import { AdapterError } from "../errors.js";
import type { Database } from "./database.js";

type SqlRow = Record<string, unknown>;

export class PostgresKnowledgeHierarchyStore implements KnowledgeHierarchyWritePort {
  constructor(
    private readonly database: Database,
    private readonly ids: () => string = randomUUID,
  ) {}

  async createCollection(input: CreateCollectionInput): Promise<KnowledgeCollection> {
    const collectionId = this.id("collection");
    return await this.runMutation(
      input.context,
      "knowledge.collection.create",
      "collection",
      collectionId,
      input.now,
      async (client) => {
        const registryRevision = await lockOrganization(client, input.context.orgId);
        await assertOrganizationAuthority(client, input.context, input.now);
        if (registryRevision !== input.expectedRegistryRevision) {
          throw revisionConflict();
        }
        await assertCollectionInOrganization(client, input.context.orgId, input.parentCollectionId);

        const result = await client.query<SqlRow>(
          `insert into knowledge_collections(
             collection_id, org_id, parent_collection_id, name, description,
             created_by_principal_id, created_at, updated_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $7)
           returning *`,
          [collectionId, input.context.orgId, input.parentCollectionId, input.name, input.description,
            input.context.actorPrincipalId, input.now.toISOString()],
        );
        await completeMutation(client, {
          context: input.context,
          action: "knowledge.collection.create",
          targetKind: "collection",
          targetId: collectionId,
          now: input.now,
          auditId: this.id("audit"),
        });
        return mapCollection(requiredRow(result.rows[0]));
      },
    );
  }

  async moveCollection(input: MoveCollectionInput): Promise<KnowledgeCollection> {
    return await this.runMutation(
      input.context,
      "knowledge.collection.move",
      "collection",
      input.collectionId,
      input.now,
      async (client) => {
        await lockOrganization(client, input.context.orgId);
        await assertOrganizationAuthority(client, input.context, input.now);
        const current = await lockCollection(client, input.context.orgId, input.collectionId);
        if (Number(current.revision) !== input.expectedRevision) throw revisionConflict();
        await assertCollectionInOrganization(client, input.context.orgId, input.parentCollectionId);
        await assertAcyclicMove(
          client,
          input.context.orgId,
          input.collectionId,
          input.parentCollectionId,
        );

        const result = await client.query<SqlRow>(
          `update knowledge_collections
           set parent_collection_id = $1, name = $2, description = $3,
               revision = revision + 1, updated_at = $4
           where collection_id = $5 and org_id = $6 and revision = $7
           returning *`,
          [input.parentCollectionId, input.name, input.description, input.now.toISOString(),
            input.collectionId, input.context.orgId, input.expectedRevision],
        );
        if (result.rows[0] === undefined) throw revisionConflict();
        await completeMutation(client, {
          context: input.context,
          action: "knowledge.collection.move",
          targetKind: "collection",
          targetId: input.collectionId,
          now: input.now,
          auditId: this.id("audit"),
        });
        return mapCollection(result.rows[0]);
      },
    );
  }

  async placeKnowledge(input: PlaceKnowledgeInput): Promise<KnowledgeCollectionPlacement> {
    return await this.runMutation(
      input.context,
      "knowledge.place",
      "item",
      input.itemId,
      input.now,
      async (client) => {
        await lockOrganization(client, input.context.orgId);
        await assertOrganizationAuthority(client, input.context, input.now);
        await assertKnowledgeItemInOrganization(client, input.context.orgId, input.itemId);
        await assertCollectionInOrganization(client, input.context.orgId, input.collectionId);

        const currentResult = await client.query<SqlRow>(
          `select * from knowledge_collection_items
           where item_id = $1 and org_id = $2
           for update`,
          [input.itemId, input.context.orgId],
        );
        const current = currentResult.rows[0];
        if (current !== undefined) {
          const revision = Number(current.revision);
          const sameCollection = String(current.collection_id) === input.collectionId;
          if (sameCollection && isPlacementReplay(input.expectedPlacementRevision, revision)) {
            return mapPlacement(current);
          }
          if (input.expectedPlacementRevision === null
            || revision !== input.expectedPlacementRevision) {
            throw revisionConflict();
          }

          const updated = await client.query<SqlRow>(
            `update knowledge_collection_items
             set collection_id = $1, placed_by_principal_id = $2,
                 revision = revision + 1, updated_at = $3
             where item_id = $4 and org_id = $5 and revision = $6
             returning *`,
            [input.collectionId, input.context.actorPrincipalId, input.now.toISOString(),
              input.itemId, input.context.orgId, input.expectedPlacementRevision],
          );
          if (updated.rows[0] === undefined) throw revisionConflict();
          await completeMutation(client, {
            context: input.context,
            action: "knowledge.place",
            targetKind: "item",
            targetId: input.itemId,
            now: input.now,
            auditId: this.id("audit"),
          });
          return mapPlacement(updated.rows[0]);
        }

        if (input.expectedPlacementRevision !== null) throw revisionConflict();
        const created = await client.query<SqlRow>(
          `insert into knowledge_collection_items(
             item_id, org_id, collection_id, placed_by_principal_id, created_at, updated_at
           ) values ($1, $2, $3, $4, $5, $5)
           returning *`,
          [input.itemId, input.context.orgId, input.collectionId,
            input.context.actorPrincipalId, input.now.toISOString()],
        );
        await completeMutation(client, {
          context: input.context,
          action: "knowledge.place",
          targetKind: "item",
          targetId: input.itemId,
          now: input.now,
          auditId: this.id("audit"),
        });
        return mapPlacement(requiredRow(created.rows[0]));
      },
    );
  }

  async getCollection(orgId: string, collectionId: string): Promise<KnowledgeCollection | null> {
    try {
      const result = await this.database.query<SqlRow>(
        "select * from knowledge_collections where org_id = $1 and collection_id = $2",
        [orgId, collectionId],
      );
      return result.rows[0] === undefined ? null : mapCollection(result.rows[0]);
    } catch (error) {
      throw normalizeHierarchyError(error);
    }
  }

  async getPlacement(orgId: string, itemId: string): Promise<KnowledgeCollectionPlacement | null> {
    try {
      const result = await this.database.query<SqlRow>(
        "select * from knowledge_collection_items where org_id = $1 and item_id = $2",
        [orgId, itemId],
      );
      return result.rows[0] === undefined ? null : mapPlacement(result.rows[0]);
    } catch (error) {
      throw normalizeHierarchyError(error);
    }
  }

  private async runMutation<T>(
    context: AccessContext,
    action: string,
    targetKind: "collection" | "item",
    targetId: string,
    now: Date,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      const normalized = normalizeHierarchyError(error);
      await this.auditRejectedMutation(context, action, targetKind, targetId, now, normalized.code);
      throw normalized;
    }
  }

  private async auditRejectedMutation(
    context: AccessContext,
    action: string,
    targetKind: "collection" | "item",
    targetId: string,
    now: Date,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.database.transaction(async (client) => {
        await insertAudit(client, {
          context,
          action,
          targetKind,
          targetId,
          decision: "failed",
          now,
          auditId: this.id("audit"),
          receiptMetadata: { errorCode },
        });
      });
    } catch {
      // A failed best-effort security audit must not replace the stable domain error.
    }
  }

  private id(prefix: string): string {
    return `${prefix}_${this.ids()}`;
  }
}

async function lockOrganization(client: PoolClient, orgId: string): Promise<number> {
  const result = await client.query<{ registry_revision: string | number }>(
    "select registry_revision from organizations where org_id = $1 for update",
    [orgId],
  );
  if (result.rows[0] === undefined) throw delegationDenied();
  return Number(result.rows[0].registry_revision);
}

async function assertOrganizationAuthority(
  client: PoolClient,
  context: AccessContext,
  now: Date,
): Promise<void> {
  const parsedContext = accessContextSchema.safeParse(context);
  if (!parsedContext.success) throw delegationDenied();

  const userResult = await client.query<SqlRow>(
    `select * from principals
     where principal_id = $1 and org_id = $2
       and principal_type = 'user' and status = 'active'
     for share`,
    [context.onBehalfOfUserId, context.orgId],
  );
  if (userResult.rows[0] === undefined) throw delegationDenied();
  const user = mapPrincipal(userResult.rows[0]);

  if (context.actorAgentId === null) {
    if (context.actorPrincipalId !== user.principalId || context.delegationId !== null) {
      throw delegationDenied();
    }
  } else if (context.actorPrincipalId !== context.actorAgentId || context.delegationId === null) {
    throw delegationDenied();
  }

  const grantsResult = await client.query<SqlRow>(
    "select * from resource_grants where org_id = $1 and principal_id = $2 for share",
    [context.orgId, context.onBehalfOfUserId],
  );
  const userGrants = grantsResult.rows.map(mapGrant);
  const exactUserGrant = userGrants.some((grant) => (
    grant.scope.kind === "organization"
    && grant.scope.id === context.orgId
    && grant.revokedAt === null
    && (grant.expiresAt === null || Date.parse(grant.expiresAt) > now.getTime())
    && grant.capabilities.includes("knowledge.organize")
  ));
  if (!exactUserGrant) throw delegationDenied();

  let agentCapabilities: readonly KnowledgeCapability[] = [];
  let delegation: Delegation | null = null;
  if (context.actorAgentId !== null) {
    const agentResult = await client.query<SqlRow>(
      `select * from principals
       where principal_id = $1 and org_id = $2
         and principal_type = 'agent' and status = 'active'
       for share`,
      [context.actorAgentId, context.orgId],
    );
    if (agentResult.rows[0] === undefined) throw delegationDenied();
    const agent = mapPrincipal(agentResult.rows[0]);
    agentCapabilities = agent.capabilities;
    if (!agentCapabilities.includes("knowledge.organize")) throw delegationDenied();

    const delegationResult = await client.query<SqlRow>(
      "select * from delegations where delegation_id = $1 and org_id = $2 for share",
      [context.delegationId, context.orgId],
    );
    if (delegationResult.rows[0] !== undefined) delegation = mapDelegation(delegationResult.rows[0]);
    const exactDelegationScope = delegation?.resourceScopes.some((scope) => (
      scope.kind === "organization" && scope.id === context.orgId
    )) === true;
    if (!exactDelegationScope) throw delegationDenied();
  }

  const decision = authorizeKnowledgeOperation({
    context,
    capability: "knowledge.organize",
    resource: { orgId: context.orgId, itemId: null, sourceId: null, tags: [] },
    userGrants,
    agentCapabilities,
    delegation,
    now,
  });
  if (!decision.allowed) throw delegationDenied();
}

async function lockCollection(client: PoolClient, orgId: string, collectionId: string): Promise<SqlRow> {
  const result = await client.query<SqlRow>(
    "select * from knowledge_collections where collection_id = $1 and org_id = $2 for update",
    [collectionId, orgId],
  );
  if (result.rows[0] === undefined) throw knowledgeNotFound();
  return result.rows[0];
}

async function assertCollectionInOrganization(
  client: PoolClient,
  orgId: string,
  collectionId: string | null,
): Promise<void> {
  if (collectionId === null) return;
  const result = await client.query<{ collection_id: string }>(
    `select collection_id from knowledge_collections
     where collection_id = $1 and org_id = $2
     for share`,
    [collectionId, orgId],
  );
  if (result.rows[0] === undefined) throw knowledgeNotFound();
}

async function assertKnowledgeItemInOrganization(
  client: PoolClient,
  orgId: string,
  itemId: string,
): Promise<void> {
  const result = await client.query<{ item_id: string }>(
    "select item_id from knowledge_items where item_id = $1 and org_id = $2 for share",
    [itemId, orgId],
  );
  if (result.rows[0] === undefined) throw knowledgeNotFound();
}

async function assertAcyclicMove(
  client: PoolClient,
  orgId: string,
  collectionId: string,
  parentCollectionId: string | null,
): Promise<void> {
  if (parentCollectionId === null) return;
  if (parentCollectionId === collectionId) throw knowledgeConflict();
  const result = await client.query<{ collection_id: string }>(
    `with recursive descendants(collection_id) as (
       select collection_id from knowledge_collections
       where org_id = $1 and parent_collection_id = $2
       union
       select child.collection_id
       from knowledge_collections child
       join descendants parent on child.parent_collection_id = parent.collection_id
       where child.org_id = $1
     )
     select collection_id from descendants where collection_id = $3 limit 1`,
    [orgId, collectionId, parentCollectionId],
  );
  if (result.rows[0] !== undefined) throw knowledgeConflict();
}

async function completeMutation(
  client: PoolClient,
  input: {
    readonly context: AccessContext;
    readonly action: string;
    readonly targetKind: "collection" | "item";
    readonly targetId: string;
    readonly now: Date;
    readonly auditId: string;
  },
): Promise<void> {
  await client.query(
    "update organizations set registry_revision = registry_revision + 1 where org_id = $1",
    [input.context.orgId],
  );
  await insertAudit(client, { ...input, decision: "completed", receiptMetadata: {} });
}

async function insertAudit(
  client: PoolClient,
  input: {
    readonly context: AccessContext;
    readonly action: string;
    readonly targetKind: "collection" | "item";
    readonly targetId: string;
    readonly decision: "completed" | "failed";
    readonly now: Date;
    readonly auditId: string;
    readonly receiptMetadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `insert into audit_events(
       audit_event_id, org_id, task_id, actor_principal_id, on_behalf_of_user_id,
       action, target_kind, target_id, decision, receipt_metadata, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [input.auditId, input.context.orgId, input.context.taskId, input.context.actorPrincipalId,
      input.context.onBehalfOfUserId, input.action, input.targetKind, input.targetId, input.decision,
      JSON.stringify(input.receiptMetadata), input.now.toISOString()],
  );
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

function mapCollection(row: SqlRow): KnowledgeCollection {
  return knowledgeCollectionSchema.parse({
    schema: "cowikiharness.collection/v1",
    collectionId: String(row.collection_id),
    orgId: String(row.org_id),
    parentCollectionId: row.parent_collection_id === null ? null : String(row.parent_collection_id),
    name: String(row.name),
    description: String(row.description),
    revision: Number(row.revision),
    createdByPrincipalId: String(row.created_by_principal_id),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  });
}

function mapPlacement(row: SqlRow): KnowledgeCollectionPlacement {
  return knowledgeCollectionPlacementSchema.parse({
    schema: "cowikiharness.collection-placement/v1",
    orgId: String(row.org_id),
    itemId: String(row.item_id),
    collectionId: String(row.collection_id),
    placedByPrincipalId: String(row.placed_by_principal_id),
    revision: Number(row.revision),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  });
}

function isPlacementReplay(expectedRevision: number | null, currentRevision: number): boolean {
  if (expectedRevision === null) return currentRevision === 0;
  return expectedRevision === currentRevision || expectedRevision + 1 === currentRevision;
}

function requiredRow(row: SqlRow | undefined): SqlRow {
  if (row === undefined) {
    throw new AdapterError("INVALID_OPERATION", "Knowledge hierarchy mutation could not be completed");
  }
  return row;
}

function normalizeHierarchyError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (hasSqlState(error, "23505") || hasSqlState(error, "23514")) return knowledgeConflict();
  return new AdapterError("INVALID_OPERATION", "Knowledge hierarchy operation could not be completed");
}

function hasSqlState(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function delegationDenied(): AdapterError {
  return new AdapterError("DELEGATION_DENIED", "Knowledge hierarchy mutation is not authorized");
}

function revisionConflict(): AdapterError {
  return new AdapterError("REVISION_CONFLICT", "Knowledge hierarchy revision changed");
}

function knowledgeNotFound(): AdapterError {
  return new AdapterError("KNOWLEDGE_NOT_FOUND", "Knowledge hierarchy resource was not found");
}

function knowledgeConflict(): AdapterError {
  return new AdapterError("KNOWLEDGE_CONFLICT", "Knowledge hierarchy mutation conflicts with stored state");
}

function toTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
