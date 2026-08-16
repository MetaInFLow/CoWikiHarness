import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

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
  PostgresKnowledgeHierarchyStore,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "@openlifewiki/adapters";
import {
  KnowledgeOperations,
  KnowledgeOrganizationOperations,
} from "@openlifewiki/knowledge-agent";
import express, { type Express } from "express";

import { PostgresA2ATaskStore } from "./a2a-task-store.js";
import { buildKnowledgeAgentCard } from "./agent-card.js";
import { KnowledgeAgentExecutor } from "./agent-executor.js";
import { KnowledgeServerTaskRunner } from "./knowledge-task-runner.js";
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

export interface A2AServer {
  readonly app: Express;
  readonly database: Database;
  readonly store: PostgresKnowledgeStore;
  start(): Promise<{ readonly url: string; readonly port: number }>;
  close(): Promise<void>;
}

export async function createA2AServer(
  config: ServerConfig,
  options: {
    readonly modelRuntime?: KnowledgeModelRuntime;
    readonly now?: () => Date;
    readonly migrationsDir?: string;
    readonly beforeCancellationSettlement?: () => Promise<void>;
  } = {},
): Promise<A2AServer> {
  const database = createDatabase({ connectionString: config.databaseUrl });
  let modelRuntime: KnowledgeModelRuntime | undefined;
  try {
    await runMigrations(database, { migrationsDir: options.migrationsDir ?? migrationsDirectory() });
    const store = new PostgresKnowledgeStore(database, config.tokenHmacSecret);
    const operations = new KnowledgeOperations(store);
    const hierarchyStore = new PostgresKnowledgeHierarchyStore(database);
    const organizationOperations = new KnowledgeOrganizationOperations(hierarchyStore);
    modelRuntime = options.modelRuntime ?? await createKnowledgeModelRuntime(config);
    const agent = createConfiguredKnowledgeAgent({ runtime: modelRuntime, operations });
    const runner = new KnowledgeServerTaskRunner(
      store,
      operations,
      organizationOperations,
      hierarchyStore,
      agent,
      database,
    );
    await runner.recoverInterruptedTasks();

    const card = buildKnowledgeAgentCard(config.publicUrl);
    const taskStore = new PostgresA2ATaskStore(store);
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
    app.use(createBearerAuthentication({ store, now: options.now ?? (() => new Date()) }));
    app.use(jsonRpcHandler({ requestHandler, userBuilder: buildAuthenticatedUser }));

    let httpServer: Server | undefined;
    let closing: Promise<void> | undefined;
    return {
      app,
      database,
      store,
      async start() {
        if (httpServer !== undefined) throw new Error("Knowledge server is already listening");
        httpServer = await listen(app, config.port);
        const address = httpServer.address() as AddressInfo;
        const url = listeningUrl(config.publicUrl, address.port);
        updateCardUrl(card, url);
        return { url, port: address.port };
      },
      async close() {
        closing ??= (async () => {
          if (httpServer !== undefined) await closeHttpServer(httpServer);
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

async function listen(app: Express, port: number): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve(server));
    server.once("error", reject);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
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
