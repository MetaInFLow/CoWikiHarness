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
  readonly registryRevision: number;
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface KnowledgeGraphReadPort {
  readAuthorizedGraph(input: {
    readonly principal: Principal;
    readonly query: KnowledgeGraphQuery;
    readonly now: Date;
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
  readonly context: AccessContext;
  readonly expectedRegistryRevision: number;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly now: Date;
}

export interface MoveCollectionInput {
  readonly context: AccessContext;
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly now: Date;
}

export interface PlaceKnowledgeInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly collectionId: string;
  readonly expectedPlacementRevision: number | null;
  readonly now: Date;
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
    const rawResponse = {
      schema: "cowikiharness.graph/v1",
      registryRevision: page.registryRevision,
      generatedAt: input.now.toISOString(),
      elements: {
        nodes: page.nodes,
        edges: page.edges,
      },
      truncated: page.truncated,
      nextCursor: page.nextCursor,
    };
    const parsed = knowledgeGraphResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw invalidProjection();
    }

    const nodeIds = new Set<string>();
    for (const node of parsed.data.elements.nodes) {
      if (nodeIds.has(node.data.id)) {
        throw invalidProjection();
      }
      nodeIds.add(node.data.id);
    }

    const edgeIds = new Set<string>();
    for (const edge of parsed.data.elements.edges) {
      if (edgeIds.has(edge.data.id)) {
        throw invalidProjection();
      }
      edgeIds.add(edge.data.id);
      if (!nodeIds.has(edge.data.source) || !nodeIds.has(edge.data.target)) {
        throw invalidProjection();
      }
    }

    const nodes = [...parsed.data.elements.nodes].sort((left, right) => (
      compareCodeUnits(left.data.type, right.data.type)
      || compareCodeUnits(left.data.id, right.data.id)
    ));
    const edges = [...parsed.data.elements.edges].sort((left, right) => (
      compareCodeUnits(left.data.type, right.data.type)
      || compareCodeUnits(left.data.id, right.data.id)
    ));

    return {
      ...parsed.data,
      elements: {
        nodes,
        edges,
      },
    };
  }
}

function invalidProjection(): KnowledgeGraphError {
  return new KnowledgeGraphError(
    "GRAPH_INVALID_PROJECTION",
    "Knowledge graph projection is invalid.",
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
