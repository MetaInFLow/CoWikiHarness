import { constants, type Dirent, type Stats } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertBodyReadAllowed } from "@openlifewiki/core";
import {
  sha256Canonical,
  type AuthorizedSourceV1,
  type ConnectorStatus,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import type {
  ConnectorProbeOptions,
  ConnectorProvider,
  ProgressiveConnectorBinding,
  ProgressiveConnectorListOptions,
  ProgressiveConnectorProbeOptions,
  ProgressiveConnectorProvider,
} from "./connector-provider.js";
import {
  progressiveConnectorScopeHash,
  redacted,
  safeBlocking,
} from "./connector-provider.js";

const PROVIDER_NAME = "filesystem-adapter";
const PROVIDER_VERSION = "0.1.0-dev.1";
const MAX_PAGE_SIZE = 500;
const BODY_CHUNK_BYTES = 64 * 1024;

interface LocalScope {
  readonly schema: "openlifewiki.scope/local-folder/v1";
  readonly root: string;
  readonly symlinkPolicy: "deny" | "within-root";
}

interface InspectedNode {
  readonly node: SkeletonNode;
  readonly lexicalPath: string;
  readonly actualPath: string;
  readonly stats: Stats;
}

interface CursorPayload {
  readonly schema: "openlifewiki.local-cursor/v1";
  readonly sourceId: string;
  readonly scopeHash: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly offset: number;
}

export const localFolderConnector: ConnectorProvider & ProgressiveConnectorProvider = {
  connectorType: "local-folder",

  async probe(options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions) {
    if (isProgressiveProbe(options)) assertActionBinding(options);
    const { source, now } = options;
    const observedAt = now().toISOString();
    const scope = parseLocalScope(source.scope);
    try {
      const actual = await realpath(scope.root);
      const details = await stat(actual);
      if (!details.isDirectory()) {
        return status(source, "blocked", "LOCAL_NOT_DIRECTORY", "Choose an authorized directory", observedAt);
      }
      if (scope.symlinkPolicy === "deny" && resolve(scope.root) !== actual) {
        return status(source, "blocked", "LOCAL_SYMLINK_BLOCKED", "Choose the real directory path or narrow the symlink policy", observedAt);
      }
      const fingerprint = sha256Canonical({
        provider: "filesystem", actual, device: String(details.dev), inode: String(details.ino),
      });
      return {
        schema: "openlifewiki.connector-status/v1",
        sourceId: source.sourceId,
        connectorType: "local-folder",
        providerName: PROVIDER_NAME,
        providerProject: "openLifeWiki",
        providerVersion: PROVIDER_VERSION,
        identity: {
          profile: "local",
          account: redacted(actual.split(sep).filter(Boolean).at(-1) ?? "root"),
          fingerprint,
        },
        authorizedScope: source.scope,
        status: "connected",
        lastProbe: observedAt,
        changedItems: 0,
        blocking: null,
      };
    } catch (error) {
      const code = errorCode(error);
      return status(
        source,
        "blocked",
        code === "EACCES" || code === "EPERM" ? "LOCAL_PERMISSION_DENIED" : "LOCAL_UNAVAILABLE",
        "Check the approved local path and read permission",
        observedAt,
      );
    }
  },

  async listRootsMetadata(options) {
    const context = await localContext(options);
    const { offset } = decodeCursor(options.cursor, {
      sourceId: options.sourceId,
      scopeHash: options.scopeHash,
      parentNodeId: options.rootNodeId,
      parentNodeVersion: "authorized-root",
    });
    validateLimit(options.limit);
    if (offset > 1) throw localError("LOCAL_CURSOR_INVALID", "Local Folder cursor is outside the approved root set");
    const inspected = await inspectNode(context, context.scope.root, null, true, null, false);
    if (inspected.node.permission !== "readable" || inspected.node.kind !== "directory") {
      throw localError("LOCAL_ROOT_BLOCKED", "The approved Local Folder root is not readable");
    }
    const nodes = offset === 0 ? [withPage(inspected.node, options.cursor, false)] : [];
    return skeletonPage(options, options.rootNodeId, nodes, null, true);
  },

  async listChildrenMetadata(options) {
    const context = await localContext(options);
    validateLimit(options.limit);
    assertNodeBinding(options, options.parent);
    const parentPath = locatorPath(options.parent.locator);
    const inspectedParent = await inspectNode(
      context,
      parentPath,
      options.parent.parentId,
      options.parent.nodeId === options.rootNodeId,
      options.parent.title,
      true,
    );
    if (inspectedParent.node.nodeId !== options.parent.nodeId
      || inspectedParent.node.nodeVersion !== options.parent.nodeVersion) {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder parent version changed before enumeration");
    }
    if (inspectedParent.node.permission !== "readable" || !inspectedParent.stats.isDirectory()) {
      throw localError("LOCAL_PARENT_BLOCKED", "The Local Folder parent cannot be enumerated");
    }
    const cursor = decodeCursor(options.cursor, {
      sourceId: options.sourceId,
      scopeHash: options.scopeHash,
      parentNodeId: options.parent.nodeId,
      parentNodeVersion: options.parent.nodeVersion,
    });
    let entries: Dirent[];
    try {
      entries = await readdir(inspectedParent.actualPath, { withFileTypes: true });
    } catch (error) {
      throw localError(
        errorCode(error) === "EACCES" || errorCode(error) === "EPERM"
          ? "LOCAL_PERMISSION_DENIED" : "LOCAL_ENUMERATION_FAILED",
        "The Local Folder layer could not be enumerated",
      );
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (cursor.offset > entries.length) {
      throw localError("LOCAL_CURSOR_INVALID", "Local Folder cursor is outside the current direct-child set");
    }
    const selected = entries.slice(cursor.offset, cursor.offset + options.limit);
    const nextOffset = cursor.offset + selected.length;
    const hasMore = nextOffset < entries.length;
    const nextCursor = hasMore ? encodeCursor({
      schema: "openlifewiki.local-cursor/v1",
      sourceId: options.sourceId,
      scopeHash: options.scopeHash,
      parentNodeId: options.parent.nodeId,
      parentNodeVersion: options.parent.nodeVersion,
      offset: nextOffset,
    }) : null;
    const nodes: SkeletonNode[] = [];
    for (const entry of selected) {
      const childPath = resolve(inspectedParent.lexicalPath, entry.name);
      const inspected = await inspectNode(
        context, childPath, options.parent.nodeId, false, entry.name, false,
      );
      nodes.push(withPage(inspected.node, options.cursor, hasMore));
    }
    const parentAfter = await inspectNode(
      context,
      parentPath,
      options.parent.parentId,
      options.parent.nodeId === options.rootNodeId,
      options.parent.title,
      true,
    );
    if (parentAfter.node.nodeId !== options.parent.nodeId
      || parentAfter.node.nodeVersion !== options.parent.nodeVersion) {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder parent changed during enumeration");
    }
    return skeletonPage(options, options.parent.nodeId, nodes, nextCursor, !hasMore);
  },

  async getVersion(options) {
    const context = await localContext(options);
    assertNodeBinding(options, options.node);
    const inspected = await inspectNode(
      context,
      locatorPath(options.node.locator),
      options.node.parentId,
      options.node.nodeId === options.rootNodeId,
      options.node.title,
      true,
    );
    if (inspected.node.nodeId !== options.node.nodeId) {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder node identity changed");
    }
    return inspected.node.nodeVersion;
  },

  async readApprovedLeafBody(options) {
    const context = await localContext(options);
    assertNodeBinding(options, options.node);
    assertBodyReadAllowed(options.bodyReadGate);
    if (options.bodyReadGate.authorization.authorizationHash !== options.authorizationHash
      || options.bodyReadGate.authorization.sourceId !== options.sourceId
      || options.bodyReadGate.request.nodeId !== options.node.nodeId
      || options.bodyReadGate.request.nodeVersion !== options.node.nodeVersion
      || options.expectedVersion !== options.node.nodeVersion) {
      throw localError("LOCAL_VERSION_MISMATCH", "The Local Folder body request version is stale or mismatched");
    }
    const inspected = await inspectNode(
      context,
      locatorPath(options.node.locator),
      options.node.parentId,
      options.node.nodeId === options.rootNodeId,
      options.node.title,
      true,
    );
    if (inspected.node.nodeId !== options.node.nodeId
      || inspected.node.nodeVersion !== options.expectedVersion) {
      throw localError("LOCAL_VERSION_MISMATCH", "The Local Folder leaf version changed before body read");
    }
    if (!inspected.stats.isFile()
      || inspected.node.permission !== "readable"
      || inspected.node.scanability !== "metadata-and-body") {
      throw localError("LOCAL_BODY_READ_DENIED", "The selected Local Folder node is not an approved readable leaf");
    }
    if (inspected.stats.size > options.source.budget.maxBodyBytes) {
      throw localError("LOCAL_BODY_BUDGET_EXCEEDED", "The selected Local Folder leaf exceeds the approved body budget");
    }
    return {
      sourceId: options.sourceId,
      nodeId: options.node.nodeId,
      nodeVersion: options.expectedVersion,
      stream: streamStableFile(inspected.actualPath, options.expectedVersion, options.sourceId),
    };
  },
};

async function localContext(binding: ProgressiveConnectorBinding): Promise<{
  readonly source: AuthorizedSourceV1;
  readonly scope: LocalScope;
  readonly rootActual: string;
  readonly rootLexical: string;
}> {
  assertActionBinding(binding);
  const scope = parseLocalScope(binding.source.scope);
  let rootActual: string;
  try {
    rootActual = await realpath(scope.root);
  } catch {
    throw localError("LOCAL_ROOT_UNAVAILABLE", "The approved Local Folder root is unavailable");
  }
  return { source: binding.source, scope, rootActual, rootLexical: resolve(scope.root) };
}

function assertActionBinding(binding: ProgressiveConnectorBinding): void {
  const { authorizationHash, ...authorizationPayload } = binding.source;
  if (binding.source.connectorType !== "local-folder"
    || sha256Canonical(authorizationPayload) !== authorizationHash
    || binding.sourceId !== binding.source.sourceId
    || binding.authorizationHash !== authorizationHash
    || binding.rootNodeId !== binding.source.rootNodeId
    || binding.scopeHash !== progressiveConnectorScopeHash(binding.source)) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder action binding is invalid or stale");
  }
  parseLocalScope(binding.source.scope);
}

function assertNodeBinding(binding: ProgressiveConnectorBinding, node: SkeletonNode): void {
  if (node.sourceId !== binding.sourceId) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder node Source binding is invalid");
  }
}

async function inspectNode(
  context: Awaited<ReturnType<typeof localContext>>,
  lexicalPathInput: string,
  parentId: string | null,
  rootNode: boolean,
  titleInput: string | null,
  requireReadable: boolean,
): Promise<InspectedNode> {
  const lexicalPath = resolve(lexicalPathInput);
  assertLexicalScope(context.rootLexical, lexicalPath);
  if (rootNode && lexicalPath !== context.rootLexical) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "The Local Folder root locator does not match the approved root");
  }
  let linkStats: Stats;
  try {
    linkStats = await lstat(lexicalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder node was deleted during the operation");
    }
    throw localError("LOCAL_METADATA_FAILED", "The Local Folder node metadata is unavailable");
  }
  const relativePath = relative(context.rootLexical, lexicalPath).split(sep).join("/");
  const isSymlink = linkStats.isSymbolicLink();
  let actualPath = lexicalPath;
  let details = linkStats;
  let symlinkAllowed = !isSymlink;
  if (isSymlink && context.scope.symlinkPolicy === "within-root") {
    try {
      actualPath = await realpath(lexicalPath);
      assertActualScope(context.rootActual, actualPath);
      details = await stat(actualPath);
      symlinkAllowed = true;
    } catch {
      symlinkAllowed = false;
      actualPath = lexicalPath;
      details = linkStats;
    }
  }
  if (!isSymlink) {
    try {
      actualPath = await realpath(lexicalPath);
      assertActualScope(context.rootActual, actualPath);
    } catch {
      throw localError("LOCAL_SCOPE_ESCAPE", "The Local Folder node escaped the approved root");
    }
  }
  const policyReadable = scopePermits(context.source, relativePath, details.isDirectory());
  let permission: SkeletonNode["permission"] = policyReadable && symlinkAllowed ? "readable" : "denied";
  if (permission === "readable") {
    try {
      await access(actualPath, constants.R_OK);
    } catch (error) {
      permission = errorCode(error) === "EACCES" || errorCode(error) === "EPERM" ? "denied" : "unknown";
    }
  }
  if (requireReadable && permission !== "readable") {
    throw localError("LOCAL_NODE_BLOCKED", "The Local Folder node is outside readable approved scope");
  }
  const kind = details.isDirectory() ? "directory" : details.isFile() ? "file" : isSymlink ? "symlink" : "other";
  const nodeId = rootNode
    ? context.source.rootNodeId
    : sha256Canonical({
      provider: "filesystem",
      sourceId: context.source.sourceId,
      device: String(details.dev),
      inode: String(details.ino),
    });
  const nodeVersion = statVersion(context.source.sourceId, details);
  const title = titleInput ?? lexicalPath.split(sep).filter(Boolean).at(-1) ?? "Root";
  const node: SkeletonNode = {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: context.source.sourceId,
    nodeId,
    parentId,
    kind,
    title,
    locator: pathToFileURL(lexicalPath).href,
    childCount: details.isDirectory()
      ? { value: null, kind: "unknown" }
      : { value: 0, kind: "known" },
    modifiedRange: Number.isFinite(details.mtimeMs)
      ? { from: details.mtime.toISOString(), to: details.mtime.toISOString() }
      : null,
    permission,
    scanability: details.isFile() && permission === "readable" ? "metadata-and-body" : "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: details.isFile()
      ? { bytes: details.size, kind: "known" }
      : { bytes: null, kind: "unknown" },
    nodeVersion,
  };
  return { node, lexicalPath, actualPath, stats: details };
}

async function* streamStableFile(
  path: string,
  expectedVersion: string,
  sourceId: string,
): AsyncGenerator<Uint8Array> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || statVersion(sourceId, before) !== expectedVersion) {
      throw localError("LOCAL_VERSION_MISMATCH", "The Local Folder leaf changed before streaming");
    }
    let position = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(BODY_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    const after = await handle.stat();
    if (statVersion(sourceId, after) !== expectedVersion || position !== after.size) {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder leaf changed during streaming");
    }
  } catch (error) {
    if (isLocalError(error)) throw error;
    throw localError("LOCAL_BODY_READ_FAILED", "The selected Local Folder leaf could not be streamed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function skeletonPage(
  options: ProgressiveConnectorListOptions,
  parentNodeId: string,
  nodes: readonly SkeletonNode[],
  nextCursor: string | null,
  pageComplete: boolean,
): SkeletonPage {
  const payload = {
    sourceId: options.sourceId,
    parentNodeId,
    requestScopeHash: options.scopeHash,
    nodes,
    nextCursor,
    pageComplete,
    observedAt: options.now().toISOString(),
  };
  return {
    schema: "openlifewiki.skeleton-page/v1",
    ...payload,
    skeletonVersion: sha256Canonical(payload),
  };
}

function withPage(node: SkeletonNode, cursor: string | null, hasMore: boolean): SkeletonNode {
  return { ...node, page: { cursor, hasMore } };
}

function statVersion(sourceId: string, details: Stats): string {
  return sha256Canonical({
    provider: "filesystem-stat",
    sourceId,
    device: String(details.dev),
    inode: String(details.ino),
    mode: details.mode,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
    kind: details.isDirectory() ? "directory" : details.isFile() ? "file" : details.isSymbolicLink() ? "symlink" : "other",
  });
}

function parseLocalScope(scope: Readonly<Record<string, unknown>>): LocalScope {
  if (scope.schema !== "openlifewiki.scope/local-folder/v1"
    || typeof scope.root !== "string" || scope.root.length === 0
    || (scope.symlinkPolicy !== "deny" && scope.symlinkPolicy !== "within-root")) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder scope is invalid");
  }
  return {
    schema: scope.schema,
    root: scope.root,
    symlinkPolicy: scope.symlinkPolicy,
  };
}

function scopePermits(
  source: AuthorizedSourceV1,
  relativePath: string,
  container: boolean,
): boolean {
  const normalized = relativePath.length === 0 ? "/" : `/${relativePath}`;
  const hidden = relativePath.split("/").some((part) => part.startsWith(".") && part.length > 1);
  if (hidden) return false;
  const included = source.include.some((pattern) => includeMatches(normalized, normalizePattern(pattern), container));
  const excluded = source.exclude.some((pattern) => excludeMatches(normalized, normalizePattern(pattern), container));
  return included && !excluded;
}

function includeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesGlob(path, pattern)) return true;
  if (!container) return false;
  const prefix = fixedGlobPrefix(pattern);
  if (prefix === path || prefix.startsWith(path === "/" ? "/" : `${path}/`)) return true;
  return pattern.includes("**") && (prefix === "/" || path.startsWith(`${prefix}/`));
}

function excludeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesGlob(path, pattern)) return true;
  return container && fixedGlobPrefix(pattern) !== "/" && fixedGlobPrefix(pattern) === path;
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

function assertLexicalScope(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw localError("LOCAL_SCOPE_ESCAPE", "Local Folder path escaped the approved root");
  }
}

function assertActualScope(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw localError("LOCAL_SCOPE_ESCAPE", "Local Folder target escaped the approved root");
  }
}

function locatorPath(locator: string): string {
  try {
    const url = new URL(locator);
    if (url.protocol !== "file:" || url.username.length > 0 || url.password.length > 0) throw new Error();
    return fileURLToPath(url);
  } catch {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder node locator is invalid");
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw localError("LOCAL_LIMIT_INVALID", `Local Folder page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function encodeCursor(payload: CursorPayload): string {
  const wrapped = { payload, hash: sha256Canonical(payload) };
  return Buffer.from(JSON.stringify(wrapped), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null,
  expected: Omit<CursorPayload, "schema" | "offset">,
): { readonly offset: number } {
  if (cursor === null) return { offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly payload?: CursorPayload;
      readonly hash?: string;
    };
    const payload = parsed.payload;
    if (payload === undefined
      || payload.schema !== "openlifewiki.local-cursor/v1"
      || parsed.hash !== sha256Canonical(payload)
      || payload.sourceId !== expected.sourceId
      || payload.scopeHash !== expected.scopeHash
      || payload.parentNodeId !== expected.parentNodeId
      || payload.parentNodeVersion !== expected.parentNodeVersion
      || !Number.isSafeInteger(payload.offset)
      || payload.offset < 0) {
      throw new Error();
    }
    return { offset: payload.offset };
  } catch {
    throw localError("LOCAL_CURSOR_INVALID", "Local Folder cursor is invalid or stale");
  }
}

function isProgressiveProbe(
  options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions,
): options is ProgressiveConnectorProbeOptions {
  return "authorizationHash" in options && "scopeHash" in options;
}

function status(
  source: ConnectorProbeOptions["source"],
  connection: ConnectorStatus["status"],
  code: string,
  remediation: string,
  lastProbe: string,
): ConnectorStatus {
  return {
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: "local-folder",
    providerName: PROVIDER_NAME,
    providerProject: "openLifeWiki",
    providerVersion: PROVIDER_VERSION,
    identity: { profile: "local", account: "unverified" },
    authorizedScope: source.scope,
    status: connection,
    lastProbe,
    changedItems: 0,
    blocking: safeBlocking(code, remediation),
  };
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function localError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function isLocalError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("LOCAL_");
}
