import {
  KnowledgeGraphError,
  sha256Canonical,
  type KnowledgeGraphPage,
  type KnowledgeGraphReadPort,
} from "@openlifewiki/core";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphQuery,
  Principal,
} from "@openlifewiki/protocol";

import {
  loadAuthorizedGraphSnapshot,
  type AuthorizedGraphCollectionRow,
  type AuthorizedGraphSnapshot,
} from "./authorized-graph-snapshot.js";
import type { Database } from "./database.js";
import { GraphCursorCodec } from "./graph-cursor.js";

const UNFILED_NODE_ID = "collection:unfiled";

interface StructuralScope {
  readonly collectionIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  readonly includeUnfiled: boolean;
}

interface GraphBundle {
  readonly seedKey: string;
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
}

export class PostgresKnowledgeGraphStore implements KnowledgeGraphReadPort {
  readonly #cursorCodec: GraphCursorCodec;

  constructor(
    private readonly database: Database,
    tokenHmacSecret: string,
  ) {
    this.#cursorCodec = new GraphCursorCodec(tokenHmacSecret);
  }

  async readAuthorizedGraph(input: {
    readonly principal: Principal;
    readonly query: KnowledgeGraphQuery;
    readonly now: Date;
  }): Promise<KnowledgeGraphPage> {
    const snapshot = await loadAuthorizedGraphSnapshot(this.database, {
      principal: input.principal,
      now: input.now,
    });
    const queryHash = graphQueryHash(input.query);
    const cursor = input.query.cursor === null
      ? null
      : this.#cursorCodec.decode(input.query.cursor);
    if (cursor !== null && (
      cursor.orgId !== snapshot.orgId
      || cursor.principalId !== snapshot.principalId
      || cursor.queryHash !== queryHash
      || cursor.registryRevision !== snapshot.registryRevision
    )) {
      throw snapshotExpired();
    }
    validateRoot(snapshot, input.query);

    const scope = selectStructuralScope(snapshot, input.query);
    const seeds = seedKeys(scope, input.query);
    if (cursor !== null && !seeds.includes(cursor.afterSeedKey)) {
      throw snapshotExpired();
    }
    const bundles = buildBundles(snapshot, scope, input.query, seeds);
    for (const bundle of bundles) {
      if (bundle.nodes.length > 500) {
        throw new KnowledgeGraphError(
          "GRAPH_INVALID_QUERY",
          "A knowledge graph bundle exceeds the 500 node limit.",
        );
      }
    }
    const page = paginateBundles({
      bundles,
      afterSeedKey: cursor?.afterSeedKey ?? null,
      limit: input.query.limit,
    });
    const nextCursor = page.truncated && page.lastCompletedSeedKey !== null
      ? this.#cursorCodec.encode({
        version: 1,
        orgId: snapshot.orgId,
        principalId: snapshot.principalId,
        queryHash,
        registryRevision: snapshot.registryRevision,
        afterSeedKey: page.lastCompletedSeedKey,
      })
      : null;

    return {
      registryRevision: snapshot.registryRevision,
      nodes: sortNodes(page.nodes),
      edges: sortEdges(page.edges),
      truncated: page.truncated,
      nextCursor,
    };
  }
}

function buildBundles(
  snapshot: AuthorizedGraphSnapshot,
  scope: StructuralScope,
  query: KnowledgeGraphQuery,
  seeds: readonly string[],
): GraphBundle[] {
  const collections = new Map(snapshot.collections.map((collection) => [
    collection.collectionId,
    collection,
  ]));
  const placements = new Map(snapshot.placements.map((placement) => [placement.itemId, placement]));

  const pathToScopeRoot = (collectionId: string): ReadonlySet<string> => {
    const path = new Set<string>();
    let current = collections.get(collectionId);
    while (current !== undefined
      && scope.collectionIds.has(current.collectionId)
      && !path.has(current.collectionId)) {
      path.add(current.collectionId);
      current = current.parentCollectionId === null
        ? undefined
        : collections.get(current.parentCollectionId);
    }
    return path;
  };

  return seeds.map((seedKey) => {
    let bundleScope: StructuralScope;
    if (seedKey === UNFILED_NODE_ID) {
      bundleScope = { collectionIds: new Set(), itemIds: new Set(), includeUnfiled: true };
    } else if (seedKey.startsWith("collection:")) {
      bundleScope = {
        collectionIds: pathToScopeRoot(seedKey.slice("collection:".length)),
        itemIds: new Set(),
        includeUnfiled: false,
      };
    } else {
      const itemId = seedKey.slice("item:".length);
      const placement = placements.get(itemId);
      bundleScope = {
        collectionIds: placement === undefined
          ? new Set()
          : pathToScopeRoot(placement.collectionId),
        itemIds: new Set([itemId]),
        includeUnfiled: placement === undefined,
      };
    }
    const projected = projectGraph(snapshot, bundleScope, query);
    return { seedKey, nodes: projected.nodes, edges: projected.edges };
  });
}

function paginateBundles(input: {
  readonly bundles: readonly GraphBundle[];
  readonly afterSeedKey: string | null;
  readonly limit: number;
}): {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly truncated: boolean;
  readonly lastCompletedSeedKey: string | null;
} {
  const afterIndex = input.afterSeedKey === null
    ? -1
    : input.bundles.findIndex((bundle) => bundle.seedKey === input.afterSeedKey);
  const startIndex = afterIndex + 1;
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  let completed = 0;
  let lastCompletedSeedKey: string | null = null;

  for (let index = startIndex; index < input.bundles.length; index += 1) {
    const bundle = input.bundles[index];
    if (bundle === undefined) break;
    const candidateNodeIds = new Set(nodes.keys());
    for (const node of bundle.nodes) candidateNodeIds.add(node.data.id);
    if (completed > 0 && candidateNodeIds.size > input.limit) break;

    for (const node of bundle.nodes) nodes.set(node.data.id, node);
    for (const relation of bundle.edges) edges.set(relation.data.id, relation);
    completed += 1;
    lastCompletedSeedKey = bundle.seedKey;
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: startIndex + completed < input.bundles.length,
    lastCompletedSeedKey,
  };
}

function graphQueryHash(query: KnowledgeGraphQuery): string {
  return sha256Canonical({
    root: query.root,
    depth: query.depth,
    include: query.include,
    limit: query.limit,
  });
}

function seedKeys(scope: StructuralScope, query: KnowledgeGraphQuery): string[] {
  if (query.root?.type === "knowledge") return [itemNodeId(query.root.id)];
  const keys = [
    ...[...scope.collectionIds].map(collectionNodeId),
    ...[...scope.itemIds].map(itemNodeId),
  ];
  if (scope.includeUnfiled) keys.push(UNFILED_NODE_ID);
  return keys.sort(compareCodeUnits);
}

function snapshotExpired(): KnowledgeGraphError {
  return new KnowledgeGraphError(
    "GRAPH_SNAPSHOT_EXPIRED",
    "The knowledge graph snapshot has expired.",
  );
}

function projectGraph(
  snapshot: AuthorizedGraphSnapshot,
  scope: StructuralScope,
  query: KnowledgeGraphQuery,
): { readonly nodes: KnowledgeGraphNode[]; readonly edges: KnowledgeGraphEdge[] } {
  const nodes = new Map(structuralNodes(snapshot, scope).map((node) => [node.data.id, node]));
  const edges = new Map(structuralEdges(snapshot, scope).map((relation) => [
    relation.data.id,
    relation,
  ]));
  const includes = new Set(query.include);
  const tags = new Map(snapshot.tags.map((tag) => [tag.tagId, tag]));
  const principals = new Map(snapshot.principals.map((principal) => [principal.id, principal]));
  const connectors = new Map(snapshot.connectors.map((connector) => [connector.id, connector]));
  const includedLocations = snapshot.locations.filter((location) => (
    scope.itemIds.has(location.itemId)
    && (includes.has("locations")
      || (includes.has("connectors") && location.connectorInstanceId !== null))
  ));

  const addNode = (node: KnowledgeGraphNode): void => {
    nodes.set(node.data.id, node);
  };
  const addEdge = (relation: KnowledgeGraphEdge): void => {
    if (nodes.has(relation.data.source) && nodes.has(relation.data.target)) {
      edges.set(relation.data.id, relation);
    }
  };

  if (includes.has("tags")) {
    for (const relation of snapshot.knowledgeTags) {
      if (!scope.itemIds.has(relation.itemId)) continue;
      const tag = tags.get(relation.tagId);
      if (tag === undefined) continue;
      addNode({
        data: {
          id: tagNodeId(tag.tagId),
          type: "tag",
          label: tag.name,
          description: tag.description,
        },
      });
      addEdge(edge("TAGGED_WITH", itemNodeId(relation.itemId), tagNodeId(tag.tagId)));
    }
  }

  for (const location of includedLocations) {
    addNode({
      data: {
        id: locationNodeId(location.locationId),
        type: "location",
        label: `${location.kind} (${location.role})`,
        kind: location.kind,
        role: location.role,
        availability: location.availability,
        lastVerifiedAt: location.lastVerifiedAt,
      },
    });
    addEdge(edge("HAS_LOCATION", itemNodeId(location.itemId), locationNodeId(location.locationId)));
  }

  if (includes.has("versions")) {
    for (const version of snapshot.currentVersions) {
      if (!scope.itemIds.has(version.itemId)) continue;
      addNode({
        data: {
          id: versionNodeId(version.versionId),
          type: "version",
          label: `Version ${version.ordinal}`,
          ordinal: version.ordinal,
          bodyHash: version.bodyHash,
          providerVersion: version.providerVersion,
          createdAt: version.createdAt,
        },
      });
      addEdge(edge("CURRENT_VERSION", itemNodeId(version.itemId), versionNodeId(version.versionId)));
    }
  }

  if (includes.has("principals")) {
    for (const item of snapshot.knowledgeItems) {
      if (!scope.itemIds.has(item.itemId)) continue;
      const principal = principals.get(item.ownerPrincipalId);
      if (principal === undefined) continue;
      addNode(principalNode(principal));
      addEdge(edge("OWNED_BY", itemNodeId(item.itemId), principalNodeId(principal.id)));
    }
    for (const relation of snapshot.shares) {
      if (!scope.itemIds.has(relation.itemId)) continue;
      const principal = principals.get(relation.principalId);
      if (principal === undefined) continue;
      addNode(principalNode(principal));
      addEdge(edge("SHARED_WITH", itemNodeId(relation.itemId), principalNodeId(principal.id)));
    }
    for (const location of includedLocations) {
      const principal = principals.get(location.ownerPrincipalId);
      if (principal === undefined) continue;
      addNode(principalNode(principal));
      addEdge(edge(
        "OWNED_BY",
        locationNodeId(location.locationId),
        principalNodeId(principal.id),
      ));
    }
  }

  if (includes.has("connectors")) {
    for (const location of includedLocations) {
      if (location.connectorInstanceId === null) continue;
      const connector = connectors.get(location.connectorInstanceId);
      if (connector === undefined) continue;
      addNode({
        data: {
          id: connectorNodeId(connector.id),
          type: "connector",
          label: connector.displayName,
          connectorType: connector.type,
          status: connector.status,
        },
      });
      addEdge(edge(
        "PROVIDED_BY",
        locationNodeId(location.locationId),
        connectorNodeId(connector.id),
      ));
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function principalNode(principal: AuthorizedGraphSnapshot["principals"][number]): KnowledgeGraphNode {
  return {
    data: {
      id: principalNodeId(principal.id),
      type: "principal",
      label: principal.displayName,
      principalType: principal.type,
    },
  };
}

function validateRoot(snapshot: AuthorizedGraphSnapshot, query: KnowledgeGraphQuery): void {
  if (query.root === null) return;
  const exists = query.root.type === "knowledge"
    ? snapshot.knowledgeItems.some((item) => item.itemId === query.root?.id)
    : snapshot.collections.some((collection) => collection.collectionId === query.root?.id);
  if (!exists) {
    throw new KnowledgeGraphError(
      "GRAPH_ROOT_NOT_FOUND",
      "The requested knowledge graph root was not found.",
    );
  }
}

function selectStructuralScope(
  snapshot: AuthorizedGraphSnapshot,
  query: KnowledgeGraphQuery,
): StructuralScope {
  const collections = new Map(snapshot.collections.map((collection) => [
    collection.collectionId,
    collection,
  ]));
  const placements = new Map(snapshot.placements.map((placement) => [placement.itemId, placement]));

  if (query.root?.type === "knowledge") {
    const collectionIds = new Set<string>();
    const placement = placements.get(query.root.id);
    let current = placement === undefined ? undefined : collections.get(placement.collectionId);
    while (current !== undefined && !collectionIds.has(current.collectionId)) {
      collectionIds.add(current.collectionId);
      current = current.parentCollectionId === null
        ? undefined
        : collections.get(current.parentCollectionId);
    }
    return {
      collectionIds,
      itemIds: new Set([query.root.id]),
      includeUnfiled: placement === undefined,
    };
  }

  const productiveCollectionIds = productiveCollections(snapshot, collections);
  const childCollections = groupCollectionsByParent(snapshot.collections);
  const itemsByCollection = groupItemsByCollection(snapshot);
  const collectionIds = new Set<string>();
  const itemIds = new Set<string>();
  let includeUnfiled = false;

  const visit = (rootId: string): void => {
    let frontier = [rootId];
    for (let distance = 0; distance <= query.depth && frontier.length > 0; distance += 1) {
      const next: string[] = [];
      for (const collectionId of frontier) {
        collectionIds.add(collectionId);
        if (distance >= query.depth) continue;
        for (const itemId of itemsByCollection.get(collectionId) ?? []) itemIds.add(itemId);
        for (const child of childCollections.get(collectionId) ?? []) {
          if (productiveCollectionIds.has(child.collectionId)) next.push(child.collectionId);
        }
      }
      frontier = next;
    }
  };

  if (query.root?.type === "collection") {
    visit(query.root.id);
  } else {
    for (const collection of snapshot.collections) {
      if (collection.parentCollectionId === null
        && productiveCollectionIds.has(collection.collectionId)) {
        visit(collection.collectionId);
      }
    }
    const unfiledItems = snapshot.knowledgeItems
      .filter((item) => !placements.has(item.itemId))
      .map((item) => item.itemId);
    if (unfiledItems.length > 0) {
      includeUnfiled = true;
      if (query.depth >= 1) {
        for (const itemId of unfiledItems) itemIds.add(itemId);
      }
    }
  }

  return { collectionIds, itemIds, includeUnfiled };
}

function productiveCollections(
  snapshot: AuthorizedGraphSnapshot,
  collections: ReadonlyMap<string, AuthorizedGraphCollectionRow>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const placement of snapshot.placements) {
    let current = collections.get(placement.collectionId);
    while (current !== undefined && !result.has(current.collectionId)) {
      result.add(current.collectionId);
      current = current.parentCollectionId === null
        ? undefined
        : collections.get(current.parentCollectionId);
    }
  }
  return result;
}

function groupCollectionsByParent(
  collections: readonly AuthorizedGraphCollectionRow[],
): ReadonlyMap<string, readonly AuthorizedGraphCollectionRow[]> {
  const result = new Map<string, AuthorizedGraphCollectionRow[]>();
  for (const collection of collections) {
    if (collection.parentCollectionId === null) continue;
    const siblings = result.get(collection.parentCollectionId) ?? [];
    siblings.push(collection);
    result.set(collection.parentCollectionId, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) => compareCodeUnits(left.collectionId, right.collectionId));
  }
  return result;
}

function groupItemsByCollection(snapshot: AuthorizedGraphSnapshot): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const placement of snapshot.placements) {
    const itemIds = result.get(placement.collectionId) ?? [];
    itemIds.push(placement.itemId);
    result.set(placement.collectionId, itemIds);
  }
  for (const itemIds of result.values()) itemIds.sort(compareCodeUnits);
  return result;
}

function structuralNodes(
  snapshot: AuthorizedGraphSnapshot,
  scope: StructuralScope,
): KnowledgeGraphNode[] {
  const nodes: KnowledgeGraphNode[] = [];
  for (const collection of snapshot.collections) {
    if (!scope.collectionIds.has(collection.collectionId)) continue;
    nodes.push({
      data: {
        id: collectionNodeId(collection.collectionId),
        type: "collection",
        label: collection.name,
        description: collection.description,
        revision: collection.revision,
      },
    });
  }
  if (scope.includeUnfiled) {
    nodes.push({
      data: {
        id: UNFILED_NODE_ID,
        type: "collection",
        label: "Unfiled",
        description: "",
        revision: 0,
      },
    });
  }
  for (const item of snapshot.knowledgeItems) {
    if (!scope.itemIds.has(item.itemId)) continue;
    nodes.push({
      data: {
        id: itemNodeId(item.itemId),
        type: "knowledge",
        label: item.title,
        status: item.status,
        revision: item.revision,
        updatedAt: item.updatedAt,
      },
    });
  }
  return nodes;
}

function structuralEdges(
  snapshot: AuthorizedGraphSnapshot,
  scope: StructuralScope,
): KnowledgeGraphEdge[] {
  const edges: KnowledgeGraphEdge[] = [];
  for (const collection of snapshot.collections) {
    if (collection.parentCollectionId === null
      || !scope.collectionIds.has(collection.collectionId)
      || !scope.collectionIds.has(collection.parentCollectionId)) continue;
    edges.push(edge(
      "CONTAINS",
      collectionNodeId(collection.parentCollectionId),
      collectionNodeId(collection.collectionId),
    ));
  }
  const placedItems = new Set<string>();
  for (const placement of snapshot.placements) {
    if (!scope.itemIds.has(placement.itemId)
      || !scope.collectionIds.has(placement.collectionId)) continue;
    placedItems.add(placement.itemId);
    edges.push(edge(
      "CONTAINS",
      collectionNodeId(placement.collectionId),
      itemNodeId(placement.itemId),
    ));
  }
  if (scope.includeUnfiled) {
    for (const itemId of scope.itemIds) {
      if (!placedItems.has(itemId)) edges.push(edge("CONTAINS", UNFILED_NODE_ID, itemNodeId(itemId)));
    }
  }
  return edges;
}

function edge(
  type: KnowledgeGraphEdge["data"]["type"],
  source: string,
  target: string,
): KnowledgeGraphEdge {
  return {
    data: {
      id: `edge:${sha256Canonical({ type, source, target }).slice("sha256:".length)}`,
      source,
      target,
      type,
    },
  };
}

function collectionNodeId(collectionId: string): string {
  return `collection:${collectionId}`;
}

function itemNodeId(itemId: string): string {
  return `item:${itemId}`;
}

function tagNodeId(tagId: string): string {
  return `tag:${tagId}`;
}

function locationNodeId(locationId: string): string {
  return `location:${locationId}`;
}

function versionNodeId(versionId: string): string {
  return `version:${versionId}`;
}

function principalNodeId(principalId: string): string {
  return `principal:${principalId}`;
}

function connectorNodeId(connectorId: string): string {
  return `connector:${connectorId}`;
}

function sortNodes(nodes: readonly KnowledgeGraphNode[]): KnowledgeGraphNode[] {
  return [...nodes].sort((left, right) => (
    compareCodeUnits(left.data.type, right.data.type)
    || compareCodeUnits(left.data.id, right.data.id)
  ));
}

function sortEdges(edges: readonly KnowledgeGraphEdge[]): KnowledgeGraphEdge[] {
  return [...edges].sort((left, right) => (
    compareCodeUnits(left.data.type, right.data.type)
    || compareCodeUnits(left.data.id, right.data.id)
  ));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
