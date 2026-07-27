import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative } from "node:path";

import { assertBodyReadAllowed } from "@openlifewiki/core";
import {
  assertEnumerationIntent,
  assertScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
  type ConnectorStatus,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "../command-runner.js";
import { nodeCommandRunner } from "../command-runner.js";
import type {
  ConnectorProbeOptions,
  ConnectorProvider,
  ProgressiveConnectorBinding,
  ProgressiveConnectorChildrenOptions,
  ProgressiveConnectorListOptions,
  ProgressiveConnectorProbeOptions,
  ProgressiveConnectorProvider,
  ProgressiveConnectorReadOptions,
} from "./connector-provider.js";
import {
  assertBodyBudgetReservationReceipt,
  commandFailureKind,
  parseVersion,
  progressiveConnectorScopeHash,
  redacted,
  safeBlocking,
} from "./connector-provider.js";

const PROVIDER_NAME = "codex app-server v2";
const PROVIDER_PROJECT = "openai/codex";
const MAX_PAGE_SIZE = 100;
const BODY_CHUNK_BYTES = 64 * 1024;
const JSONL_PROTOCOL_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSONL_OUTPUT_BYTES = 64 * 1024 * 1024;
const SAFE_ENV_NAMES = [
  "CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME",
] as const;

interface CodexHistoryScope {
  readonly schema: "openlifewiki.scope/codex-history/v1";
  readonly projectRoots: readonly string[];
  readonly threadIds: readonly string[];
}

interface CodexHistoryLocator {
  readonly schema: "openlifewiki.locator/codex-history/v1";
  readonly kind: "source-root" | "project" | "thread";
  readonly projectRoot: string | null;
  readonly threadId: string | null;
}

interface ThreadMetadata {
  readonly id: string;
  readonly cwd: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cliVersion: string;
  readonly turns: readonly unknown[];
  readonly raw: Readonly<Record<string, unknown>>;
}

interface CursorPayload {
  readonly schema: "openlifewiki.codex-history-cursor/v1";
  readonly sourceId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly intentId: string;
  readonly scopeHash: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly mode: "projects" | "threads";
  readonly offset: number;
  readonly platformCursor: string | null;
  readonly pageSequence: number;
}

interface CodexContext {
  readonly source: AuthorizedSourceV1;
  readonly plan: ProgressiveConnectorBinding["plan"];
  readonly scope: CodexHistoryScope;
  readonly runner: CommandRunner;
  readonly providerVersion: string;
  readonly contractHash: string;
}

export function createCodexHistoryConnector(
  progressiveRunner: CommandRunner = nodeCommandRunner,
): ConnectorProvider & ProgressiveConnectorProvider {
  return {
    connectorType: "codex-history",

    async probe(options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions) {
      const runner = isProgressiveProbe(options) ? progressiveRunner : options.runner;
      if (isProgressiveProbe(options)) assertActionBinding(options);
      return await probeCodexHistory(
        options.source,
        runner,
        options.now,
        "scratchRoot" in options ? options.scratchRoot : undefined,
      );
    },

    async listRootsMetadata(options) {
      const context = await codexContext(options, progressiveRunner);
      validateLimit(options.limit);
      if (options.cursor !== null) throw codexError("CODEX_CURSOR_INVALID", "Codex History root metadata has no continuation cursor");
      await verifyContextIdentity(context);
      const locator: CodexHistoryLocator = {
        schema: "openlifewiki.locator/codex-history/v1", kind: "source-root", projectRoot: null, threadId: null,
      };
      const node = skeletonNode(context, locator, {
        nodeId: options.rootNodeId,
        parentId: null,
        title: "Codex History",
        kind: "directory",
        childCount: { value: context.scope.projectRoots.length, kind: "known" },
        version: sourceRootVersion(context),
        body: false,
      });
      return skeletonPage(options, options.rootNodeId, [node], null, true);
    },

    async listChildrenMetadata(options) {
      const context = await codexContext(options, progressiveRunner);
      validateLimit(options.limit);
      assertNodeBinding(context, options.parent);
      assertTraversalBinding(options);
      const locator = parseLocator(options.parent.locator, context.scope);
      assertEffectiveScope(context, options.parent, locator);
      const cursor = decodeCursor(
        options.cursor,
        cursorExpected(options),
        locator.kind === "source-root" ? "projects" : "threads",
      );
      assertPageChain(options, cursor.pageSequence);
      if (locator.kind === "source-root") return await listProjects(context, options, cursor);
      if (locator.kind === "project") return await listThreads(context, options, locator, cursor);
      throw codexError("CODEX_PARENT_BLOCKED", "A Codex History thread has no enumerable child layer");
    },

    async getVersion(options) {
      const context = await codexContext(options, progressiveRunner);
      assertNodeBinding(context, options.node);
      const locator = parseLocator(options.node.locator, context.scope);
      assertEffectiveScope(context, options.node, locator);
      if (locator.kind === "source-root") {
        await verifyContextIdentity(context);
        return sourceRootVersion(context);
      }
      if (locator.kind === "project") {
        await verifyContextIdentity(context);
        return projectVersion(context, locator.projectRoot!);
      }
      return threadVersion(await readThreadMetadata(context, locator, false));
    },

    async readApprovedLeafBody(options) {
      const context = await codexContext(options, progressiveRunner);
      assertNodeBinding(context, options.node);
      assertBodyReadAllowed(options.bodyReadGate);
      assertBodyBinding(options);
      const locator = parseLocator(options.node.locator, context.scope);
      assertEffectiveScope(context, options.node, locator);
      if (locator.kind !== "thread" || options.node.scanability !== "metadata-and-body") {
        throw codexError("CODEX_BODY_READ_DENIED", "The selected Codex History node is not an approved thread leaf");
      }
      try {
        assertBodyBudgetReservationReceipt(options.budgetReservation, {
          source: options.source,
          plan: options.plan,
          node: options.node,
          expectedPhysicalIoAccountingHash: options.expectedPhysicalIoAccountingHash,
          trustedReceiptHashes: options.bodyReadGate.trustedReceiptHashes,
        });
      } catch {
        throw codexError("CODEX_BODY_BUDGET_INVALID", "The Codex History body budget permit is invalid or untrusted");
      }
      const current = await readThreadMetadata(context, locator, false);
      if (threadVersion(current) !== options.expectedVersion) {
        throw codexError("CODEX_VERSION_MISMATCH", "The selected Codex thread changed before body read");
      }
      const maxOutputBytes = options.budgetReservation.reservedBytes + JSONL_PROTOCOL_OVERHEAD_BYTES;
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes > MAX_JSONL_OUTPUT_BYTES) {
        throw codexError("CODEX_BODY_TOO_LARGE", "The approved Codex History reservation exceeds the supported JSONL body limit");
      }
      const full = await readThreadMetadata(
        context,
        locator,
        true,
        maxOutputBytes,
      );
      if (threadVersion(full) !== options.expectedVersion) {
        throw codexError("CODEX_VERSION_MISMATCH", "The selected Codex thread changed while its body was being read");
      }
      const bytes = renderThreadMarkdown(full);
      if (bytes.byteLength > options.budgetReservation.reservedBytes) {
        throw codexError("CODEX_BODY_BUDGET_EXCEEDED", "The selected Codex thread exceeded the approved body budget");
      }
      return {
        sourceId: options.sourceId,
        nodeId: options.node.nodeId,
        nodeVersion: options.expectedVersion,
        stream: bytesAsChunks(bytes),
      };
    },
  };
}

export const codexHistoryConnector = createCodexHistoryConnector();

async function probeCodexHistory(
  source: ConnectorProbeOptions["source"],
  runner: CommandRunner,
  now: () => Date,
  scratchRoot: string | undefined,
): Promise<ConnectorStatus> {
    const observedAt = now().toISOString();
    let version: string | undefined;
    try {
      const result = await runner.run("codex", ["--version"], { env: safeEnvironment(), timeoutMs: 15_000 });
      version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (version === undefined) return blocked("CODEX_VERSION_INVALID", "Install a supported Codex CLI release");
    } catch (error) {
      const kind = commandFailureKind(error);
      const code = kind === "missing" ? "CODEX_CLI_MISSING"
        : kind === "timeout" ? "CODEX_PROVIDER_TIMEOUT" : "CODEX_PROVIDER_FAILED";
      return base(kind === "missing" ? "missing" : "blocked", { account: "unverified" }, safeBlocking(code, "Install Codex CLI and sign in through Codex"));
    }
    let loginMode: string;
    try {
      const login = await runner.run("codex", ["login", "status"], { env: safeEnvironment(), timeoutMs: 20_000 });
      const combined = `${login.stdout}\n${login.stderr}`;
      if (!/(logged in|authenticated)/iu.test(combined)) return authRequired();
      loginMode = /chatgpt/iu.test(combined) ? "ChatGPT login" : "Codex login";
    } catch (error) {
      return commandFailureKind(error) === "timeout"
        ? blocked("CODEX_AUTH_TIMEOUT", "Retry the Codex login check")
        : blocked("CODEX_AUTH_CHECK_FAILED", "Retry the Codex login check");
    }
    let account: CodexAccount;
    try {
      account = await readCodexAccount(runner);
    } catch (error) {
      return commandFailureKind(error) === "timeout"
        ? blocked("CODEX_ACCOUNT_TIMEOUT", "Retry the Codex account identity check")
        : blocked("CODEX_IDENTITY_UNAVAILABLE", "Sign in with a ChatGPT account that exposes a stable public email identity");
    }
    const visibleIdentity = {
      account: redactEmail(account.email),
      profile: loginMode,
      ...(account.planType === null ? {} : { plan: account.planType }),
    };

    const approvedObservation = source.providerObservation;
    if (approvedObservation !== undefined) {
      if (approvedObservation.providerName !== PROVIDER_NAME
        || approvedObservation.providerVersion !== version) {
        return blocked("CODEX_VERSION_CHANGED", "Preview and approve Codex History again for the current Codex version", loginMode);
      }
      if (approvedObservation.contractHash === null) {
        return blocked("CODEX_SCHEMA_UNVERIFIED", "Preview and approve Codex History after app-server v2 schema verification", loginMode);
      }
      const fingerprint = sha256Canonical({
        provider: "codex", accountType: account.type, email: account.email,
        version, loginMode, schema: approvedObservation.contractHash,
      });
      return {
        ...base("connected", { ...visibleIdentity, fingerprint }, null),
        providerContractHash: approvedObservation.contractHash,
      };
    }

    if (scratchRoot === undefined) {
      return blocked("CODEX_SCHEMA_UNVERIFIED", "Preview and approve Codex History after app-server v2 schema verification", loginMode);
    }
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(scratchRoot, "codex-schema-"));
    try {
      await runner.run("codex", ["app-server", "generate-json-schema", "--out", scratch], { env: safeEnvironment(), timeoutMs: 60_000 });
      const schemaDocuments = await readJsonTree(scratch);
      if (!hasRequiredAppServerV2Schema(schemaDocuments)) {
        return blocked("CODEX_SCHEMA_MISMATCH", "Update Codex to a release with the required app-server v2 thread contract", loginMode);
      }
      const contractHash = sha256Canonical(schemaDocuments);
      const fingerprint = sha256Canonical({
        provider: "codex", accountType: account.type, email: account.email,
        version, loginMode, schema: contractHash,
      });
      return { ...base("connected", { ...visibleIdentity, fingerprint }, null), providerContractHash: contractHash };
    } catch (error) {
      const kind = commandFailureKind(error);
      return blocked(kind === "timeout" ? "CODEX_SCHEMA_TIMEOUT" : "CODEX_SCHEMA_UNAVAILABLE", "Verify the Codex app-server v2 schema generator", loginMode);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    function base(
      status: ConnectorStatus["status"], identity: Readonly<Record<string, string>>, blocking: ConnectorStatus["blocking"],
    ): ConnectorStatus {
      return {
        schema: "openlifewiki.connector-status/v1", sourceId: source.sourceId, connectorType: "codex-history",
        providerName: PROVIDER_NAME, providerProject: PROVIDER_PROJECT, ...(version === undefined ? {} : { providerVersion: version }),
        identity, authorizedScope: source.scope, status, lastProbe: observedAt, changedItems: 0, blocking,
      };
    }
    function blocked(code: string, remediation: string, account = "unverified"): ConnectorStatus {
      return base("blocked", { account }, safeBlocking(code, remediation));
    }
    function authRequired(): ConnectorStatus {
      return base("auth-required", { account: "unverified" }, safeBlocking("CODEX_AUTH_REQUIRED", "Sign in through the Codex CLI"));
    }
}

async function codexContext(binding: ProgressiveConnectorBinding, runner: CommandRunner): Promise<CodexContext> {
  assertActionBinding(binding);
  const scope = parseCodexHistoryScope(binding.source.scope);
  const observation = binding.source.providerObservation;
  if (observation === undefined || observation.providerName !== PROVIDER_NAME || observation.contractHash === null) {
    throw codexError("CODEX_SCHEMA_UNVERIFIED", "The approved Codex app-server v2 contract is absent");
  }
  let result;
  try {
    result = await runner.run("codex", ["--version"], { env: safeEnvironment(), timeoutMs: 15_000 });
  } catch {
    throw codexError("CODEX_PROVIDER_FAILED", "The approved Codex CLI is unavailable");
  }
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (version === undefined || version !== observation.providerVersion) {
    throw codexError("CODEX_VERSION_CHANGED", "The Codex CLI version changed after Source approval");
  }
  return {
    source: binding.source,
    plan: binding.plan,
    scope,
    runner,
    providerVersion: version,
    contractHash: observation.contractHash,
  };
}

async function verifyContextIdentity(context: CodexContext): Promise<void> {
  await runCodexExchange(context);
}

async function listProjects(
  context: CodexContext,
  options: ProgressiveConnectorChildrenOptions,
  cursor: DecodedCursor,
): Promise<SkeletonPage> {
  if (cursor.mode !== "projects" || cursor.platformCursor !== null) throw invalidCursor();
  if (options.parent.nodeVersion !== sourceRootVersion(context)) {
    throw codexError("CODEX_NODE_CHANGED", "The approved Codex History Source root changed before enumeration");
  }
  await verifyContextIdentity(context);
  const eligible = context.scope.projectRoots.filter((root) => scopePermits(context, projectLogicalPath(root), true));
  if (cursor.offset > eligible.length) throw invalidCursor();
  const selected = eligible.slice(cursor.offset, cursor.offset + options.limit);
  const nextOffset = cursor.offset + selected.length;
  const hasMore = nextOffset < eligible.length;
  const nextCursor = hasMore ? encodeCursor(cursorPayload(
    options, "projects", nextOffset, null, cursor.pageSequence + 1,
  )) : null;
  const nodes = selected.map((projectRoot) => withPage(skeletonNode(context, {
    schema: "openlifewiki.locator/codex-history/v1", kind: "project", projectRoot, threadId: null,
  }, {
    nodeId: projectNodeId(context, projectRoot),
    parentId: options.parent.nodeId,
    title: basename(projectRoot) || projectRoot,
    kind: "directory",
    childCount: { value: null, kind: "unknown" },
    version: projectVersion(context, projectRoot),
    body: false,
  }), options.cursor, hasMore));
  return skeletonPage(options, options.parent.nodeId, nodes, nextCursor, !hasMore);
}

async function listThreads(
  context: CodexContext,
  options: ProgressiveConnectorChildrenOptions,
  locator: CodexHistoryLocator,
  cursor: DecodedCursor,
): Promise<SkeletonPage> {
  if (cursor.mode !== "threads" || cursor.offset !== 0 || locator.projectRoot === null) throw invalidCursor();
  if (options.parent.nodeVersion !== projectVersion(context, locator.projectRoot)) {
    throw codexError("CODEX_NODE_CHANGED", "The approved Codex project root changed before enumeration");
  }
  const response = await runCodexExchange(context, {
    method: "thread/list",
    params: { cwd: locator.projectRoot, cursor: cursor.platformCursor, limit: options.limit, useStateDbOnly: true },
  });
  const result = actionResult(response, "CODEX_ENUMERATION_FAILED", "The approved Codex thread layer could not be enumerated");
  if (!Array.isArray(result.data) || result.data.length > options.limit
    || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor.length > 0)
    || result.nextCursor !== null && result.nextCursor === cursor.platformCursor) {
    throw codexError("CODEX_ENUMERATION_INCOMPLETE", "The Codex thread page response was incomplete");
  }
  const parsed = result.data.map(parseThreadMetadata);
  if (parsed.some((thread) => thread === undefined)) {
    throw codexError("CODEX_ENUMERATION_INCOMPLETE", "The Codex thread page contained invalid metadata");
  }
  const all = parsed as ThreadMetadata[];
  if (all.some((thread) => thread.cwd !== locator.projectRoot || thread.turns.length !== 0)
    || new Set(all.map(({ id }) => id)).size !== all.length) {
    throw codexError("CODEX_ENUMERATION_INCOMPLETE", "The Codex thread page escaped, duplicated or exposed body content");
  }
  const eligible = all.filter((thread) => context.scope.threadIds.includes(thread.id)
    && scopePermits(context, threadLogicalPath(locator.projectRoot!, thread.id), false));
  const hasMore = result.nextCursor !== null;
  const nextCursor = hasMore ? encodeCursor(cursorPayload(
    options, "threads", 0, result.nextCursor as string, cursor.pageSequence + 1,
  )) : null;
  const nodes = eligible.map((thread) => withPage(threadNode(context, locator.projectRoot!, options.parent.nodeId, thread), options.cursor, hasMore));
  return skeletonPage(options, options.parent.nodeId, nodes, nextCursor, !hasMore);
}

async function readThreadMetadata(
  context: CodexContext,
  locator: CodexHistoryLocator,
  includeTurns: boolean,
  maxOutputBytes?: number,
): Promise<ThreadMetadata> {
  if (locator.kind !== "thread" || locator.projectRoot === null || locator.threadId === null
    || !context.scope.projectRoots.includes(locator.projectRoot) || !context.scope.threadIds.includes(locator.threadId)) {
    throw codexError("CODEX_SCOPE_DENIED", "The Codex thread is outside the approved Source scope");
  }
  let response: Readonly<Record<string, unknown>>;
  try {
    response = await runCodexExchange(context, {
      method: "thread/read",
      params: { threadId: locator.threadId, includeTurns },
    }, maxOutputBytes);
  } catch (error) {
    if (includeTurns && outputLimitExceeded(error)) {
      throw codexError("CODEX_BODY_TOO_LARGE", "The Codex thread exceeded the approved JSONL body transport limit");
    }
    throw error;
  }
  const result = actionResult(response, "CODEX_METADATA_FAILED", "The approved Codex thread metadata could not be read");
  const thread = parseThreadMetadata(result.thread);
  if (thread === undefined || thread.id !== locator.threadId || thread.cwd !== locator.projectRoot
    || (!includeTurns && thread.turns.length !== 0)) {
    throw codexError("CODEX_METADATA_INVALID", "The approved Codex thread response was invalid or outside its project root");
  }
  return thread;
}

async function runCodexExchange(
  context: CodexContext,
  action?: { readonly method: "thread/list" | "thread/read"; readonly params: Readonly<Record<string, unknown>> },
  maxOutputBytes?: number,
): Promise<Readonly<Record<string, unknown>>> {
  if (context.runner.runJsonLineSession === undefined) {
    throw codexError("CODEX_APP_SERVER_UNAVAILABLE", "The command runner does not support Codex app-server JSONL sessions");
  }
  const steps = [
    {
      message: {
        method: "initialize", id: 0,
        params: { clientInfo: { name: "openlifewiki", title: "openLifeWiki", version: "0.1.0-dev.1" } },
      },
      awaitResponseId: 0,
    },
    { message: { method: "initialized", params: {} } },
    { message: { method: "account/read", id: 1, params: { refreshToken: false } }, awaitResponseId: 1 },
    ...(action === undefined ? [] : [{ message: { method: action.method, id: 2, params: action.params }, awaitResponseId: 2 }]),
  ];
  let responses: readonly unknown[];
  try {
    responses = await context.runner.runJsonLineSession("codex", ["app-server", "--stdio"], steps, {
      env: safeEnvironment(),
      timeoutMs: action?.method === "thread/read" && action.params.includeTurns === true ? 60_000 : 30_000,
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });
  } catch (error) {
    if (outputLimitExceeded(error)) throw error;
    throw codexError("CODEX_APP_SERVER_FAILED", "The Codex app-server request failed");
  }
  const account = parseAccountResponse(responses.find((value) => isRecord(value) && value.id === 1));
  if (account === undefined) throw codexError("CODEX_IDENTITY_UNAVAILABLE", "The Codex app-server returned no stable account identity");
  const fingerprints = ["ChatGPT login", "Codex login"].map((loginMode) => sha256Canonical({
    provider: "codex", accountType: account.type, email: account.email,
    version: context.providerVersion, loginMode, schema: context.contractHash,
  }));
  if (!fingerprints.includes(context.source.identityFingerprint)) {
    throw codexError("CODEX_IDENTITY_CHANGED", "The logged-in Codex account changed after Source approval");
  }
  if (action === undefined) return {};
  const response = responses.find((value) => isRecord(value) && value.id === 2);
  if (!isRecord(response)) throw codexError("CODEX_APP_SERVER_INVALID", "The Codex app-server returned no bound response");
  return response;
}

function actionResult(
  response: Readonly<Record<string, unknown>>,
  code: string,
  message: string,
): Readonly<Record<string, unknown>> {
  if ("error" in response || !isRecord(response.result)) throw codexError(code, message);
  return response.result;
}

function parseAccountResponse(value: unknown): CodexAccount | undefined {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.account)) return undefined;
  const account = value.result.account;
  if (account.type !== "chatgpt" || typeof account.email !== "string"
    || (account.planType !== undefined && account.planType !== null && typeof account.planType !== "string")) return undefined;
  const email = account.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(email)) return undefined;
  return { type: "chatgpt", email, planType: typeof account.planType === "string" ? account.planType : null };
}

function parseThreadMetadata(value: unknown): ThreadMetadata | undefined {
  if (!isRecord(value) || !safeThreadId(value.id) || typeof value.cwd !== "string"
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0
    || typeof value.cliVersion !== "string" || value.cliVersion.length === 0
    || !Array.isArray(value.turns) || !isRecord(value.status) || typeof value.status.type !== "string") return undefined;
  const sourceKind = threadSourceKind(value.source);
  if (sourceKind === undefined) return undefined;
  return {
    id: value.id,
    cwd: value.cwd,
    sourceKind,
    status: value.status.type,
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
    cliVersion: value.cliVersion,
    turns: value.turns,
    raw: value,
  };
}

function threadSourceKind(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value) && typeof value.custom === "string" && value.custom.length > 0) return "custom";
  if (isRecord(value) && isRecord(value.subAgent)) return "subAgent";
  return undefined;
}

function threadVersion(thread: ThreadMetadata): string {
  return sha256Canonical({
    provider: "codex-thread", id: thread.id, cwd: thread.cwd, sourceKind: thread.sourceKind,
    status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt, cliVersion: thread.cliVersion,
  });
}

function sourceRootVersion(context: CodexContext): string {
  return sha256Canonical({
    provider: "codex-history-root", scopeHash: progressiveConnectorScopeHash(context.source),
    version: context.providerVersion, contractHash: context.contractHash,
  });
}

function projectVersion(context: CodexContext, projectRoot: string): string {
  return sha256Canonical({
    provider: "codex-history-project", projectRoot, version: context.providerVersion, contractHash: context.contractHash,
  });
}

function threadNode(context: CodexContext, projectRoot: string, parentId: string, thread: ThreadMetadata): SkeletonNode {
  const locator: CodexHistoryLocator = {
    schema: "openlifewiki.locator/codex-history/v1", kind: "thread", projectRoot, threadId: thread.id,
  };
  return skeletonNode(context, locator, {
    nodeId: threadNodeId(context, projectRoot, thread.id),
    parentId,
    title: thread.id,
    kind: "thread",
    childCount: { value: 0, kind: "known" },
    version: threadVersion(thread),
    body: true,
  });
}

function skeletonNode(
  context: CodexContext,
  locator: CodexHistoryLocator,
  input: {
    readonly nodeId: string;
    readonly parentId: string | null;
    readonly title: string;
    readonly kind: string;
    readonly childCount: SkeletonNode["childCount"];
    readonly version: string;
    readonly body: boolean;
  },
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: context.source.sourceId,
    nodeId: input.nodeId,
    parentId: input.parentId,
    kind: input.kind,
    title: input.title,
    locator: encodeLocator(locator),
    childCount: input.childCount,
    modifiedRange: null,
    permission: "readable",
    scanability: input.body ? "metadata-and-body" : "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: null, kind: "unknown" },
    nodeVersion: input.version,
  };
}

function renderThreadMarkdown(thread: ThreadMetadata): Uint8Array {
  const lines = [
    `# Codex thread \`${thread.id}\``,
    "",
    `- Project: ${JSON.stringify(thread.cwd)}`,
    `- Source: ${JSON.stringify(thread.sourceKind)}`,
    `- Status: ${JSON.stringify(thread.status)}`,
    `- Created: ${new Date(thread.createdAt * 1_000).toISOString()}`,
    `- Updated: ${new Date(thread.updatedAt * 1_000).toISOString()}`,
  ];
  for (const [index, turn] of thread.turns.entries()) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      throw codexError("CODEX_BODY_INVALID", "The Codex thread contained an invalid turn");
    }
    lines.push("", `## Turn ${index + 1}`);
    for (const item of turn.items) {
      if (!isRecord(item)) throw codexError("CODEX_BODY_INVALID", "The Codex thread contained an invalid item");
      if (item.type === "userMessage") {
        if (!Array.isArray(item.content)) throw codexError("CODEX_BODY_INVALID", "The Codex user message was invalid");
        const text = item.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? [normalizedBodyText(part.text)] : []);
        if (text.length > 0) lines.push("", "### User", "", text.join("\n\n"));
      } else if (item.type === "agentMessage") {
        if (typeof item.text !== "string") throw codexError("CODEX_BODY_INVALID", "The Codex assistant message was invalid");
        lines.push("", "### Assistant", "", normalizedBodyText(item.text));
      } else if (item.type === "plan") {
        if (typeof item.text !== "string") throw codexError("CODEX_BODY_INVALID", "The Codex plan message was invalid");
        lines.push("", "### Plan", "", normalizedBodyText(item.text));
      }
    }
  }
  const markdown = `${lines.join("\n")}\n`;
  if (!wellFormedUtf16(markdown)) throw codexError("CODEX_BODY_INVALID", "The Codex thread body was not valid UTF-8 text");
  return Buffer.from(markdown, "utf8");
}

function normalizedBodyText(value: string): string {
  if (!wellFormedUtf16(value)) throw codexError("CODEX_BODY_INVALID", "The Codex message body was not valid UTF-8 text");
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

async function* bytesAsChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += BODY_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, bytes.byteLength));
  }
}

function assertBodyBinding(options: ProgressiveConnectorReadOptions): void {
  const target = options.bodyReadGate.path.at(-1);
  if (options.bodyReadGate.authorization.authorizationHash !== options.authorizationHash
    || options.bodyReadGate.authorization.sourceId !== options.sourceId
    || options.bodyReadGate.plan.scanPlanHash !== options.plan.scanPlanHash
    || options.bodyReadGate.request.nodeId !== options.node.nodeId
    || options.bodyReadGate.request.nodeVersion !== options.node.nodeVersion
    || target === undefined || sha256Canonical(target) !== sha256Canonical(options.node)
    || options.expectedVersion !== options.node.nodeVersion) {
    throw codexError("CODEX_BODY_BINDING_INVALID", "The Codex History body node, path, plan or version binding is invalid");
  }
}

function assertActionBinding(binding: ProgressiveConnectorBinding): void {
  assertScanPlan(binding.plan);
  const { authorizationHash, ...payload } = binding.source;
  const sourceIndex = binding.plan.sourceIds.indexOf(binding.sourceId);
  if (binding.source.connectorType !== "codex-history" || sha256Canonical(payload) !== authorizationHash
    || binding.sourceId !== binding.source.sourceId || binding.authorizationHash !== authorizationHash
    || binding.rootNodeId !== binding.source.rootNodeId || binding.scopeHash !== progressiveConnectorScopeHash(binding.source)
    || sourceIndex < 0 || binding.plan.authorizationHashes[sourceIndex] !== binding.authorizationHash
    || binding.plan.rootNodeIds[sourceIndex] !== binding.rootNodeId) {
    throw codexError("CODEX_ACTION_BINDING_INVALID", "Codex History action binding is invalid or stale");
  }
  parseCodexHistoryScope(binding.source.scope);
}

function assertNodeBinding(context: CodexContext, node: SkeletonNode): void {
  if (node.sourceId !== context.source.sourceId) throw codexError("CODEX_ACTION_BINDING_INVALID", "Codex History node Source binding is invalid");
  const locator = parseLocator(node.locator, context.scope);
  const expectedId = locator.kind === "source-root" ? context.source.rootNodeId
    : locator.kind === "project" ? projectNodeId(context, locator.projectRoot!)
      : threadNodeId(context, locator.projectRoot!, locator.threadId!);
  const expectedParent = locator.kind === "source-root" ? null
    : locator.kind === "project" ? context.source.rootNodeId : projectNodeId(context, locator.projectRoot!);
  if (node.nodeId !== expectedId || node.parentId !== expectedParent) {
    throw codexError("CODEX_ACTION_BINDING_INVALID", "Codex History node identity binding is invalid");
  }
}

function assertEffectiveScope(context: CodexContext, node: SkeletonNode, locator: CodexHistoryLocator): void {
  const path = locator.kind === "source-root" ? "/"
    : locator.kind === "project" ? projectLogicalPath(locator.projectRoot!)
      : threadLogicalPath(locator.projectRoot!, locator.threadId!);
  if (!scopePermits(context, path, locator.kind !== "thread") || node.permission !== "readable") {
    throw codexError("CODEX_SCOPE_DENIED", "The Codex History node is outside the effective Source and Scan Plan scope");
  }
}

function assertTraversalBinding(options: ProgressiveConnectorChildrenOptions): void {
  assertEnumerationIntent(options.intent, { plan: options.plan, trustedDecisionReceipts: options.trustedDecisionReceipts });
  if (!options.trustedReceiptHashes.includes(options.intent.receiptHash)
    || options.trustedDecisionReceipts.some(({ receiptHash }) => !options.trustedReceiptHashes.includes(receiptHash))
    || options.intent.sourceId !== options.sourceId || options.intent.authorizationHash !== options.authorizationHash
    || options.intent.targetNodeId !== options.parent.nodeId || options.intent.targetNodeVersion !== options.parent.nodeVersion) {
    throw codexError("CODEX_TRAVERSAL_DENIED", "Codex History enumeration intent is absent, untrusted or mismatched");
  }
  const previous = options.previousPageReceipt;
  if (options.cursor === null) {
    if (previous !== null) throw codexError("CODEX_PAGE_CHAIN_INVALID", "The first Codex History page cannot claim a previous receipt");
    return;
  }
  if (previous === null || !options.trustedReceiptHashes.includes(previous.receiptHash)) {
    throw codexError("CODEX_PAGE_CHAIN_INVALID", "A trusted previous Codex History page receipt is required");
  }
  const { receiptHash, ...payload } = previous;
  if (sha256Canonical(payload) !== receiptHash || previous.scanId !== options.plan.scanId
    || previous.scanPlanHash !== options.plan.scanPlanHash || previous.skeletonVersion !== options.plan.skeletonVersion
    || previous.sourceId !== options.sourceId || previous.intentId !== options.intent.intentId
    || previous.nextCursor !== options.cursor || previous.state !== "open") {
    throw codexError("CODEX_PAGE_CHAIN_INVALID", "The previous Codex History page receipt is invalid or stale");
  }
}

function assertPageChain(options: ProgressiveConnectorChildrenOptions, sequence: number): void {
  if (options.previousPageReceipt !== null && options.previousPageReceipt.pageSequence + 1 !== sequence) {
    throw codexError("CODEX_PAGE_CHAIN_INVALID", "Codex History page sequence is not contiguous");
  }
}

function projectNodeId(context: CodexContext, projectRoot: string): string {
  return sha256Canonical({ provider: "codex-history-project-id", sourceId: context.source.sourceId, projectRoot });
}

function threadNodeId(context: CodexContext, projectRoot: string, threadId: string): string {
  return sha256Canonical({ provider: "codex-history-thread-id", sourceId: context.source.sourceId, projectRoot, threadId });
}

function projectLogicalPath(projectRoot: string): string {
  return `/project/${sha256Canonical(projectRoot).slice("sha256:".length, "sha256:".length + 16)}`;
}

function threadLogicalPath(projectRoot: string, threadId: string): string {
  return `${projectLogicalPath(projectRoot)}/thread/${threadId}`;
}

function encodeLocator(locator: CodexHistoryLocator): string {
  return `openlifewiki-codex-history://node/${Buffer.from(JSON.stringify(locator), "utf8").toString("base64url")}`;
}

function parseLocator(raw: string, scope: CodexHistoryScope): CodexHistoryLocator {
  try {
    const url = new URL(raw);
    const value = JSON.parse(Buffer.from(url.pathname.slice(1), "base64url").toString("utf8")) as unknown;
    if (url.protocol !== "openlifewiki-codex-history:" || url.hostname !== "node" || !isRecord(value)
      || value.schema !== "openlifewiki.locator/codex-history/v1"
      || (value.kind !== "source-root" && value.kind !== "project" && value.kind !== "thread")
      || !(value.projectRoot === null || typeof value.projectRoot === "string")
      || !(value.threadId === null || typeof value.threadId === "string")) throw new Error();
    const locator = value as unknown as CodexHistoryLocator;
    if (locator.kind === "source-root" && (locator.projectRoot !== null || locator.threadId !== null)) throw new Error();
    if (locator.kind === "project" && (locator.projectRoot === null || locator.threadId !== null
      || !scope.projectRoots.includes(locator.projectRoot))) throw new Error();
    if (locator.kind === "thread" && (locator.projectRoot === null || locator.threadId === null
      || !scope.projectRoots.includes(locator.projectRoot) || !scope.threadIds.includes(locator.threadId))) throw new Error();
    return locator;
  } catch {
    throw codexError("CODEX_ACTION_BINDING_INVALID", "Codex History node locator is invalid or outside the approved scope");
  }
}

function parseCodexHistoryScope(scope: Readonly<Record<string, unknown>>): CodexHistoryScope {
  if (scope.schema !== "openlifewiki.scope/codex-history/v1"
    || Object.keys(scope).some((key) => !["schema", "projectRoots", "threadIds"].includes(key))
    || !stringArray(scope.projectRoots) || !stringArray(scope.threadIds)
    || scope.projectRoots.length === 0 || scope.threadIds.length === 0
    || new Set(scope.projectRoots).size !== scope.projectRoots.length
    || new Set(scope.threadIds).size !== scope.threadIds.length
    || scope.projectRoots.some((root) => !isAbsolute(root) || normalize(root) !== root)
    || scope.threadIds.some((id) => !safeThreadId(id))) {
    throw codexError("CODEX_SCOPE_INVALID", "Codex History scope requires normalized project roots and explicit thread IDs");
  }
  return { schema: "openlifewiki.scope/codex-history/v1", projectRoots: [...scope.projectRoots], threadIds: [...scope.threadIds] };
}

function safeThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

type DecodedCursor = Pick<CursorPayload, "mode" | "offset" | "platformCursor" | "pageSequence">;

function cursorExpected(options: ProgressiveConnectorChildrenOptions): Omit<CursorPayload, "schema" | "mode" | "offset" | "platformCursor" | "pageSequence"> {
  return {
    sourceId: options.sourceId, scanPlanHash: options.plan.scanPlanHash, skeletonVersion: options.plan.skeletonVersion,
    intentId: options.intent.intentId, scopeHash: options.scopeHash, parentNodeId: options.parent.nodeId,
    parentNodeVersion: options.parent.nodeVersion,
  };
}

function cursorPayload(
  options: ProgressiveConnectorChildrenOptions,
  mode: CursorPayload["mode"],
  offset: number,
  platformCursor: string | null,
  pageSequence: number,
): CursorPayload {
  return { schema: "openlifewiki.codex-history-cursor/v1", ...cursorExpected(options), mode, offset, platformCursor, pageSequence };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ payload, hash: sha256Canonical(payload) }), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null,
  expected: ReturnType<typeof cursorExpected>,
  initialMode: CursorPayload["mode"],
): DecodedCursor {
  if (cursor === null) return { mode: initialMode, offset: 0, platformCursor: null, pageSequence: 1 };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { payload?: CursorPayload; hash?: string };
    const payload = value.payload;
    if (payload === undefined || payload.schema !== "openlifewiki.codex-history-cursor/v1"
      || value.hash !== sha256Canonical(payload) || payload.sourceId !== expected.sourceId
      || payload.scanPlanHash !== expected.scanPlanHash || payload.skeletonVersion !== expected.skeletonVersion
      || payload.intentId !== expected.intentId || payload.scopeHash !== expected.scopeHash
      || payload.parentNodeId !== expected.parentNodeId || payload.parentNodeVersion !== expected.parentNodeVersion
      || (payload.mode !== "projects" && payload.mode !== "threads") || !Number.isSafeInteger(payload.offset)
      || payload.offset < 0 || !(payload.platformCursor === null || typeof payload.platformCursor === "string")
      || !Number.isSafeInteger(payload.pageSequence) || payload.pageSequence < 2) throw new Error();
    return payload;
  } catch {
    throw invalidCursor();
  }
}

function scopePermits(context: CodexContext, path: string, container: boolean): boolean {
  const included = (patterns: readonly string[]) => patterns.some((pattern) => includeMatches(path, normalizePattern(pattern), container));
  const excluded = [...context.source.exclude, ...context.plan.policy.exclude]
    .some((pattern) => matchesSimpleGlob(path, normalizePattern(pattern)));
  const sensitivity = context.source.sensitivity.rules.find(({ match }) => matchesSimpleGlob(path, normalizePattern(match)))?.level
    ?? context.source.sensitivity.default;
  return included(context.source.include) && included(context.plan.policy.include) && !excluded
    && (sensitivity === "normal" || context.plan.policy.sensitivity === "sensitive");
}

function includeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesSimpleGlob(path, pattern)) return true;
  if (!container) return false;
  const prefix = fixedGlobPrefix(pattern);
  return prefix === path || prefix.startsWith(path === "/" ? "/" : `${path}/`)
    || pattern.includes("**") && prefix === "/";
}

function matchesSimpleGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "u").test(path);
}

function fixedGlobPrefix(pattern: string): string {
  const wildcard = pattern.search(/[?*[\]{}()]/u);
  const fixed = (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/+$/u, "");
  return fixed.length === 0 ? "/" : fixed;
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function skeletonPage(
  options: ProgressiveConnectorListOptions,
  parentNodeId: string,
  nodes: readonly SkeletonNode[],
  nextCursor: string | null,
  pageComplete: boolean,
): SkeletonPage {
  return {
    schema: "openlifewiki.skeleton-page/v1", sourceId: options.sourceId, parentNodeId,
    requestScopeHash: options.scopeHash, nodes, nextCursor, pageComplete,
    observedAt: options.now().toISOString(), skeletonVersion: options.plan.skeletonVersion,
  };
}

function withPage(node: SkeletonNode, cursor: string | null, hasMore: boolean): SkeletonNode {
  return { ...node, page: { cursor, hasMore } };
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw codexError("CODEX_LIMIT_INVALID", `Codex History page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false;
  }
  return true;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function outputLimitExceeded(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) return false;
    if ("code" in current && current.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function isProgressiveProbe(
  options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions,
): options is ProgressiveConnectorProbeOptions {
  return "authorizationHash" in options && "scopeHash" in options;
}

function invalidCursor(): Error & { readonly code: string } {
  return codexError("CODEX_CURSOR_INVALID", "Codex History continuation cursor is invalid or stale");
}

function codexError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

interface CodexAccount {
  readonly type: "chatgpt";
  readonly email: string;
  readonly planType: string | null;
}

async function readCodexAccount(runner: CommandRunner): Promise<CodexAccount> {
  if (runner.runJsonLineSession === undefined) {
    throw new Error("Command runner does not support staged JSONL sessions");
  }
  const responses = await runner.runJsonLineSession("codex", ["app-server", "--stdio"], [
    {
      message: {
        method: "initialize", id: 0,
        params: { clientInfo: { name: "openlifewiki", title: "openLifeWiki", version: "0.1.0-dev.1" } },
      },
      awaitResponseId: 0,
    },
    { message: { method: "initialized", params: {} } },
    { message: { method: "account/read", id: 1, params: { refreshToken: false } }, awaitResponseId: 1 },
  ], { env: safeEnvironment(), timeoutMs: 30_000 });
  for (const value of responses) {
    if (!isRecord(value) || value.id !== 1 || !isRecord(value.result) || !isRecord(value.result.account)) continue;
    const account = value.result.account;
    if (account.type !== "chatgpt" || typeof account.email !== "string"
      || (account.planType !== undefined && account.planType !== null && typeof account.planType !== "string")) break;
    const email = account.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/u.test(email)) break;
    return { type: "chatgpt", email, planType: typeof account.planType === "string" ? account.planType : null };
  }
  throw new Error("Codex account/read returned no stable ChatGPT identity");
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${redacted(local ?? "account")}@${domain ?? "hidden"}`;
}

interface SchemaDocument {
  readonly path: string;
  readonly value: unknown;
}

async function readJsonTree(root: string): Promise<readonly SchemaDocument[]> {
  const parts: SchemaDocument[] = [];
  await walk(root, root, parts);
  return parts;
}

async function walk(root: string, directory: string, parts: SchemaDocument[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, parts);
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      parts.push({ path: relative(root, path).replaceAll("\\", "/"), value: JSON.parse(await readFile(path, "utf8")) as unknown });
    }
  }
}

function hasRequiredAppServerV2Schema(documents: readonly SchemaDocument[]): boolean {
  const list = documents.find(({ path }) => path === "v2/ThreadListParams.json");
  const read = documents.find(({ path }) => path === "v2/ThreadReadParams.json");
  const clientRequests = documents.filter(({ path }) => path.endsWith("ClientRequest.json"));
  if (list === undefined || read === undefined || clientRequests.length === 0) return false;
  const listProperties = schemaProperties(list.value);
  const readProperties = schemaProperties(read.value);
  if (listProperties === undefined || readProperties === undefined) return false;
  return clientRequests.some(({ value }) => declaresMethod(value, "thread/list"))
    && clientRequests.some(({ value }) => declaresMethod(value, "thread/read"))
    && propertyAllowsType(listProperties.cwd, "string", list.value)
    && propertyAllowsType(listProperties.cursor, "string", list.value)
    && propertyAllowsType(listProperties.useStateDbOnly, "boolean", list.value)
    && propertyAllowsType(readProperties.threadId, "string", read.value)
    && propertyAllowsType(readProperties.includeTurns, "boolean", read.value);
}

function schemaProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.properties)) return value.properties;
  for (const child of Object.values(value)) {
    const found = schemaProperties(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function propertyAllowsType(
  value: unknown,
  expected: "string" | "boolean",
  root: unknown,
  resolving = new Set<string>(),
): boolean {
  if (!isRecord(value)) return false;
  if (value.type === expected) return true;
  if (Array.isArray(value.type) && value.type.includes(expected)) return true;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    if (resolving.has(value.$ref)) return false;
    const resolved = resolveLocalReference(root, value.$ref);
    if (resolved === undefined) return false;
    resolving.add(value.$ref);
    const allowed = propertyAllowsType(resolved, expected, root, resolving);
    resolving.delete(value.$ref);
    if (allowed) return true;
  }
  return Object.values(value).some((child) => Array.isArray(child)
    ? child.some((item) => propertyAllowsType(item, expected, root, resolving))
    : propertyAllowsType(child, expected, root, resolving));
}

function resolveLocalReference(root: unknown, reference: string): unknown {
  let current = root;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function declaresMethod(value: unknown, method: string): boolean {
  if (Array.isArray(value)) return value.some((item) => declaresMethod(item, method));
  if (!isRecord(value)) return false;
  if (isRecord(value.properties) && isRecord(value.properties.method)) {
    const schema = value.properties.method;
    if (schema.const === method || (Array.isArray(schema.enum) && schema.enum.includes(method))) return true;
  }
  return Object.values(value).some((item) => declaresMethod(item, method));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
