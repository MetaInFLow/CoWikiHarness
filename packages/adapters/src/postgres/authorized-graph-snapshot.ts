import { KnowledgeGraphError } from "@openlifewiki/core";
import type { Principal } from "@openlifewiki/protocol";
import { z } from "zod";

import type { Database } from "./database.js";

export interface AuthorizedGraphKnowledgeItemRow {
  readonly itemId: string;
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly status: "draft" | "stable" | "deprecated";
  readonly currentVersionId: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AuthorizedGraphCollectionRow {
  readonly collectionId: string;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
}

export interface AuthorizedGraphPlacementRow {
  readonly itemId: string;
  readonly collectionId: string;
  readonly revision: number;
}

export interface AuthorizedGraphTagRow {
  readonly tagId: string;
  readonly name: string;
  readonly description: string;
}

export interface AuthorizedGraphKnowledgeTagRow {
  readonly itemId: string;
  readonly tagId: string;
}

export interface AuthorizedGraphLocationRow {
  readonly locationId: string;
  readonly itemId: string;
  readonly kind: "managed-markdown" | "feishu" | "github" | "person-local";
  readonly role: "canonical" | "original" | "managed-copy" | "reference";
  readonly connectorInstanceId: string | null;
  readonly ownerPrincipalId: string;
  readonly availability: "available" | "offline" | "unknown" | "revoked";
  readonly lastVerifiedAt: string | null;
}

export interface AuthorizedGraphCurrentVersionRow {
  readonly versionId: string;
  readonly itemId: string;
  readonly ordinal: number;
  readonly bodyHash: string;
  readonly providerVersion: string | null;
  readonly createdAt: string;
}

export interface AuthorizedGraphConnectorRow {
  readonly id: string;
  readonly type: "local-folder" | "github" | "feishu" | "codex-history";
  readonly displayName: string;
  readonly status: "active" | "disabled";
}

export interface AuthorizedGraphPrincipalRow {
  readonly id: string;
  readonly type: "user" | "agent" | "relay";
  readonly displayName: string;
}

export interface AuthorizedGraphShareRow {
  readonly itemId: string;
  readonly principalId: string;
}

export interface AuthorizedGraphSnapshot {
  readonly registryRevision: number;
  readonly principalId: string;
  readonly orgId: string;
  readonly organizationRole: "owner" | "member" | null;
  readonly hasOrganizationQueryGrant: boolean;
  readonly knowledgeItems: readonly AuthorizedGraphKnowledgeItemRow[];
  readonly collections: readonly AuthorizedGraphCollectionRow[];
  readonly placements: readonly AuthorizedGraphPlacementRow[];
  readonly tags: readonly AuthorizedGraphTagRow[];
  readonly knowledgeTags: readonly AuthorizedGraphKnowledgeTagRow[];
  readonly locations: readonly AuthorizedGraphLocationRow[];
  readonly currentVersions: readonly AuthorizedGraphCurrentVersionRow[];
  readonly connectors: readonly AuthorizedGraphConnectorRow[];
  readonly principals: readonly AuthorizedGraphPrincipalRow[];
  readonly shares: readonly AuthorizedGraphShareRow[];
}

const safeInteger = z.union([
  z.int().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/u),
]).transform((value, context) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    context.addIssue({ code: "custom", message: "Expected a safe integer" });
    return z.NEVER;
  }
  return number;
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();

const principalContextSchema = z.strictObject({
  registryRevision: safeInteger,
  principalId: id,
  orgId: id,
  organizationRole: z.enum(["owner", "member"]).nullable(),
});
const knowledgeItemSchema = z.strictObject({
  itemId: id,
  ownerPrincipalId: id,
  title: z.string().min(1).max(500),
  status: z.enum(["draft", "stable", "deprecated"]),
  currentVersionId: id.nullable(),
  revision: safeInteger,
  updatedAt: timestamp,
});
const collectionSchema = z.strictObject({
  collectionId: id,
  parentCollectionId: id.nullable(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  revision: safeInteger,
});
const placementSchema = z.strictObject({ itemId: id, collectionId: id, revision: safeInteger });
const tagSchema = z.strictObject({
  tagId: id,
  name: z.string().min(1).max(100),
  description: z.string().max(2_000),
});
const knowledgeTagSchema = z.strictObject({ itemId: id, tagId: id });
const locationSchema = z.strictObject({
  locationId: id,
  itemId: id,
  kind: z.enum(["managed-markdown", "feishu", "github", "person-local"]),
  role: z.enum(["canonical", "original", "managed-copy", "reference"]),
  connectorInstanceId: id.nullable(),
  ownerPrincipalId: id,
  availability: z.enum(["available", "offline", "unknown", "revoked"]),
  lastVerifiedAt: nullableTimestamp,
});
const currentVersionSchema = z.strictObject({
  versionId: id,
  itemId: id,
  ordinal: z.int().positive(),
  bodyHash: hash,
  providerVersion: z.string().min(1).max(500).nullable(),
  createdAt: timestamp,
});
const connectorSchema = z.strictObject({
  id,
  type: z.enum(["local-folder", "github", "feishu", "codex-history"]),
  displayName: z.string().min(1).max(200),
  status: z.enum(["active", "disabled"]),
});
const principalSchema = z.strictObject({
  id,
  type: z.enum(["user", "agent", "relay"]),
  displayName: z.string().min(1).max(200),
});
const shareSchema = z.strictObject({ itemId: id, principalId: id });
const snapshotQueryRowSchema = z.strictObject({
  principalContext: principalContextSchema.nullable(),
  hasAnyQueryGrant: z.boolean(),
  hasOrganizationQueryGrant: z.boolean(),
  knowledgeItems: z.array(knowledgeItemSchema),
  collections: z.array(collectionSchema),
  placements: z.array(placementSchema),
  tags: z.array(tagSchema),
  knowledgeTags: z.array(knowledgeTagSchema),
  locations: z.array(locationSchema),
  currentVersions: z.array(currentVersionSchema),
  connectors: z.array(connectorSchema),
  principals: z.array(principalSchema),
  shares: z.array(shareSchema),
});

interface SnapshotQueryRow {
  readonly principalContext: unknown;
  readonly hasAnyQueryGrant: unknown;
  readonly hasOrganizationQueryGrant: unknown;
  readonly knowledgeItems: unknown;
  readonly collections: unknown;
  readonly placements: unknown;
  readonly tags: unknown;
  readonly knowledgeTags: unknown;
  readonly locations: unknown;
  readonly currentVersions: unknown;
  readonly connectors: unknown;
  readonly principals: unknown;
  readonly shares: unknown;
}

const SNAPSHOT_SQL = `
with recursive
principal_context as (
  select
    o.registry_revision,
    p.principal_id,
    p.org_id,
    p.organization_role
  from principals p
  join organizations o on o.org_id = p.org_id
  where p.principal_id = $1
    and p.org_id = $2
    and p.principal_type = 'user'
    and p.status = 'active'
),
active_grants as (
  select rg.scope_kind, rg.scope_id
  from resource_grants rg
  join principal_context pc
    on pc.org_id = rg.org_id
   and pc.principal_id = rg.principal_id
  where rg.revoked_at is null
    and (rg.expires_at is null or rg.expires_at > $3::timestamptz)
    and rg.capabilities @> array['knowledge.query']::text[]
),
authorized_items as (
  select distinct
    ki.item_id,
    ki.org_id,
    ki.owner_principal_id,
    ki.title,
    ki.status,
    current_version.version_id as current_version_id,
    ki.revision,
    ki.updated_at
  from knowledge_items ki
  join principal_context pc on pc.org_id = ki.org_id
  join principals item_owner
    on item_owner.principal_id = ki.owner_principal_id
   and item_owner.org_id = ki.org_id
  left join knowledge_versions current_version
    on current_version.version_id = ki.current_version_id
   and current_version.org_id = ki.org_id
   and current_version.item_id = ki.item_id
  where exists (
    select 1
    from active_grants ag
    where (ag.scope_kind = 'organization' and ag.scope_id = pc.org_id)
       or (ag.scope_kind = 'item' and ag.scope_id = ki.item_id)
       or (ag.scope_kind = 'tag' and exists (
         select 1
         from knowledge_tags kt
         join tags t on t.tag_id = kt.tag_id and t.org_id = kt.org_id
         where kt.org_id = ki.org_id
           and kt.item_id = ki.item_id
           and t.name = ag.scope_id
       ))
       or (ag.scope_kind = 'source' and exists (
         select 1
         from knowledge_locations kl
         join source_authorizations sa
           on sa.source_authorization_id = kl.source_authorization_id
          and sa.org_id = kl.org_id
          and sa.status = 'active'
         where kl.org_id = ki.org_id
           and kl.item_id = ki.item_id
           and sa.source_id = ag.scope_id
       ))
  )
    and (
      ki.status <> 'draft'
      or ki.owner_principal_id = pc.principal_id
      or exists (
        select 1 from active_grants direct_grant
        where direct_grant.scope_kind = 'item'
          and direct_grant.scope_id = ki.item_id
      )
    )
),
valid_collections as (
  select c.collection_id, c.org_id, c.parent_collection_id, c.name, c.description, c.revision
  from knowledge_collections c
  join principal_context pc on pc.org_id = c.org_id
  where c.parent_collection_id is null
  union
  select child.collection_id, child.org_id, child.parent_collection_id,
    child.name, child.description, child.revision
  from knowledge_collections child
  join valid_collections parent
    on parent.org_id = child.org_id
   and parent.collection_id = child.parent_collection_id
),
collection_seeds as (
  select c.collection_id, c.org_id, c.parent_collection_id, c.name, c.description, c.revision
  from valid_collections c
  join principal_context pc on pc.org_id = c.org_id
  where exists (
    select 1 from active_grants ag
    where ag.scope_kind = 'organization' and ag.scope_id = pc.org_id
  )
  union
  select c.collection_id, c.org_id, c.parent_collection_id, c.name, c.description, c.revision
  from authorized_items ai
  join knowledge_collection_items placement
    on placement.org_id = ai.org_id and placement.item_id = ai.item_id
  join valid_collections c
    on c.org_id = placement.org_id and c.collection_id = placement.collection_id
),
visible_collections as (
  select collection_id, org_id, parent_collection_id, name, description, revision
  from collection_seeds
  union
  select parent.collection_id, parent.org_id, parent.parent_collection_id,
    parent.name, parent.description, parent.revision
  from visible_collections child
  join valid_collections parent
    on parent.org_id = child.org_id
   and parent.collection_id = child.parent_collection_id
),
authorized_placements as (
  select placement.item_id, placement.collection_id, placement.revision
  from knowledge_collection_items placement
  join authorized_items ai
    on ai.org_id = placement.org_id and ai.item_id = placement.item_id
  join visible_collections collection
    on collection.org_id = placement.org_id
   and collection.collection_id = placement.collection_id
),
authorized_knowledge_tags as (
  select kt.item_id, kt.tag_id, kt.org_id
  from knowledge_tags kt
  join authorized_items ai on ai.org_id = kt.org_id and ai.item_id = kt.item_id
  join tags t on t.org_id = kt.org_id and t.tag_id = kt.tag_id
),
authorized_tags as (
  select distinct t.tag_id, t.name, t.description
  from tags t
  join authorized_knowledge_tags kt on kt.org_id = t.org_id and kt.tag_id = t.tag_id
),
authorized_locations as (
  select
    kl.location_id,
    kl.org_id,
    kl.item_id,
    kl.location_kind,
    kl.location_role,
    connector.connector_instance_id,
    kl.owner_principal_id,
    kl.availability,
    kl.last_verified_at
  from knowledge_locations kl
  join authorized_items ai on ai.org_id = kl.org_id and ai.item_id = kl.item_id
  join principals location_owner
    on location_owner.principal_id = kl.owner_principal_id
   and location_owner.org_id = kl.org_id
  left join connector_instances connector
    on connector.connector_instance_id = kl.connector_instance_id
   and connector.org_id = kl.org_id
),
authorized_current_versions as (
  select kv.version_id, kv.item_id, kv.ordinal, kv.body_hash, kv.provider_version, kv.created_at
  from knowledge_versions kv
  join authorized_items ai
    on ai.org_id = kv.org_id
   and ai.item_id = kv.item_id
   and ai.current_version_id = kv.version_id
),
authorized_connectors as (
  select distinct ci.connector_instance_id, ci.connector_type, ci.display_name, ci.status
  from connector_instances ci
  join authorized_locations location
    on location.org_id = ci.org_id
   and location.connector_instance_id = ci.connector_instance_id
),
visible_shares as (
  select distinct ai.item_id, target.principal_id
  from authorized_items ai
  join principal_context pc on pc.org_id = ai.org_id
  join resource_grants rg
    on rg.org_id = ai.org_id
   and rg.scope_kind = 'item'
   and rg.scope_id = ai.item_id
  join principals target
    on target.org_id = rg.org_id
   and target.principal_id = rg.principal_id
   and target.status = 'active'
  where rg.revoked_at is null
    and (rg.expires_at is null or rg.expires_at > $3::timestamptz)
    and rg.capabilities @> array['knowledge.query']::text[]
    and (
      pc.organization_role = 'owner'
      or ai.owner_principal_id = pc.principal_id
      or target.principal_id = pc.principal_id
    )
),
visible_principal_ids as (
  select owner_principal_id as principal_id from authorized_items
  union
  select owner_principal_id as principal_id from authorized_locations
  union
  select principal_id from visible_shares
),
visible_principals as (
  select p.principal_id, p.principal_type, p.display_name
  from principals p
  join principal_context pc on pc.org_id = p.org_id
  join visible_principal_ids visible on visible.principal_id = p.principal_id
)
select
  (select jsonb_build_object(
    'registryRevision', pc.registry_revision::text,
    'principalId', pc.principal_id,
    'orgId', pc.org_id,
    'organizationRole', pc.organization_role
  ) from principal_context pc) as "principalContext",
  exists(select 1 from active_grants) as "hasAnyQueryGrant",
  exists(
    select 1 from active_grants ag join principal_context pc on true
    where ag.scope_kind = 'organization' and ag.scope_id = pc.org_id
  ) as "hasOrganizationQueryGrant",
  coalesce((select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'ownerPrincipalId', owner_principal_id,
    'title', title,
    'status', status,
    'currentVersionId', current_version_id,
    'revision', revision::text,
    'updatedAt', updated_at
  ) order by item_id) from authorized_items), '[]'::jsonb) as "knowledgeItems",
  coalesce((select jsonb_agg(jsonb_build_object(
    'collectionId', collection_id,
    'parentCollectionId', parent_collection_id,
    'name', name,
    'description', description,
    'revision', revision::text
  ) order by collection_id) from visible_collections), '[]'::jsonb) as "collections",
  coalesce((select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'collectionId', collection_id,
    'revision', revision::text
  ) order by item_id) from authorized_placements), '[]'::jsonb) as "placements",
  coalesce((select jsonb_agg(jsonb_build_object(
    'tagId', tag_id,
    'name', name,
    'description', description
  ) order by tag_id) from authorized_tags), '[]'::jsonb) as "tags",
  coalesce((select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'tagId', tag_id
  ) order by item_id, tag_id) from authorized_knowledge_tags), '[]'::jsonb) as "knowledgeTags",
  coalesce((select jsonb_agg(jsonb_build_object(
    'locationId', location_id,
    'itemId', item_id,
    'kind', location_kind,
    'role', location_role,
    'connectorInstanceId', connector_instance_id,
    'ownerPrincipalId', owner_principal_id,
    'availability', availability,
    'lastVerifiedAt', last_verified_at
  ) order by location_id) from authorized_locations), '[]'::jsonb) as "locations",
  coalesce((select jsonb_agg(jsonb_build_object(
    'versionId', version_id,
    'itemId', item_id,
    'ordinal', ordinal,
    'bodyHash', body_hash,
    'providerVersion', provider_version,
    'createdAt', created_at
  ) order by version_id) from authorized_current_versions), '[]'::jsonb) as "currentVersions",
  coalesce((select jsonb_agg(jsonb_build_object(
    'id', connector_instance_id,
    'type', connector_type,
    'displayName', display_name,
    'status', status
  ) order by connector_instance_id) from authorized_connectors), '[]'::jsonb) as "connectors",
  coalesce((select jsonb_agg(jsonb_build_object(
    'id', principal_id,
    'type', principal_type,
    'displayName', display_name
  ) order by principal_id) from visible_principals), '[]'::jsonb) as "principals",
  coalesce((select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'principalId', principal_id
  ) order by item_id, principal_id) from visible_shares), '[]'::jsonb) as "shares"
`;

export async function loadAuthorizedGraphSnapshot(
  database: Database,
  input: { readonly principal: Principal; readonly now: Date },
): Promise<AuthorizedGraphSnapshot> {
  if (input.principal.type !== "user") {
    throw new KnowledgeGraphError(
      "GRAPH_PRINCIPAL_NOT_SUPPORTED",
      "Knowledge graph reads support user principals only.",
    );
  }
  if (input.principal.status !== "active") {
    throw forbidden();
  }

  const result = await database.query<SnapshotQueryRow>(SNAPSHOT_SQL, [
    input.principal.principalId,
    input.principal.orgId,
    input.now.toISOString(),
  ]);
  const parsed = snapshotQueryRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new KnowledgeGraphError("GRAPH_UNAVAILABLE", "The knowledge graph snapshot is unavailable.");
  }
  if (parsed.data.principalContext === null || !parsed.data.hasAnyQueryGrant) {
    throw forbidden();
  }

  const { principalContext } = parsed.data;
  return {
    registryRevision: principalContext.registryRevision,
    principalId: principalContext.principalId,
    orgId: principalContext.orgId,
    organizationRole: principalContext.organizationRole,
    hasOrganizationQueryGrant: parsed.data.hasOrganizationQueryGrant,
    knowledgeItems: parsed.data.knowledgeItems,
    collections: parsed.data.collections,
    placements: parsed.data.placements,
    tags: parsed.data.tags,
    knowledgeTags: parsed.data.knowledgeTags,
    locations: parsed.data.locations,
    currentVersions: parsed.data.currentVersions,
    connectors: parsed.data.connectors,
    principals: parsed.data.principals,
    shares: parsed.data.shares,
  };
}

function forbidden(): KnowledgeGraphError {
  return new KnowledgeGraphError(
    "GRAPH_FORBIDDEN",
    "The principal is not authorized to read the knowledge graph.",
  );
}
