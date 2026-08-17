import { fileURLToPath } from "node:url";

import {
  AGENT_CARD_PATH,
  type AgentCard,
  type CancelTaskRequest,
  type Task,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import {
  createDatabase,
  PostgresKnowledgeGraphStore,
  PostgresKnowledgeHierarchyStore,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import { KnowledgeGraphProjectionService } from "@openlifewiki/core";
import {
  KnowledgeOperations,
  KnowledgeOrganizationOperations,
} from "@openlifewiki/knowledge-agent";
import express, { type Express } from "express";

import { PostgresA2ATaskStore } from "./a2a-task-store.js";
import { buildKnowledgeAgentCard } from "./agent-card.js";
import { KnowledgeAgentExecutor } from "./agent-executor.js";
import { KnowledgeServerTaskRunner } from "./knowledge-task-runner.js";
import { listenHttp, type HttpListenerBinding } from "./http-listener.js";
import {
  buildAuthenticatedUser,
  createBearerAuthentication,
  requireAuthenticatedUser,
} from "./authentication.js";
import type { ServerConfig } from "./config.js";
import {
  createConfiguredKnowledgeAgent,
  createKnowledgeModelRuntime,
  type KnowledgeModelRuntime,
} from "./model-runtime.js";
import {
  createGraphCorsMiddleware,
  createGraphHandler,
  handleGraphAuthenticationFailure,
  type GraphRequestLog,
} from "./graph-route.js";

export interface A2AServer {
  readonly app: Express;
  readonly database: Database;
  readonly store: PostgresKnowledgeStore;
  start(): Promise<{
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly internalUrl: string;
  }>;
  close(): Promise<void>;
}

export async function createA2AServer(
  config: ServerConfig,
  options: {
    readonly modelRuntime?: KnowledgeModelRuntime;
    readonly now?: () => Date;
    readonly migrationsDir?: string;
    readonly beforeCancellationSettlement?: () => Promise<void>;
    readonly afterHierarchyMutationCommit?: () => Promise<void>;
    readonly graphLogger?: (entry: GraphRequestLog) => void;
  } = {},
): Promise<A2AServer> {
  const database = createDatabase({ connectionString: config.databaseUrl });
  let modelRuntime: KnowledgeModelRuntime | undefined;
  try {
    await runMigrations(database, { migrationsDir: options.migrationsDir ?? migrationsDirectory() });
    const store = new PostgresKnowledgeStore(database, config.tokenHmacSecret);
    const graphStore = new PostgresKnowledgeGraphStore(database, config.tokenHmacSecret);
    const graphProjection = new KnowledgeGraphProjectionService(graphStore);
    const operations = new KnowledgeOperations(store);
    const hierarchyStore = new PostgresKnowledgeHierarchyStore(database);
    const organizationOperations = new KnowledgeOrganizationOperations(hierarchyStore);
    modelRuntime = options.modelRuntime ?? await createKnowledgeModelRuntime(config);
    const agent = createConfiguredKnowledgeAgent({ runtime: modelRuntime, operations });
    const runner = new KnowledgeServerTaskRunner(
      store,
      operations,
      organizationOperations,
      agent,
      database,
      options.afterHierarchyMutationCommit,
    );
    await runner.recoverInterruptedTasks();

    const card = buildKnowledgeAgentCard(config.publicUrl);
    const taskStore = new PostgresA2ATaskStore(store);
    await taskStore.reconcileCompletedTasks(options.now);
    const executor = new KnowledgeAgentExecutor(
      store,
      runner,
      options.now,
      options.beforeCancellationSettlement,
    );
    const requestHandler = new AuthenticatedRequestHandler(card, taskStore, executor);
    const app = express();
    app.disable("x-powered-by");
    app.get("/healthz", async (_request, response) => {
      try {
        await database.query("select 1");
        response.status(200).send({ status: "ready" });
      } catch {
        response.status(503).send({ status: "unavailable" });
      }
    });
    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
    app.use("/api/v1/graph", createGraphCorsMiddleware(
      config.graphAllowedOrigins,
      options.graphLogger === undefined ? {} : { logger: options.graphLogger },
    ));
    app.use(createBearerAuthentication({
      store,
      now: options.now ?? (() => new Date()),
      onInfrastructureFailure: handleGraphAuthenticationFailure,
    }));
    app.get("/api/v1/graph", createGraphHandler({
      projection: graphProjection,
      ...(options.now === undefined ? {} : { now: options.now }),
    }));
    app.use(jsonRpcHandler({ requestHandler, userBuilder: buildAuthenticatedUser }));

    let httpBinding: HttpListenerBinding | undefined;
    let closing: Promise<void> | undefined;
    return {
      app,
      database,
      store,
      async start() {
        if (httpBinding !== undefined) throw new Error("Knowledge server is already listening");
        httpBinding = await listenHttp(app, { host: config.bindHost, port: config.port });
        const url = listeningUrl(config.publicUrl, httpBinding.port);
        updateCardUrl(card, url);
        return {
          url,
          host: httpBinding.host,
          port: httpBinding.port,
          internalUrl: httpBinding.internalUrl,
        };
      },
      async close() {
        closing ??= (async () => {
          if (httpBinding !== undefined) await httpBinding.close();
          await modelRuntime?.close();
          await database.close();
        })();
        await closing;
      },
    };
  } catch (error) {
    await modelRuntime?.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

class AuthenticatedRequestHandler extends DefaultRequestHandler {
  constructor(
    card: AgentCard,
    taskStore: PostgresA2ATaskStore,
    private readonly executor: KnowledgeAgentExecutor,
  ) {
    super(card, taskStore, executor);
  }

  override async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const principalId = requireAuthenticatedUser(context.user).principal.principalId;
    return await this.executor.withCancellationPrincipal(
      principalId,
      async () => await super.cancelTask(params, context),
    );
  }
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("../../../packages/adapters/migrations", import.meta.url));
}

function listeningUrl(publicUrl: string, port: number): string {
  const url = new URL(publicUrl);
  if (url.port === "0") url.port = String(port);
  return url.toString().replace(/\/$/u, "");
}

function updateCardUrl(card: AgentCard, url: string): void {
  const first = card.supportedInterfaces[0];
  if (first !== undefined) first.url = url;
  if (card.provider !== undefined) card.provider.url = url;
}
