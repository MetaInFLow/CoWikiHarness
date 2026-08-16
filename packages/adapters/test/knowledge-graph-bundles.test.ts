import type { KnowledgeGraphNode } from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import {
  paginateSeedBundles,
  uniqueSortedSeedKeys,
} from "../src/postgres/knowledge-graph-bundles.js";

describe("incremental knowledge graph bundles", () => {
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
