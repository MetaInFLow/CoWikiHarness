import { describe, expect, it } from "vitest";

import {
  knowledgeGraphResponseSchema,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeGraphQuery,
  type Principal,
} from "@openlifewiki/protocol";

import {
  KnowledgeGraphError,
  KnowledgeGraphProjectionService,
  type KnowledgeGraphPage,
  type KnowledgeGraphReadPort,
} from "../src/index.js";

const NOW = new Date("2026-08-16T00:00:00.000Z");

const query = {
  root: null,
  depth: 1,
  include: ["tags"],
  limit: 100,
  cursor: null,
} as const satisfies KnowledgeGraphQuery;

const knowledgeNode = {
  data: {
    id: "item:item_a",
    type: "knowledge",
    label: "Architecture",
    status: "stable",
    revision: 3,
    updatedAt: NOW.toISOString(),
  },
} as const satisfies KnowledgeGraphNode;

const tagNode = {
  data: {
    id: "tag:tag_z",
    type: "tag",
    label: "architecture",
    description: "Architecture knowledge",
  },
} as const satisfies KnowledgeGraphNode;

const principalNode = {
  data: {
    id: "principal:principal_owner",
    type: "principal",
    label: "Owner",
    principalType: "user",
  },
} as const satisfies KnowledgeGraphNode;

const taggedEdge = {
  data: {
    id: "edge:tagged",
    source: "item:item_a",
    target: "tag:tag_z",
    type: "TAGGED_WITH",
  },
} as const satisfies KnowledgeGraphEdge;

class FakeReadPort implements KnowledgeGraphReadPort {
  readonly calls: Array<{
    principal: Principal;
    query: KnowledgeGraphQuery;
    now: Date;
  }> = [];

  constructor(private readonly page: KnowledgeGraphPage) {}

  async readAuthorizedGraph(input: {
    principal: Principal;
    query: KnowledgeGraphQuery;
    now: Date;
  }): Promise<KnowledgeGraphPage> {
    this.calls.push(input);
    return this.page;
  }
}

describe("KnowledgeGraphProjectionService", () => {
  it("projects an authorized page deterministically and preserves the exact read inputs", async () => {
    const nodes: KnowledgeGraphNode[] = [tagNode, knowledgeNode];
    const edges: KnowledgeGraphEdge[] = [taggedEdge];
    const port = new FakeReadPort(page({ nodes, edges }));
    const service = new KnowledgeGraphProjectionService(port);
    const activeUser = principal();

    const result = await service.read({ principal: activeUser, query, now: NOW });

    expect(result.elements.nodes.map((node) => node.data.id)).toEqual([
      "item:item_a",
      "tag:tag_z",
    ]);
    expect(result.generatedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.principal).toBe(activeUser);
    expect(port.calls[0]?.query).toBe(query);
    expect(port.calls[0]?.now).toBe(NOW);
  });

  it("sorts nodes and edges by type then ID without mutating the port arrays", async () => {
    const secondTaggedEdge = {
      data: { ...taggedEdge.data, id: "edge:tagged_a" },
    } as const satisfies KnowledgeGraphEdge;
    const firstTaggedEdge = {
      data: { ...taggedEdge.data, id: "edge:tagged_z" },
    } as const satisfies KnowledgeGraphEdge;
    const sharedEdge = {
      data: {
        id: "edge:shared_m",
        source: "item:item_a",
        target: "principal:principal_owner",
        type: "SHARED_WITH",
      },
    } as const satisfies KnowledgeGraphEdge;
    const nodes: KnowledgeGraphNode[] = [tagNode, principalNode, knowledgeNode];
    const edges: KnowledgeGraphEdge[] = [firstTaggedEdge, sharedEdge, secondTaggedEdge];
    const originalNodeIds = nodes.map((node) => node.data.id);
    const originalEdgeIds = edges.map((edge) => edge.data.id);
    const service = new KnowledgeGraphProjectionService(new FakeReadPort(page({ nodes, edges })));

    const result = await service.read({ principal: principal(), query, now: NOW });

    expect(result.elements.nodes.map((node) => node.data.id)).toEqual([
      "item:item_a",
      "principal:principal_owner",
      "tag:tag_z",
    ]);
    expect(result.elements.edges.map((edge) => edge.data.id)).toEqual([
      "edge:shared_m",
      "edge:tagged_a",
      "edge:tagged_z",
    ]);
    expect(nodes.map((node) => node.data.id)).toEqual(originalNodeIds);
    expect(edges.map((edge) => edge.data.id)).toEqual(originalEdgeIds);
  });

  it("uses code-unit ordering for mixed-case node and edge IDs", async () => {
    const lowercaseNode = {
      data: { ...knowledgeNode.data, id: "item:a", label: "Lowercase" },
    } as const satisfies KnowledgeGraphNode;
    const uppercaseNode = {
      data: { ...knowledgeNode.data, id: "item:B", label: "Uppercase" },
    } as const satisfies KnowledgeGraphNode;
    const lowercaseEdge = {
      data: {
        ...taggedEdge.data,
        id: "edge:a",
        source: "item:a",
      },
    } as const satisfies KnowledgeGraphEdge;
    const uppercaseEdge = {
      data: {
        ...taggedEdge.data,
        id: "edge:B",
        source: "item:B",
      },
    } as const satisfies KnowledgeGraphEdge;
    const port = new FakeReadPort(page({
      nodes: [lowercaseNode, tagNode, uppercaseNode],
      edges: [lowercaseEdge, uppercaseEdge],
    }));

    const result = await new KnowledgeGraphProjectionService(port).read({
      principal: principal(),
      query,
      now: NOW,
    });

    expect(result.elements.nodes.map((node) => node.data.id)).toEqual([
      "item:B",
      "item:a",
      "tag:tag_z",
    ]);
    expect(result.elements.edges.map((edge) => edge.data.id)).toEqual([
      "edge:B",
      "edge:a",
    ]);
  });

  it("projects a node derived from a legal 256-character registry ID", async () => {
    const registryId = `r${"a".repeat(255)}`;
    const longNode = {
      data: { ...knowledgeNode.data, id: `item:${registryId}`, label: "Long registry ID" },
    } as const satisfies KnowledgeGraphNode;
    const service = new KnowledgeGraphProjectionService(new FakeReadPort(page({
      nodes: [longNode],
    })));

    const result = await service.read({ principal: principal(), query, now: NOW });

    expect(result.elements.nodes).toEqual([longNode]);
  });

  it("rejects an edge whose source or target is absent", async () => {
    const port = new FakeReadPort(page({ nodes: [knowledgeNode], edges: [taggedEdge] }));

    await expectGraphError(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
      "GRAPH_INVALID_PROJECTION",
    );
  });

  it("rejects duplicate node IDs", async () => {
    const port = new FakeReadPort(page({ nodes: [knowledgeNode, knowledgeNode] }));

    await expectGraphError(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
      "GRAPH_INVALID_PROJECTION",
    );
  });

  it("rejects duplicate edge IDs", async () => {
    const port = new FakeReadPort(page({
      nodes: [knowledgeNode, tagNode],
      edges: [taggedEdge, taggedEdge],
    }));

    await expectGraphError(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
      "GRAPH_INVALID_PROJECTION",
    );
  });

  it.each([
    ["agent", principal({ type: "agent" }), "GRAPH_PRINCIPAL_NOT_SUPPORTED"],
    ["relay", principal({ type: "relay" }), "GRAPH_PRINCIPAL_NOT_SUPPORTED"],
    ["revoked user", principal({ status: "revoked" }), "GRAPH_FORBIDDEN"],
  ] as const)("fails closed for an %s before calling the port", async (_name, actor, code) => {
    const port = new FakeReadPort(page());

    await expectGraphError(
      new KnowledgeGraphProjectionService(port).read({ principal: actor, query, now: NOW }),
      code,
    );
    expect(port.calls).toHaveLength(0);
  });

  it("maps an invalid port payload to a non-leaking projection error", async () => {
    const invalidConnector = {
      data: {
        id: "connector:connector_1",
        type: "connector",
        label: "GitHub",
        connectorType: "github",
        status: "token_live_sensitive",
      },
    } as unknown as KnowledgeGraphNode;
    const port = new FakeReadPort(page({ nodes: [invalidConnector] }));

    await expect(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
    ).rejects.toMatchObject({
      name: "KnowledgeGraphError",
      code: "GRAPH_INVALID_PROJECTION",
      message: "Knowledge graph projection is invalid.",
    });
  });

  it("maps a malformed node wrapper to an invalid projection error", async () => {
    const malformedPage = page({
      nodes: [null as unknown as KnowledgeGraphNode],
    });

    await expect(
      new KnowledgeGraphProjectionService(new FakeReadPort(malformedPage)).read({
        principal: principal(),
        query,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      name: "KnowledgeGraphError",
      code: "GRAPH_INVALID_PROJECTION",
      message: "Knowledge graph projection is invalid.",
    });
  });

  it("preserves a ZodError thrown directly by the port", async () => {
    const invalidResponse = knowledgeGraphResponseSchema.safeParse({});
    if (invalidResponse.success) {
      throw new Error("Expected an invalid graph response fixture.");
    }
    const portError = invalidResponse.error;

    await expect(
      new KnowledgeGraphProjectionService(throwingPort(portError)).read({
        principal: principal(),
        query,
        now: NOW,
      }),
    ).rejects.toBe(portError);
  });

  it("preserves a KnowledgeGraphError thrown by the port", async () => {
    const portError = new KnowledgeGraphError("GRAPH_UNAVAILABLE", "Graph storage unavailable.");
    const port = throwingPort(portError);

    await expect(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
    ).rejects.toBe(portError);
  });

  it("preserves an unknown infrastructure error thrown by the port", async () => {
    const portError = new Error("Database connection failed.");
    const port = throwingPort(portError);

    await expect(
      new KnowledgeGraphProjectionService(port).read({ principal: principal(), query, now: NOW }),
    ).rejects.toBe(portError);
  });

  it("passes through a valid truncation cursor", async () => {
    const port = new FakeReadPort(page({ truncated: true, nextCursor: "graph-page-2" }));

    const result = await new KnowledgeGraphProjectionService(port).read({
      principal: principal(),
      query,
      now: NOW,
    });

    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("graph-page-2");
  });
});

function page(overrides: Partial<KnowledgeGraphPage> = {}): KnowledgeGraphPage {
  return {
    registryRevision: 7,
    nodes: [],
    edges: [],
    truncated: false,
    nextCursor: null,
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    schema: "openlifewiki.principal/v1",
    principalId: "principal_user_1",
    orgId: "org_default",
    type: "user",
    displayName: "User One",
    organizationRole: "member",
    capabilities: [],
    status: "active",
    ...overrides,
  };
}

function throwingPort(error: unknown): KnowledgeGraphReadPort {
  return {
    async readAuthorizedGraph(): Promise<KnowledgeGraphPage> {
      throw error;
    },
  };
}

async function expectGraphError(
  promise: Promise<unknown>,
  code: InstanceType<typeof KnowledgeGraphError>["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "KnowledgeGraphError",
    code,
  });
}
