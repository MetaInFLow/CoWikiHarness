import { randomUUID } from "node:crypto";

import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphQuery,
  Principal,
} from "@openlifewiki/protocol";
import { KnowledgeGraphProjectionService, sha256Canonical } from "@openlifewiki/core";
import { describe, expect, it } from "vitest";

import {
  createDatabase,
  GraphCursorCodec,
  PostgresKnowledgeGraphStore,
  runMigrations,
  type Database,
} from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;
const NOW = new Date("2026-08-16T12:00:00.000Z");
const TOKEN_HMAC_SECRET = "graph-store-integration-secret-at-least-32-bytes";
const VIRTUAL_UNFILED_NODE_ID = "collection:__virtual__:unfiled";

describePostgres("PostgresKnowledgeGraphStore", () => {
  it("applies collection root depth and hides unauthorized or empty branches", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);

      const depthZero = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ root: { type: "collection", id: ids.rootCollection }, depth: 0 }),
        now: NOW,
      });
      expect(nodeIds(depthZero.nodes)).toEqual([`collection:${ids.rootCollection}`]);
      expect(depthZero.edges).toEqual([]);

      const depthOne = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ root: { type: "collection", id: ids.rootCollection }, depth: 1 }),
        now: NOW,
      });
      expect(nodeIds(depthOne.nodes)).toEqual([
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.hiddenItem}`,
      ].sort(compareCodeUnits));
      expect(nodeIds(depthOne.nodes)).not.toContain(`collection:${ids.emptyCollection}`);
      expect(edgeTriples(depthOne.edges)).toEqual([
        `CONTAINS|collection:${ids.rootCollection}|collection:${ids.childCollection}`,
        `CONTAINS|collection:${ids.rootCollection}|item:${ids.hiddenItem}`,
      ]);

      const depthTwo = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ root: { type: "collection", id: ids.rootCollection }, depth: 2 }),
        now: NOW,
      });
      expect(nodeIds(depthTwo.nodes)).toEqual([
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.draftItem}`,
        `item:${ids.hiddenItem}`,
        `item:${ids.stableItem}`,
      ].sort(compareCodeUnits));
      expect(nodeIds(depthTwo.nodes)).not.toContain(`collection:${ids.emptyCollection}`);
      assertClosedPage(depthTwo.nodes, depthTwo.edges);

      const itemMember = await store.readAuthorizedGraph({
        principal: principals.itemMember,
        query: graphQuery({ root: { type: "collection", id: ids.rootCollection }, depth: 2 }),
        now: NOW,
      });
      expect(nodeIds(itemMember.nodes)).toEqual([
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.stableItem}`,
      ].sort(compareCodeUnits));
      expect(JSON.stringify(itemMember)).not.toContain(ids.hiddenItem);
      expect(JSON.stringify(itemMember)).not.toContain(ids.draftItem);

      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.noGrant,
          query: graphQuery(),
          now: NOW,
        }),
        "GRAPH_FORBIDDEN",
      );

      for (const root of [
        { type: "knowledge", id: ids.hiddenItem },
        { type: "knowledge", id: `unknown_${ids.suffix}` },
        { type: "collection", id: ids.emptyCollection },
        { type: "collection", id: `unknown_${ids.suffix}` },
      ] as const) {
        await expectGraphError(
          store.readAuthorizedGraph({
            principal: principals.itemMember,
            query: graphQuery({ root }),
            now: NOW,
          }),
          "GRAPH_ROOT_NOT_FOUND",
        );
      }
    });
  });

  it("builds complete knowledge and unfiled bundles with strict include projection", async () => {
    await withGraphFixture(async ({ database, ids, principals, secrets }) => {
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const root = { type: "knowledge", id: ids.stableItem } as const;

      const base = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ root, depth: 0 }),
        now: NOW,
      });
      expect(nodeIds(base.nodes)).toEqual([
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.stableItem}`,
      ].sort(compareCodeUnits));
      expect(new Set(base.nodes.map((node) => node.data.type))).toEqual(
        new Set(["collection", "knowledge"]),
      );

      const all = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({
          root,
          depth: 4,
          include: ["tags", "locations", "versions", "principals", "connectors"],
        }),
        now: NOW,
      });
      expect(nodeIds(all.nodes)).toEqual([
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `connector:${ids.connector}`,
        `item:${ids.stableItem}`,
        `location:${ids.location}`,
        `principal:${ids.itemMember}`,
        `principal:${ids.owner}`,
        `tag:${ids.tag}`,
        `version:${ids.version}`,
      ].sort(compareCodeUnits));
      expect(nodeById(all.nodes, `collection:${ids.rootCollection}`)).toMatchObject({
        data: { type: "collection", label: "Root", description: "Root description", revision: 1 },
      });
      expect(nodeById(all.nodes, VIRTUAL_UNFILED_NODE_ID)).toBeUndefined();
      expect(nodeById(all.nodes, `location:${ids.location}`)).toMatchObject({
        data: { type: "location", label: "github (canonical)", kind: "github", role: "canonical" },
      });
      expect(nodeById(all.nodes, `version:${ids.version}`)).toMatchObject({
        data: { type: "version", label: "Version 3", ordinal: 3 },
      });
      expect(edgeTriples(all.edges)).toEqual([
        `CONTAINS|collection:${ids.childCollection}|item:${ids.stableItem}`,
        `CONTAINS|collection:${ids.rootCollection}|collection:${ids.childCollection}`,
        `CURRENT_VERSION|item:${ids.stableItem}|version:${ids.version}`,
        `HAS_LOCATION|item:${ids.stableItem}|location:${ids.location}`,
        `OWNED_BY|item:${ids.stableItem}|principal:${ids.owner}`,
        `OWNED_BY|location:${ids.location}|principal:${ids.owner}`,
        `PROVIDED_BY|location:${ids.location}|connector:${ids.connector}`,
        `SHARED_WITH|item:${ids.stableItem}|principal:${ids.itemMember}`,
        `TAGGED_WITH|item:${ids.stableItem}|tag:${ids.tag}`,
      ].sort(compareCodeUnits));
      assertStableEdgeIds(all.edges);
      assertClosedPage(all.nodes, all.edges);

      const depthZeroJson = JSON.stringify(all);
      for (const forbidden of [
        secrets.body,
        secrets.locator,
        secrets.metadata,
        secrets.connectorSecret,
        "bodyMarkdown",
        "body_markdown",
        "locator",
        "metadata",
        "secretReference",
        "token_digest",
      ]) {
        expect(depthZeroJson).not.toContain(forbidden);
      }

      const projectionCases = [
        { include: ["tags"], present: ["tag"], absent: ["location", "version", "principal", "connector"] },
        { include: ["locations"], present: ["location"], absent: ["tag", "version", "principal", "connector"] },
        { include: ["versions"], present: ["version"], absent: ["tag", "location", "principal", "connector"] },
        { include: ["principals"], present: ["principal"], absent: ["tag", "location", "version", "connector"] },
        { include: ["connectors"], present: ["location", "connector"], absent: ["tag", "version", "principal"] },
      ] as const;
      for (const projection of projectionCases) {
        const page = await store.readAuthorizedGraph({
          principal: principals.owner,
          query: graphQuery({ root, include: [...projection.include] }),
          now: NOW,
        });
        const types = new Set(page.nodes.map((node) => node.data.type));
        for (const type of projection.present) expect(types.has(type)).toBe(true);
        for (const type of projection.absent) expect(types.has(type)).toBe(false);
        if (projection.include[0] === "locations") {
          expect(page.edges.some((edge) => edge.data.type === "PROVIDED_BY")).toBe(false);
        }
        if (projection.include[0] === "connectors") {
          expect(page.edges.some((edge) => edge.data.type === "HAS_LOCATION")).toBe(true);
          expect(page.edges.some((edge) => edge.data.type === "PROVIDED_BY")).toBe(true);
        }
        assertClosedPage(page.nodes, page.edges);
      }

      const forestAtZero = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ depth: 0 }),
        now: NOW,
      });
      expect(nodeIds(forestAtZero.nodes)).toEqual([
        VIRTUAL_UNFILED_NODE_ID,
        `collection:${ids.rootCollection}`,
      ].sort(compareCodeUnits));
      expect(nodeIds(forestAtZero.nodes)).not.toContain(`collection:${ids.emptyCollection}`);

      const forestAtOne = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({ depth: 1 }),
        now: NOW,
      });
      expect(nodeIds(forestAtOne.nodes)).toEqual([
        VIRTUAL_UNFILED_NODE_ID,
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.hiddenItem}`,
        `item:${ids.unfiledItem}`,
      ].sort(compareCodeUnits));
      expect(edgeTriples(forestAtOne.edges)).toContain(
        `CONTAINS|${VIRTUAL_UNFILED_NODE_ID}|item:${ids.unfiledItem}`,
      );

      const unfiled = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({
          root: { type: "knowledge", id: ids.unfiledItem },
          depth: 0,
        }),
        now: NOW,
      });
      expect(nodeIds(unfiled.nodes)).toEqual([
        VIRTUAL_UNFILED_NODE_ID,
        `item:${ids.unfiledItem}`,
      ]);
      expect(edgeTriples(unfiled.edges)).toEqual([
        `CONTAINS|${VIRTUAL_UNFILED_NODE_ID}|item:${ids.unfiledItem}`,
      ]);
    });
  });

  it("rejects malformed or snapshot-incompatible cursors with stable errors", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const codec = new GraphCursorCodec(TOKEN_HMAC_SECRET);
      const baseQuery = graphQuery({
        root: { type: "collection", id: ids.rootCollection },
        depth: 2,
        limit: 1,
      });
      const firstPage = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: baseQuery,
        now: NOW,
      });
      expect(firstPage.nextCursor).not.toBeNull();
      const validCursor = firstPage.nextCursor as string;
      const validPayload = codec.decode(validCursor);
      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.owner,
          query: { ...baseQuery, cursor: `${validCursor}tampered` },
          now: NOW,
        }),
        "GRAPH_INVALID_QUERY",
      );

      const validPage = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: { ...baseQuery, cursor: validCursor },
        now: NOW,
      });
      expect(validPage.registryRevision).toBe(17);

      const incompatiblePayloads = [
        { ...validPayload, orgId: `other_${ids.suffix}` },
        { ...validPayload, principalId: ids.itemMember },
        { ...validPayload, queryHash: `sha256:${"b".repeat(64)}` },
        { ...validPayload, snapshotHash: `sha256:${"c".repeat(64)}` },
        { ...validPayload, registryRevision: 18 },
        { ...validPayload, afterSeedKey: `item:missing_${ids.suffix}` },
      ] as const;
      for (const payload of incompatiblePayloads) {
        await expectGraphError(
          store.readAuthorizedGraph({
            principal: principals.owner,
            query: { ...baseQuery, cursor: codec.encode(payload) },
            now: NOW,
          }),
          "GRAPH_SNAPSHOT_EXPIRED",
        );
      }

      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.noGrant,
          query: { ...baseQuery, cursor: "malformed-cursor" },
          now: NOW,
        }),
        "GRAPH_INVALID_QUERY",
      );

      await expectGraphError(
        store.readAuthorizedGraph({
          principal: { ...principals.owner, type: "agent" },
          query: { ...baseQuery, cursor: validCursor },
          now: NOW,
        }),
        "GRAPH_PRINCIPAL_NOT_SUPPORTED",
      );
    });
  });

  it("paginates complete seed bundles without dangling or duplicate elements", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const query = graphQuery({
        depth: 2,
        include: ["tags", "locations", "versions", "principals", "connectors"],
        limit: 3,
      });
      const repeatedFirstPage = await Promise.all([
        store.readAuthorizedGraph({ principal: principals.owner, query, now: NOW }),
        store.readAuthorizedGraph({ principal: principals.owner, query, now: NOW }),
      ]);
      expect(repeatedFirstPage[0]).toEqual(repeatedFirstPage[1]);

      const pages = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const page = await store.readAuthorizedGraph({
          principal: principals.owner,
          query: { ...query, cursor },
          now: NOW,
        });
        pages.push(page);
        assertClosedPage(page.nodes, page.edges);
        assertDeterministicOrder(page.nodes, page.edges);
        if (!page.truncated) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor;
      }

      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(pages.at(-1)?.truncated).toBe(false);
      expect(pages.filter((page) => nodeIds(page.nodes).includes(
        `collection:${ids.rootCollection}`,
      )).length).toBeGreaterThan(1);

      const mergedNodes = new Map<string, KnowledgeGraphNode>();
      const mergedEdges = new Map<string, KnowledgeGraphEdge>();
      for (const page of pages) {
        for (const node of page.nodes) mergedNodes.set(node.data.id, node);
        for (const edge of page.edges) mergedEdges.set(edge.data.id, edge);
      }
      const unpaginated = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: { ...query, limit: 500 },
        now: NOW,
      });
      expect([...mergedNodes.keys()].sort(compareCodeUnits)).toEqual(
        nodeIds(unpaginated.nodes).sort(compareCodeUnits),
      );
      expect([...mergedEdges.keys()].sort(compareCodeUnits)).toEqual(
        unpaginated.edges.map((edge) => edge.data.id).sort(compareCodeUnits),
      );
      expect(nodeIds(unpaginated.nodes)).toEqual(expect.arrayContaining([
        VIRTUAL_UNFILED_NODE_ID,
        `collection:${ids.childCollection}`,
        `collection:${ids.rootCollection}`,
        `item:${ids.draftItem}`,
        `item:${ids.hiddenItem}`,
        `item:${ids.stableItem}`,
        `item:${ids.unfiledItem}`,
      ]));
    });
  });

  it("keeps a real unfiled collection distinct from the virtual node across pages", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const realUnfiledItem = `real_unfiled_item_${ids.suffix}`;
      await database.query(
        `insert into knowledge_collections(
           collection_id, org_id, parent_collection_id, name, description, revision,
           created_by_principal_id
         ) values ('unfiled', $1, null, 'Real unfiled', '', 1, $2)`,
        [ids.org, ids.owner],
      );
      await database.query(
        `insert into knowledge_items(
           item_id, org_id, owner_principal_id, title, status, revision, updated_at
         ) values ($1, $2, $3, 'Real unfiled item', 'stable', 1, $4)`,
        [realUnfiledItem, ids.org, ids.owner, NOW.toISOString()],
      );
      await database.query(
        `insert into knowledge_collection_items(
           item_id, org_id, collection_id, placed_by_principal_id
         ) values ($1, $2, 'unfiled', $3)`,
        [realUnfiledItem, ids.org, ids.owner],
      );

      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const codec = new GraphCursorCodec(TOKEN_HMAC_SECRET);
      const query = graphQuery({ depth: 1, limit: 1 });
      const mergedNodeIds = new Set<string>();
      const completedSeeds = new Set<string>();
      let cursor: string | null = null;
      let completed = false;

      for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
        const page = await store.readAuthorizedGraph({
          principal: principals.owner,
          query: { ...query, cursor },
          now: NOW,
        });
        for (const id of nodeIds(page.nodes)) mergedNodeIds.add(id);
        assertClosedPage(page.nodes, page.edges);
        if (!page.truncated) {
          completed = true;
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        const completedSeed = codec.decode(page.nextCursor as string).afterSeedKey;
        expect(completedSeeds.has(completedSeed)).toBe(false);
        completedSeeds.add(completedSeed);
        cursor = page.nextCursor;
      }

      expect(mergedNodeIds).toContain(VIRTUAL_UNFILED_NODE_ID);
      expect(mergedNodeIds).toContain("collection:unfiled");
      expect(mergedNodeIds).toContain(`item:${realUnfiledItem}`);
      expect(completedSeeds.size).toBeGreaterThan(1);
      expect(completed).toBe(true);
    });
  });

  it("supports a 256-character registry ID through store, projection, and pagination", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const longItemId = `m${"a".repeat(255)}`;
      const followingItemId = `z_after_long_${ids.suffix}`;
      for (const [itemId, title] of [
        [longItemId, "Long registry item"],
        [followingItemId, "Following registry item"],
      ] as const) {
        await database.query(
          `insert into knowledge_items(
             item_id, org_id, owner_principal_id, title, status, revision, updated_at
           ) values ($1, $2, $3, $4, 'stable', 1, $5)`,
          [itemId, ids.org, ids.owner, title, NOW.toISOString()],
        );
      }

      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const projected = await new KnowledgeGraphProjectionService(store).read({
        principal: principals.owner,
        query: graphQuery({ root: { type: "knowledge", id: longItemId }, limit: 1 }),
        now: NOW,
      });
      expect(nodeIds(projected.elements.nodes)).toContain(`item:${longItemId}`);

      const codec = new GraphCursorCodec(TOKEN_HMAC_SECRET);
      const query = graphQuery({ depth: 1, limit: 1 });
      const completedSeeds: string[] = [];
      let cursor: string | null = null;
      let completed = false;
      for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
        const page = await store.readAuthorizedGraph({
          principal: principals.owner,
          query: { ...query, cursor },
          now: NOW,
        });
        if (!page.truncated) {
          completed = true;
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        completedSeeds.push(codec.decode(page.nextCursor as string).afterSeedKey);
        cursor = page.nextCursor;
      }

      expect(completedSeeds).toContain(`item:${longItemId}`);
      expect(new Set(completedSeeds).size).toBe(completedSeeds.length);
      expect(completed).toBe(true);
    });
  });

  it("expires a cursor when an authorization grant or visible share naturally expires", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const expiresAt = new Date(NOW.getTime() + 1_000);
      const afterExpiry = new Date(NOW.getTime() + 2_000);
      await database.query(
        `update resource_grants
         set expires_at = $1
         where org_id = $2 and principal_id = $3`,
        [expiresAt.toISOString(), ids.org, ids.itemMember],
      );
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);

      const memberQuery = graphQuery({
        root: { type: "collection", id: ids.rootCollection },
        depth: 2,
        limit: 1,
      });
      const memberFirstPage = await store.readAuthorizedGraph({
        principal: principals.itemMember,
        query: memberQuery,
        now: NOW,
      });
      expect(memberFirstPage.nextCursor).not.toBeNull();
      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.itemMember,
          query: { ...memberQuery, cursor: memberFirstPage.nextCursor },
          now: afterExpiry,
        }),
        "GRAPH_SNAPSHOT_EXPIRED",
      );

      const ownerQuery = graphQuery({ depth: 2, include: ["principals"], limit: 1 });
      const ownerFirstPage = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: ownerQuery,
        now: NOW,
      });
      expect(ownerFirstPage.nextCursor).not.toBeNull();
      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.owner,
          query: { ...ownerQuery, cursor: ownerFirstPage.nextCursor },
          now: afterExpiry,
        }),
        "GRAPH_SNAPSHOT_EXPIRED",
      );
    });
  });

  it("returns the first complete bundle over the page budget and rejects a 501-node bundle", async () => {
    await withGraphFixture(async ({ database, ids, principals }) => {
      const store = new PostgresKnowledgeGraphStore(database, TOKEN_HMAC_SECRET);
      const root = { type: "knowledge", id: ids.stableItem } as const;
      const complete = await store.readAuthorizedGraph({
        principal: principals.owner,
        query: graphQuery({
          root,
          include: ["tags", "locations", "versions", "principals", "connectors"],
          limit: 1,
        }),
        now: NOW,
      });
      expect(complete.nodes.length).toBeGreaterThan(1);
      expect(complete.truncated).toBe(false);
      expect(complete.nextCursor).toBeNull();
      assertClosedPage(complete.nodes, complete.edges);

      await database.query(
        `insert into tags(tag_id, org_id, name, description)
         select concat('bulk_', value::text, '_', $1::text), $2,
           concat('bulk-', value::text, '-', $1::text), ''
         from generate_series(1, 497) as value`,
        [ids.suffix, ids.org],
      );
      await database.query(
        `insert into knowledge_tags(org_id, item_id, tag_id)
         select $1, $2, concat('bulk_', value::text, '_', $3::text)
         from generate_series(1, 497) as value`,
        [ids.org, ids.stableItem, ids.suffix],
      );

      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.owner,
          query: graphQuery({ root, include: ["tags"] }),
          now: NOW,
        }),
        "GRAPH_INVALID_QUERY",
      );
      await expectGraphError(
        store.readAuthorizedGraph({
          principal: principals.owner,
          query: graphQuery({ depth: 2, include: ["tags"] }),
          now: NOW,
        }),
        "GRAPH_INVALID_QUERY",
      );
    });
  });
});

function graphQuery(overrides: Partial<KnowledgeGraphQuery> = {}): KnowledgeGraphQuery {
  return {
    root: null,
    depth: 2,
    include: [],
    limit: 500,
    cursor: null,
    ...overrides,
  };
}

function nodeIds(nodes: readonly KnowledgeGraphNode[]): string[] {
  return nodes.map((node) => node.data.id);
}

function edgeTriples(edges: readonly KnowledgeGraphEdge[]): string[] {
  return edges.map((edge) => `${edge.data.type}|${edge.data.source}|${edge.data.target}`)
    .sort(compareCodeUnits);
}

function nodeById(nodes: readonly KnowledgeGraphNode[], id: string): KnowledgeGraphNode | undefined {
  return nodes.find((node) => node.data.id === id);
}

function assertStableEdgeIds(edges: readonly KnowledgeGraphEdge[]): void {
  for (const edge of edges) {
    const { type, source, target } = edge.data;
    expect(edge.data.id).toBe(
      `edge:${sha256Canonical({ type, source, target }).slice("sha256:".length)}`,
    );
  }
}

function assertDeterministicOrder(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
): void {
  const expectedNodes = [...nodes].sort((left, right) => (
    compareCodeUnits(left.data.type, right.data.type)
    || compareCodeUnits(left.data.id, right.data.id)
  ));
  const expectedEdges = [...edges].sort((left, right) => (
    compareCodeUnits(left.data.type, right.data.type)
    || compareCodeUnits(left.data.id, right.data.id)
  ));
  expect(nodes).toEqual(expectedNodes);
  expect(edges).toEqual(expectedEdges);
}

function assertClosedPage(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
): void {
  const ids = new Set(nodeIds(nodes));
  expect(ids.size).toBe(nodes.length);
  expect(new Set(edges.map((edge) => edge.data.id)).size).toBe(edges.length);
  for (const edge of edges) {
    expect(ids.has(edge.data.source)).toBe(true);
    expect(ids.has(edge.data.target)).toBe(true);
  }
}

async function expectGraphError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "KnowledgeGraphError", code });
}

interface GraphFixture {
  readonly database: Database;
  readonly ids: FixtureIds;
  readonly principals: {
    readonly owner: Principal;
    readonly itemMember: Principal;
    readonly noGrant: Principal;
  };
  readonly secrets: {
    readonly body: string;
    readonly locator: string;
    readonly metadata: string;
    readonly connectorSecret: string;
  };
}

interface FixtureIds {
  readonly suffix: string;
  readonly org: string;
  readonly owner: string;
  readonly itemMember: string;
  readonly noGrant: string;
  readonly rootCollection: string;
  readonly childCollection: string;
  readonly emptyCollection: string;
  readonly stableItem: string;
  readonly draftItem: string;
  readonly hiddenItem: string;
  readonly unfiledItem: string;
  readonly tag: string;
  readonly location: string;
  readonly version: string;
  readonly connector: string;
}

async function withGraphFixture(work: (fixture: GraphFixture) => Promise<void>): Promise<void> {
  const isolated = await createIsolatedTestDatabase();
  try {
    await runMigrations(isolated.database, { migrationsDir: "migrations" });
    await work(await seedGraphFixture(isolated.database));
  } finally {
    await isolated.cleanup();
  }
}

async function seedGraphFixture(database: Database): Promise<GraphFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const ids: FixtureIds = {
    suffix,
    org: `org_${suffix}`,
    owner: `owner_${suffix}`,
    itemMember: `item_member_${suffix}`,
    noGrant: `no_grant_${suffix}`,
    rootCollection: `root_${suffix}`,
    childCollection: `child_${suffix}`,
    emptyCollection: `empty_${suffix}`,
    stableItem: `stable_${suffix}`,
    draftItem: `draft_${suffix}`,
    hiddenItem: `hidden_${suffix}`,
    unfiledItem: `unfiled_${suffix}`,
    tag: `tag_${suffix}`,
    location: `location_${suffix}`,
    version: `version_${suffix}`,
    connector: `connector_${suffix}`,
  };
  const secrets = {
    body: `BODY-SECRET-${suffix}`,
    locator: `file:///Users/private/${suffix}.md`,
    metadata: `METADATA-SECRET-${suffix}`,
    connectorSecret: `vault://connector/${suffix}`,
  };

  await database.query(
    "insert into organizations(org_id, name, registry_revision) values ($1, 'Graph store fixture', 17)",
    [ids.org],
  );
  await database.query(
    `insert into principals(
       principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
     ) values
       ($1, $4, 'user', 'Owner display', 'owner', '{}', 'active'),
       ($2, $4, 'user', 'Item member display', 'member', '{}', 'active'),
       ($3, $4, 'user', 'No grant display', 'member', '{}', 'active')`,
    [ids.owner, ids.itemMember, ids.noGrant, ids.org],
  );
  await database.query(
    `insert into connector_instances(
       connector_instance_id, org_id, connector_type, display_name, secret_reference, status
     ) values ($1, $2, 'github', 'Safe GitHub', $3, 'active')`,
    [ids.connector, ids.org, secrets.connectorSecret],
  );

  const items = [
    [ids.stableItem, "Stable title", "stable"],
    [ids.draftItem, "Draft title", "draft"],
    [ids.hiddenItem, "Hidden title", "stable"],
    [ids.unfiledItem, "Unfiled title", "stable"],
  ] as const;
  for (const [itemId, title, status] of items) {
    await database.query(
      `insert into knowledge_items(
         item_id, org_id, owner_principal_id, title, status, revision, updated_at
       ) values ($1, $2, $3, $4, $5, 4, '2026-08-16T10:00:00.000Z')`,
      [itemId, ids.org, ids.owner, title, status],
    );
  }

  await database.query(
    `insert into knowledge_locations(
       location_id, org_id, item_id, location_kind, location_role, locator,
       connector_instance_id, owner_principal_id, metadata, availability, last_verified_at
     ) values (
       $1, $2, $3, 'github', 'canonical', $4, $5, $6, $7::jsonb, 'available',
       '2026-08-16T11:00:00.000Z'
     )`,
    [ids.location, ids.org, ids.stableItem, secrets.locator, ids.connector, ids.owner,
      JSON.stringify({ private: secrets.metadata })],
  );
  await database.query(
    `insert into knowledge_versions(
       version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
       provider_version, provenance, created_by_principal_id, created_at
     ) values (
       $1, $2, $3, $4, 3, $5, $6, 'provider-safe-v3', '{"safe":true}', $7,
       '2026-08-16T11:30:00.000Z'
     )`,
    [ids.version, ids.org, ids.stableItem, ids.location, `sha256:${"a".repeat(64)}`,
      secrets.body, ids.owner],
  );
  await database.query(
    "update knowledge_items set current_version_id = $1 where item_id = $2",
    [ids.version, ids.stableItem],
  );
  await database.query(
    "insert into tags(tag_id, org_id, name, description) values ($1, $2, 'product', 'Product tag')",
    [ids.tag, ids.org],
  );
  await database.query(
    "insert into knowledge_tags(org_id, item_id, tag_id) values ($1, $2, $3)",
    [ids.org, ids.stableItem, ids.tag],
  );

  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, parent_collection_id, name, description, revision,
       created_by_principal_id
     ) values ($1, $2, null, 'Root', 'Root description', 1, $3)`,
    [ids.rootCollection, ids.org, ids.owner],
  );
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, parent_collection_id, name, description, revision,
       created_by_principal_id
     ) values
       ($1, $3, $4, 'Child', 'Child description', 2, $5),
       ($2, $3, $4, 'Empty', 'Empty description', 0, $5)`,
    [ids.childCollection, ids.emptyCollection, ids.org, ids.rootCollection, ids.owner],
  );
  for (const [itemId, collectionId] of [
    [ids.stableItem, ids.childCollection],
    [ids.draftItem, ids.childCollection],
    [ids.hiddenItem, ids.rootCollection],
  ] as const) {
    await database.query(
      `insert into knowledge_collection_items(
         item_id, org_id, collection_id, placed_by_principal_id
       ) values ($1, $2, $3, $4)`,
      [itemId, ids.org, collectionId, ids.owner],
    );
  }

  await database.query(
    `insert into resource_grants(
       grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
     ) values
       ($1, $3, $4, 'organization', $3, '{knowledge.query}'),
       ($2, $3, $5, 'item', $6, '{knowledge.query}')`,
    [`grant_owner_${suffix}`, `grant_member_${suffix}`, ids.org, ids.owner, ids.itemMember,
      ids.stableItem],
  );

  const principal = (
    principalId: string,
    organizationRole: "owner" | "member",
  ): Principal => ({
    schema: "openlifewiki.principal/v1",
    principalId,
    orgId: ids.org,
    type: "user",
    displayName: "Caller-supplied display",
    organizationRole,
    capabilities: [],
    status: "active",
  });

  return {
    database,
    ids,
    principals: {
      owner: principal(ids.owner, "owner"),
      itemMember: principal(ids.itemMember, "member"),
      noGrant: principal(ids.noGrant, "member"),
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
  const schema = `openlifewiki_graph_store_${randomUUID().replaceAll("-", "")}`;
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
