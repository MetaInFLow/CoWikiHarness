import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { PostgresKnowledgeStore } from "@openlifewiki/adapters";
import { KnowledgeGraphError, sha256Canonical } from "@openlifewiki/core";
import {
  knowledgeGraphResponseSchema,
  type KnowledgeGraphQuery,
  type KnowledgeGraphResponse,
  type Principal,
} from "@openlifewiki/protocol";
import express from "express";
import { describe, expect, it } from "vitest";

import { createBearerAuthentication } from "../src/authentication.js";
import { readServerConfig } from "../src/config.js";
import {
  createGraphCorsMiddleware,
  createGraphHandler,
  handleGraphAuthenticationFailure,
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
    "https://*",
    "https://*.example.com",
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

  it.each([
    ["GET", "/api/v1/graph/child"],
    ["POST", "/api/v1/graph/child"],
    ["OPTIONS", "/api/v1/graph/child"],
    ["HEAD", "/api/v1/graph/child"],
    ["GET", "/api/v1/graph/"],
    ["POST", "/api/v1/graph/"],
    ["OPTIONS", "/api/v1/graph/"],
    ["HEAD", "/api/v1/graph/"],
  ] as const)("does not apply graph behavior to %s %s", async (method, path) => {
    const logs: GraphRequestLog[] = [];
    const app = express();
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      ["https://graph.example"],
      { logger: (entry) => logs.push(entry) },
    ));
    app.use((_request, response) => response.status(418).end());
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { Origin: "https://graph.example" },
      });
      expect(response.status).toBe(418);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("cache-control")).toBeNull();
      expect(response.headers.get("x-request-id")).toBeNull();
      expect(response.headers.get("vary")).toBeNull();
      expect(logs).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("graph HTTP handler", () => {
  it("returns a strict placement revision that HTTP clients can consume", async () => {
    let placementRevision = 7;
    const server = await startGraphTestServer({
      principal: testPrincipal("user"),
      projection: { async read() { return placementGraphResponse(9, placementRevision++); } },
    });
    try {
      const firstResponse = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      const firstGraph = knowledgeGraphResponseSchema.parse(await firstResponse.json());
      const secondResponse = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      const secondGraph = knowledgeGraphResponseSchema.parse(await secondResponse.json());

      expect(firstResponse.status).toBe(200);
      expect(firstGraph.elements.edges[0]?.data).toMatchObject({
        type: "CONTAINS",
        placementRevision: 7,
      });
      expect(secondGraph.elements.edges[0]?.data).toMatchObject({
        type: "CONTAINS",
        placementRevision: 8,
      });
      expect(secondResponse.headers.get("etag")).not.toBe(firstResponse.headers.get("etag"));
    } finally {
      await server.close();
    }
  });

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
      expect(response.headers.get("etag")).toMatch(/^W\/"sha256:[a-f0-9]{64}"$/u);
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

  it("uses canonical query ETags and applies weak If-None-Match comparison", async () => {
    const principal = testPrincipal("user");
    let projectionCalls = 0;
    const projection = {
      async read(): Promise<KnowledgeGraphResponse> {
        projectionCalls += 1;
        return {
          ...graphResponse(11),
          generatedAt: new Date(NOW.getTime() + projectionCalls * 1_000).toISOString(),
        };
      },
    };
    const server = await startGraphTestServer({ principal, projection });
    try {
      const first = await fetch(
        `${server.url}/api/v1/graph?include=versions%2Ctags&limit=100&depth=2`,
        { headers: { Authorization: "Bearer unit-user-token" } },
      );
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^W\/"sha256:[a-f0-9]{64}"$/u);
      expect(first.status).toBe(200);

      const strongEquivalent = etag!.slice(2);
      const cases = [
        ["exact weak tag", etag!, 304],
        ["strong equivalent", strongEquivalent, 304],
        ["matching tag in a list", `"other", ${etag}`, 304],
        ["wildcard", "*", 304],
        ["non-matching tag", 'W/"other"', 200],
        ["comma inside a quoted opaque tag", `"opaque,with,commas", ${etag}`, 304],
        ["malformed trailing comma", `${etag},`, 200],
      ] as const;

      for (const [_name, ifNoneMatch, expectedStatus] of cases) {
        const response = await fetch(
          `${server.url}/api/v1/graph?depth=2&limit=100&include=tags%2Cversions`,
          { headers: { Authorization: "Bearer unit-user-token", "If-None-Match": ifNoneMatch } },
        );
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get("etag")).toBe(etag);
        expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
        expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
        if (expectedStatus === 304) expect(await response.text()).toBe("");
      }
      expect(projectionCalls).toBe(1 + cases.length);
    } finally {
      await server.close();
    }
  });

  it("changes the ETag when the authorized representation changes at the same revision", async () => {
    const principal = testPrincipal("user");
    let projectionCalls = 0;
    const projection = {
      async read(): Promise<KnowledgeGraphResponse> {
        projectionCalls += 1;
        const response = graphResponse(11);
        if (projectionCalls === 1) return response;
        return {
          ...response,
          elements: {
            nodes: [],
            edges: [],
          },
        };
      },
    };
    const server = await startGraphTestServer({ principal, projection });
    try {
      const first = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      const firstEtag = first.headers.get("etag");
      expect(first.status).toBe(200);

      const changed = await fetch(`${server.url}/api/v1/graph`, {
        headers: {
          Authorization: "Bearer unit-user-token",
          "If-None-Match": firstEtag!,
        },
      });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(firstEtag);
      expect((await changed.json()).registryRevision).toBe(11);
      expect(projectionCalls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("binds otherwise identical graph ETags to the authenticated principal", async () => {
    const firstServer = await startGraphTestServer({
      principal: testPrincipal("user"),
      projection: { async read() { return graphResponse(11); } },
    });
    const secondServer = await startGraphTestServer({
      principal: { ...testPrincipal("user"), principalId: "principal_other_user" },
      projection: { async read() { return graphResponse(11); } },
    });
    try {
      const [first, second] = await Promise.all([
        fetch(`${firstServer.url}/api/v1/graph`, {
          headers: { Authorization: "Bearer first-user-token" },
        }),
        fetch(`${secondServer.url}/api/v1/graph`, {
          headers: { Authorization: "Bearer second-user-token" },
        }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers.get("etag")).not.toBe(second.headers.get("etag"));
    } finally {
      await firstServer.close();
      await secondServer.close();
    }
  });

  it("does not let Express trailing-slash matching invoke the graph handler", async () => {
    const principal = testPrincipal("user");
    const logs: GraphRequestLog[] = [];
    let projectionCalls = 0;
    const app = express();
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      ["https://graph.example"],
      { logger: (entry) => logs.push(entry) },
    ));
    app.use(createBearerAuthentication({
      store: {
        async authenticate() { return principal; },
      } as unknown as PostgresKnowledgeStore,
      now: () => NOW,
    }));
    app.get("/api/v1/graph", createGraphHandler({
      projection: {
        async read() {
          projectionCalls += 1;
          return graphResponse(1);
        },
      },
      now: () => NOW,
    }));
    app.use((_request, response) => response.status(418).end());
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}/api/v1/graph/`, {
        headers: { Authorization: "Bearer unit-user-token" },
      });
      expect(response.status).toBe(418);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(response.headers.get("x-request-id")).toBeNull();
      expect(response.headers.get("vary")).toBeNull();
      expect(projectionCalls).toBe(0);
      expect(logs).toEqual([]);
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

  it("keeps an invalid bearer token as 401 unauthorized", async () => {
    const logs: GraphRequestLog[] = [];
    const server = await startGraphTestServer({
      principal: null,
      projection: { async read() { return graphResponse(1); } },
      logs,
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer invalid-token" },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "unauthorized",
        requestId: "request-unit-1",
      });
      expect(logs).toEqual([expect.objectContaining({ status: 401, errorCode: null })]);
    } finally {
      await server.close();
    }
  });

  it("maps thrown graph authentication infrastructure failures to one safe 503 log", async () => {
    const logs: GraphRequestLog[] = [];
    let projectionCalls = 0;
    const server = await startGraphTestServer({
      principal: null,
      authenticationError: new Error(
        "select * from principal_tokens at /Users/private token-prefix hidden-title locator",
      ),
      projection: { async read() { projectionCalls += 1; return graphResponse(1); } },
      logs,
    });
    try {
      const response = await fetch(`${server.url}/api/v1/graph`, {
        headers: { Authorization: "Bearer infrastructure-failure-token" },
      });
      const body = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(body)).toEqual({
        error: {
          code: "GRAPH_UNAVAILABLE",
          message: "The knowledge graph is temporarily unavailable.",
          requestId: "request-unit-1",
        },
      });
      expect(response.headers.get("x-request-id")).toBe("request-unit-1");
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(varyValues(response)).toEqual(["Authorization", "Origin"]);
      expect(projectionCalls).toBe(0);
      expect(logs).toEqual([{
        event: "knowledge_graph_http_request",
        requestId: "request-unit-1",
        orgId: null,
        principalIdHash: null,
        queryHash: null,
        registryRevision: null,
        nodeCount: null,
        edgeCount: null,
        durationMs: 7,
        status: 503,
        errorCode: "GRAPH_UNAVAILABLE",
      }]);
      for (const secret of [
        "principal_tokens",
        "/Users/private",
        "token-prefix",
        "hidden-title",
        "locator",
        "infrastructure-failure-token",
      ]) {
        expect(body).not.toContain(secret);
        expect(JSON.stringify(logs)).not.toContain(secret);
      }
    } finally {
      await server.close();
    }
  });

  it("preserves the existing 401 behavior for thrown authentication failures outside graph", async () => {
    const app = express();
    app.use(createBearerAuthentication({
      store: {
        async authenticate() { throw new Error("database unavailable"); },
      } as unknown as PostgresKnowledgeStore,
      now: () => NOW,
      onInfrastructureFailure: handleGraphAuthenticationFailure,
    }));
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}/`, {
        headers: { Authorization: "Bearer infrastructure-failure-token" },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("x-request-id")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it.each(["returns false", "throws"] as const)(
    "does not double-send when an authentication failure callback sends then %s",
    async (behavior) => {
      const app = express();
      let errorMiddlewareCalls = 0;
      app.use(createBearerAuthentication({
        store: {
          async authenticate() { throw new Error("database unavailable"); },
        } as unknown as PostgresKnowledgeStore,
        now: () => NOW,
        onInfrastructureFailure(_request, response) {
          response.status(503).send({ error: "safe infrastructure response" });
          if (behavior === "throws") throw new Error("callback failed after sending");
          return false;
        },
      }));
      const errorHandler: express.ErrorRequestHandler = (_error, _request, response, _next) => {
        errorMiddlewareCalls += 1;
        if (!response.headersSent) response.status(500).end();
      };
      app.use(errorHandler);
      const server = await startTestServer(app);
      try {
        const response = await fetch(`${server.url}/`, {
          headers: { Authorization: "Bearer infrastructure-failure-token" },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "safe infrastructure response" });
        expect(errorMiddlewareCalls).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

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
  readonly authenticationError?: Error;
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
      async authenticate() {
        if (input.authenticationError !== undefined) throw input.authenticationError;
        return input.principal;
      },
    } as unknown as PostgresKnowledgeStore,
    now: () => NOW,
    onInfrastructureFailure: handleGraphAuthenticationFailure,
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

function placementGraphResponse(
  registryRevision: number,
  placementRevision: number,
): KnowledgeGraphResponse {
  return {
    ...graphResponse(registryRevision),
    elements: {
      nodes: [
        ...graphResponse(registryRevision).elements.nodes,
        {
          data: {
            id: "item:item_1",
            type: "knowledge",
            label: "Placed item",
            status: "stable",
            revision: 2,
            updatedAt: NOW.toISOString(),
          },
        },
      ],
      edges: [{
        data: {
          id: "edge:placement",
          source: "collection:root",
          target: "item:item_1",
          type: "CONTAINS",
          placementRevision,
        },
      }],
    },
  } as unknown as KnowledgeGraphResponse;
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
