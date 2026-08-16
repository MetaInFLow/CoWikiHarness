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

import { loadAuthorizedGraphSnapshot } from "./authorized-graph-snapshot.js";
import type { Database } from "./database.js";
import { GraphCursorCodec } from "./graph-cursor.js";
import {
  createKnowledgeGraphBundleContext,
  paginateSeedBundles,
} from "./knowledge-graph-bundles.js";

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
    const queryHash = graphQueryHash(input.query);
    const cursor = input.query.cursor === null
      ? null
      : this.#cursorCodec.decode(input.query.cursor);
    if (cursor !== null && (
      cursor.orgId !== input.principal.orgId
      || cursor.principalId !== input.principal.principalId
      || cursor.queryHash !== queryHash
    )) {
      throw snapshotExpired();
    }

    let snapshot;
    try {
      snapshot = await loadAuthorizedGraphSnapshot(this.database, {
        principal: input.principal,
        now: input.now,
      });
    } catch (error) {
      if (cursor !== null
        && error instanceof KnowledgeGraphError
        && error.code === "GRAPH_FORBIDDEN") {
        throw snapshotExpired();
      }
      throw error;
    }

    const snapshotHash = sha256Canonical(snapshot);
    if (cursor !== null && (
      cursor.registryRevision !== snapshot.registryRevision
      || cursor.snapshotHash !== snapshotHash
    )) {
      throw snapshotExpired();
    }

    const context = createKnowledgeGraphBundleContext(snapshot, input.query);
    if (cursor !== null && !context.seedKeys.includes(cursor.afterSeedKey)) {
      throw snapshotExpired();
    }
    const page = paginateSeedBundles({
      seedKeys: context.seedKeys,
      afterSeedKey: cursor?.afterSeedKey ?? null,
      limit: input.query.limit,
      buildBundle: context.buildBundle,
    });
    const nextCursor = page.truncated && page.lastCompletedSeedKey !== null
      ? this.#cursorCodec.encode({
        version: 1,
        orgId: snapshot.orgId,
        principalId: snapshot.principalId,
        queryHash,
        snapshotHash,
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

function graphQueryHash(query: KnowledgeGraphQuery): string {
  return sha256Canonical({
    root: query.root,
    depth: query.depth,
    include: query.include,
    limit: query.limit,
  });
}

function snapshotExpired(): KnowledgeGraphError {
  return new KnowledgeGraphError(
    "GRAPH_SNAPSHOT_EXPIRED",
    "The knowledge graph snapshot has expired.",
  );
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
