import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  KnowledgeGraphError,
  sha256Canonical,
  type KnowledgeGraphProjectionService,
} from "@openlifewiki/core";
import {
  KNOWLEDGE_GRAPH_INCLUDES,
  knowledgeGraphQuerySchema,
  type KnowledgeGraphErrorCode,
  type KnowledgeGraphQuery,
  type Principal,
} from "@openlifewiki/protocol";
import type { Request, RequestHandler, Response } from "express";

import { buildAuthenticatedUser } from "./authentication.js";

const GRAPH_QUERY_PARAMETERS = new Set(["root", "depth", "include", "limit", "cursor"]);
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const graphRequestContext = Symbol("openlifewiki.graph-request-context");
const CACHE_CONTROL = "private, max-age=0, must-revalidate";

export interface GraphRequestLog {
  readonly event: "knowledge_graph_http_request";
  readonly requestId: string;
  readonly orgId: string | null;
  readonly principalIdHash: string | null;
  readonly queryHash: string | null;
  readonly registryRevision: number | null;
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly durationMs: number;
  readonly status: number;
  readonly errorCode: KnowledgeGraphErrorCode | null;
}

interface MutableGraphRequestContext {
  readonly requestId: string;
  orgId: string | null;
  principalIdHash: string | null;
  queryHash: string | null;
  registryRevision: number | null;
  nodeCount: number | null;
  edgeCount: number | null;
  errorCode: KnowledgeGraphErrorCode | null;
}

type GraphRequest = Request & { [graphRequestContext]?: MutableGraphRequestContext };

export class GraphRouteError extends Error {
  constructor(readonly code: KnowledgeGraphErrorCode, message: string) {
    super(message);
    this.name = "GraphRouteError";
  }
}

export function parseGraphHttpQuery(parameters: URLSearchParams): KnowledgeGraphQuery {
  try {
    const seen = new Set<string>();
    for (const key of parameters.keys()) {
      if (!GRAPH_QUERY_PARAMETERS.has(key) || seen.has(key)) throw invalidQuery();
      seen.add(key);
    }

    const include = parseIncludes(parameters.get("include"));
    const rawCursor = parameters.get("cursor");
    if (rawCursor !== null && (rawCursor.length > 4_096 || !CURSOR.test(rawCursor))) {
      throw invalidQuery();
    }
    const parsed = knowledgeGraphQuerySchema.safeParse({
      root: parseRoot(parameters.get("root")),
      depth: parseInteger(parameters.get("depth"), 2),
      include,
      limit: parseInteger(parameters.get("limit"), 500),
      cursor: rawCursor,
    });
    if (!parsed.success) throw invalidQuery();
    return parsed.data;
  } catch (error) {
    if (error instanceof GraphRouteError) throw error;
    throw invalidQuery();
  }
}

export function createGraphCorsMiddleware(
  allowedOrigins: readonly string[],
  options: {
    readonly logger?: (entry: GraphRequestLog) => void;
    readonly requestId?: () => string;
    readonly monotonicNow?: () => number;
  } = {},
): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (request, response, next) => {
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    const context: MutableGraphRequestContext = {
      requestId: (options.requestId ?? randomUUID)(),
      orgId: null,
      principalIdHash: null,
      queryHash: null,
      registryRevision: null,
      nodeCount: null,
      edgeCount: null,
      errorCode: null,
    };
    (request as GraphRequest)[graphRequestContext] = context;
    response.setHeader("Cache-Control", CACHE_CONTROL);
    response.setHeader("X-Request-ID", context.requestId);
    response.vary("Authorization");
    response.vary("Origin");
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      const entry: GraphRequestLog = {
        event: "knowledge_graph_http_request",
        requestId: context.requestId,
        orgId: context.orgId,
        principalIdHash: context.principalIdHash,
        queryHash: context.queryHash,
        registryRevision: context.registryRevision,
        nodeCount: context.nodeCount,
        edgeCount: context.edgeCount,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        status: response.statusCode,
        errorCode: context.errorCode,
      };
      try {
        (options.logger ?? defaultGraphLogger)(entry);
      } catch {
        // Logging must never change the graph response.
      }
    };
    response.once("finish", logRequest);
    response.once("close", logRequest);
    const origin = request.headers.origin;
    if (origin !== undefined && allowed.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Accept, If-None-Match",
      );
      response.status(204).end();
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      response.status(405).end();
      return;
    }
    next();
  };
}

export function createGraphHandler(input: {
  readonly projection: Pick<KnowledgeGraphProjectionService, "read">;
  readonly now?: () => Date;
}): RequestHandler {
  return async (request, response) => {
    const context = graphContext(request);
    try {
      const principal = (await buildAuthenticatedUser(request)).principal;
      recordPrincipal(context, principal);
      if (principal.type !== "user") {
        throw new GraphRouteError(
          "GRAPH_PRINCIPAL_NOT_SUPPORTED",
          "Knowledge graph reads support user principals only.",
        );
      }
      const query = parseGraphHttpQuery(
        new URL(request.originalUrl, "http://graph.invalid").searchParams,
      );
      context.queryHash = sha256Canonical(query);
      const graph = await input.projection.read({
        principal,
        query,
        now: (input.now ?? (() => new Date()))(),
      });
      context.registryRevision = graph.registryRevision;
      context.nodeCount = graph.elements.nodes.length;
      context.edgeCount = graph.elements.edges.length;

      const etag = `"${sha256Canonical({
        principalId: principal.principalId,
        query,
        registryRevision: graph.registryRevision,
      })}"`;
      response.setHeader("ETag", etag);
      if (request.headers["if-none-match"] === etag) {
        response.status(304).end();
        return;
      }
      response.status(200).type("application/json").send(graph);
    } catch (error) {
      const mapped = mapGraphError(error);
      context.errorCode = mapped.code;
      response.status(mapped.status).type("application/json").send({
        error: {
          code: mapped.code,
          message: mapped.message,
          requestId: context.requestId,
        },
      });
    }
  };
}

export function handleGraphAuthenticationFailure(
  request: Request,
  response: Response,
): boolean {
  const context = (request as GraphRequest)[graphRequestContext];
  if (context === undefined) return false;
  context.errorCode = "GRAPH_UNAVAILABLE";
  response.status(503).type("application/json").send({
    error: {
      code: "GRAPH_UNAVAILABLE",
      message: "The knowledge graph is temporarily unavailable.",
      requestId: context.requestId,
    },
  });
  return true;
}

function parseRoot(value: string | null): KnowledgeGraphQuery["root"] {
  if (value === null) return null;
  const separator = value.indexOf(":");
  if (separator < 1) throw invalidQuery();
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!REGISTRY_ID.test(id)) throw invalidQuery();
  if (prefix === "collection") return { type: "collection", id };
  if (prefix === "item") return { type: "knowledge", id };
  throw invalidQuery();
}

function parseInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw invalidQuery();
  return Number(value);
}

function parseIncludes(value: string | null): KnowledgeGraphQuery["include"] {
  if (value === null) return ["tags"];
  const requested = value.split(",");
  if (requested.some((entry) => entry === "") || new Set(requested).size !== requested.length) {
    throw invalidQuery();
  }
  const requestedSet = new Set(requested);
  if (requested.some((entry) => !(KNOWLEDGE_GRAPH_INCLUDES as readonly string[]).includes(entry))) {
    throw invalidQuery();
  }
  return KNOWLEDGE_GRAPH_INCLUDES.filter((entry) => requestedSet.has(entry));
}

function invalidQuery(): GraphRouteError {
  return new GraphRouteError("GRAPH_INVALID_QUERY", "The graph query is invalid.");
}

function graphContext(request: Request): MutableGraphRequestContext {
  const context = (request as GraphRequest)[graphRequestContext];
  if (context !== undefined) return context;
  return {
    requestId: randomUUID(),
    orgId: null,
    principalIdHash: null,
    queryHash: null,
    registryRevision: null,
    nodeCount: null,
    edgeCount: null,
    errorCode: null,
  };
}

function recordPrincipal(context: MutableGraphRequestContext, principal: Principal): void {
  context.orgId = principal.orgId;
  context.principalIdHash = `sha256:${createHash("sha256")
    .update(principal.principalId, "utf8")
    .digest("hex")}`;
}

function mapGraphError(error: unknown): {
  readonly status: number;
  readonly code: KnowledgeGraphErrorCode;
  readonly message: string;
} {
  const code = error instanceof GraphRouteError || error instanceof KnowledgeGraphError
    ? error.code
    : "GRAPH_UNAVAILABLE";
  switch (code) {
    case "GRAPH_INVALID_QUERY":
      return { status: 400, code, message: "The graph query is invalid." };
    case "GRAPH_FORBIDDEN":
      return {
        status: 403,
        code,
        message: "The principal is not authorized to read the knowledge graph.",
      };
    case "GRAPH_PRINCIPAL_NOT_SUPPORTED":
      return {
        status: 403,
        code,
        message: "Knowledge graph reads support user principals only.",
      };
    case "GRAPH_ROOT_NOT_FOUND":
      return {
        status: 404,
        code,
        message: "The requested knowledge graph root was not found.",
      };
    case "GRAPH_SNAPSHOT_EXPIRED":
      return { status: 409, code, message: "The knowledge graph snapshot has expired." };
    default:
      return {
        status: 503,
        code: "GRAPH_UNAVAILABLE",
        message: "The knowledge graph is temporarily unavailable.",
      };
  }
}

function defaultGraphLogger(entry: GraphRequestLog): void {
  console.log(JSON.stringify(entry));
}
