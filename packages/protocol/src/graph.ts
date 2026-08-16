import { z } from "zod";

import { CONNECTOR_TYPES } from "./connector.js";

export const KNOWLEDGE_GRAPH_NODE_TYPES = [
  "collection",
  "knowledge",
  "tag",
  "location",
  "version",
  "principal",
  "connector",
] as const;

export const KNOWLEDGE_GRAPH_EDGE_TYPES = [
  "CONTAINS",
  "TAGGED_WITH",
  "HAS_LOCATION",
  "CURRENT_VERSION",
  "OWNED_BY",
  "SHARED_WITH",
  "PROVIDED_BY",
] as const;

export const KNOWLEDGE_GRAPH_INCLUDES = [
  "tags",
  "locations",
  "versions",
  "principals",
  "connectors",
] as const;

export const KNOWLEDGE_GRAPH_ERROR_CODES = [
  "GRAPH_INVALID_QUERY",
  "GRAPH_FORBIDDEN",
  "GRAPH_PRINCIPAL_NOT_SUPPORTED",
  "GRAPH_ROOT_NOT_FOUND",
  "GRAPH_SNAPSHOT_EXPIRED",
  "GRAPH_UNAVAILABLE",
  "GRAPH_INVALID_PROJECTION",
] as const;

const registryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const graphElementId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/);
const collectionElementId = z.string().regex(
  /^collection:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
);
const knowledgeElementId = z.string().regex(
  /^item:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
);
const collectionNodeElementId = z.union([
  collectionElementId,
  z.literal("collection:__virtual__:unfiled"),
]);
const tagElementId = z.string().regex(/^tag:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const locationElementId = z.string().regex(/^location:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const versionElementId = z.string().regex(/^version:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const principalElementId = z.string().regex(/^principal:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const connectorElementId = z.string().regex(/^connector:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const label = z.string().min(1).max(500);

export const knowledgeGraphQuerySchema = z.strictObject({
  root: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("collection"), id: registryId }),
    z.strictObject({ type: z.literal("knowledge"), id: registryId }),
  ]).nullable(),
  depth: z.int().min(0).max(4),
  include: z.array(z.enum(KNOWLEDGE_GRAPH_INCLUDES)).max(5)
    .refine((value) => new Set(value).size === value.length, "include values must be unique"),
  limit: z.int().min(1).max(500),
  cursor: z.string().min(1).max(4_096).nullable(),
});

const knowledgeGraphNodeDataSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: collectionNodeElementId,
    type: z.literal("collection"),
    label: z.string().min(1).max(200),
    description: z.string().max(2_000),
    revision: z.int().nonnegative(),
  }),
  z.strictObject({
    id: knowledgeElementId,
    type: z.literal("knowledge"),
    label,
    status: z.enum(["draft", "stable", "deprecated"]),
    revision: z.int().nonnegative(),
    updatedAt: timestamp,
  }),
  z.strictObject({
    id: tagElementId,
    type: z.literal("tag"),
    label: z.string().min(1).max(100),
    description: z.string().max(2_000),
  }),
  z.strictObject({
    id: locationElementId,
    type: z.literal("location"),
    label,
    kind: z.enum(["managed-markdown", "feishu", "github", "person-local"]),
    role: z.enum(["canonical", "original", "managed-copy", "reference"]),
    availability: z.enum(["available", "offline", "unknown", "revoked"]),
    lastVerifiedAt: timestamp.nullable(),
  }),
  z.strictObject({
    id: versionElementId,
    type: z.literal("version"),
    label,
    ordinal: z.int().positive(),
    bodyHash: hash,
    providerVersion: z.string().min(1).max(500).nullable(),
    createdAt: timestamp,
  }),
  z.strictObject({
    id: principalElementId,
    type: z.literal("principal"),
    label: z.string().min(1).max(200),
    principalType: z.enum(["user", "agent", "relay"]),
  }),
  z.strictObject({
    id: connectorElementId,
    type: z.literal("connector"),
    label: z.string().min(1).max(200),
    connectorType: z.enum(CONNECTOR_TYPES),
    status: z.enum(["active", "disabled"]),
  }),
]);

export const knowledgeGraphNodeSchema = z.strictObject({
  data: knowledgeGraphNodeDataSchema,
});

const edgeIdentity = {
  id: graphElementId,
} as const;
const relationIdentity = {
  id: graphElementId,
  source: graphElementId,
  target: graphElementId,
} as const;

const knowledgeGraphEdgeDataSchema = z.union([
  z.strictObject({
    ...edgeIdentity,
    source: collectionElementId,
    target: knowledgeElementId,
    type: z.literal("CONTAINS"),
    placementRevision: z.int().nonnegative(),
  }),
  z.strictObject({
    ...edgeIdentity,
    source: collectionElementId,
    target: collectionElementId,
    type: z.literal("CONTAINS"),
  }),
  z.strictObject({
    ...edgeIdentity,
    source: z.literal("collection:__virtual__:unfiled"),
    target: knowledgeElementId,
    type: z.literal("CONTAINS"),
  }),
  ...KNOWLEDGE_GRAPH_EDGE_TYPES.filter((type) => type !== "CONTAINS").map((type) => (
    z.strictObject({
      ...relationIdentity,
      type: z.literal(type),
    })
  )),
]);

export const knowledgeGraphEdgeSchema = z.strictObject({
  data: knowledgeGraphEdgeDataSchema,
});

export const knowledgeGraphResponseSchema = z.strictObject({
  schema: z.literal("cowikiharness.graph/v1"),
  registryRevision: z.int().nonnegative(),
  generatedAt: timestamp,
  elements: z.strictObject({
    nodes: z.array(knowledgeGraphNodeSchema),
    edges: z.array(knowledgeGraphEdgeSchema),
  }),
  truncated: z.boolean(),
  nextCursor: z.string().min(1).max(4_096).nullable(),
}).superRefine((response, context) => {
  const nodeTypes = new Map(response.elements.nodes.map((node) => [
    node.data.id,
    node.data.type,
  ]));

  response.elements.edges.forEach((edge, index) => {
    const sourceType = nodeTypes.get(edge.data.source);
    const targetType = nodeTypes.get(edge.data.target);
    if (sourceType === undefined
      || targetType === undefined
      || !hasValidEndpointTypes(edge.data.type, sourceType, targetType)) {
      context.addIssue({
        code: "custom",
        message: "Edge endpoints must exist and match the relation semantics",
        path: ["elements", "edges", index, "data"],
      });
    }
  });
});

function hasValidEndpointTypes(
  edgeType: (typeof KNOWLEDGE_GRAPH_EDGE_TYPES)[number],
  sourceType: (typeof KNOWLEDGE_GRAPH_NODE_TYPES)[number],
  targetType: (typeof KNOWLEDGE_GRAPH_NODE_TYPES)[number],
): boolean {
  switch (edgeType) {
    case "CONTAINS":
      return sourceType === "collection"
        && (targetType === "collection" || targetType === "knowledge");
    case "TAGGED_WITH":
      return sourceType === "knowledge" && targetType === "tag";
    case "HAS_LOCATION":
      return sourceType === "knowledge" && targetType === "location";
    case "CURRENT_VERSION":
      return sourceType === "knowledge" && targetType === "version";
    case "OWNED_BY":
      return (sourceType === "knowledge" || sourceType === "location")
        && targetType === "principal";
    case "SHARED_WITH":
      return sourceType === "knowledge" && targetType === "principal";
    case "PROVIDED_BY":
      return sourceType === "location" && targetType === "connector";
  }
}

export const knowledgeCollectionSchema = z.strictObject({
  schema: z.literal("cowikiharness.collection/v1"),
  collectionId: registryId,
  orgId: registryId,
  parentCollectionId: registryId.nullable(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  revision: z.int().nonnegative(),
  createdByPrincipalId: registryId,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const knowledgeCollectionPlacementSchema = z.strictObject({
  schema: z.literal("cowikiharness.collection-placement/v1"),
  orgId: registryId,
  itemId: registryId,
  collectionId: registryId,
  placedByPrincipalId: registryId,
  revision: z.int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const knowledgeCollectionResultSchema = z.strictObject({
  schema: z.literal("cowikiharness.collection-result/v1"),
  taskId: registryId,
  collection: knowledgeCollectionSchema,
});

export const knowledgePlacementResultSchema = z.strictObject({
  schema: z.literal("cowikiharness.placement-result/v1"),
  taskId: registryId,
  placement: knowledgeCollectionPlacementSchema,
});

export type KnowledgeGraphErrorCode = (typeof KNOWLEDGE_GRAPH_ERROR_CODES)[number];
export type KnowledgeGraphQuery = z.infer<typeof knowledgeGraphQuerySchema>;
export type KnowledgeGraphNode = z.infer<typeof knowledgeGraphNodeSchema>;
export type KnowledgeGraphEdge = z.infer<typeof knowledgeGraphEdgeSchema>;
export type KnowledgeGraphResponse = z.infer<typeof knowledgeGraphResponseSchema>;
export type KnowledgeCollection = z.infer<typeof knowledgeCollectionSchema>;
export type KnowledgeCollectionPlacement = z.infer<typeof knowledgeCollectionPlacementSchema>;
export type KnowledgeCollectionResult = z.infer<typeof knowledgeCollectionResultSchema>;
export type KnowledgePlacementResult = z.infer<typeof knowledgePlacementResultSchema>;
