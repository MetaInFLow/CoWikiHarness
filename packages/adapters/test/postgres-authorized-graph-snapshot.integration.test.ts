import { randomUUID } from "node:crypto";

import type { Principal } from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import { createDatabase, runMigrations } from "../src/index.js";
import {
  loadAuthorizedGraphSnapshot,
  type AuthorizedGraphSnapshot,
} from "../src/postgres/authorized-graph-snapshot.js";
import type { Database } from "../src/postgres/database.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;
const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("authorized graph snapshot decoding", () => {
  it("reads placement revision from the authorized SQL projection", async () => {
    let statement = "";
    const database = {
      async query(text: string) {
        statement = text;
        return {
          rows: [{
            principalContext: {
              registryRevision: "1",
              principalId: "principal_1",
              orgId: "org_1",
              organizationRole: "owner",
            },
            hasAnyQueryGrant: true,
            hasOrganizationQueryGrant: true,
            knowledgeItems: [],
            collections: [],
            placements: [{ itemId: "item_1", collectionId: "collection_1", revision: "7" }],
            tags: [],
            knowledgeTags: [],
            locations: [],
            currentVersions: [],
            connectors: [],
            principals: [],
            shares: [],
          }],
        };
      },
    } as unknown as Database;
    const principal: Principal = {
      schema: "openlifewiki.principal/v1",
      principalId: "principal_1",
      orgId: "org_1",
      type: "user",
      displayName: "Owner",
      organizationRole: "owner",
      capabilities: ["knowledge.query"],
      status: "active",
    };

    const snapshot = await loadAuthorizedGraphSnapshot(database, { principal, now: NOW });

    expect(snapshot.placements).toEqual([{
      itemId: "item_1",
      collectionId: "collection_1",
      revision: 7,
    }]);
    expect(statement).toMatch(
      /authorized_placements as \(\s*select placement\.item_id, placement\.collection_id, placement\.revision/u,
    );
    expect(statement).toMatch(/'revision', revision::text[\s\S]+from authorized_placements/u);
  });
});

describePostgres("PostgreSQL authorized graph snapshot", () => {
  it("loads only SQL-authorized graph rows for organization, item, tag, and source grants", async () => {
    await withGraphFixture(async ({ database, ids, principals, secrets }) => {
      const owner = await loadAuthorizedGraphSnapshot(database, { principal: principals.owner, now: NOW });
      expect(owner.registryRevision).toBe(41);
      expect(owner.organizationRole).toBe("owner");
      expect(owner.hasOrganizationQueryGrant).toBe(true);
      expect(idsOf(owner.knowledgeItems, "itemId")).toEqual([
        ids.directStableItem,
        ids.hiddenSiblingItem,
        ids.ownerDraftItem,
        ids.revokedSourceItem,
        ids.sourceItem,
        ids.tagDraftItem,
        ids.tagItem,
        ids.unfiledItem,
      ].sort());
      expect(idsOf(owner.collections, "collectionId")).toEqual([
        ids.childCollection,
        ids.emptyCollection,
        ids.rootCollection,
        ids.siblingCollection,
      ].sort());

      const itemMember = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.itemMember,
        now: NOW,
      });
      expect(itemMember.hasOrganizationQueryGrant).toBe(false);
      expect(idsOf(itemMember.knowledgeItems, "itemId")).toEqual([
        ids.directStableItem,
        ids.ownerDraftItem,
      ].sort());
      expect(idsOf(itemMember.collections, "collectionId")).toEqual([
        ids.childCollection,
        ids.rootCollection,
      ].sort());
      expect(idsOf(itemMember.placements, "itemId")).toEqual([
        ids.directStableItem,
        ids.ownerDraftItem,
      ].sort());
      expect(itemMember.shares).toEqual([
        { itemId: ids.directStableItem, principalId: ids.itemMember },
        { itemId: ids.ownerDraftItem, principalId: ids.itemMember },
      ]);
      expect(idsOf(itemMember.principals, "id")).toEqual([ids.itemMember, ids.owner].sort());

      const tagMember = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.tagMember,
        now: NOW,
      });
      expect(idsOf(tagMember.knowledgeItems, "itemId")).toEqual([
        ids.tagItem,
        ids.unfiledItem,
      ].sort());
      expect(idsOf(tagMember.collections, "collectionId")).toEqual([
        ids.childCollection,
        ids.rootCollection,
      ].sort());
      expect(tagMember.placements).toEqual([
        { itemId: ids.tagItem, collectionId: ids.childCollection, revision: 6 },
      ]);
      expect(tagMember.tags).toEqual([
        { tagId: ids.teamTag, name: "team", description: "Visible team tag" },
      ]);
      expect(idsOf(tagMember.knowledgeTags, "itemId")).toEqual([
        ids.tagItem,
        ids.unfiledItem,
      ].sort());
      expect(tagMember.shares).toEqual([]);
      expect(idsOf(tagMember.principals, "id")).toEqual([ids.owner]);

      const sourceMember = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.sourceMember,
        now: NOW,
      });
      expect(idsOf(sourceMember.knowledgeItems, "itemId")).toEqual([ids.sourceItem]);
      expect(idsOf(sourceMember.locations, "itemId")).toEqual([ids.sourceItem]);
      expect(idsOf(sourceMember.currentVersions, "itemId")).toEqual([ids.sourceItem]);
      expect(sourceMember.connectors).toEqual([{
        id: ids.sharedConnector,
        type: "github",
        displayName: "Shared GitHub",
        status: "active",
      }]);

      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, { principal: principals.none, now: NOW }),
        "GRAPH_FORBIDDEN",
      );

      expectSafeShape(itemMember);
      const itemJson = JSON.stringify(itemMember);
      for (const forbidden of [
        secrets.body,
        secrets.locator,
        secrets.absolutePath,
        secrets.metadata,
        secrets.connectorSecret,
        secrets.authorization,
        ids.activeSourceAuthorization,
        ids.hiddenSiblingItem,
        "Hidden sibling title",
        ids.otherMember,
        "Other member display",
        "bodyMarkdown",
        "locator",
        "metadata",
        "secretReference",
        "sourceAuthorizationId",
        "capabilities",
        "delegation",
      ]) {
        expect(itemJson).not.toContain(forbidden);
      }
    });
  });

  it("shows item-share targets only to item owners, organization owners, or the target itself", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const owner = await loadAuthorizedGraphSnapshot(database, { principal: principals.owner, now: NOW });
      expect(owner.shares).toEqual(expect.arrayContaining([
        { itemId: ids.directStableItem, principalId: ids.itemMember },
        { itemId: ids.directStableItem, principalId: ids.otherMember },
        { itemId: ids.tagItem, principalId: ids.otherMember },
      ]));
      expect(idsOf(owner.principals, "id")).toEqual(expect.arrayContaining([
        ids.itemMember,
        ids.otherMember,
        ids.owner,
      ]));

      const tagMember = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.tagMember,
        now: NOW,
      });
      expect(tagMember.shares).toEqual([]);
      expect(JSON.stringify(tagMember)).not.toContain(ids.otherMember);
    });
  });

  it("does not expose cross-organization relationship targets from corrupted foreign keys", async () => {
    await withGraphFixture(async (fixture) => {
      const { database, ids, principals } = fixture;
      await injectCrossOrganizationRelationships(fixture);

      const snapshot = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.owner,
        now: NOW,
      });
      const json = JSON.stringify(snapshot);
      for (const foreignValue of [
        ids.otherOrg,
        ids.foreignOwner,
        ids.foreignVersion,
        ids.foreignTag,
        ids.foreignCollection,
        ids.foreignConnector,
        "Foreign owner",
        "Cross-org collection title",
        "Cross-org connector display",
        "Cross-org tag title",
      ]) {
        expect(json).not.toContain(foreignValue);
      }

      expect(snapshot.knowledgeItems.find((item) => item.itemId === ids.directStableItem))
        .toMatchObject({ currentVersionId: null });
      expect(snapshot.knowledgeItems.find((item) => item.itemId === ids.tagItem))
        .toMatchObject({ currentVersionId: null });
      expect(idsOf(snapshot.knowledgeItems, "itemId")).not.toContain(ids.hiddenSiblingItem);
      expect(idsOf(snapshot.collections, "collectionId")).not.toContain(ids.childCollection);
      expect(snapshot.locations.find((location) => location.itemId === ids.directStableItem))
        .toMatchObject({ connectorInstanceId: null });
      expect(idsOf(snapshot.locations, "itemId")).not.toContain(ids.ownerDraftItem);
      assertSnapshotRelationshipsClosed(snapshot);
    });
  });

  it("lets an ordinary member who owns an item see every share on that item", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      await database.query(
        "update knowledge_items set owner_principal_id = $1 where item_id = $2",
        [ids.tagMember, ids.tagItem],
      );

      const snapshot = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.tagMember,
        now: NOW,
      });
      expect(snapshot.shares).toContainEqual({
        itemId: ids.tagItem,
        principalId: ids.otherMember,
      });
      expect(idsOf(snapshot.principals, "id")).toEqual(expect.arrayContaining([
        ids.tagMember,
        ids.otherMember,
      ]));
    });
  });

  it("keeps organization-query members from seeing shares targeted to other principals", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      await database.query(
        `insert into resource_grants(
           grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
         ) values ($1, $2, $3, 'organization', $2, '{knowledge.query}')`,
        [`grant_member_org_${randomUUID()}`, principals.owner.orgId, ids.itemMember],
      );

      const snapshot = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.itemMember,
        now: NOW,
      });
      expect(snapshot.hasOrganizationQueryGrant).toBe(true);
      expect(snapshot.shares).toEqual([
        { itemId: ids.directStableItem, principalId: ids.itemMember },
        { itemId: ids.ownerDraftItem, principalId: ids.itemMember },
      ]);
      expect(snapshot.shares.some((share) => share.principalId === ids.otherMember)).toBe(false);
    });
  });

  it("returns stable empty arrays when an active local grant matches no items", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      await database.query("delete from knowledge_tags where tag_id = $1", [ids.teamTag]);

      const snapshot = await loadAuthorizedGraphSnapshot(database, {
        principal: principals.tagMember,
        now: NOW,
      });
      expect(snapshot.hasOrganizationQueryGrant).toBe(false);
      for (const rows of [
        snapshot.knowledgeItems,
        snapshot.collections,
        snapshot.placements,
        snapshot.tags,
        snapshot.knowledgeTags,
        snapshot.locations,
        snapshot.currentVersions,
        snapshot.connectors,
        snapshot.principals,
        snapshot.shares,
      ]) {
        expect(rows).toEqual([]);
      }
    });
  });

  it("fails closed when a selected safe row violates the runtime contract", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      await database.query("update knowledge_items set title = '' where item_id = $1", [ids.directStableItem]);

      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, { principal: principals.itemMember, now: NOW }),
        "GRAPH_UNAVAILABLE",
      );
    });
  });

  it("rejects unsupported, revoked, missing, and database-inconsistent principals", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, { principal: principals.agent, now: NOW }),
        "GRAPH_PRINCIPAL_NOT_SUPPORTED",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, { principal: principals.relay, now: NOW }),
        "GRAPH_PRINCIPAL_NOT_SUPPORTED",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, {
          principal: { ...principals.owner, status: "revoked" },
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, {
          principal: { ...principals.revoked, status: "active" },
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, {
          principal: { ...principals.owner, principalId: ids.missingPrincipal },
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, {
          principal: { ...principals.owner, principalId: ids.agent },
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );
      await expectGraphError(
        loadAuthorizedGraphSnapshot(database, {
          principal: { ...principals.owner, orgId: ids.otherOrg },
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );
    });
  });
});

function expectSafeShape(snapshot: AuthorizedGraphSnapshot): void {
  expect(Object.keys(snapshot).sort()).toEqual([
    "collections",
    "connectors",
    "currentVersions",
    "hasOrganizationQueryGrant",
    "knowledgeItems",
    "knowledgeTags",
    "locations",
    "orgId",
    "organizationRole",
    "placements",
    "principalId",
    "principals",
    "registryRevision",
    "shares",
    "tags",
  ]);
  expect(Object.keys(snapshot.knowledgeItems[0] ?? {}).sort()).toEqual([
    "currentVersionId", "itemId", "ownerPrincipalId", "revision", "status", "title", "updatedAt",
  ]);
  expect(Object.keys(snapshot.collections[0] ?? {}).sort()).toEqual([
    "collectionId", "description", "name", "parentCollectionId", "revision",
  ]);
  expect(Object.keys(snapshot.placements[0] ?? {}).sort()).toEqual(["collectionId", "itemId", "revision"]);
  expect(Object.keys(snapshot.locations[0] ?? {}).sort()).toEqual([
    "availability", "connectorInstanceId", "itemId", "kind", "lastVerifiedAt", "locationId",
    "ownerPrincipalId", "role",
  ]);
  expect(Object.keys(snapshot.currentVersions[0] ?? {}).sort()).toEqual([
    "bodyHash", "createdAt", "itemId", "ordinal", "providerVersion", "versionId",
  ]);
  expect(Object.keys(snapshot.principals[0] ?? {}).sort()).toEqual(["displayName", "id", "type"]);
}

function idsOf<T, K extends keyof T>(rows: readonly T[], key: K): T[K][] {
  return rows.map((row) => row[key]).sort();
}

async function expectGraphError(
  promise: Promise<unknown>,
  code: "GRAPH_FORBIDDEN" | "GRAPH_PRINCIPAL_NOT_SUPPORTED" | "GRAPH_UNAVAILABLE",
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "KnowledgeGraphError", code });
}

interface GraphFixture {
  readonly database: Database;
  readonly ids: Readonly<Record<FixtureId, string>>;
  readonly principals: Readonly<Record<FixturePrincipal, Principal>>;
  readonly secrets: {
    readonly body: string;
    readonly locator: string;
    readonly absolutePath: string;
    readonly metadata: string;
    readonly connectorSecret: string;
    readonly authorization: string;
  };
}

type FixturePrincipal = "owner" | "itemMember" | "tagMember" | "sourceMember" | "none"
  | "otherMember" | "revoked" | "agent" | "relay";

type FixtureId = FixturePrincipal | "otherOrg" | "foreignOwner" | "missingPrincipal"
  | "directStableItem" | "ownerDraftItem" | "tagItem" | "tagDraftItem" | "unfiledItem"
  | "sourceItem" | "revokedSourceItem" | "hiddenSiblingItem"
  | "rootCollection" | "childCollection" | "siblingCollection" | "emptyCollection"
  | "teamTag" | "hiddenTag" | "sharedConnector" | "hiddenConnector"
  | "activeSourceAuthorization" | "revokedSourceAuthorization"
  | "foreignVersion" | "foreignTag" | "foreignCollection" | "foreignConnector";

async function withGraphFixture(work: (fixture: GraphFixture) => Promise<void>): Promise<void> {
  const isolated = await createIsolatedTestDatabase();
  try {
    await runMigrations(isolated.database, { migrationsDir: "migrations" });
    const fixture = await seedGraphFixture(isolated.database);
    await work(fixture);
  } finally {
    await isolated.cleanup();
  }
}

async function injectCrossOrganizationRelationships(fixture: GraphFixture): Promise<void> {
  const { database, ids, principals } = fixture;
  await database.query(
    `insert into connector_instances(
       connector_instance_id, org_id, connector_type, display_name, status
     ) values ($1, $2, 'github', 'Cross-org connector display', 'active')`,
    [ids.foreignConnector, ids.otherOrg],
  );
  await database.query(
    `insert into tags(tag_id, org_id, name, description)
     values ($1, $2, 'cross-org-tag', 'Cross-org tag title')`,
    [ids.foreignTag, ids.otherOrg],
  );
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, name, description, created_by_principal_id
     ) values ($1, $2, 'Cross-org collection title', 'Foreign collection description', $3)`,
    [ids.foreignCollection, ids.otherOrg, ids.foreignOwner],
  );
  await database.query(
    `insert into knowledge_versions(
       version_id, org_id, item_id, location_id, ordinal, body_hash, provider_version,
       provenance, created_by_principal_id
     )
     select $1, $2, $3, location_id, 2, $4, 'foreign-provider-version', '{}', $5
     from knowledge_locations
     where org_id = $6 and item_id = $3
     order by location_id
     limit 1`,
    [ids.foreignVersion, ids.otherOrg, ids.directStableItem, `sha256:${"b".repeat(64)}`,
      ids.foreignOwner, principals.owner.orgId],
  );
  await database.query(
    "update knowledge_items set current_version_id = $1 where item_id = $2",
    [ids.foreignVersion, ids.directStableItem],
  );
  await database.query(
    "update knowledge_items set current_version_id = $1 where item_id = $2",
    [`version_${ids.sourceItem}`, ids.tagItem],
  );
  await database.query(
    "update knowledge_items set owner_principal_id = $1 where item_id = $2",
    [ids.foreignOwner, ids.hiddenSiblingItem],
  );
  await database.query(
    "update knowledge_collections set parent_collection_id = $1 where collection_id = $2",
    [ids.foreignCollection, ids.childCollection],
  );
  await database.query(
    "update knowledge_collection_items set collection_id = $1 where item_id = $2",
    [ids.foreignCollection, ids.sourceItem],
  );
  await database.query(
    `insert into knowledge_tags(org_id, item_id, tag_id) values ($1, $2, $3)`,
    [principals.owner.orgId, ids.directStableItem, ids.foreignTag],
  );
  await database.query(
    `insert into resource_grants(
       grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
     ) values ($1, $2, $3, 'item', $4, '{knowledge.query}')`,
    [`grant_foreign_share_${randomUUID()}`, principals.owner.orgId, ids.foreignOwner, ids.directStableItem],
  );
  await database.query(
    "update knowledge_locations set connector_instance_id = $1 where item_id = $2",
    [ids.foreignConnector, ids.directStableItem],
  );
  await database.query(
    "update knowledge_locations set owner_principal_id = $1 where item_id = $2",
    [ids.foreignOwner, ids.ownerDraftItem],
  );
}

function assertSnapshotRelationshipsClosed(snapshot: AuthorizedGraphSnapshot): void {
  const itemIds = new Set(snapshot.knowledgeItems.map((item) => item.itemId));
  const collectionIds = new Set(snapshot.collections.map((collection) => collection.collectionId));
  const tagIds = new Set(snapshot.tags.map((tag) => tag.tagId));
  const versionIds = new Set(snapshot.currentVersions.map((version) => version.versionId));
  const connectorIds = new Set(snapshot.connectors.map((connector) => connector.id));
  const principalIds = new Set(snapshot.principals.map((principal) => principal.id));

  for (const item of snapshot.knowledgeItems) {
    expect(principalIds.has(item.ownerPrincipalId)).toBe(true);
    expect(item.currentVersionId === null || versionIds.has(item.currentVersionId)).toBe(true);
  }
  for (const collection of snapshot.collections) {
    expect(collection.parentCollectionId === null || collectionIds.has(collection.parentCollectionId))
      .toBe(true);
  }
  for (const placement of snapshot.placements) {
    expect(itemIds.has(placement.itemId)).toBe(true);
    expect(collectionIds.has(placement.collectionId)).toBe(true);
  }
  for (const relation of snapshot.knowledgeTags) {
    expect(itemIds.has(relation.itemId)).toBe(true);
    expect(tagIds.has(relation.tagId)).toBe(true);
  }
  for (const location of snapshot.locations) {
    expect(itemIds.has(location.itemId)).toBe(true);
    expect(principalIds.has(location.ownerPrincipalId)).toBe(true);
    expect(location.connectorInstanceId === null || connectorIds.has(location.connectorInstanceId)).toBe(true);
  }
  for (const version of snapshot.currentVersions) {
    expect(itemIds.has(version.itemId)).toBe(true);
  }
  for (const share of snapshot.shares) {
    expect(itemIds.has(share.itemId)).toBe(true);
    expect(principalIds.has(share.principalId)).toBe(true);
  }
}

async function seedGraphFixture(database: Database): Promise<GraphFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const id = (name: FixtureId): string => `${name}_${suffix}`;
  const ids = Object.fromEntries(([
    "owner", "itemMember", "tagMember", "sourceMember", "none", "otherMember", "revoked", "agent",
    "relay", "otherOrg", "foreignOwner", "missingPrincipal", "directStableItem", "ownerDraftItem",
    "tagItem", "tagDraftItem", "unfiledItem", "sourceItem", "revokedSourceItem", "hiddenSiblingItem",
    "rootCollection", "childCollection", "siblingCollection", "emptyCollection", "teamTag", "hiddenTag",
    "sharedConnector", "hiddenConnector", "activeSourceAuthorization", "revokedSourceAuthorization",
    "foreignVersion", "foreignTag", "foreignCollection", "foreignConnector",
  ] satisfies FixtureId[]).map((name) => [name, id(name)])) as Record<FixtureId, string>;
  const orgId = `org_${suffix}`;
  const secrets = {
    body: `BODY-SECRET-${suffix}`,
    locator: `https://github.com/private/repo/${suffix}.md`,
    absolutePath: `/Users/private/knowledge/${suffix}.md`,
    metadata: `METADATA-SECRET-${suffix}`,
    connectorSecret: `vault://connector/${suffix}`,
    authorization: `AUTHORIZATION-SECRET-${suffix}`,
  };

  await database.query(
    `insert into organizations(org_id, name, registry_revision)
     values ($1, 'Graph fixture', 41), ($2, 'Other graph fixture', 99)`,
    [orgId, ids.otherOrg],
  );
  await database.query(
    `insert into principals(
       principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
     ) values
       ($1, $10, 'user', 'Owner display', 'owner', '{}', 'active'),
       ($2, $10, 'user', 'Item member display', 'member', '{}', 'active'),
       ($3, $10, 'user', 'Tag member display', 'member', '{}', 'active'),
       ($4, $10, 'user', 'Source member display', 'member', '{}', 'active'),
       ($5, $10, 'user', 'No grant display', 'member', '{knowledge.query}', 'active'),
       ($6, $10, 'user', 'Other member display', 'member', '{}', 'active'),
       ($7, $10, 'user', 'Revoked display', 'member', '{}', 'revoked'),
       ($8, $10, 'agent', 'Agent display', null, '{knowledge.query}', 'active'),
       ($9, $10, 'relay', 'Relay display', null, '{knowledge.query}', 'active'),
       ($11, $12, 'user', 'Foreign owner', 'owner', '{}', 'active')`,
    [ids.owner, ids.itemMember, ids.tagMember, ids.sourceMember, ids.none, ids.otherMember,
      ids.revoked, ids.agent, ids.relay, orgId, ids.foreignOwner, ids.otherOrg],
  );
  await database.query(
    `insert into connector_instances(
       connector_instance_id, org_id, connector_type, display_name, secret_reference, status
     ) values
       ($1, $3, 'github', 'Shared GitHub', $4, 'active'),
       ($2, $3, 'local-folder', 'Hidden connector', $5, 'active')`,
    [ids.sharedConnector, ids.hiddenConnector, orgId, secrets.connectorSecret, `vault://hidden/${suffix}`],
  );
  await database.query(
    `insert into source_authorizations(
       source_authorization_id, org_id, connector_instance_id, source_id, authorization_hash,
       authorization_json, approval_receipt_json, status
     ) values
       ($1, $3, $4, 'source-active', $5, $6::jsonb, '{"approved":true}', 'active'),
       ($2, $3, $4, 'source-revoked', $7, $8::jsonb, '{"approved":true}', 'revoked')`,
    [ids.activeSourceAuthorization, ids.revokedSourceAuthorization, orgId, ids.sharedConnector,
      `active-hash-${suffix}`, JSON.stringify({ token: secrets.authorization }),
      `revoked-hash-${suffix}`, JSON.stringify({ token: `REVOKED-${secrets.authorization}` })],
  );

  const itemRows: readonly [string, string, string, "draft" | "stable"][] = [
    [ids.directStableItem, ids.owner, "Direct stable title", "stable"],
    [ids.ownerDraftItem, ids.owner, "Owner draft title", "draft"],
    [ids.tagItem, ids.owner, "Tagged stable title", "stable"],
    [ids.tagDraftItem, ids.owner, "Tagged draft title", "draft"],
    [ids.unfiledItem, ids.owner, "Unfiled tagged title", "stable"],
    [ids.sourceItem, ids.owner, "Active source title", "stable"],
    [ids.revokedSourceItem, ids.owner, "Revoked source title", "stable"],
    [ids.hiddenSiblingItem, ids.otherMember, "Hidden sibling title", "stable"],
  ];
  for (const [itemId, ownerId, title, status] of itemRows) {
    await database.query(
      `insert into knowledge_items(item_id, org_id, owner_principal_id, title, status, revision, updated_at)
       values ($1, $2, $3, $4, $5, 7, '2026-08-16T10:00:00.000Z')`,
      [itemId, orgId, ownerId, title, status],
    );
  }

  const locationRows: readonly [string, string, string | null, string | null, string, string][] = [
    [`location_direct_${suffix}`, ids.directStableItem, ids.sharedConnector, null, secrets.locator,
      ids.owner],
    [`location_owner_draft_${suffix}`, ids.ownerDraftItem, null, null,
      `file://${secrets.absolutePath}`, ids.owner],
    [`location_tag_${suffix}`, ids.tagItem, ids.sharedConnector, null,
      `https://example.test/tag/${suffix}`, ids.owner],
    [`location_tag_draft_${suffix}`, ids.tagDraftItem, null, null,
      `https://example.test/tag-draft/${suffix}`, ids.owner],
    [`location_unfiled_${suffix}`, ids.unfiledItem, null, null,
      `https://example.test/unfiled/${suffix}`, ids.owner],
    [`location_source_${suffix}`, ids.sourceItem, ids.sharedConnector, ids.activeSourceAuthorization,
      `https://example.test/source/${suffix}`, ids.owner],
    [`location_revoked_source_${suffix}`, ids.revokedSourceItem, ids.sharedConnector,
      ids.revokedSourceAuthorization, `https://example.test/revoked-source/${suffix}`, ids.owner],
    [`location_hidden_${suffix}`, ids.hiddenSiblingItem, ids.hiddenConnector, null,
      `file:///hidden/${suffix}`, ids.otherMember],
  ];
  for (const [locationId, itemId, connectorId, sourceAuthorizationId, locator, ownerId] of locationRows) {
    await database.query(
      `insert into knowledge_locations(
         location_id, org_id, item_id, location_kind, location_role, locator, connector_instance_id,
         source_authorization_id, owner_principal_id, metadata, availability, last_verified_at
       ) values ($1, $2, $3, $4, 'canonical', $5, $6, $7, $8, $9::jsonb, 'available',
         '2026-08-16T11:00:00.000Z')`,
      [locationId, orgId, itemId, connectorId === ids.hiddenConnector ? "person-local" : "github",
        locator, connectorId, sourceAuthorizationId, ownerId,
        JSON.stringify({ private: secrets.metadata })],
    );
    await database.query(
      `insert into knowledge_versions(
         version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown, provider_version,
         provenance, created_by_principal_id, created_at
       ) values ($1, $2, $3, $4, 1, $5, $6, 'provider-v1', $7::jsonb, $8,
         '2026-08-16T11:30:00.000Z')`,
      [`version_${itemId}`, orgId, itemId, locationId, `sha256:${"a".repeat(64)}`,
        `${secrets.body}-${itemId}`, JSON.stringify({ private: secrets.authorization }), ownerId],
    );
  }
  await database.query(
    `update knowledge_items set current_version_id = concat('version_', item_id) where org_id = $1`,
    [orgId],
  );

  await database.query(
    `insert into tags(tag_id, org_id, name, description) values
       ($1, $3, 'team', 'Visible team tag'),
       ($2, $3, 'hidden-tag', 'Hidden tag description')`,
    [ids.teamTag, ids.hiddenTag, orgId],
  );
  await database.query(
    `insert into knowledge_tags(org_id, item_id, tag_id) values
       ($1, $2, $5), ($1, $3, $5), ($1, $4, $5), ($1, $6, $7)`,
    [orgId, ids.tagItem, ids.tagDraftItem, ids.unfiledItem, ids.teamTag,
      ids.hiddenSiblingItem, ids.hiddenTag],
  );

  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, parent_collection_id, name, description, revision,
       created_by_principal_id
     ) values
       ($1, $3, null, 'Root', 'Root collection', 2, $4),
       ($2, $3, null, 'Empty', 'Empty collection', 2, $4)`,
    [ids.rootCollection, ids.emptyCollection, orgId, ids.owner],
  );
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, parent_collection_id, name, description, revision,
       created_by_principal_id
     ) values
       ($1, $4, $3, 'Child', 'Authorized child', 3, $5),
       ($2, $4, $3, 'Sibling', 'Hidden sibling collection', 4, $5)`,
    [ids.childCollection, ids.siblingCollection, ids.rootCollection, orgId, ids.owner],
  );
  const placements: readonly [string, string, number][] = [
    [ids.directStableItem, ids.childCollection, 2],
    [ids.ownerDraftItem, ids.childCollection, 3],
    [ids.tagItem, ids.childCollection, 6],
    [ids.sourceItem, ids.childCollection, 4],
    [ids.revokedSourceItem, ids.siblingCollection, 5],
    [ids.hiddenSiblingItem, ids.siblingCollection, 8],
  ];
  for (const [itemId, collectionId, revision] of placements) {
    await database.query(
      `insert into knowledge_collection_items(
         item_id, org_id, collection_id, placed_by_principal_id, revision
       ) values ($1, $2, $3, $4, $5)`,
      [itemId, orgId, collectionId, ids.owner, revision],
    );
  }

  const grants: readonly [string, string, string, string, string, string | null, string | null][] = [
    [`grant_owner_${suffix}`, ids.owner, "organization", orgId, "knowledge.query", null, null],
    [`grant_item_stable_${suffix}`, ids.itemMember, "item", ids.directStableItem, "knowledge.query", null, null],
    [`grant_item_draft_${suffix}`, ids.itemMember, "item", ids.ownerDraftItem, "knowledge.query", null, null],
    [`grant_tag_${suffix}`, ids.tagMember, "tag", "team", "knowledge.query", null, null],
    [`grant_source_active_${suffix}`, ids.sourceMember, "source", "source-active", "knowledge.query", null, null],
    [`grant_source_revoked_${suffix}`, ids.sourceMember, "source", "source-revoked", "knowledge.query", null, null],
    [`grant_share_other_direct_${suffix}`, ids.otherMember, "item", ids.directStableItem, "knowledge.query", null, null],
    [`grant_share_other_tag_${suffix}`, ids.otherMember, "item", ids.tagItem, "knowledge.query", null, null],
    [`grant_expired_hidden_${suffix}`, ids.itemMember, "item", ids.hiddenSiblingItem, "knowledge.query",
      "2026-08-16T12:00:00.000Z", null],
    [`grant_revoked_hidden_${suffix}`, ids.itemMember, "item", ids.hiddenSiblingItem, "knowledge.query", null,
      "2026-08-15T12:00:00.000Z"],
    [`grant_non_query_hidden_${suffix}`, ids.tagMember, "item", ids.hiddenSiblingItem, "knowledge.store", null, null],
  ];
  for (const [grantId, principalId, scopeKind, scopeId, capability, expiresAt, revokedAt] of grants) {
    await database.query(
      `insert into resource_grants(
         grant_id, org_id, principal_id, scope_kind, scope_id, capabilities, expires_at, revoked_at
       ) values ($1, $2, $3, $4, $5, array[$6]::text[], $7, $8)`,
      [grantId, orgId, principalId, scopeKind, scopeId, capability, expiresAt, revokedAt],
    );
  }

  const principal = (
    principalId: string,
    type: Principal["type"] = "user",
    status: Principal["status"] = "active",
  ): Principal => ({
    schema: "openlifewiki.principal/v1",
    principalId,
    orgId,
    type,
    displayName: "Untrusted caller display",
    organizationRole: type === "user" ? "member" : null,
    capabilities: principalId === ids.none ? ["knowledge.query"] : [],
    status,
  });

  return {
    database,
    ids: { ...ids, otherOrg: ids.otherOrg },
    principals: {
      owner: principal(ids.owner),
      itemMember: principal(ids.itemMember),
      tagMember: principal(ids.tagMember),
      sourceMember: principal(ids.sourceMember),
      none: principal(ids.none),
      otherMember: principal(ids.otherMember),
      revoked: principal(ids.revoked, "user", "revoked"),
      agent: principal(ids.agent, "agent"),
      relay: principal(ids.relay, "relay"),
    },
    secrets,
  };
}

async function createIsolatedTestDatabase(): Promise<{
  readonly database: Database;
  readonly cleanup: () => Promise<void>;
}> {
  const connectionString = requiredTestDatabaseUrl();
  const adminDatabase = createDatabase({ connectionString });
  const schema = `openlifewiki_graph_${randomUUID().replaceAll("-", "")}`;
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
