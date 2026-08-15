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
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertBodyReadAllowed, isScanPathPermitted } from "@openlifewiki/core";
import {
  assertEnumerationIntent,
  assertScanPlan,
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
  ProgressiveConnectorChildrenOptions,
  ProgressiveConnectorListOptions,
  ProgressiveConnectorProbeOptions,
  ProgressiveConnectorProvider,
} from "./connector-provider.js";
import {
  assertBodyBudgetReservationReceipt,
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
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly intentId: string;
  readonly scopeHash: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly offset: number;
  readonly pageSequence: number;
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
      const fingerprint = filesystemIdentityFingerprint(actual, details);
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
    validateLimit(options.limit);
    if (options.cursor !== null) {
      throw localError("LOCAL_CURSOR_INVALID", "Local Folder root metadata has no continuation cursor");
    }
    const inspected = await inspectNode(context, context.scope.root, null, true, null, false);
    if (inspected.node.permission !== "readable" || inspected.node.kind !== "directory") {
      throw localError("LOCAL_ROOT_BLOCKED", "The approved Local Folder root is not readable");
    }
    const nodes = [withPage(inspected.node, options.cursor, false)];
    return skeletonPage(options, options.rootNodeId, nodes, null, true);
  },

  async listChildrenMetadata(options) {
    const context = await localContext(options);
    validateLimit(options.limit);
    assertNodeBinding(options, options.parent);
    assertTraversalBinding(options);
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
      scanPlanHash: options.plan.scanPlanHash,
      skeletonVersion: options.plan.skeletonVersion,
      intentId: options.intent.intentId,
      scopeHash: options.scopeHash,
      parentNodeId: options.parent.nodeId,
      parentNodeVersion: options.parent.nodeVersion,
    });
    if (options.previousPageReceipt !== null
      && options.previousPageReceipt.pageSequence + 1 !== cursor.pageSequence) {
      throw localError("LOCAL_PAGE_CHAIN_INVALID", "Local Folder page sequence is not contiguous");
    }
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
    const eligible = entries.filter((entry) => {
      const childPath = resolve(inspectedParent.lexicalPath, entry.name);
      const relativePath = relative(context.rootLexical, childPath).split(sep).join("/");
      return scopePermits(
        context.source,
        context.plan,
        relativePath,
        entry.isDirectory() || entry.isSymbolicLink(),
      );
    });
    if (cursor.offset > eligible.length) {
      throw localError("LOCAL_CURSOR_INVALID", "Local Folder cursor is outside the current direct-child set");
    }
    const selected = eligible.slice(cursor.offset, cursor.offset + options.limit);
    const nextOffset = cursor.offset + selected.length;
    const hasMore = nextOffset < eligible.length;
    const nodes: SkeletonNode[] = [];
    for (const entry of selected) {
      const childPath = resolve(inspectedParent.lexicalPath, entry.name);
      const inspected = await inspectNode(
        context, childPath, options.parent.nodeId, false, entry.name, false,
      );
      nodes.push(inspected.node.permission === "readable"
        ? inspected.node
        : blockedPlaceholder(options, options.parent.nodeId, cursor.offset + nodes.length));
    }
    const nextCursor = hasMore ? encodeCursor({
      schema: "openlifewiki.local-cursor/v1",
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
    const pagedNodes = nodes.map((node) => withPage(node, options.cursor, hasMore));
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
    return skeletonPage(options, options.parent.nodeId, pagedNodes, nextCursor, !hasMore);
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
    const gateTarget = options.bodyReadGate.path.at(-1);
    if (options.bodyReadGate.authorization.authorizationHash !== options.authorizationHash
      || options.bodyReadGate.authorization.sourceId !== options.sourceId
      || options.bodyReadGate.plan.scanPlanHash !== options.plan.scanPlanHash
      || options.bodyReadGate.request.nodeId !== options.node.nodeId
      || options.bodyReadGate.request.nodeVersion !== options.node.nodeVersion
      || gateTarget === undefined
      || sha256Canonical(gateTarget) !== sha256Canonical(options.node)
      || options.expectedVersion !== options.node.nodeVersion) {
      throw localError("LOCAL_BODY_BINDING_INVALID", "The Local Folder body node, path, plan or version binding is invalid");
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
    try {
      assertBodyBudgetReservationReceipt(options.budgetReservation, {
        source: options.source,
        plan: options.plan,
        node: options.node,
        activeBodyReadLease: options.activeBodyReadLease,
        expectedPhysicalIoAccountingHash: options.expectedPhysicalIoAccountingHash,
        trustedReceiptHashes: options.bodyReadGate.trustedReceiptHashes,
      });
    } catch {
      throw localError("LOCAL_BODY_BUDGET_INVALID", "The Local Folder body budget permit is invalid or untrusted");
    }
    if (inspected.stats.size > options.budgetReservation.reservedBytes) {
      throw localError("LOCAL_BODY_BUDGET_EXCEEDED", "The selected Local Folder leaf exceeds the approved body budget");
    }
    return {
      sourceId: options.sourceId,
      nodeId: options.node.nodeId,
      nodeVersion: options.expectedVersion,
      stream: streamStableFile(
        inspected.actualPath,
        inspected.lexicalPath,
        context.rootActual,
        options.expectedVersion,
        options.sourceId,
        options.budgetReservation.reservedBytes,
      ),
    };
  },
};

async function localContext(binding: ProgressiveConnectorBinding): Promise<{
  readonly source: AuthorizedSourceV1;
  readonly plan: ProgressiveConnectorBinding["plan"];
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
  const rootDetails = await stat(rootActual).catch(() => {
    throw localError("LOCAL_ROOT_UNAVAILABLE", "The approved Local Folder root is unavailable");
  });
  const currentFingerprint = filesystemIdentityFingerprint(rootActual, rootDetails);
  if (currentFingerprint !== binding.source.identityFingerprint) {
    throw localError("LOCAL_IDENTITY_CHANGED", "The approved Local Folder root identity changed");
  }
  return {
    source: binding.source,
    plan: binding.plan,
    scope,
    rootActual,
    rootLexical: resolve(scope.root),
  };
}

function assertActionBinding(binding: ProgressiveConnectorBinding): void {
  assertScanPlan(binding.plan);
  const { authorizationHash, ...authorizationPayload } = binding.source;
  const sourceIndex = binding.plan.sourceIds.indexOf(binding.sourceId);
  if (binding.source.connectorType !== "local-folder"
    || sha256Canonical(authorizationPayload) !== authorizationHash
    || binding.sourceId !== binding.source.sourceId
    || binding.authorizationHash !== authorizationHash
    || binding.rootNodeId !== binding.source.rootNodeId
    || binding.scopeHash !== progressiveConnectorScopeHash(binding.source)
    || sourceIndex < 0
    || binding.plan.authorizationHashes[sourceIndex] !== binding.authorizationHash
    || binding.plan.rootNodeIds[sourceIndex] !== binding.rootNodeId) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder action binding is invalid or stale");
  }
  parseLocalScope(binding.source.scope);
}

function assertNodeBinding(binding: ProgressiveConnectorBinding, node: SkeletonNode): void {
  if (node.sourceId !== binding.sourceId) {
    throw localError("LOCAL_ACTION_BINDING_INVALID", "Local Folder node Source binding is invalid");
  }
}

function assertTraversalBinding(options: ProgressiveConnectorChildrenOptions): void {
  assertEnumerationIntent(options.intent, {
    plan: options.plan,
    trustedDecisionReceipts: options.trustedDecisionReceipts,
  });
  if (!options.trustedReceiptHashes.includes(options.intent.receiptHash)
    || options.trustedDecisionReceipts.some(({ receiptHash }) => !options.trustedReceiptHashes.includes(receiptHash))
    || options.intent.sourceId !== options.sourceId
    || options.intent.authorizationHash !== options.authorizationHash
    || options.intent.targetNodeId !== options.parent.nodeId
    || options.intent.targetNodeVersion !== options.parent.nodeVersion) {
    throw localError("LOCAL_TRAVERSAL_DENIED", "Local Folder enumeration intent or target version is absent, untrusted or mismatched");
  }
  const previous = options.previousPageReceipt;
  if (options.cursor === null) {
    if (previous !== null) {
      throw localError("LOCAL_PAGE_CHAIN_INVALID", "The first Local Folder page cannot claim a previous receipt");
    }
    return;
  }
  if (previous === null || !options.trustedReceiptHashes.includes(previous.receiptHash)) {
    throw localError("LOCAL_PAGE_CHAIN_INVALID", "A trusted previous Local Folder page receipt is required");
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
    throw localError("LOCAL_PAGE_CHAIN_INVALID", "The previous Local Folder page receipt is invalid or stale");
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
  const lexicalPolicyReadable = scopePermits(
    context.source,
    context.plan,
    relativePath,
    details.isDirectory(),
  );
  const actualRelativePath = relative(context.rootActual, actualPath).split(sep).join("/");
  const actualPolicyReadable = scopePermits(
    context.source,
    context.plan,
    actualRelativePath,
    details.isDirectory(),
  );
  const policyReadable = lexicalPolicyReadable && actualPolicyReadable;
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
      provider: "filesystem-logical-path",
      sourceId: context.source.sourceId,
      relativePath,
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
  expectedActualPath: string,
  lexicalPath: string,
  rootActual: string,
  expectedVersion: string,
  sourceId: string,
  maxBodyBytes: number,
): AsyncGenerator<Uint8Array> {
  let handle;
  try {
    handle = await open(expectedActualPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || statVersion(sourceId, before) !== expectedVersion) {
      throw localError("LOCAL_VERSION_MISMATCH", "The Local Folder leaf changed before streaming");
    }
    const currentActualPath = await realpath(lexicalPath);
    assertActualScope(rootActual, currentActualPath);
    if (currentActualPath !== expectedActualPath) {
      throw localError("LOCAL_NODE_CHANGED", "The Local Folder leaf target changed before streaming");
    }
    const beforeFirstChunk = await handle.stat();
    if (statVersion(sourceId, beforeFirstChunk) !== expectedVersion) {
      throw localError("LOCAL_VERSION_MISMATCH", "The Local Folder leaf changed before the first chunk");
    }
    let position = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(BODY_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (position + bytesRead > maxBodyBytes) {
        throw localError("LOCAL_BODY_BUDGET_EXCEEDED", "The Local Folder leaf grew beyond the approved body budget");
      }
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
    skeletonVersion: options.plan.skeletonVersion,
  };
}

function withPage(node: SkeletonNode, cursor: string | null, hasMore: boolean): SkeletonNode {
  return { ...node, page: { cursor, hasMore } };
}

function blockedPlaceholder(
  options: ProgressiveConnectorChildrenOptions,
  parentNodeId: string,
  ordinal: number,
): SkeletonNode {
  const opaque = sha256Canonical({
    sourceId: options.sourceId,
    intentId: options.intent.intentId,
    parentNodeId,
    ordinal,
    kind: "blocked",
  });
  const id = opaque.slice("sha256:".length);
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: options.sourceId,
    nodeId: opaque,
    parentId: parentNodeId,
    kind: "blocked",
    title: "Blocked item",
    locator: `openlifewiki://blocked/${id}`,
    childCount: { value: null, kind: "unknown" },
    modifiedRange: null,
    permission: "denied",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: null, kind: "unknown" },
    nodeVersion: sha256Canonical({ opaque, state: "blocked" }),
  };
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

function filesystemIdentityFingerprint(actual: string, details: Stats): string {
  return sha256Canonical({
    provider: "filesystem",
    actual,
    device: String(details.dev),
    inode: String(details.ino),
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
  plan: ProgressiveConnectorBinding["plan"],
  relativePath: string,
  container: boolean,
): boolean {
  const normalized = relativePath.length === 0 ? "/" : `/${relativePath}`;
  const hidden = relativePath.split("/").some((part) => part.startsWith(".") && part.length > 1);
  if (hidden) return false;
  return isScanPathPermitted({
    path: normalized,
    container,
    includeSets: [source.include, ...plan.policy.includeSets],
    exclude: [...source.exclude, ...plan.policy.exclude],
  });
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
  expected: Omit<CursorPayload, "schema" | "offset" | "pageSequence">,
): { readonly offset: number; readonly pageSequence: number } {
  if (cursor === null) return { offset: 0, pageSequence: 1 };
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
      || payload.scanPlanHash !== expected.scanPlanHash
      || payload.skeletonVersion !== expected.skeletonVersion
      || payload.intentId !== expected.intentId
      || payload.scopeHash !== expected.scopeHash
      || payload.parentNodeId !== expected.parentNodeId
      || payload.parentNodeVersion !== expected.parentNodeVersion
      || !Number.isSafeInteger(payload.offset)
      || payload.offset < 0
      || !Number.isSafeInteger(payload.pageSequence)
      || payload.pageSequence < 2) {
      throw new Error();
    }
    return { offset: payload.offset, pageSequence: payload.pageSequence };
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
