import { KnowledgeGraphError, sha256Canonical } from "@openlifewiki/core";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphQuery,
} from "@openlifewiki/protocol";

import type {
  AuthorizedGraphCollectionRow,
  AuthorizedGraphConnectorRow,
  AuthorizedGraphCurrentVersionRow,
  AuthorizedGraphKnowledgeItemRow,
  AuthorizedGraphKnowledgeTagRow,
  AuthorizedGraphLocationRow,
  AuthorizedGraphPlacementRow,
  AuthorizedGraphPrincipalRow,
  AuthorizedGraphShareRow,
  AuthorizedGraphSnapshot,
  AuthorizedGraphTagRow,
} from "./authorized-graph-snapshot.js";

export const UNFILED_NODE_ID = "collection:__virtual__:unfiled";

export interface GraphBundle {
  readonly seedKey: string;
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
}

export interface PaginatedGraphBundles {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly truncated: boolean;
  readonly lastCompletedSeedKey: string | null;
}

export interface KnowledgeGraphBundleContext {
  readonly seedKeys: readonly string[];
  readonly buildBundle: (seedKey: string) => GraphBundle;
}

interface StructuralScope {
  readonly collectionIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  readonly includeUnfiled: boolean;
}

interface ProjectionIndexes {
  readonly collections: ReadonlyMap<string, AuthorizedGraphCollectionRow>;
  readonly knowledgeItems: ReadonlyMap<string, AuthorizedGraphKnowledgeItemRow>;
  readonly placements: ReadonlyMap<string, AuthorizedGraphPlacementRow>;
  readonly tags: ReadonlyMap<string, AuthorizedGraphTagRow>;
  readonly knowledgeTagsByItem: ReadonlyMap<string, readonly AuthorizedGraphKnowledgeTagRow[]>;
  readonly locationsByItem: ReadonlyMap<string, readonly AuthorizedGraphLocationRow[]>;
  readonly currentVersionsByItem: ReadonlyMap<string, readonly AuthorizedGraphCurrentVersionRow[]>;
  readonly principals: ReadonlyMap<string, AuthorizedGraphPrincipalRow>;
  readonly connectors: ReadonlyMap<string, AuthorizedGraphConnectorRow>;
  readonly sharesByItem: ReadonlyMap<string, readonly AuthorizedGraphShareRow[]>;
  readonly childCollectionsByParent: ReadonlyMap<string, readonly AuthorizedGraphCollectionRow[]>;
  readonly itemIdsByCollection: ReadonlyMap<string, readonly string[]>;
  readonly productiveCollectionIds: ReadonlySet<string>;
  readonly unfiledItemIds: readonly string[];
}

export function createKnowledgeGraphBundleContext(
  snapshot: AuthorizedGraphSnapshot,
  query: KnowledgeGraphQuery,
): KnowledgeGraphBundleContext {
  const indexes = createProjectionIndexes(snapshot);
  validateRoot(indexes, query);
  const scope = selectStructuralScope(indexes, query);
  const seedKeys = selectSeedKeys(scope, query);

  return {
    seedKeys,
    buildBundle(seedKey): GraphBundle {
      return {
        seedKey,
        ...projectGraph(indexes, bundleScope(indexes, scope, seedKey), query),
      };
    },
  };
}

export function uniqueSortedSeedKeys(seedKeys: Iterable<string>): string[] {
  return [...new Set(seedKeys)].sort(compareCodeUnits);
}

export function paginateSeedBundles(input: {
  readonly seedKeys: readonly string[];
  readonly afterSeedKey: string | null;
  readonly limit: number;
  readonly buildBundle: (seedKey: string) => GraphBundle;
}): PaginatedGraphBundles {
  const afterIndex = input.afterSeedKey === null
    ? -1
    : input.seedKeys.indexOf(input.afterSeedKey);
  const startIndex = afterIndex + 1;
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  let completed = 0;
  let lastCompletedSeedKey: string | null = null;

  for (let index = startIndex; index < input.seedKeys.length; index += 1) {
    const seedKey = input.seedKeys[index];
    if (seedKey === undefined) break;
    const bundle = input.buildBundle(seedKey);
    if (bundle.nodes.length > 500) {
      throw new KnowledgeGraphError(
        "GRAPH_INVALID_QUERY",
        "A knowledge graph bundle exceeds the 500 node limit.",
      );
    }

    const candidateNodeIds = new Set(nodes.keys());
    for (const node of bundle.nodes) candidateNodeIds.add(node.data.id);
    if (completed > 0 && candidateNodeIds.size > input.limit) break;

    for (const node of bundle.nodes) nodes.set(node.data.id, node);
    for (const relation of bundle.edges) edges.set(relation.data.id, relation);
    completed += 1;
    lastCompletedSeedKey = seedKey;

    if (nodes.size >= input.limit && index + 1 < input.seedKeys.length) break;
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: startIndex + completed < input.seedKeys.length,
    lastCompletedSeedKey,
  };
}

function createProjectionIndexes(snapshot: AuthorizedGraphSnapshot): ProjectionIndexes {
  const collections = new Map(snapshot.collections.map((row) => [row.collectionId, row]));
  const knowledgeItems = new Map(snapshot.knowledgeItems.map((row) => [row.itemId, row]));
  const placements = new Map(snapshot.placements.map((row) => [row.itemId, row]));
  const tags = new Map(snapshot.tags.map((row) => [row.tagId, row]));
  const principals = new Map(snapshot.principals.map((row) => [row.id, row]));
  const connectors = new Map(snapshot.connectors.map((row) => [row.id, row]));
  const knowledgeTagsByItem = groupRows(snapshot.knowledgeTags, (row) => row.itemId);
  const locationsByItem = groupRows(snapshot.locations, (row) => row.itemId);
  const currentVersionsByItem = groupRows(snapshot.currentVersions, (row) => row.itemId);
  const sharesByItem = groupRows(snapshot.shares, (row) => row.itemId);
  const childCollectionsByParent = groupRows(
    snapshot.collections.filter((row) => row.parentCollectionId !== null),
    (row) => row.parentCollectionId as string,
  );
  const itemIdsByCollection = new Map<string, string[]>();
  for (const placement of snapshot.placements) {
    appendGrouped(itemIdsByCollection, placement.collectionId, placement.itemId);
  }
  for (const itemIds of itemIdsByCollection.values()) itemIds.sort(compareCodeUnits);

  const productiveCollectionIds = new Set<string>();
  for (const placement of snapshot.placements) {
    let current = collections.get(placement.collectionId);
    while (current !== undefined && !productiveCollectionIds.has(current.collectionId)) {
      productiveCollectionIds.add(current.collectionId);
      current = current.parentCollectionId === null
        ? undefined
        : collections.get(current.parentCollectionId);
    }
  }
  const unfiledItemIds = [...knowledgeItems.keys()]
    .filter((itemId) => !placements.has(itemId))
    .sort(compareCodeUnits);

  return {
    collections,
    knowledgeItems,
    placements,
    tags,
    knowledgeTagsByItem,
    locationsByItem,
    currentVersionsByItem,
    principals,
    connectors,
    sharesByItem,
    childCollectionsByParent,
    itemIdsByCollection,
    productiveCollectionIds,
    unfiledItemIds,
  };
}

function validateRoot(indexes: ProjectionIndexes, query: KnowledgeGraphQuery): void {
  if (query.root === null) return;
  const exists = query.root.type === "knowledge"
    ? indexes.knowledgeItems.has(query.root.id)
    : indexes.collections.has(query.root.id);
  if (!exists) {
    throw new KnowledgeGraphError(
      "GRAPH_ROOT_NOT_FOUND",
      "The requested knowledge graph root was not found.",
    );
  }
}

function selectStructuralScope(
  indexes: ProjectionIndexes,
  query: KnowledgeGraphQuery,
): StructuralScope {
  if (query.root?.type === "knowledge") {
    const placement = indexes.placements.get(query.root.id);
    return {
      collectionIds: placement === undefined
        ? new Set()
        : pathToVisibleRoot(indexes, placement.collectionId),
      itemIds: new Set([query.root.id]),
      includeUnfiled: placement === undefined,
    };
  }

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
        for (const itemId of indexes.itemIdsByCollection.get(collectionId) ?? []) {
          itemIds.add(itemId);
        }
        for (const child of indexes.childCollectionsByParent.get(collectionId) ?? []) {
          if (indexes.productiveCollectionIds.has(child.collectionId)) {
            next.push(child.collectionId);
          }
        }
      }
      frontier = next;
    }
  };

  if (query.root?.type === "collection") {
    visit(query.root.id);
  } else {
    for (const collection of indexes.collections.values()) {
      if (collection.parentCollectionId === null
        && indexes.productiveCollectionIds.has(collection.collectionId)) {
        visit(collection.collectionId);
      }
    }
    if (indexes.unfiledItemIds.length > 0) {
      includeUnfiled = true;
      if (query.depth >= 1) {
        for (const itemId of indexes.unfiledItemIds) itemIds.add(itemId);
      }
    }
  }

  return { collectionIds, itemIds, includeUnfiled };
}

function selectSeedKeys(scope: StructuralScope, query: KnowledgeGraphQuery): string[] {
  if (query.root?.type === "knowledge") return [itemNodeId(query.root.id)];
  const keys = new Set<string>();
  for (const collectionId of scope.collectionIds) keys.add(collectionNodeId(collectionId));
  for (const itemId of scope.itemIds) keys.add(itemNodeId(itemId));
  if (scope.includeUnfiled) keys.add(UNFILED_NODE_ID);
  return uniqueSortedSeedKeys(keys);
}

function bundleScope(
  indexes: ProjectionIndexes,
  scope: StructuralScope,
  seedKey: string,
): StructuralScope {
  if (seedKey === UNFILED_NODE_ID) {
    return { collectionIds: new Set(), itemIds: new Set(), includeUnfiled: true };
  }
  if (seedKey.startsWith("collection:")) {
    return {
      collectionIds: pathToScopeRoot(indexes, scope, seedKey.slice("collection:".length)),
      itemIds: new Set(),
      includeUnfiled: false,
    };
  }

  const itemId = seedKey.slice("item:".length);
  const placement = indexes.placements.get(itemId);
  return {
    collectionIds: placement === undefined
      ? new Set()
      : pathToScopeRoot(indexes, scope, placement.collectionId),
    itemIds: new Set([itemId]),
    includeUnfiled: placement === undefined,
  };
}

function pathToVisibleRoot(indexes: ProjectionIndexes, collectionId: string): ReadonlySet<string> {
  const path = new Set<string>();
  let current = indexes.collections.get(collectionId);
  while (current !== undefined && !path.has(current.collectionId)) {
    path.add(current.collectionId);
    current = current.parentCollectionId === null
      ? undefined
      : indexes.collections.get(current.parentCollectionId);
  }
  return path;
}

function pathToScopeRoot(
  indexes: ProjectionIndexes,
  scope: StructuralScope,
  collectionId: string,
): ReadonlySet<string> {
  const path = new Set<string>();
  let current = indexes.collections.get(collectionId);
  while (current !== undefined
    && scope.collectionIds.has(current.collectionId)
    && !path.has(current.collectionId)) {
    path.add(current.collectionId);
    current = current.parentCollectionId === null
      ? undefined
      : indexes.collections.get(current.parentCollectionId);
  }
  return path;
}

function projectGraph(
  indexes: ProjectionIndexes,
  scope: StructuralScope,
  query: KnowledgeGraphQuery,
): { readonly nodes: KnowledgeGraphNode[]; readonly edges: KnowledgeGraphEdge[] } {
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  const includes = new Set(query.include);

  for (const collectionId of scope.collectionIds) {
    const collection = indexes.collections.get(collectionId);
    if (collection === undefined) continue;
    addNode(nodes, {
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
    addNode(nodes, {
      data: {
        id: UNFILED_NODE_ID,
        type: "collection",
        label: "Unfiled",
        description: "",
        revision: 0,
      },
    });
  }
  for (const itemId of scope.itemIds) {
    const item = indexes.knowledgeItems.get(itemId);
    if (item === undefined) continue;
    addNode(nodes, {
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

  addStructuralEdges(indexes, scope, nodes, edges);

  for (const itemId of scope.itemIds) {
    if (includes.has("tags")) {
      for (const relation of indexes.knowledgeTagsByItem.get(itemId) ?? []) {
        const tag = indexes.tags.get(relation.tagId);
        if (tag === undefined) continue;
        addNode(nodes, {
          data: {
            id: tagNodeId(tag.tagId),
            type: "tag",
            label: tag.name,
            description: tag.description,
          },
        });
        addClosedEdge(nodes, edges, edge("TAGGED_WITH", itemNodeId(itemId), tagNodeId(tag.tagId)));
      }
    }

    const includedLocations = (indexes.locationsByItem.get(itemId) ?? []).filter((location) => (
      includes.has("locations")
      || (includes.has("connectors") && location.connectorInstanceId !== null)
    ));
    for (const location of includedLocations) {
      addNode(nodes, locationNode(location));
      addClosedEdge(nodes, edges, edge(
        "HAS_LOCATION",
        itemNodeId(itemId),
        locationNodeId(location.locationId),
      ));
    }

    if (includes.has("versions")) {
      for (const version of indexes.currentVersionsByItem.get(itemId) ?? []) {
        addNode(nodes, {
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
        addClosedEdge(nodes, edges, edge(
          "CURRENT_VERSION",
          itemNodeId(itemId),
          versionNodeId(version.versionId),
        ));
      }
    }

    if (includes.has("principals")) {
      const item = indexes.knowledgeItems.get(itemId);
      const owner = item === undefined ? undefined : indexes.principals.get(item.ownerPrincipalId);
      if (owner !== undefined) {
        addNode(nodes, principalNode(owner));
        addClosedEdge(nodes, edges, edge(
          "OWNED_BY",
          itemNodeId(itemId),
          principalNodeId(owner.id),
        ));
      }
      for (const share of indexes.sharesByItem.get(itemId) ?? []) {
        const principal = indexes.principals.get(share.principalId);
        if (principal === undefined) continue;
        addNode(nodes, principalNode(principal));
        addClosedEdge(nodes, edges, edge(
          "SHARED_WITH",
          itemNodeId(itemId),
          principalNodeId(principal.id),
        ));
      }
      for (const location of includedLocations) {
        const principal = indexes.principals.get(location.ownerPrincipalId);
        if (principal === undefined) continue;
        addNode(nodes, principalNode(principal));
        addClosedEdge(nodes, edges, edge(
          "OWNED_BY",
          locationNodeId(location.locationId),
          principalNodeId(principal.id),
        ));
      }
    }

    if (includes.has("connectors")) {
      for (const location of includedLocations) {
        if (location.connectorInstanceId === null) continue;
        const connector = indexes.connectors.get(location.connectorInstanceId);
        if (connector === undefined) continue;
        addNode(nodes, {
          data: {
            id: connectorNodeId(connector.id),
            type: "connector",
            label: connector.displayName,
            connectorType: connector.type,
            status: connector.status,
          },
        });
        addClosedEdge(nodes, edges, edge(
          "PROVIDED_BY",
          locationNodeId(location.locationId),
          connectorNodeId(connector.id),
        ));
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function addStructuralEdges(
  indexes: ProjectionIndexes,
  scope: StructuralScope,
  nodes: ReadonlyMap<string, KnowledgeGraphNode>,
  edges: Map<string, KnowledgeGraphEdge>,
): void {
  for (const collectionId of scope.collectionIds) {
    const collection = indexes.collections.get(collectionId);
    if (collection?.parentCollectionId === null || collection === undefined) continue;
    if (!scope.collectionIds.has(collection.parentCollectionId)) continue;
    addClosedEdge(nodes, edges, containmentEdge(
      collectionNodeId(collection.parentCollectionId),
      collectionNodeId(collection.collectionId),
    ));
  }
  for (const itemId of scope.itemIds) {
    const placement = indexes.placements.get(itemId);
    if (placement !== undefined && scope.collectionIds.has(placement.collectionId)) {
      addClosedEdge(nodes, edges, placementEdge(
        collectionNodeId(placement.collectionId),
        itemNodeId(itemId),
        placement.revision,
      ));
    } else if (placement === undefined && scope.includeUnfiled) {
      addClosedEdge(nodes, edges, containmentEdge(UNFILED_NODE_ID, itemNodeId(itemId)));
    }
  }
}

function locationNode(location: AuthorizedGraphLocationRow): KnowledgeGraphNode {
  return {
    data: {
      id: locationNodeId(location.locationId),
      type: "location",
      label: `${location.kind} (${location.role})`,
      kind: location.kind,
      role: location.role,
      availability: location.availability,
      lastVerifiedAt: location.lastVerifiedAt,
    },
  };
}

function principalNode(principal: AuthorizedGraphPrincipalRow): KnowledgeGraphNode {
  return {
    data: {
      id: principalNodeId(principal.id),
      type: "principal",
      label: principal.displayName,
      principalType: principal.type,
    },
  };
}

function addNode(nodes: Map<string, KnowledgeGraphNode>, node: KnowledgeGraphNode): void {
  nodes.set(node.data.id, node);
}

function addClosedEdge(
  nodes: ReadonlyMap<string, KnowledgeGraphNode>,
  edges: Map<string, KnowledgeGraphEdge>,
  relation: KnowledgeGraphEdge,
): void {
  if (nodes.has(relation.data.source) && nodes.has(relation.data.target)) {
    edges.set(relation.data.id, relation);
  }
}

function edge(
  type: Exclude<KnowledgeGraphEdge["data"]["type"], "CONTAINS">,
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

function containmentEdge(source: string, target: string): KnowledgeGraphEdge {
  return {
    data: {
      id: `edge:${sha256Canonical({ type: "CONTAINS", source, target }).slice("sha256:".length)}`,
      source,
      target,
      type: "CONTAINS",
    },
  };
}

function placementEdge(
  source: string,
  target: string,
  placementRevision: number,
): KnowledgeGraphEdge {
  return {
    data: {
      id: `edge:${sha256Canonical({ type: "CONTAINS", source, target }).slice("sha256:".length)}`,
      source,
      target,
      type: "CONTAINS",
      placementRevision,
    },
  };
}

function groupRows<T>(rows: readonly T[], key: (row: T) => string): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) appendGrouped(grouped, key(row), row);
  return grouped;
}

function appendGrouped<T>(grouped: Map<string, T[]>, key: string, value: T): void {
  const values = grouped.get(key) ?? [];
  values.push(value);
  grouped.set(key, values);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
