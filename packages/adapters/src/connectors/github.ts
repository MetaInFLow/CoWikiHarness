import { TextDecoder } from "node:util";

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

const PROVIDER_NAME = "gh";
const PROVIDER_PROJECT = "cli/cli";
const MAX_PAGE_SIZE = 500;
const BODY_CHUNK_BYTES = 64 * 1024;
const GITHUB_SCOPE_QUERY = "query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){nameWithOwner object(expression:$expression){__typename oid ... on Commit{tree{oid}} ... on Blob{byteSize isBinary}}}}";
const SAFE_ENV_NAMES = [
  "GH_CONFIG_DIR", "HOME", "LANG", "LC_ALL", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME",
] as const;

interface GithubScope {
  readonly schema: "openlifewiki.scope/github/v1";
  readonly hostname: string;
  readonly repository: string;
  readonly ref: string;
  readonly path: string | null;
}

interface ResolvedObject {
  readonly kind: "directory" | "file";
  readonly oid: string;
  readonly size: number | null;
}

interface TreeEntry {
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly sha: string;
  readonly size: number | null;
}

interface CursorPayload {
  readonly schema: "openlifewiki.github-cursor/v1";
  readonly sourceId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly intentId: string;
  readonly scopeHash: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly offset: number;
  readonly pageSequence: number;
}

export function createGithubConnector(
  progressiveRunner: CommandRunner = nodeCommandRunner,
): ConnectorProvider & ProgressiveConnectorProvider {
  return {
    connectorType: "github",

    async probe(options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions) {
      const runner = isProgressiveProbe(options) ? progressiveRunner : options.runner;
      if (isProgressiveProbe(options)) assertActionBinding(options);
      return await probeGithub(options.source, runner, options.now);
    },

    async listRootsMetadata(options) {
      const context = await githubContext(options, progressiveRunner);
      validateLimit(options.limit);
      if (options.cursor !== null) {
        throw githubError("GITHUB_CURSOR_INVALID", "GitHub root metadata has no continuation cursor");
      }
      const resolved = await resolveScopedObject(context, context.scope.path);
      const relativePath = "";
      const readable = scopePermits(context.source, context.plan, relativePath, resolved.kind === "directory");
      const node = githubNode(context, {
        nodeId: options.rootNodeId,
        parentId: null,
        repoPath: context.scope.path,
        title: context.scope.path?.split("/").at(-1) ?? context.scope.repository,
        object: resolved,
        readable,
      });
      return skeletonPage(options, options.rootNodeId, [node], null, true);
    },

    async listChildrenMetadata(options) {
      const context = await githubContext(options, progressiveRunner);
      validateLimit(options.limit);
      assertNodeBinding(options, options.parent);
      assertTraversalBinding(options);
      const locator = parseLocator(options.parent.locator, context.scope);
      if (locator.kind !== "directory") {
        throw githubError("GITHUB_PARENT_BLOCKED", "The GitHub parent is not an enumerable tree");
      }
      const current = await resolveScopedObject(context, locator.path);
      if (current.kind !== "directory" || current.oid !== options.parent.nodeVersion) {
        throw githubError("GITHUB_NODE_CHANGED", "The GitHub tree changed before enumeration");
      }
      const cursor = decodeCursor(options.cursor, {
        sourceId: options.sourceId,
        scanPlanHash: options.plan.scanPlanHash,
        skeletonVersion: options.plan.skeletonVersion,
        intentId: options.intent.intentId,
        scopeHash: options.scopeHash,
        parentNodeId: options.parent.nodeId,
        parentNodeVersion: options.parent.nodeVersion,
      });
      if (options.previousPageReceipt !== null
        && options.previousPageReceipt.pageSequence + 1 !== cursor.pageSequence) {
        throw githubError("GITHUB_PAGE_CHAIN_INVALID", "GitHub page sequence is not contiguous");
      }
      const entries = await listTree(context, options.parent.nodeVersion);
      const eligible = entries.filter((entry) => {
        const repoPath = joinRepoPath(locator.path, entry.path);
        return isInsideAuthorizedPath(context.scope.path, repoPath)
          && scopePermits(
            context.source,
            context.plan,
            relativeToAuthorizedRoot(context.scope.path, repoPath),
            entry.type === "tree",
          );
      });
      if (cursor.offset > eligible.length) {
        throw githubError("GITHUB_CURSOR_INVALID", "GitHub cursor is outside the current direct-child set");
      }
      const selected = eligible.slice(cursor.offset, cursor.offset + options.limit);
      const nextOffset = cursor.offset + selected.length;
      const hasMore = nextOffset < eligible.length;
      const nextCursor = hasMore ? encodeCursor({
        schema: "openlifewiki.github-cursor/v1",
        sourceId: options.sourceId,
        scanPlanHash: options.plan.scanPlanHash,
        skeletonVersion: options.plan.skeletonVersion,
        intentId: options.intent.intentId,
        scopeHash: options.scopeHash,
        parentNodeId: options.parent.nodeId,
        parentNodeVersion: options.parent.nodeVersion,
        offset: nextOffset,
        pageSequence: cursor.pageSequence + 1,
      }) : null;
      const nodes = selected.map((entry) => {
        const repoPath = joinRepoPath(locator.path, entry.path);
        return withPage(githubNode(context, {
          nodeId: logicalNodeId(context, repoPath),
          parentId: options.parent.nodeId,
          repoPath,
          title: entry.path,
          object: {
            kind: entry.type === "tree" ? "directory" : "file",
            oid: entry.sha,
            size: entry.size,
          },
          readable: true,
        }), options.cursor, hasMore);
      });
      return skeletonPage(options, options.parent.nodeId, nodes, nextCursor, !hasMore);
    },

    async getVersion(options) {
      const context = await githubContext(options, progressiveRunner);
      assertNodeBinding(options, options.node);
      const locator = parseLocator(options.node.locator, context.scope);
      const current = await resolveScopedObject(context, locator.path);
      return current.oid;
    },

    async readApprovedLeafBody(options) {
      const context = await githubContext(options, progressiveRunner);
      assertNodeBinding(options, options.node);
      assertBodyReadAllowed(options.bodyReadGate);
      const gateTarget = options.bodyReadGate.path.at(-1);
      if (options.bodyReadGate.authorization.authorizationHash !== options.authorizationHash
        || options.bodyReadGate.authorization.sourceId !== options.sourceId
        || options.bodyReadGate.plan.scanPlanHash !== options.plan.scanPlanHash
        || options.bodyReadGate.request.nodeId !== options.node.nodeId
        || options.bodyReadGate.request.nodeVersion !== options.node.nodeVersion
        || gateTarget === undefined
        || sha256Canonical(gateTarget) !== sha256Canonical(options.node)
        || options.expectedVersion !== options.node.nodeVersion) {
        throw githubError("GITHUB_BODY_BINDING_INVALID", "The GitHub body node, path, plan or version binding is invalid");
      }
      const locator = parseLocator(options.node.locator, context.scope);
      if (locator.kind !== "file" || options.node.scanability !== "metadata-and-body") {
        throw githubError("GITHUB_BODY_READ_DENIED", "The selected GitHub node is not an approved readable blob");
      }
      const current = await resolveScopedObject(context, locator.path);
      if (current.kind !== "file" || current.oid !== options.expectedVersion) {
        throw githubError("GITHUB_VERSION_MISMATCH", "The GitHub blob changed before body read");
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
        throw githubError("GITHUB_BODY_BUDGET_INVALID", "The GitHub body budget permit is invalid or untrusted");
      }
      if (current.size === null || current.size > options.budgetReservation.reservedBytes) {
        throw githubError("GITHUB_BODY_BUDGET_EXCEEDED", "The selected GitHub blob exceeds the approved body budget");
      }
      const bytes = await readBlob(context, options.expectedVersion, options.budgetReservation.reservedBytes);
      return {
        sourceId: options.sourceId,
        nodeId: options.node.nodeId,
        nodeVersion: options.expectedVersion,
        stream: bytesAsChunks(bytes),
      };
    },
  };
}

export const githubConnector = createGithubConnector();

async function probeGithub(
  source: ConnectorProbeOptions["source"],
  runner: CommandRunner,
  now: () => Date,
): Promise<ConnectorStatus> {
  const observedAt = now().toISOString();
  let scope: GithubScope;
  try {
    scope = parseGithubScope(source.scope);
  } catch {
    return blockedStatus(source, observedAt, "GITHUB_SCOPE_INVALID", "Review the approved GitHub scope");
  }
  let version: string | undefined;
  try {
    const result = await runner.run("gh", ["--version"], { env: githubEnvironment(), timeoutMs: 15_000 });
    version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (version === undefined) {
      return blockedStatus(source, observedAt, "GITHUB_VERSION_INVALID", "Install a supported GitHub CLI release");
    }
  } catch (error) {
    const kind = commandFailureKind(error);
    return baseStatus(source, observedAt, version, kind === "missing" ? "missing" : "blocked", null,
      safeBlocking(kind === "missing" ? "GITHUB_CLI_MISSING" : kind === "timeout"
        ? "GITHUB_PROVIDER_TIMEOUT" : "GITHUB_PROVIDER_FAILED", "Install GitHub CLI and sign in"));
  }
  let login: string | undefined;
  try {
    const auth = await runner.run("gh", ["auth", "status", "--active", "--hostname", scope.hostname, "--json", "hosts"], {
      env: githubEnvironment(scope.hostname), timeoutMs: 20_000,
    });
    login = activeGithubLogin(auth.stdout, scope.hostname);
  } catch {
    return baseStatus(source, observedAt, version, "blocked", null,
      safeBlocking("GITHUB_AUTH_CHECK_FAILED", "Retry the GitHub authentication check"));
  }
  if (login === undefined) {
    return baseStatus(source, observedAt, version, "auth-required", null,
      safeBlocking("GITHUB_AUTH_REQUIRED", "Sign in to the approved GitHub host"));
  }
  try {
    const object = await resolveGithubObject(runner, scope, scope.path);
    if (object === null) {
      return baseStatus(source, observedAt, version, "blocked", null,
        safeBlocking("GITHUB_SCOPE_MISMATCH", "Review the approved repository, path and ref"));
    }
  } catch {
    return baseStatus(source, observedAt, version, "blocked", null,
      safeBlocking("GITHUB_SCOPE_CHECK_FAILED", "Retry the approved repository, path and ref metadata check"));
  }
  const fingerprint = sha256Canonical({ provider: "github", hostname: scope.hostname, login });
  return baseStatus(source, observedAt, version, "connected", {
    account: redacted(login), host: scope.hostname, fingerprint,
  }, null);
}

async function githubContext(binding: ProgressiveConnectorBinding, runner: CommandRunner): Promise<{
  readonly source: AuthorizedSourceV1;
  readonly plan: ProgressiveConnectorBinding["plan"];
  readonly scope: GithubScope;
  readonly runner: CommandRunner;
}> {
  assertActionBinding(binding);
  const scope = parseGithubScope(binding.source.scope);
  let version: string;
  let login: string;
  try {
    const versionResult = await runner.run("gh", ["--version"], { env: githubEnvironment(), timeoutMs: 15_000 });
    const parsed = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (parsed === undefined) throw new Error();
    version = parsed;
    const auth = await runner.run("gh", ["auth", "status", "--active", "--hostname", scope.hostname, "--json", "hosts"], {
      env: githubEnvironment(scope.hostname), timeoutMs: 20_000,
    });
    const active = activeGithubLogin(auth.stdout, scope.hostname);
    if (active === undefined) throw new Error();
    login = active;
  } catch (error) {
    const kind = commandFailureKind(error);
    throw githubError(kind === "missing" ? "GITHUB_CLI_MISSING" : kind === "timeout"
      ? "GITHUB_PROVIDER_TIMEOUT" : "GITHUB_AUTH_REQUIRED", "The approved GitHub CLI session is unavailable");
  }
  const fingerprint = sha256Canonical({ provider: "github", hostname: scope.hostname, login });
  const observation = binding.source.providerObservation;
  if (fingerprint !== binding.source.identityFingerprint
    || observation !== undefined
      && (observation.providerName !== PROVIDER_NAME || observation.providerVersion !== version)) {
    throw githubError("GITHUB_IDENTITY_CHANGED", "The approved GitHub identity or provider version changed");
  }
  return { source: binding.source, plan: binding.plan, scope, runner };
}

function assertActionBinding(binding: ProgressiveConnectorBinding): void {
  assertScanPlan(binding.plan);
  const { authorizationHash, ...authorizationPayload } = binding.source;
  const sourceIndex = binding.plan.sourceIds.indexOf(binding.sourceId);
  if (binding.source.connectorType !== "github"
    || sha256Canonical(authorizationPayload) !== authorizationHash
    || binding.sourceId !== binding.source.sourceId
    || binding.authorizationHash !== authorizationHash
    || binding.rootNodeId !== binding.source.rootNodeId
    || binding.scopeHash !== progressiveConnectorScopeHash(binding.source)
    || sourceIndex < 0
    || binding.plan.authorizationHashes[sourceIndex] !== binding.authorizationHash
    || binding.plan.rootNodeIds[sourceIndex] !== binding.rootNodeId) {
    throw githubError("GITHUB_ACTION_BINDING_INVALID", "GitHub action binding is invalid or stale");
  }
  parseGithubScope(binding.source.scope);
}

function assertNodeBinding(binding: ProgressiveConnectorBinding, node: SkeletonNode): void {
  if (node.sourceId !== binding.sourceId) {
    throw githubError("GITHUB_ACTION_BINDING_INVALID", "GitHub node Source binding is invalid");
  }
}

function assertTraversalBinding(options: ProgressiveConnectorChildrenOptions): void {
  assertEnumerationIntent(options.intent, { plan: options.plan, trustedDecisionReceipts: options.trustedDecisionReceipts });
  if (!options.trustedReceiptHashes.includes(options.intent.receiptHash)
    || options.trustedDecisionReceipts.some(({ receiptHash }) => !options.trustedReceiptHashes.includes(receiptHash))
    || options.intent.sourceId !== options.sourceId
    || options.intent.authorizationHash !== options.authorizationHash
    || options.intent.targetNodeId !== options.parent.nodeId
    || options.intent.targetNodeVersion !== options.parent.nodeVersion) {
    throw githubError("GITHUB_TRAVERSAL_DENIED", "GitHub enumeration intent is absent, untrusted or mismatched");
  }
  const previous = options.previousPageReceipt;
  if (options.cursor === null) {
    if (previous !== null) throw githubError("GITHUB_PAGE_CHAIN_INVALID", "The first GitHub page cannot claim a previous receipt");
    return;
  }
  if (previous === null || !options.trustedReceiptHashes.includes(previous.receiptHash)) {
    throw githubError("GITHUB_PAGE_CHAIN_INVALID", "A trusted previous GitHub page receipt is required");
  }
  const { receiptHash, ...payload } = previous;
  if (sha256Canonical(payload) !== receiptHash
    || previous.scanId !== options.plan.scanId
    || previous.scanPlanHash !== options.plan.scanPlanHash
    || previous.skeletonVersion !== options.plan.skeletonVersion
    || previous.sourceId !== options.sourceId
    || previous.intentId !== options.intent.intentId
    || previous.nextCursor !== options.cursor
    || previous.state !== "open") {
    throw githubError("GITHUB_PAGE_CHAIN_INVALID", "The previous GitHub page receipt is invalid or stale");
  }
}

async function resolveScopedObject(
  context: Awaited<ReturnType<typeof githubContext>>,
  repoPath: string | null,
): Promise<ResolvedObject> {
  const resolved = await resolveGithubObject(context.runner, context.scope, repoPath);
  if (resolved === null) throw githubError("GITHUB_NODE_CHANGED", "The approved GitHub object no longer resolves");
  return resolved;
}

async function resolveGithubObject(
  runner: CommandRunner,
  scope: GithubScope,
  repoPath: string | null,
): Promise<ResolvedObject | null> {
  const [owner, name] = scope.repository.split("/");
  const expression = repoPath === null ? scope.ref : `${scope.ref}:${repoPath}`;
  let result;
  try {
    result = await runner.run("gh", [
      "api", "graphql", "-f", `query=${GITHUB_SCOPE_QUERY}`,
      "-F", `owner=${owner ?? ""}`, "-F", `name=${name ?? ""}`, "-F", `expression=${expression}`,
    ], { env: githubEnvironment(scope.hostname), timeoutMs: 20_000 });
  } catch {
    throw githubError("GITHUB_METADATA_FAILED", "GitHub object metadata could not be resolved");
  }
  const value = parseObject(result.stdout);
  const repository = isRecord(value?.data) && isRecord(value.data.repository) ? value.data.repository : null;
  const object = repository !== null && repository.nameWithOwner === scope.repository && isRecord(repository.object)
    ? repository.object : null;
  if (object === null || typeof object.oid !== "string" || object.oid.length === 0) return null;
  if (object.__typename === "Commit") {
    const treeOid = isRecord(object.tree) && typeof object.tree.oid === "string"
      ? object.tree.oid : object.oid;
    return { kind: "directory", oid: treeOid, size: null };
  }
  if (object.__typename === "Tree") return { kind: "directory", oid: object.oid, size: null };
  if (object.__typename === "Blob") {
    const size = Number.isSafeInteger(object.byteSize) && Number(object.byteSize) >= 0 ? Number(object.byteSize) : null;
    return { kind: "file", oid: object.oid, size };
  }
  return null;
}

async function listTree(
  context: Awaited<ReturnType<typeof githubContext>>,
  treeSha: string,
): Promise<readonly TreeEntry[]> {
  const endpoint = `repos/${encodeRepository(context.scope.repository)}/git/trees/${encodeURIComponent(treeSha)}`;
  let result;
  try {
    result = await context.runner.run("gh", ["api", endpoint], {
      env: githubEnvironment(context.scope.hostname), timeoutMs: 30_000,
    });
  } catch {
    throw githubError("GITHUB_ENUMERATION_FAILED", "The GitHub tree layer could not be enumerated");
  }
  const value = parseObject(result.stdout);
  if (value === undefined || value.truncated === true || !Array.isArray(value.tree)) {
    throw githubError("GITHUB_ENUMERATION_INCOMPLETE", "The GitHub tree response was incomplete");
  }
  const entries: TreeEntry[] = [];
  const directPaths = new Set<string>();
  for (const raw of value.tree) {
    if (!isRecord(raw)
      || typeof raw.path !== "string" || raw.path.length === 0 || raw.path.includes("/")
      || (raw.type !== "blob" && raw.type !== "tree")
      || typeof raw.sha !== "string" || raw.sha.length === 0) {
      throw githubError("GITHUB_ENUMERATION_INCOMPLETE", "The GitHub tree response contained an invalid direct child");
    }
    if (directPaths.has(raw.path)) {
      throw githubError("GITHUB_ENUMERATION_INCOMPLETE", "The GitHub tree response contained duplicate direct children");
    }
    directPaths.add(raw.path);
    entries.push({
      path: raw.path,
      type: raw.type,
      sha: raw.sha,
      size: Number.isSafeInteger(raw.size) && Number(raw.size) >= 0 ? Number(raw.size) : null,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return entries;
}

async function readBlob(
  context: Awaited<ReturnType<typeof githubContext>>,
  blobSha: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const endpoint = `repos/${encodeRepository(context.scope.repository)}/git/blobs/${encodeURIComponent(blobSha)}`;
  let result;
  try {
    result = await context.runner.run("gh", ["api", endpoint], {
      env: githubEnvironment(context.scope.hostname), timeoutMs: 30_000,
    });
  } catch {
    throw githubError("GITHUB_BODY_READ_FAILED", "The selected GitHub blob could not be read");
  }
  const value = parseObject(result.stdout);
  if (value === undefined || value.encoding !== "base64" || typeof value.content !== "string"
    || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > maxBytes) {
    throw githubError("GITHUB_BODY_INVALID", "The selected GitHub blob response was invalid or exceeded its budget");
  }
  const compact = value.content.replaceAll(/\r?\n/gu, "");
  if (compact.length === 0 && value.size !== 0
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) {
    throw githubError("GITHUB_BODY_INVALID", "The selected GitHub blob encoding was invalid");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.byteLength !== value.size || bytes.byteLength > maxBytes) {
    throw githubError("GITHUB_BODY_INVALID", "The selected GitHub blob size did not match its metadata");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw githubError("GITHUB_BODY_INVALID", "The selected GitHub blob was not valid UTF-8");
  }
  return bytes;
}

async function* bytesAsChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += BODY_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, bytes.byteLength));
  }
}

function githubNode(
  context: Awaited<ReturnType<typeof githubContext>>,
  input: {
    readonly nodeId: string;
    readonly parentId: string | null;
    readonly repoPath: string | null;
    readonly title: string;
    readonly object: ResolvedObject;
    readonly readable: boolean;
  },
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: context.source.sourceId,
    nodeId: input.nodeId,
    parentId: input.parentId,
    kind: input.object.kind,
    title: input.title,
    locator: githubLocator(context.scope, input.repoPath, input.object.kind),
    childCount: input.object.kind === "directory"
      ? { value: null, kind: "unknown" }
      : { value: 0, kind: "known" },
    modifiedRange: null,
    permission: input.readable ? "readable" : "denied",
    scanability: input.object.kind === "file" && input.readable ? "metadata-and-body" : "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: input.object.kind === "file"
      ? { bytes: input.object.size, kind: input.object.size === null ? "unknown" : "known" }
      : { bytes: null, kind: "unknown" },
    nodeVersion: input.object.oid,
  };
}

function skeletonPage(
  options: ProgressiveConnectorListOptions,
  parentNodeId: string,
  nodes: readonly SkeletonNode[],
  nextCursor: string | null,
  pageComplete: boolean,
): SkeletonPage {
  return {
    schema: "openlifewiki.skeleton-page/v1",
    sourceId: options.sourceId,
    parentNodeId,
    requestScopeHash: options.scopeHash,
    nodes,
    nextCursor,
    pageComplete,
    observedAt: options.now().toISOString(),
    skeletonVersion: options.plan.skeletonVersion,
  };
}

function withPage(node: SkeletonNode, cursor: string | null, hasMore: boolean): SkeletonNode {
  return { ...node, page: { cursor, hasMore } };
}

function logicalNodeId(context: Awaited<ReturnType<typeof githubContext>>, repoPath: string): string {
  return sha256Canonical({
    provider: "github-logical-path",
    hostname: context.scope.hostname,
    repository: context.scope.repository,
    ref: context.scope.ref,
    path: repoPath,
  });
}

function githubLocator(scope: GithubScope, repoPath: string | null, kind: ResolvedObject["kind"]): string {
  const url = new URL(`openlifewiki-github://${scope.hostname}`);
  url.pathname = `/${scope.repository.split("/").map(encodeURIComponent).join("/")}`;
  url.searchParams.set("ref", scope.ref);
  url.searchParams.set("path", repoPath ?? "");
  url.searchParams.set("kind", kind);
  return url.href;
}

function parseLocator(locator: string, scope: GithubScope): { readonly path: string | null; readonly kind: ResolvedObject["kind"] } {
  try {
    const url = new URL(locator);
    const repository = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    const path = normalizeRepoPath(url.searchParams.get("path") ?? "");
    const kind = url.searchParams.get("kind");
    if (url.protocol !== "openlifewiki-github:" || url.hostname !== scope.hostname
      || repository !== scope.repository || url.searchParams.get("ref") !== scope.ref
      || (kind !== "directory" && kind !== "file") || !isInsideAuthorizedPath(scope.path, path)) throw new Error();
    return { path: path.length === 0 ? null : path, kind };
  } catch {
    throw githubError("GITHUB_ACTION_BINDING_INVALID", "GitHub node locator is invalid or outside the approved scope");
  }
}

function parseGithubScope(scope: Readonly<Record<string, unknown>>): GithubScope {
  if (scope.schema !== "openlifewiki.scope/github/v1"
    || typeof scope.hostname !== "string" || scope.hostname.length === 0
    || typeof scope.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(scope.repository)
    || typeof scope.ref !== "string" || scope.ref.length === 0
    || !(scope.path === null || typeof scope.path === "string")) {
    throw githubError("GITHUB_SCOPE_INVALID", "GitHub scope is invalid");
  }
  const path = scope.path === null ? null : normalizeRepoPath(scope.path);
  return {
    schema: "openlifewiki.scope/github/v1",
    hostname: scope.hostname.toLowerCase(),
    repository: scope.repository,
    ref: scope.ref,
    path: path === null || path.length === 0 ? null : path,
  };
}

function normalizeRepoPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  const parts = normalized.length === 0 ? [] : normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw githubError("GITHUB_SCOPE_ESCAPE", "GitHub path escaped the approved scope");
  }
  return parts.join("/");
}

function joinRepoPath(parent: string | null, child: string): string {
  return normalizeRepoPath(parent === null ? child : `${parent}/${child}`);
}

function isInsideAuthorizedPath(root: string | null, candidate: string | null): boolean {
  if (root === null) return true;
  if (candidate === null) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

function relativeToAuthorizedRoot(root: string | null, path: string): string {
  if (root === null) return path;
  if (path === root) return "";
  if (!path.startsWith(`${root}/`)) throw githubError("GITHUB_SCOPE_ESCAPE", "GitHub path escaped the approved root");
  return path.slice(root.length + 1);
}

function scopePermits(
  source: AuthorizedSourceV1,
  plan: ProgressiveConnectorBinding["plan"],
  relativePath: string,
  container: boolean,
): boolean {
  const normalized = relativePath.length === 0 ? "/" : `/${relativePath}`;
  const sourceIncluded = source.include.some((pattern) => includeMatches(normalized, normalizePattern(pattern), container));
  const planIncluded = plan.policy.include.some((pattern) => includeMatches(normalized, normalizePattern(pattern), container));
  const excluded = [...source.exclude, ...plan.policy.exclude]
    .some((pattern) => excludeMatches(normalized, normalizePattern(pattern), container));
  return sourceIncluded && planIncluded && !excluded;
}

function includeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesSimpleGlob(path, pattern)) return true;
  if (!container) return false;
  const prefix = fixedGlobPrefix(pattern);
  return prefix === path || prefix.startsWith(path === "/" ? "/" : `${path}/`)
    || pattern.includes("**") && prefix === "/";
}

function excludeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesSimpleGlob(path, pattern)) return true;
  if (!container) return false;
  const normalized = pattern.replace(/\/+$/u, "");
  return normalized === `${path}/**` || normalized === `${path}/**/*`;
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

function encodeRepository(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw githubError("GITHUB_LIMIT_INVALID", `GitHub page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ payload, hash: sha256Canonical(payload) }), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null,
  expected: Omit<CursorPayload, "schema" | "offset" | "pageSequence">,
): { readonly offset: number; readonly pageSequence: number } {
  if (cursor === null) return { offset: 0, pageSequence: 1 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly payload?: CursorPayload; readonly hash?: string;
    };
    const payload = parsed.payload;
    if (payload === undefined || payload.schema !== "openlifewiki.github-cursor/v1"
      || parsed.hash !== sha256Canonical(payload)
      || payload.sourceId !== expected.sourceId || payload.scanPlanHash !== expected.scanPlanHash
      || payload.skeletonVersion !== expected.skeletonVersion || payload.intentId !== expected.intentId
      || payload.scopeHash !== expected.scopeHash || payload.parentNodeId !== expected.parentNodeId
      || payload.parentNodeVersion !== expected.parentNodeVersion || !Number.isSafeInteger(payload.offset)
      || payload.offset < 0 || !Number.isSafeInteger(payload.pageSequence) || payload.pageSequence < 2) throw new Error();
    return { offset: payload.offset, pageSequence: payload.pageSequence };
  } catch {
    throw githubError("GITHUB_CURSOR_INVALID", "GitHub cursor is invalid or stale");
  }
}

function githubEnvironment(hostname?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(SAFE_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  return hostname === undefined ? env : { ...env, GH_HOST: hostname };
}

function activeGithubLogin(raw: string, hostname: string): string | undefined {
  const value = parseObject(raw);
  const hosts = value?.hosts;
  if (!isRecord(hosts)) return undefined;
  const entries = hosts[hostname];
  if (!Array.isArray(entries)) return undefined;
  const active = entries.find((entry) => isRecord(entry) && entry.active === true);
  return active !== undefined && typeof active.login === "string" ? active.login : undefined;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProgressiveProbe(
  options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions,
): options is ProgressiveConnectorProbeOptions {
  return "authorizationHash" in options && "scopeHash" in options;
}

function baseStatus(
  source: ConnectorProbeOptions["source"],
  observedAt: string,
  version: string | undefined,
  status: ConnectorStatus["status"],
  identity: Readonly<Record<string, string>> | null,
  blocking: ConnectorStatus["blocking"],
): ConnectorStatus {
  return {
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: "github",
    providerName: PROVIDER_NAME,
    providerProject: PROVIDER_PROJECT,
    ...(version === undefined ? {} : { providerVersion: version }),
    identity: identity ?? { account: "unverified" },
    authorizedScope: source.scope,
    status,
    lastProbe: observedAt,
    changedItems: 0,
    blocking,
  };
}

function blockedStatus(
  source: ConnectorProbeOptions["source"],
  observedAt: string,
  code: string,
  remediation: string,
): ConnectorStatus {
  return baseStatus(source, observedAt, undefined, "blocked", null, safeBlocking(code, remediation));
}

function githubError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
