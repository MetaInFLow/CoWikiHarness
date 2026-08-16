import type {
  KnowledgeGraphNode,
  KnowledgeGraphQuery,
} from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import {
  createKnowledgeGraphBundleContext,
  paginateSeedBundles,
  uniqueSortedSeedKeys,
} from "../src/postgres/knowledge-graph-bundles.js";
import type { AuthorizedGraphSnapshot } from "../src/postgres/authorized-graph-snapshot.js";

describe("incremental knowledge graph bundles", () => {
  it("projects placement revision only on persisted collection-to-knowledge containment", () => {
    const query = {
      root: null,
      depth: 1,
      include: [],
      limit: 500,
      cursor: null,
    } satisfies KnowledgeGraphQuery;
    const context = createKnowledgeGraphBundleContext(snapshotWithPlacementRevision(), query);
    const edges = new Map(context.seedKeys.flatMap((seedKey) => (
      context.buildBundle(seedKey).edges.map((edge) => [edge.data.id, edge] as const)
    )));
    const byEndpoints = (source: string, target: string) => [...edges.values()].find((edge) => (
      edge.data.source === source && edge.data.target === target
    ));

    expect(byEndpoints("collection:root", "item:placed")?.data).toMatchObject({
      type: "CONTAINS",
      placementRevision: 7,
    });
    expect(byEndpoints("collection:root", "collection:child")?.data)
      .not.toHaveProperty("placementRevision");
    expect(byEndpoints("collection:__virtual__:unfiled", "item:unfiled")?.data)
      .not.toHaveProperty("placementRevision");
  });

  it("sorts seed keys by code units and removes duplicates", () => {
    expect(uniqueSortedSeedKeys(["item:b", "item:A", "item:b", "collection:z"]))
      .toEqual(["collection:z", "item:A", "item:b"]);
  });

  it("stops building immediately when the first complete bundle fills the page", () => {
    const built: string[] = [];
    const page = paginateSeedBundles({
      seedKeys: ["item:a", "item:b", "item:c"],
      afterSeedKey: null,
      limit: 2,
      buildBundle(seedKey) {
        built.push(seedKey);
        return {
          seedKey,
          nodes: [node(`${seedKey}:1`), node(`${seedKey}:2`)],
          edges: [],
        };
      },
    });

    expect(built).toEqual(["item:a"]);
    expect(page.nodes).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(page.lastCompletedSeedKey).toBe("item:a");
  });

  it("builds only the first over-budget candidate before stopping", () => {
    const built: string[] = [];
    const page = paginateSeedBundles({
      seedKeys: ["item:a", "item:b", "item:c"],
      afterSeedKey: null,
      limit: 2,
      buildBundle(seedKey) {
        built.push(seedKey);
        return {
          seedKey,
          nodes: seedKey === "item:a"
            ? [node("item:shared")]
            : [node(`${seedKey}:1`), node(`${seedKey}:2`)],
          edges: [],
        };
      },
    });

    expect(built).toEqual(["item:a", "item:b"]);
    expect(page.nodes.map((value) => value.data.id)).toEqual(["item:shared"]);
    expect(page.truncated).toBe(true);
    expect(page.lastCompletedSeedKey).toBe("item:a");
  });

  it("rejects a bundle larger than the hard 500-node boundary when it is built", () => {
    let builds = 0;

    expect(() => paginateSeedBundles({
      seedKeys: ["item:a", "item:b"],
      afterSeedKey: null,
      limit: 1,
      buildBundle(seedKey) {
        builds += 1;
        return {
          seedKey,
          nodes: Array.from({ length: 501 }, (_, index) => node(`item:n${index}`)),
          edges: [],
        };
      },
    })).toThrowError(expect.objectContaining({
      name: "KnowledgeGraphError",
      code: "GRAPH_INVALID_QUERY",
    }));
    expect(builds).toBe(1);
  });
});

function node(id: string): KnowledgeGraphNode {
  return {
    data: {
      id,
      type: "knowledge",
      label: id,
      status: "stable",
      revision: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
  };
}

function snapshotWithPlacementRevision(): AuthorizedGraphSnapshot {
  return {
    registryRevision: 3,
    principalId: "principal_owner",
    orgId: "org_1",
    organizationRole: "owner",
    hasOrganizationQueryGrant: true,
    collections: [
      {
        collectionId: "root",
        parentCollectionId: null,
        name: "Root",
        description: "",
        revision: 1,
      },
      {
        collectionId: "child",
        parentCollectionId: "root",
        name: "Child",
        description: "",
        revision: 1,
      },
    ],
    knowledgeItems: [
      {
        itemId: "placed",
        ownerPrincipalId: "principal_owner",
        title: "Placed",
        status: "stable",
        currentVersionId: null,
        revision: 1,
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
      {
        itemId: "unfiled",
        ownerPrincipalId: "principal_owner",
        title: "Unfiled",
        status: "stable",
        currentVersionId: null,
        revision: 1,
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
      {
        itemId: "child-item",
        ownerPrincipalId: "principal_owner",
        title: "Child item",
        status: "stable",
        currentVersionId: null,
        revision: 1,
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    ],
    placements: [
      { itemId: "placed", collectionId: "root", revision: 7 },
      { itemId: "child-item", collectionId: "child", revision: 3 },
    ],
    tags: [],
    knowledgeTags: [],
    locations: [],
    currentVersions: [],
    connectors: [],
    principals: [],
    shares: [],
  } as unknown as AuthorizedGraphSnapshot;
}
