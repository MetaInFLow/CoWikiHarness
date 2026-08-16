import {
  knowledgeGraphResponseSchema,
  type AccessContext,
  type KnowledgeCollection,
  type KnowledgeCollectionPlacement,
  type KnowledgeGraphEdge,
  type KnowledgeGraphErrorCode,
  type KnowledgeGraphNode,
  type KnowledgeGraphQuery,
  type KnowledgeGraphResponse,
  type Principal,
} from "@openlifewiki/protocol";

export interface KnowledgeGraphPage {
  registryRevision: number;
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly KnowledgeGraphEdge[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface KnowledgeGraphReadPort {
  readAuthorizedGraph(input: {
    principal: Principal;
    query: KnowledgeGraphQuery;
    now: Date;
  }): Promise<KnowledgeGraphPage>;
}

export interface KnowledgeHierarchyWritePort {
  createCollection(input: CreateCollectionInput): Promise<KnowledgeCollection>;
  moveCollection(input: MoveCollectionInput): Promise<KnowledgeCollection>;
  placeKnowledge(input: PlaceKnowledgeInput): Promise<KnowledgeCollectionPlacement>;
  getCollection(orgId: string, collectionId: string): Promise<KnowledgeCollection | null>;
  getPlacement(orgId: string, itemId: string): Promise<KnowledgeCollectionPlacement | null>;
}

export interface CreateCollectionInput {
  context: AccessContext;
  expectedRegistryRevision: number;
  parentCollectionId: string | null;
  name: string;
  description: string;
  now: Date;
}

export interface MoveCollectionInput {
  context: AccessContext;
  collectionId: string;
  expectedRevision: number;
  parentCollectionId: string | null;
  name: string;
  description: string;
  now: Date;
}

export interface PlaceKnowledgeInput {
  context: AccessContext;
  itemId: string;
  collectionId: string;
  expectedPlacementRevision: number | null;
  now: Date;
}

export class KnowledgeGraphError extends Error {
  constructor(readonly code: KnowledgeGraphErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeGraphError";
  }
}

export class KnowledgeGraphProjectionService {
  constructor(private readonly port: KnowledgeGraphReadPort) {}

  async read(input: {
    principal: Principal;
    query: KnowledgeGraphQuery;
    now: Date;
  }): Promise<KnowledgeGraphResponse> {
    if (input.principal.type !== "user") {
      throw new KnowledgeGraphError(
        "GRAPH_PRINCIPAL_NOT_SUPPORTED",
        "Knowledge graph reads support user principals only.",
      );
    }
    if (input.principal.status !== "active") {
      throw new KnowledgeGraphError(
        "GRAPH_FORBIDDEN",
        "The principal is not authorized to read the knowledge graph.",
      );
    }

    const page = await this.port.readAuthorizedGraph(input);

    try {
      const nodeIds = new Set<string>();
      for (const node of page.nodes) {
        if (nodeIds.has(node.data.id)) {
          throw invalidProjection();
        }
        nodeIds.add(node.data.id);
      }

      const edgeIds = new Set<string>();
      for (const edge of page.edges) {
        if (edgeIds.has(edge.data.id)) {
          throw invalidProjection();
        }
        edgeIds.add(edge.data.id);
        if (!nodeIds.has(edge.data.source) || !nodeIds.has(edge.data.target)) {
          throw invalidProjection();
        }
      }

      const nodes = [...page.nodes].sort((left, right) => (
        left.data.type.localeCompare(right.data.type)
        || left.data.id.localeCompare(right.data.id)
      ));
      const edges = [...page.edges].sort((left, right) => (
        left.data.type.localeCompare(right.data.type)
        || left.data.id.localeCompare(right.data.id)
      ));

      return knowledgeGraphResponseSchema.parse({
        schema: "cowikiharness.graph/v1",
        registryRevision: page.registryRevision,
        generatedAt: input.now.toISOString(),
        elements: { nodes, edges },
        truncated: page.truncated,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof KnowledgeGraphError) {
        throw error;
      }
      throw invalidProjection();
    }
  }
}

function invalidProjection(): KnowledgeGraphError {
  return new KnowledgeGraphError(
    "GRAPH_INVALID_PROJECTION",
    "Knowledge graph projection is invalid.",
  );
}
