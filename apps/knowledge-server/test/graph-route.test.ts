import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { PostgresKnowledgeStore } from "@openlifewiki/adapters";
import { KnowledgeGraphError, sha256Canonical } from "@openlifewiki/core";
import type {
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  Principal,
} from "@openlifewiki/protocol";
import express from "express";
import { describe, expect, it } from "vitest";

import { createBearerAuthentication } from "../src/authentication.js";
import { readServerConfig } from "../src/config.js";
import {
  createGraphCorsMiddleware,
  createGraphHandler,
  parseGraphHttpQuery,
  type GraphRequestLog,
} from "../src/graph-route.js";

const NOW = new Date("2026-08-17T04:00:00.000Z");

describe("graph HTTP configuration", () => {
  it("defaults a missing or empty graph origin allow-list to empty", () => {
    expect(readServerConfig(testEnvironment()).graphAllowedOrigins).toEqual([]);
    expect(readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "",
    }).graphAllowedOrigins).toEqual([]);
  });

  it("accepts canonical HTTPS and loopback HTTP origins in configured order", () => {
    expect(readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS:
        "https://graph.example,http://127.0.0.1:5173,http://localhost:3000,http://[::1]:8080",
    }).graphAllowedOrigins).toEqual([
      "https://graph.example",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      "http://[::1]:8080",
    ]);
  });

  it.each([
    "*",
    "not-an-origin",
    "https://user:password@graph.example",
    "http://graph.example",
    "https://graph.example/path",
    "https://graph.example?query=yes",
    "https://graph.example#fragment",
    "https://graph.example,https://graph.example",
    "https://graph.example,",
  ])("rejects an unsafe or non-exact graph origin list: %s", (value) => {
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: value,
    })).toThrow();
  });
});

describe("graph HTTP query parsing", () => {
  it("returns the canonical defaults", () => {
    expect(parseGraphHttpQuery(new URLSearchParams())).toEqual({
      root: null,
      depth: 2,
      include: ["tags"],
      limit: 500,
      cursor: null,
    });
  });

  it("parses a complete query independently of parameter and include ordering", () => {
    expect(parseGraphHttpQuery(new URLSearchParams(
      "limit=100&include=versions%2Ctags&root=collection%3Acollection_1&depth=2",
    ))).toEqual({
      root: { type: "collection", id: "collection_1" },
      depth: 2,
      include: ["tags", "versions"],
      limit: 100,
      cursor: null,
    });
    expect(parseGraphHttpQuery(new URLSearchParams("root=item%3Aitem_1"))).toMatchObject({
      root: { type: "knowledge", id: "item_1" },
    });
  });

  it.each([
    "depth=2&depth=3",
    "include=tags&include=versions",
    "include=tags,tags",
    "include=",
    "include=unknown",
    "depth=2.0",
    "depth=-1",
    "depth=5",
    "limit=0",
    "limit=501",
    "root=collection%3A",
    "root=unknown%3Aitem_1",
    "root=item%3Acontains%20space",
    "cursor=malformed-cursor",
    "cursor=",
    "unexpected=value",
  ])("rejects invalid input with GRAPH_INVALID_QUERY: %s", (value) => {
    expect(() => parseGraphHttpQuery(new URLSearchParams(value))).toThrow(
      expect.objectContaining({ code: "GRAPH_INVALID_QUERY" }),
    );
  });
});

describe("graph CORS middleware", () => {
  it("returns an exact allowed origin and handles preflight before authentication", async () => {
    const app = express();
    let authenticationCalls = 0;
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      ["https://graph.example", "http://127.0.0.1:5173"],
      { logger: () => undefined },
    ));
    app.use(() => { authenticationCalls += 1; });
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://graph.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, If-None-Match",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://graph.example");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Accept, If-None-Match",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
      expect(authenticationCalls).toBe(0);
      expect(await response.text()).toBe("");
    } finally {
      await server.close();
    }
  });

  it("omits allow-origin for unknown origins and does not affect other routes", async () => {
    const app = express();
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      ["https://graph.example"],
      { logger: () => undefined },
    ));
    app.get("/api/v1/graph", (_request, response) => response.status(200).send({ ok: true }));
    app.get("/other", (_request, response) => response.status(200).send({ ok: true }));
    const server = await startTestServer(app);
    try {
      const graph = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Origin: "https://other.example" },
      });
      expect(graph.headers.get("access-control-allow-origin")).toBeNull();
      expect(varyValues(graph)).toEqual(["Authorization", "Origin"]);

      const other = await fetch(`${server.url}/other`, {
        headers: { Origin: "https://graph.example" },
      });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
      expect(other.headers.get("vary")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("rejects non-read methods before downstream authentication or JSON-RPC handling", async () => {
    const app = express();
    let downstreamCalls = 0;
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      ["https://graph.example"],
      { logger: () => undefined },
    ));
    app.use((_request, response) => {
      downstreamCalls += 1;
      response.status(418).end();
    });
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        method: "POST",
        headers: { Origin: "https://graph.example" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, OPTIONS");
      expect(await response.text()).toBe("");
      expect(downstreamCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("graph HTTP handler", () => {
  it("projects an authenticated user query with stable cache metadata and safe logging", async () => {
    const principal = testPrincipal("user");
    const calls: Array<{
      readonly principal: Principal;
      readonly query: KnowledgeGraphQuery;
      readonly now: Date;
    }> = [];
    const logs: GraphRequestLog[] = [];
    const projection = {
      async read(input: typeof calls[number]): Promise<KnowledgeGraphResponse> {
        calls.push(input);
        return graphResponse(7);
      },
    };
    const server = await startGraphTestServer({ principal, projection, logs });
    try {
      const response = await fetch(
        `${server.url}/api/v1/graph?limit=100&include=versions%2Ctags&depth=2`,
        {
          headers: {
            Authorization: "Bearer unit-user-token",
            Origin: "https://graph.example",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json\b/u);
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://graph.example");
      expect(response.headers.get("x-request-id")).toBe("request-unit-1");
      expect(response.headers.get("etag")).toMatch(/^"sha256:[a-f0-9]{64}"$/u);
      expect(await response.json()).toEqual(graphResponse(7));
      expect(calls).toEqual([{
        principal,
        query: {
          root: null,
          depth: 2,
          include: ["tags", "versions"],
          limit: 100,
          cursor: null,
        },
        now: NOW,
      }]);
      expect(logs).toEqual([{
        event: "knowledge_graph_http_request",
        requestId: "request-unit-1",
        orgId: principal.orgId,
        principalIdHash: `sha256:${createHash("sha256").update(principal.principalId).digest("hex")}`,
        queryHash: sha256Canonical(calls[0]!.query),
        registryRevision: 7,
        nodeCount: 1,
        edgeCount: 0,
        durationMs: 7,
        status: 200,
        errorCode: null,
      }]);
    } finally {
      await server.close();
    }
  });

  it("uses canonical query ETags and returns an empty 304 only for an exact match", async () => {
    const principal = testPrincipal("user");
    let projectionCalls = 0;
    const projection = {
      async read(): Promise<KnowledgeGraphResponse> {
        projectionCalls += 1;
        return graphResponse(11);
      },
    };
    const server = await startGraphTestServer({ principal, projection });
    try {
      const first = await fetch(
        `${server.url}/api/v1/graph?include=versions%2Ctags&limit=100&depth=2`,
        { headers: { Authorization: "Bearer unit-user-token" } },
      );
      const etag = first.headers.get("etag");
      expect(etag).not.toBeNull();
      expect(first.status).toBe(200);

      const notModified = await fetch(
        `${server.url}/api/v1/graph?depth=2&limit=100&include=tags%2Cversions`,
        { headers: { Authorization: "Bearer unit-user-token", "If-None-Match": etag! } },
      );
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("etag")).toBe(etag);
      expect(notModified.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(varyValues(notModified)).toEqual(["Authorization", "Origin"]);
      expect(notModified.headers.get("x-request-id")).toBe("request-unit-2");
      expect(await notModified.text()).toBe("");

      const nonExact = await fetch(
        `${server.url}/api/v1/graph?include=tags%2Cversions&limit=100&depth=2`,
        { headers: { Authorization: "Bearer unit-user-token", "If-None-Match": `${etag}, "other"` } },
      );
      expect(nonExact.status).toBe(200);
      expect(projectionCalls).toBe(3);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["agent", "GRAPH_PRINCIPAL_NOT_SUPPORTED", 403],
    ["relay", "GRAPH_PRINCIPAL_NOT_SUPPORTED", 403],
  ] as const)("rejects an authenticated %s principal", async (type, code, status) => {
    let projectionCalls = 0;
    const server = await startGraphTestServer({
      principal: testPrincipal(type),
      projection: { async read() { projectionCalls += 1; return graphResponse(1); } },
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: {
          code,
          message: "Knowledge graph reads support user principals only.",
          requestId: "request-unit-1",
        },
      });
      expect(projectionCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it.each([
    [new KnowledgeGraphError("GRAPH_FORBIDDEN", "unsafe"), 403, "GRAPH_FORBIDDEN",
      "The principal is not authorized to read the knowledge graph."],
    [new KnowledgeGraphError("GRAPH_ROOT_NOT_FOUND", "unsafe"), 404, "GRAPH_ROOT_NOT_FOUND",
      "The requested knowledge graph root was not found."],
    [new KnowledgeGraphError("GRAPH_SNAPSHOT_EXPIRED", "unsafe"), 409, "GRAPH_SNAPSHOT_EXPIRED",
      "The knowledge graph snapshot has expired."],
    [new KnowledgeGraphError("GRAPH_INVALID_PROJECTION", "unsafe"), 503, "GRAPH_UNAVAILABLE",
      "The knowledge graph is temporarily unavailable."],
    [new Error("select hidden_table /Users/private token-prefix"), 503, "GRAPH_UNAVAILABLE",
      "The knowledge graph is temporarily unavailable."],
  ] as const)("maps a projection failure to safe HTTP error %s", async (failure, status, code, message) => {
    const logs: GraphRequestLog[] = [];
    const server = await startGraphTestServer({
      principal: testPrincipal("user"),
      projection: { async read() { throw failure; } },
      logs,
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(JSON.parse(body)).toEqual({
        error: { code, message, requestId: "request-unit-1" },
      });
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
      expect(body).not.toContain("hidden_table");
      expect(body).not.toContain("/Users/private");
      expect(body).not.toContain("token-prefix");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.errorCode).toBe(code);
      expect(Object.keys(logs[0] ?? {}).sort()).toEqual([
        "durationMs",
        "edgeCount",
        "errorCode",
        "event",
        "nodeCount",
        "orgId",
        "principalIdHash",
        "queryHash",
        "registryRevision",
        "requestId",
        "status",
      ]);
      expect(JSON.stringify(logs)).not.toContain("hidden_table");
      expect(JSON.stringify(logs)).not.toContain("/Users/private");
      expect(JSON.stringify(logs)).not.toContain("token-prefix");
    } finally {
      await server.close();
    }
  });

  it("returns the existing 401 envelope with graph response metadata before authentication", async () => {
    const logs: GraphRequestLog[] = [];
    const server = await startGraphTestServer({
      principal: null,
      projection: { async read() { return graphResponse(1); } },
      logs,
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph`);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "unauthorized",
        requestId: "request-unit-1",
      });
      expect(response.headers.get("x-request-id")).toBe("request-unit-1");
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
      expect(logs).toEqual([expect.objectContaining({
        requestId: "request-unit-1",
        orgId: null,
        principalIdHash: null,
        queryHash: null,
        registryRevision: null,
        nodeCount: null,
        edgeCount: null,
        status: 401,
        errorCode: null,
      })]);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed queries without calling the projection", async () => {
    let projectionCalls = 0;
    const server = await startGraphTestServer({
      principal: testPrincipal("user"),
      projection: { async read() { projectionCalls += 1; return graphResponse(1); } },
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph?depth=5`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "GRAPH_INVALID_QUERY",
          message: "The graph query is invalid.",
          requestId: "request-unit-1",
        },
      });
      expect(projectionCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://test.invalid/openlifewiki_test",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET: "unit-test-token-secret-with-at-least-32-bytes",
    OPENLIFEWIKI_MODEL: "gpt-5.5",
    OPENLIFEWIKI_PUBLIC_URL: "http://127.0.0.1:0",
    OPENAI_API_KEY: "unit-test-api-key",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    PORT: "0",
  };
}

async function startTestServer(app: express.Express): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

async function startGraphTestServer(input: {
  readonly principal: Principal | null;
  readonly projection: {
    read(input: {
      readonly principal: Principal;
      readonly query: KnowledgeGraphQuery;
      readonly now: Date;
    }): Promise<KnowledgeGraphResponse>;
  };
  readonly logs?: GraphRequestLog[];
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const app = express();
  let requestNumber = 0;
  let monotonic = 93;
  app.use("/api/v1/graph", createGraphCorsMiddleware(["https://graph.example"], {
    logger: (entry) => input.logs?.push(entry),
    requestId: () => `request-unit-${++requestNumber}`,
    monotonicNow: () => {
      monotonic += 7;
      return monotonic;
    },
  }));
  app.use(createBearerAuthentication({
    store: {
      async authenticate() { return input.principal; },
    } as unknown as PostgresKnowledgeStore,
    now: () => NOW,
  }));
  app.get("/api/v1/graph", createGraphHandler({ projection: input.projection, now: () => NOW }));
  return await startTestServer(app);
}

function graphResponse(registryRevision: number): KnowledgeGraphResponse {
  return {
    schema: "cowikiharness.graph/v1",
    registryRevision,
    generatedAt: NOW.toISOString(),
    elements: {
      nodes: [{
        data: {
          id: "collection:root",
          type: "collection",
          label: "Root",
          description: "",
          revision: 1,
        },
      }],
      edges: [],
    },
    truncated: false,
    nextCursor: null,
  };
}

function testPrincipal(type: Principal["type"]): Principal {
  return {
    schema: "openlifewiki.principal/v1",
    principalId: `principal_${type}`,
    orgId: "org_unit",
    type,
    displayName: `Test ${type}`,
    organizationRole: type === "user" ? "member" : null,
    capabilities: ["knowledge.query"],
    status: "active",
  };
}

function varyValues(response: Response): string[] {
  return (response.headers.get("vary") ?? "").split(",").map((value) => value.trim()).sort();
}
