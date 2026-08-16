import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_GRAPH_EDGE_TYPES,
  KNOWLEDGE_GRAPH_ERROR_CODES,
  KNOWLEDGE_GRAPH_INCLUDES,
  KNOWLEDGE_GRAPH_NODE_TYPES,
  knowledgeAgentResultSchema,
  knowledgeCollectionResultSchema,
  knowledgeGraphQuerySchema,
  knowledgeGraphResponseSchema,
  knowledgeOperationSchema,
  knowledgePlacementResultSchema,
} from "../src/index.js";

const NOW = "2026-08-16T00:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

const knowledgeNode = {
  data: {
    id: "item:item_1",
    type: "knowledge",
    label: "Architecture",
    status: "stable",
    revision: 2,
    updatedAt: NOW,
  },
} as const;

const locationNode = {
  data: {
    id: "location:location_1",
    type: "location",
    label: "Canonical Markdown",
    kind: "managed-markdown",
    role: "canonical",
    availability: "available",
    lastVerifiedAt: null,
  },
} as const;

const versionNode = {
  data: {
    id: "version:version_1",
    type: "version",
    label: "Version 1",
    ordinal: 1,
    bodyHash: HASH,
    providerVersion: null,
    createdAt: NOW,
  },
} as const;

const connectorNode = {
  data: {
    id: "connector:connector_1",
    type: "connector",
    label: "GitHub",
    connectorType: "github",
    status: "active",
  },
} as const;

const graphResponse = {
  schema: "cowikiharness.graph/v1",
  registryRevision: 7,
  generatedAt: NOW,
  elements: {
    nodes: [
      {
        data: {
          id: "collection:root",
          type: "collection",
          label: "Projects",
          description: "Project knowledge",
          revision: 1,
        },
      },
      knowledgeNode,
      {
        data: {
          id: "tag:product",
          type: "tag",
          label: "product",
          description: "Product knowledge",
        },
      },
      locationNode,
      versionNode,
      {
        data: {
          id: "principal:principal_1",
          type: "principal",
          label: "Anthony",
          principalType: "user",
        },
      },
      connectorNode,
    ],
    edges: [
      {
        data: {
          id: "edge:contains",
          source: "collection:root",
          target: "item:item_1",
          type: "CONTAINS",
          placementRevision: 4,
        },
      },
      { data: { id: "edge:tagged", source: "item:item_1", target: "tag:product", type: "TAGGED_WITH" } },
      { data: { id: "edge:location", source: "item:item_1", target: "location:location_1", type: "HAS_LOCATION" } },
      { data: { id: "edge:version", source: "item:item_1", target: "version:version_1", type: "CURRENT_VERSION" } },
      { data: { id: "edge:owner", source: "item:item_1", target: "principal:principal_1", type: "OWNED_BY" } },
      { data: { id: "edge:shared", source: "item:item_1", target: "principal:principal_1", type: "SHARED_WITH" } },
      { data: { id: "edge:provider", source: "location:location_1", target: "connector:connector_1", type: "PROVIDED_BY" } },
    ],
  },
  truncated: false,
  nextCursor: null,
} as const;

describe("authorized knowledge graph contracts", () => {
  it("exports the fixed graph vocabulary", () => {
    expect(KNOWLEDGE_GRAPH_NODE_TYPES).toEqual([
      "collection", "knowledge", "tag", "location", "version", "principal", "connector",
    ]);
    expect(KNOWLEDGE_GRAPH_EDGE_TYPES).toEqual([
      "CONTAINS", "TAGGED_WITH", "HAS_LOCATION", "CURRENT_VERSION",
      "OWNED_BY", "SHARED_WITH", "PROVIDED_BY",
    ]);
    expect(KNOWLEDGE_GRAPH_INCLUDES).toEqual([
      "tags", "locations", "versions", "principals", "connectors",
    ]);
    expect(KNOWLEDGE_GRAPH_ERROR_CODES).toEqual([
      "GRAPH_INVALID_QUERY",
      "GRAPH_FORBIDDEN",
      "GRAPH_PRINCIPAL_NOT_SUPPORTED",
      "GRAPH_ROOT_NOT_FOUND",
      "GRAPH_SNAPSHOT_EXPIRED",
      "GRAPH_UNAVAILABLE",
      "GRAPH_INVALID_PROJECTION",
    ]);
  });

  it("accepts one strict Cytoscape-compatible graph response", () => {
    expect(knowledgeGraphResponseSchema.parse(graphResponse)).toEqual(graphResponse);
  });

  it("allows placementRevision only on real collection-to-knowledge containment", () => {
    const placement = graphResponse.elements.edges[0]!;
    expect(knowledgeGraphResponseSchema.parse(graphResponse).elements.edges[0]).toEqual(placement);

    for (const invalidData of [
      { ...placement.data, placementRevision: undefined },
      { ...placement.data, placementRevision: -1 },
      {
        id: "edge:collection",
        source: "collection:root",
        target: "collection:child",
        type: "CONTAINS",
        placementRevision: 4,
      },
      {
        id: "edge:unfiled",
        source: "collection:__virtual__:unfiled",
        target: "item:item_1",
        type: "CONTAINS",
        placementRevision: 4,
      },
      {
        id: "edge:tagged-with-revision",
        source: "item:item_1",
        target: "tag:product",
        type: "TAGGED_WITH",
        placementRevision: 4,
      },
    ]) {
      expect(() => knowledgeGraphResponseSchema.parse({
        ...graphResponse,
        elements: { ...graphResponse.elements, edges: [{ data: invalidData }] },
      })).toThrow();
    }
  });

  it("accepts a bounded strict graph query", () => {
    const query = {
      root: { type: "collection", id: "collection_1" },
      depth: 4,
      include: ["tags", "locations", "versions", "principals", "connectors"],
      limit: 500,
      cursor: "next-page",
    } as const;

    expect(knowledgeGraphQuerySchema.parse(query)).toEqual(query);
    expect(knowledgeGraphQuerySchema.parse({ ...query, root: null, cursor: null })).toMatchObject({
      root: null,
      cursor: null,
    });
  });

  it("keeps registry IDs at 256 characters while allowing prefixed graph element IDs", () => {
    const registryId = `r${"a".repeat(255)}`;
    const graphElementId = `item:${registryId}`;
    const targetElementId = `tag:${registryId}`;
    const edgeElementId = `e${"a".repeat(511)}`;
    const response = {
      ...graphResponse,
      elements: {
        nodes: [
          { data: { ...knowledgeNode.data, id: graphElementId } },
          { data: { type: "tag", id: targetElementId, label: "long", description: "" } },
        ],
        edges: [{
          data: {
            id: edgeElementId,
            source: graphElementId,
            target: targetElementId,
            type: "TAGGED_WITH",
          },
        }],
      },
    };

    expect(knowledgeGraphQuerySchema.parse({
      root: { type: "knowledge", id: registryId },
      depth: 0,
      include: [],
      limit: 1,
      cursor: null,
    }).root).toEqual({ type: "knowledge", id: registryId });
    expect(knowledgeGraphResponseSchema.parse(response).elements.nodes[0]?.data.id)
      .toBe(graphElementId);
    expect(knowledgeGraphResponseSchema.parse(response).elements.edges[0]?.data.id)
      .toBe(edgeElementId);

    expect(() => knowledgeGraphQuerySchema.parse({
      root: { type: "knowledge", id: `r${"a".repeat(256)}` },
      depth: 0,
      include: [],
      limit: 1,
      cursor: null,
    })).toThrow();
    expect(() => knowledgeGraphResponseSchema.parse({
      ...response,
      elements: {
        nodes: [{ data: { ...knowledgeNode.data, id: `i${"a".repeat(512)}` } }],
        edges: [],
      },
    })).toThrow();
  });

  it.each([
    ["duplicate include", { root: null, depth: 2, include: ["tags", "tags"], limit: 100, cursor: null }],
    ["depth above four", { root: null, depth: 5, include: [], limit: 100, cursor: null }],
    ["limit above 500", { root: null, depth: 2, include: [], limit: 501, cursor: null }],
    ["unsupported root", { root: { type: "tag", id: "tag_1" }, depth: 2, include: [], limit: 100, cursor: null }],
    ["unknown query field", { root: null, depth: 2, include: [], limit: 100, cursor: null, dangling: true }],
  ])("rejects an invalid graph query: %s", (_name, query) => {
    expect(() => knowledgeGraphQuerySchema.parse(query)).toThrow();
  });

  it.each([
    ["bodyMarkdown", versionNode, "must never escape"],
    ["locator", locationNode, "file:///Users/anthony/private.md"],
    ["secretReference", connectorNode, "deployment-secret"],
    ["dangling", knowledgeNode, true],
  ])("rejects the forbidden or unknown node field %s", (field, node, value) => {
    const response = {
      ...graphResponse,
      elements: {
        nodes: [{ data: { ...node.data, [field]: value } }],
        edges: [],
      },
    };

    expect(() => knowledgeGraphResponseSchema.parse(response)).toThrow();
  });

  it.each([
    ["connectorType", { ...connectorNode.data, connectorType: "secret://deployment/github" }],
    ["status", { ...connectorNode.data, status: "token_live_sensitive" }],
  ])("rejects an unsupported connector %s", (_field, data) => {
    expect(() => knowledgeGraphResponseSchema.parse({
      ...graphResponse,
      elements: { nodes: [{ data }], edges: [] },
    })).toThrow();
  });

  it("rejects unknown node wrappers and response fields", () => {
    expect(() => knowledgeGraphResponseSchema.parse({
      ...graphResponse,
      elements: { nodes: [{ ...knowledgeNode, selected: true }], edges: [] },
    })).toThrow();
    expect(() => knowledgeGraphResponseSchema.parse({ ...graphResponse, metadata: {} })).toThrow();
  });

  it("rejects invalid and non-strict edges", () => {
    expect(() => knowledgeGraphResponseSchema.parse({
      ...graphResponse,
      elements: {
        nodes: [knowledgeNode],
        edges: [{ data: { id: "edge:bad", source: "item:item_1", target: "tag:product", type: "RELATED_TO" } }],
      },
    })).toThrow();
    expect(() => knowledgeGraphResponseSchema.parse({
      ...graphResponse,
      elements: {
        nodes: [knowledgeNode],
        edges: [{ data: {
          id: "edge:bad",
          source: "item:item_1",
          target: "item:item_2",
          type: "CONTAINS",
          dangling: true,
        } }],
      },
    })).toThrow();
  });
});

describe("knowledge hierarchy operation contracts", () => {
  it("parses the three explicit hierarchy operations", () => {
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: 3,
      parentCollectionId: null,
      name: "Projects",
      description: "Project knowledge",
    }).kind).toBe("knowledge.collection.create");
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.move",
      collectionId: "collection_1",
      expectedRevision: 0,
      parentCollectionId: "collection_2",
      name: "Architecture",
      description: "Architecture knowledge",
    }).kind).toBe("knowledge.collection.move");
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.place",
      itemId: "item_1",
      collectionId: "collection_2",
      expectedPlacementRevision: null,
    }).kind).toBe("knowledge.place");
  });

  it("keeps the existing knowledge.organize operation", () => {
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.organize",
      mode: "bootstrap",
      itemIds: ["item_1"],
      instruction: "Create a durable taxonomy proposal",
    }).kind).toBe("knowledge.organize");
  });

  it("enforces strict hierarchy operation bounds", () => {
    expect(() => knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.create",
      expectedRegistryRevision: -1,
      parentCollectionId: null,
      name: "Projects",
      description: "",
    })).toThrow();
    expect(() => knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.collection.move",
      collectionId: "invalid id",
      expectedRevision: 0,
      parentCollectionId: null,
      name: "",
      description: "",
    })).toThrow();
    expect(() => knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.place",
      itemId: "item_1",
      collectionId: "collection_1",
      expectedPlacementRevision: -1,
      dangling: true,
    })).toThrow();
  });
});

describe("knowledge hierarchy result contracts", () => {
  it("accepts collection and placement results in the Agent result union", () => {
    const collectionResult = {
      schema: "cowikiharness.collection-result/v1",
      taskId: "task_1",
      collection: {
        schema: "cowikiharness.collection/v1",
        collectionId: "collection_1",
        orgId: "org_1",
        parentCollectionId: null,
        name: "Projects",
        description: "Project knowledge",
        revision: 0,
        createdByPrincipalId: "principal_1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as const;
    const placementResult = {
      schema: "cowikiharness.placement-result/v1",
      taskId: "task_2",
      placement: {
        schema: "cowikiharness.collection-placement/v1",
        orgId: "org_1",
        itemId: "item_1",
        collectionId: "collection_1",
        placedByPrincipalId: "principal_1",
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as const;

    expect(knowledgeCollectionResultSchema.parse(collectionResult)).toEqual(collectionResult);
    expect(knowledgePlacementResultSchema.parse(placementResult)).toEqual(placementResult);
    expect(knowledgeAgentResultSchema.parse(collectionResult)).toEqual(collectionResult);
    expect(knowledgeAgentResultSchema.parse(placementResult)).toEqual(placementResult);
    expect(() => knowledgeCollectionResultSchema.parse({ ...collectionResult, dangling: true })).toThrow();
    expect(() => knowledgePlacementResultSchema.parse({ ...placementResult, dangling: true })).toThrow();
  });
});
