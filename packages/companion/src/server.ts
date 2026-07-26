import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateDefaultSource,
  AdapterError,
  executeConfigV1Migration,
  executeSourceAuthorization,
  executeSourceRevocation,
  getP0Sources,
  initializeRuntime,
  inspectRuntime,
  listConnectorStatuses,
  previewActivation,
  previewConfigV1Migration,
  previewInitialization,
  previewSourceAuthorization,
  previewSourceRevocation,
  probeSourceCandidate,
  readConfig,
  readConfigSnapshot,
  writeJsonAtomic,
  type CommandRunner,
} from "@openlifewiki/adapters";
import type { RuntimeLayout } from "@openlifewiki/protocol";

const PRODUCT_VERSION = "0.1.0-dev.1";
const MAX_BODY_BYTES = 16 * 1024;
const ICONS = new Set([
  "activity",
  "book-open",
  "check",
  "check-circle-2",
  "chevron-right",
  "circle-alert",
  "clipboard",
  "database",
  "external-link",
  "file-text",
  "folder-open",
  "heart-pulse",
  "house",
  "loader-circle",
  "panel-left",
  "plug-zap",
  "refresh-cw",
  "server",
  "settings-2",
  "shield-check",
  "square-terminal",
  "stop-circle",
  "triangle-alert",
  "x",
]);

export interface CompanionServerInfo {
  readonly schema: "openlifewiki.companion-server/v1";
  readonly status: "started" | "already-running" | "stopped";
  readonly pid?: number;
  readonly port?: number;
  readonly url?: string;
  readonly startedAt?: string;
}

export interface CompanionServerOptions {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly repoRoot: string;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly token?: string;
  readonly now?: () => Date;
  readonly openBrowser?: boolean;
  readonly browserOpener?: (url: string) => Promise<void>;
}

export interface CompanionServerHandle {
  readonly info: CompanionServerInfo;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface StoredServerInfo {
  readonly schema: "openlifewiki.companion-state/v1";
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly startedAt: string;
}

interface ServerContext {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly repoRoot: string;
  readonly token: string;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export async function startCompanionServer(options: CompanionServerOptions): Promise<CompanionServerHandle> {
  const existing = await companionServerStatus(options.layout);
  if (existing.status === "already-running" && existing.url !== undefined) {
    if (options.openBrowser === true) await openBrowser(existing.url, options);
    return {
      info: existing,
      closed: Promise.resolve(),
      async close() {},
    };
  }

  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(32).toString("hex");
  const stateFile = companionStateFile(options.layout);
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closePromise: Promise<void> | undefined;
  let server: Server;
  let context: ServerContext;

  const close = async (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    }).finally(async () => {
      await rm(stateFile, { force: true });
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
      resolveClosed?.();
    });
    return await closePromise;
  };
  const handleSignal = (): void => { void close(); };

  server = createServer((request, response) => {
    void handleRequest(request, response, context).catch((error: unknown) => {
      sendApiError(response, error);
    });
  });
  const port = await listen(server, host, options.port ?? 0);
  const origin = `http://${host}:${port}`;
  const url = `${origin}/#token=${token}`;
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  context = {
    layout: options.layout,
    runner: options.runner,
    repoRoot: options.repoRoot,
    token,
    origin,
    close,
  };

  await writeJsonAtomic(stateFile, {
    schema: "openlifewiki.companion-state/v1",
    pid: process.pid,
    port,
    url,
    startedAt,
  } satisfies StoredServerInfo);
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  if (options.openBrowser === true) await openBrowser(url, options);
  return {
    info: {
      schema: "openlifewiki.companion-server/v1",
      status: "started",
      pid: process.pid,
      port,
      url,
      startedAt,
    },
    closed,
    close,
  };
}

export async function companionServerStatus(layout: RuntimeLayout): Promise<CompanionServerInfo> {
  const stored = await readStoredServerInfo(layout);
  if (stored === undefined || !processIsAlive(stored.pid)) {
    if (stored !== undefined) await rm(companionStateFile(layout), { force: true });
    return { schema: "openlifewiki.companion-server/v1", status: "stopped" };
  }
  return {
    schema: "openlifewiki.companion-server/v1",
    status: "already-running",
    pid: stored.pid,
    port: stored.port,
    url: stored.url,
    startedAt: stored.startedAt,
  };
}

export async function stopCompanionServer(layout: RuntimeLayout): Promise<CompanionServerInfo> {
  const stored = await readStoredServerInfo(layout);
  if (stored === undefined || !processIsAlive(stored.pid)) {
    await rm(companionStateFile(layout), { force: true });
    return { schema: "openlifewiki.companion-server/v1", status: "stopped" };
  }
  process.kill(stored.pid, "SIGTERM");
  return { schema: "openlifewiki.companion-server/v1", status: "stopped" };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", context.origin);
  setSecurityHeaders(response);

  if (!requestUrl.pathname.startsWith("/api/")) {
    await serveAsset(requestUrl.pathname, response);
    return;
  }
  if (!authorized(request, context)) {
    sendJson(response, 401, { code: "UNAUTHORIZED", message: "Local session token required" });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    sendJson(response, 200, await buildProductStatus(context));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/sources") {
    sendJson(response, 200, await buildSourcesStatus(context));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/config/migration/preview") {
    sendJson(response, 200, await previewConfigV1Migration(context.layout.configFile, "human:owner"));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/config/migration/execute") {
    const body = await readJsonBody(request);
    const preview = await previewConfigV1Migration(context.layout.configFile, "human:owner");
    requireApprovedDigest(body, preview.previewHash);
    const result = await executeConfigV1Migration(context.layout.configFile, {
      expectedOwnerId: "human:owner",
      approval: {
        approvedBy: "human:owner",
        sourceConfigHash: preview.sourceConfigHash,
        previewHash: preview.previewHash,
      },
    });
    sendJson(response, 200, { schema: "openlifewiki.config-migration-result/v1", revision: result.config.revision });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/sources/authorization/preview") {
    const body = requireObject(await readJsonBody(request));
    sendJson(response, 200, await previewSourceAuthorization({
      configPath: context.layout.configFile,
      request: body.request,
      probe: sourceProbe(context),
    }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/sources/authorization/execute") {
    const body = requireObject(await readJsonBody(request));
    requireConfirmation(body);
    const result = await executeSourceAuthorization({
      configPath: context.layout.configFile,
      request: body.request,
      expectedPreviewHash: requireString(body.digest, "digest"),
      probe: sourceProbe(context),
    });
    sendJson(response, 200, result);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/sources/revoke/preview") {
    const body = requireObject(await readJsonBody(request));
    sendJson(response, 200, await previewSourceRevocation({
      configPath: context.layout.configFile,
      sourceId: requireString(body.sourceId, "sourceId"),
    }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/sources/revoke/execute") {
    const body = requireObject(await readJsonBody(request));
    requireConfirmation(body);
    sendJson(response, 200, await executeSourceRevocation({
      configPath: context.layout.configFile,
      sourceId: requireString(body.sourceId, "sourceId"),
      expectedPreviewHash: requireString(body.digest, "digest"),
    }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/actions/open-workspace") {
    await openWorkspace(context);
    sendJson(response, 200, { status: "opened", path: context.layout.workspaceRoot });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/operations/init/preview") {
    const plan = previewInitialization(context.layout);
    sendJson(response, 200, { plan, digest: planDigest(plan) });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/operations/init/execute") {
    const body = await readJsonBody(request);
    const plan = previewInitialization(context.layout);
    requireApprovedPlan(body, plan);
    const result = await initializeRuntime({ layout: context.layout, runner: context.runner });
    sendJson(response, 200, { result, status: await buildProductStatus(context) });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/operations/activate/preview") {
    const plan = previewActivation(context.layout);
    sendJson(response, 200, { plan, digest: planDigest(plan) });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/operations/activate/execute") {
    const body = await readJsonBody(request);
    const plan = previewActivation(context.layout);
    requireApprovedPlan(body, plan);
    const result = await activateDefaultSource({ layout: context.layout, runner: context.runner });
    sendJson(response, 200, { result, status: await buildProductStatus(context) });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/mcp/codex-config") {
    sendJson(response, 200, await buildCodexPlan(context));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/mcp/register") {
    const body = await readJsonBody(request);
    const plan = await buildCodexPlan(context);
    requireApprovedDigest(body, plan.digest);
    if (!plan.ready) throw new CompanionError("MCP_NOT_READY", "Activate the Source before registering Codex", 409);
    if (!plan.registered) {
      if (plan.present) {
        await context.runner.run("codex", ["mcp", "remove", "openlifewiki"], {
          timeoutMs: 30_000,
          env: process.env,
        });
      }
      await context.runner.run("codex", plan.args, { timeoutMs: 60_000, env: process.env });
    }
    sendJson(response, 200, { registered: true, status: await buildProductStatus(context) });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/server/stop") {
    sendJson(response, 200, { status: "stopping" });
    setTimeout(() => { void context.close(); }, 25);
    return;
  }

  sendJson(response, 404, { code: "NOT_FOUND", message: "Unknown local management route" });
}

async function buildProductStatus(context: ServerContext): Promise<unknown> {
  const doctor = await inspectRuntime(context.layout, context.runner);
  const config = await readConfig(context.layout.configFile);
  const codex = await buildCodexPlan(context, doctor.stableState === "ACTIVE");
  const p0Sources = config === undefined ? [] : getP0Sources(config);
  const sourceItems = p0Sources.map(({ id, path, collection, mask, enabled }) => ({
    id,
    path,
    collection,
    mask,
    ...(enabled === undefined ? {} : { enabled }),
  }));
  const singleSource = sourceItems.length === 1 ? sourceItems[0] : undefined;
  return {
    schema: "openlifewiki.companion-status/v1",
    productVersion: PRODUCT_VERSION,
    stableState: doctor.stableState,
    health: doctor.status,
    nextAction: doctor.nextAction,
    paths: {
      runtime: context.layout.root,
      workspace: context.layout.workspaceRoot,
      source: context.layout.sourcesDir,
      wiki: context.layout.wikiDir,
    },
    source: {
      authorized: sourceItems.length > 0,
      count: sourceItems.length,
      path: singleSource?.path ?? null,
      collection: singleSource?.collection ?? null,
      mask: singleSource?.mask ?? null,
      items: sourceItems,
    },
    components: doctor.components,
    mcp: {
      ready: doctor.stableState === "ACTIVE" && doctor.status === "ready",
      registered: codex.registered,
      tools: ["query", "get", "multi_get", "status"],
      command: codex.command,
    },
  };
}

async function buildSourcesStatus(context: ServerContext): Promise<unknown> {
  const snapshot = await readConfigSnapshot(context.layout.configFile);
  const v2 = snapshot?.config.schema === "openlifewiki.config/v2" ? snapshot.config : undefined;
  const sources = await listConnectorStatuses({
    sources: v2?.sources ?? [],
    runner: context.runner,
    scratchRoot: join(context.layout.runtimeDir, "connector-probes"),
  });
  return {
    schema: "openlifewiki.sources-status/v1",
    revision: v2?.revision ?? null,
    configHash: snapshot?.hash ?? null,
    migrationRequired: snapshot?.config.schema === "openlifewiki.config/v1",
    authorizations: v2?.sources ?? [],
    sources,
  };
}

function sourceProbe(context: ServerContext) {
  return async ({ source, now }: Parameters<Parameters<typeof previewSourceAuthorization>[0]["probe"]>[0]) => (
    await probeSourceCandidate({
      source,
      runner: context.runner,
      now,
      scratchRoot: join(context.layout.runtimeDir, "connector-probes"),
    })
  );
}

async function buildCodexPlan(context: ServerContext, readyOverride?: boolean): Promise<{
  readonly schema: "openlifewiki.codex-registration/v1";
  readonly ready: boolean;
  readonly registered: boolean;
  readonly present: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly digest: string;
}> {
  const args = [
    "mcp",
    "add",
    "--env",
    `PATH=${process.env.PATH ?? ""}`,
    "openlifewiki",
    "--",
    "pnpm",
    "--dir",
    context.repoRoot,
    "openlifewiki",
    "mcp",
    "--stdio",
  ] as const;
  const desiredCommand = "pnpm";
  const desiredArgs = ["--dir", context.repoRoot, "openlifewiki", "mcp", "--stdio"] as const;
  const current = await readCodexRegistration(context.runner);
  const present = current !== undefined;
  const registered = current?.transport?.type === "stdio"
    && current.transport.command === desiredCommand
    && JSON.stringify(current.transport.args) === JSON.stringify(desiredArgs);
  const ready = readyOverride ?? (await inspectRuntime(context.layout, context.runner)).stableState === "ACTIVE";
  const command = formatCommand("codex", args);
  return {
    schema: "openlifewiki.codex-registration/v1",
    ready,
    registered,
    present,
    command,
    args,
    digest: planDigest({ command: "codex", args }),
  };
}

async function readCodexRegistration(runner: CommandRunner): Promise<{
  readonly transport?: {
    readonly type?: string;
    readonly command?: string;
    readonly args?: readonly string[];
  };
} | undefined> {
  try {
    const result = await runner.run("codex", ["mcp", "get", "openlifewiki", "--json"], {
      timeoutMs: 15_000,
      env: process.env,
    });
    const value = JSON.parse(result.stdout) as unknown;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

async function openWorkspace(context: ServerContext): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  await context.runner.run(command, [context.layout.workspaceRoot], { timeoutMs: 15_000 });
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
  if (pathname === "/favicon.ico") {
    sendText(response, 204, "image/x-icon", "");
    return;
  }
  if (pathname.startsWith("/icons/") && pathname.endsWith(".svg")) {
    const name = pathname.slice("/icons/".length, -".svg".length);
    if (!ICONS.has(name)) {
      sendText(response, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve("lucide-static/package.json"));
    sendText(response, 200, "image/svg+xml", await readFile(join(packageRoot, "icons", `${name}.svg`), "utf8"));
    return;
  }
  const asset = pathname === "/" ? "index.html" : pathname.slice(1);
  if (asset !== "index.html" && asset !== "styles.css" && asset !== "app.js") {
    sendText(response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }
  const mime = asset.endsWith(".css")
    ? "text/css; charset=utf-8"
    : asset.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
  sendText(response, 200, mime, await readFile(join(publicDir, asset), "utf8"));
}

function authorized(request: IncomingMessage, context: ServerContext): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== context.origin) return false;
  const supplied = request.headers["x-openlifewiki-session"];
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(context.token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireApprovedPlan(body: unknown, plan: unknown): void {
  requireApprovedDigest(body, planDigest(plan));
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionError("INVALID_REQUEST", "Request body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CompanionError("INVALID_REQUEST", `${field} is required`, 400);
  }
  return value;
}

function requireConfirmation(body: Record<string, unknown>): void {
  if (body.confirmed !== true) {
    throw new CompanionError("APPROVAL_REQUIRED", "Exact Owner confirmation is required", 400);
  }
}

function requireApprovedDigest(body: unknown, expectedDigest: string): void {
  if (typeof body !== "object" || body === null) {
    throw new CompanionError("APPROVAL_REQUIRED", "Operation approval is required", 400);
  }
  const request = body as Record<string, unknown>;
  if (request.confirmed !== true || request.digest !== expectedDigest) {
    throw new CompanionError("PLAN_CHANGED", "Preview the current plan and confirm it before execution", 409);
  }
}

function planDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new CompanionError("BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new CompanionError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function sendApiError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) return;
  if (error instanceof CompanionError) {
    sendJson(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof AdapterError) {
    sendJson(response, 409, {
      code: error.code,
      message: error.message,
      ...(error.publicDetails === undefined ? {} : { details: error.publicDetails }),
    });
    return;
  }
  sendJson(response, 500, {
    code: "COMPANION_FAILED",
    message: "Local management request failed",
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function sendText(response: ServerResponse, status: number, contentType: string, value: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.end(value);
}

function companionStateFile(layout: RuntimeLayout): string {
  return join(layout.runtimeDir, "companion", "server.json");
}

async function readStoredServerInfo(layout: RuntimeLayout): Promise<StoredServerInfo | undefined> {
  try {
    const value = JSON.parse(await readFile(companionStateFile(layout), "utf8")) as Partial<StoredServerInfo>;
    if (value.schema !== "openlifewiki.companion-state/v1"
      || typeof value.pid !== "number"
      || typeof value.port !== "number"
      || typeof value.url !== "string"
      || typeof value.startedAt !== "string") return undefined;
    return value as StoredServerInfo;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Companion did not receive a TCP port");
  return address.port;
}

async function openBrowser(url: string, options: CompanionServerOptions): Promise<void> {
  if (options.browserOpener !== undefined) {
    await options.browserOpener(url);
    return;
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await options.runner.run(command, args, { timeoutMs: 15_000 });
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

class CompanionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CompanionError";
  }
}
