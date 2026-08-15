import { assertBodyReadAllowed, isScanPathPermitted, matchesScanPattern } from "@openlifewiki/core";
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

const PROVIDER_NAME = "lark-cli";
const PROVIDER_PROJECT = "larksuite/cli";
const MAX_PAGE_SIZE = 50;
const BODY_CHUNK_BYTES = 64 * 1024;
const SAFE_ENV_NAMES = [
  "HOME", "LANG", "LC_ALL", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME",
] as const;

interface FeishuScope {
  readonly schema: "openlifewiki.scope/feishu/v1";
  readonly profile: string;
  readonly expectedTenantId: string;
  readonly documentIds: readonly string[];
  readonly wikiNodeIds: readonly string[];
  readonly baseIds: readonly string[];
}

type RootKind = "document" | "wiki" | "base";
type ObjectKind = "source-root" | "document" | "wiki" | "page-content" | "base";

interface FeishuLocator {
  readonly schema: "openlifewiki.locator/feishu/v1";
  readonly kind: ObjectKind;
  readonly rootKind: RootKind | null;
  readonly rootId: string | null;
  readonly objectId: string;
  readonly parentObjectId: string | null;
  readonly spaceId: string | null;
  readonly objectToken: string | null;
  readonly objectType: string | null;
  readonly docToken: string | null;
  readonly hasChildren: boolean | null;
}

interface FeishuMetadata {
  readonly locator: FeishuLocator;
  readonly title: string;
  readonly kind: "directory" | "file";
  readonly version: string;
  readonly size: number | null;
  readonly bodyReadable: boolean;
}

interface FeishuAuthStatus {
  readonly appId: string;
  readonly verified: boolean;
  readonly user: {
    readonly status: string;
    readonly available: boolean;
    readonly verified: boolean;
    readonly openId: string;
    readonly userName: string;
    readonly tokenStatus: string;
    readonly scopes: readonly string[];
  };
}

interface FeishuCurrentUser {
  readonly name: string;
  readonly openId: string;
  readonly tenantKey: string;
}

interface FeishuIdentity {
  readonly version: string;
  readonly auth: FeishuAuthStatus;
  readonly user: FeishuCurrentUser;
  readonly requiredScopes: readonly string[];
}

interface CursorPayload {
  readonly schema: "openlifewiki.feishu-cursor/v1";
  readonly sourceId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly intentId: string;
  readonly scopeHash: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly mode: "local" | "platform";
  readonly offset: number;
  readonly platformCursor: string | null;
  readonly pageSequence: number;
}

interface WikiNode {
  readonly spaceId: string;
  readonly nodeToken: string;
  readonly objectToken: string;
  readonly objectType: string;
  readonly parentNodeToken: string | null;
  readonly hasChildren: boolean;
  readonly title: string;
}

type FeishuContext = Awaited<ReturnType<typeof feishuContext>>;

export function createFeishuConnector(
  progressiveRunner: CommandRunner = nodeCommandRunner,
): ConnectorProvider & ProgressiveConnectorProvider {
  return {
    connectorType: "feishu",

    async probe(options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions) {
      const runner = isProgressiveProbe(options) ? progressiveRunner : options.runner;
      if (isProgressiveProbe(options)) assertActionBinding(options);
      return await probeFeishu(options.source, runner, options.now);
    },

    async listRootsMetadata(options) {
      const context = await feishuContext(options, progressiveRunner);
      validateLimit(options.limit);
      if (options.cursor !== null) throw feishuError("FEISHU_CURSOR_INVALID", "Feishu root metadata has no continuation cursor");
      const metadata = sourceRootMetadata(context);
      return skeletonPage(options, options.rootNodeId, [metadataNode(context, metadata, options.rootNodeId, null, true)], null, true);
    },

    async listChildrenMetadata(options) {
      const context = await feishuContext(options, progressiveRunner);
      validateLimit(options.limit);
      assertNodeBinding(options, options.parent);
      assertTraversalBinding(options);
      const claimedLocator = parseLocator(options.parent.locator, context.scope);
      const current = await metadataForLocator(context, claimedLocator);
      if (current.version !== options.parent.nodeVersion
        || sha256Canonical(current.locator) !== sha256Canonical(claimedLocator)) {
        throw feishuError("FEISHU_NODE_CHANGED", "The Feishu container changed before enumeration");
      }
      const locator = current.locator;
      const cursor = decodeCursor(options.cursor, cursorExpected(options));
      if (options.previousPageReceipt !== null
        && options.previousPageReceipt.pageSequence + 1 !== cursor.pageSequence) {
        throw feishuError("FEISHU_PAGE_CHAIN_INVALID", "Feishu page sequence is not contiguous");
      }
      if (locator.kind === "source-root") return await listApprovedRoots(context, options, locator, cursor);
      if (locator.kind === "wiki" && locator.hasChildren === true) {
        return await listWikiLayer(context, options, current, cursor);
      }
      if (locator.kind === "base") {
        throw feishuError(
          "FEISHU_BASE_HIERARCHY_UNSUPPORTED",
          "The public Feishu CLI does not expose a direct-child-only Base root listing",
        );
      }
      throw feishuError("FEISHU_PARENT_BLOCKED", "The selected Feishu object has no enumerable direct-child layer");
    },

    async getVersion(options) {
      const context = await feishuContext(options, progressiveRunner);
      assertNodeBinding(options, options.node);
      const claimedLocator = parseLocator(options.node.locator, context.scope);
      const current = await metadataForLocator(context, claimedLocator);
      if (sha256Canonical(current.locator) !== sha256Canonical(claimedLocator)) {
        throw feishuError("FEISHU_ACTION_BINDING_INVALID", "The Feishu node locator no longer matches its approved object");
      }
      return current.version;
    },

    async readApprovedLeafBody(options) {
      const context = await feishuContext(options, progressiveRunner);
      assertNodeBinding(options, options.node);
      assertBodyReadAllowed(options.bodyReadGate);
      const gateTarget = options.bodyReadGate.path.at(-1);
      if (options.bodyReadGate.authorization.authorizationHash !== options.authorizationHash
        || options.bodyReadGate.authorization.sourceId !== options.sourceId
        || options.bodyReadGate.plan.scanPlanHash !== options.plan.scanPlanHash
        || options.bodyReadGate.request.nodeId !== options.node.nodeId
        || options.bodyReadGate.request.nodeVersion !== options.node.nodeVersion
        || gateTarget === undefined || sha256Canonical(gateTarget) !== sha256Canonical(options.node)
        || options.expectedVersion !== options.node.nodeVersion) {
        throw feishuError("FEISHU_BODY_BINDING_INVALID", "The Feishu body node, path, plan or version binding is invalid");
      }
      const locator = parseLocator(options.node.locator, context.scope);
      const current = await metadataForLocator(context, locator);
      if (current.version !== options.expectedVersion
        || sha256Canonical(current.locator) !== sha256Canonical(locator)) {
        throw feishuError("FEISHU_VERSION_MISMATCH", "The Feishu object changed before body read");
      }
      const docToken = bodyDocumentToken(current.locator);
      if (docToken === null || options.node.scanability !== "metadata-and-body") {
        throw feishuError("FEISHU_BODY_READ_DENIED", "The selected Feishu object has no approved document body surface");
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
        throw feishuError("FEISHU_BODY_BUDGET_INVALID", "The Feishu body budget permit is invalid or untrusted");
      }
      if (current.size !== null && current.size > options.budgetReservation.reservedBytes) {
        throw feishuError("FEISHU_BODY_BUDGET_EXCEEDED", "The selected Feishu document exceeds the approved body budget");
      }
      const bytes = await fetchDocumentBody(context, docToken, options.budgetReservation.reservedBytes);
      const after = await metadataForLocator(context, current.locator);
      if (after.version !== options.expectedVersion
        || sha256Canonical(after.locator) !== sha256Canonical(current.locator)) {
        throw feishuError("FEISHU_VERSION_MISMATCH", "The Feishu object changed while its body was being read");
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

export const feishuConnector = createFeishuConnector();

async function probeFeishu(
  source: ConnectorProbeOptions["source"],
  runner: CommandRunner,
  now: () => Date,
): Promise<ConnectorStatus> {
  const observedAt = now().toISOString();
  let scope: FeishuScope;
  try {
    scope = parseFeishuScope(source.scope);
  } catch {
    return status(source, observedAt, scopeProfile(source.scope), undefined, "blocked", null,
      safeBlocking("FEISHU_SCOPE_INVALID", "Review the approved Feishu object scope"));
  }
  let identity: FeishuIdentity;
  try {
    identity = await inspectIdentity(runner, scope);
  } catch (error) {
    const code = feishuProviderErrorCode(error);
    const kind = commandFailureKind(error);
    const state = kind === "missing" ? "missing" : code === "FEISHU_AUTH_REQUIRED" ? "auth-required" : "blocked";
    return status(source, observedAt, scope.profile, undefined, state, null, safeBlocking(
      code ?? (kind === "missing" ? "FEISHU_CLI_MISSING" : kind === "timeout" ? "FEISHU_PROVIDER_TIMEOUT" : "FEISHU_PROVIDER_FAILED"),
      `Verify selected profile ${scope.profile}, tenant and required read scopes`,
    ));
  }
  if (identity.user.tenantKey !== scope.expectedTenantId) {
    return status(source, observedAt, scope.profile, identity.version, "blocked", identity,
      safeBlocking("FEISHU_TENANT_MISMATCH", `Use profile ${scope.profile} for the approved tenant`));
  }
  return status(source, observedAt, scope.profile, identity.version, "connected", identity, null);
}

async function feishuContext(binding: ProgressiveConnectorBinding, runner: CommandRunner): Promise<{
  readonly source: AuthorizedSourceV1;
  readonly plan: ProgressiveConnectorBinding["plan"];
  readonly scope: FeishuScope;
  readonly runner: CommandRunner;
}> {
  assertActionBinding(binding);
  const scope = parseFeishuScope(binding.source.scope);
  let identity: FeishuIdentity;
  try {
    identity = await inspectIdentity(runner, scope);
  } catch (error) {
    throw feishuError(feishuProviderErrorCode(error) ?? "FEISHU_AUTH_REQUIRED", "The approved Feishu CLI profile is unavailable");
  }
  const fingerprint = identityFingerprint(scope.profile, identity);
  const observation = binding.source.providerObservation;
  if (identity.user.tenantKey !== scope.expectedTenantId
    || fingerprint !== binding.source.identityFingerprint
    || observation !== undefined
      && (observation.providerName !== PROVIDER_NAME || observation.providerVersion !== identity.version)) {
    throw feishuError("FEISHU_IDENTITY_CHANGED", "The approved Feishu profile, tenant, identity or provider version changed");
  }
  return { source: binding.source, plan: binding.plan, scope, runner };
}

async function inspectIdentity(runner: CommandRunner, scope: FeishuScope): Promise<FeishuIdentity> {
  let version: string;
  try {
    const result = await runLark(runner, scope.profile, ["--version"], 15_000);
    const parsed = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (parsed === undefined) throw feishuError("FEISHU_VERSION_INVALID", "The Feishu CLI version response was invalid");
    version = parsed;
  } catch (error) {
    if (errorCode(error) !== undefined) throw error;
    throw error;
  }
  const requiredScopes = requiredFeishuScopes(scope);
  let auth: FeishuAuthStatus | undefined;
  try {
    auth = parseAuthStatus((await runLark(runner, scope.profile, ["auth", "status", "--json", "--verify"], 30_000)).stdout);
  } catch {
    throw feishuError("FEISHU_AUTH_CHECK_FAILED", "The Feishu authentication check failed");
  }
  if (auth === undefined || auth.verified !== true || auth.user.verified !== true
    || auth.user.available !== true || auth.user.status !== "ready" || auth.user.tokenStatus !== "valid") {
    throw feishuError("FEISHU_AUTH_REQUIRED", "The selected Feishu profile requires authentication");
  }
  if (!requiredScopes.every((required) => feishuScopeGranted(auth.user.scopes, required))) {
    throw feishuError("FEISHU_SCOPE_MISSING", "The selected Feishu profile lacks an approved read scope");
  }
  const checkedScopes = requiredScopes.map((required) => (
    required === "drive:drive.metadata:readonly" && auth.user.scopes.includes("drive:drive")
      ? "drive:drive"
      : required
  ));
  try {
    const check = await runLark(runner, scope.profile, [
      "auth", "check", "--scope", checkedScopes.join(" "), "--json",
    ], 30_000);
    if (!scopeCheckPassed(check.stdout, checkedScopes)) {
      throw feishuError("FEISHU_SCOPE_MISSING", "The selected Feishu profile lacks an approved read scope");
    }
  } catch (error) {
    if (errorCode(error) === "FEISHU_SCOPE_MISSING") throw error;
    throw feishuError("FEISHU_SCOPE_CHECK_FAILED", "The Feishu scope check failed");
  }
  let user: FeishuCurrentUser | undefined;
  try {
    user = parseCurrentUser((await runLark(runner, scope.profile, [
      "contact", "+get-user", "--as", "user", "--json",
    ], 30_000)).stdout);
  } catch {
    throw feishuError("FEISHU_IDENTITY_INVALID", "The Feishu current user could not be verified");
  }
  if (user === undefined || user.openId !== auth.user.openId) {
    throw feishuError("FEISHU_IDENTITY_INVALID", "The Feishu current user did not match the selected profile");
  }
  return { version, auth, user, requiredScopes };
}

async function listApprovedRoots(
  context: FeishuContext,
  options: ProgressiveConnectorChildrenOptions,
  _locator: FeishuLocator,
  cursor: DecodedCursor,
): Promise<SkeletonPage> {
  if (cursor.mode !== "local" || cursor.platformCursor !== null) throw invalidCursor();
  const descriptors = approvedRootDescriptors(context.scope).filter(({ path }) => scanPermits(context, path, true));
  if (cursor.offset > descriptors.length) throw invalidCursor();
  const selected = descriptors.slice(cursor.offset, cursor.offset + options.limit);
  const metadata = await Promise.all(selected.map(async ({ kind, id }) => await approvedRootMetadata(context, kind, id)));
  const nextOffset = cursor.offset + selected.length;
  const hasMore = nextOffset < descriptors.length;
  const nextCursor = hasMore ? encodeCursor(cursorPayload(options, "local", nextOffset, null, cursor.pageSequence + 1)) : null;
  return skeletonPage(options, options.parent.nodeId, metadata.map((item) => withPage(metadataNode(
    context, item, logicalNodeId(item.locator), options.parent.nodeId, scanPermits(context, logicalPath(item.locator), item.kind === "directory"),
  ), options.cursor, hasMore)), nextCursor, !hasMore);
}

async function listWikiLayer(
  context: FeishuContext,
  options: ProgressiveConnectorChildrenOptions,
  parent: FeishuMetadata,
  cursor: DecodedCursor,
): Promise<SkeletonPage> {
  const locator = parent.locator;
  const firstPage = cursor.pageSequence === 1 && cursor.mode === "local"
    && cursor.offset === 0 && cursor.platformCursor === null;
  if ((!firstPage && cursor.mode !== "platform") || cursor.offset !== 0 || locator.spaceId === null) throw invalidCursor();
  const content = firstPage ? wikiPageContentMetadata(parent) : null;
  const eligibleContent = content !== null && scanPermits(context, logicalPath(content.locator), false) ? [content] : [];
  const remainingLimit = options.limit - eligibleContent.length;
  if (remainingLimit === 0) {
    const nextCursor = encodeCursor(cursorPayload(options, "platform", 0, null, cursor.pageSequence + 1));
    return skeletonPage(options, options.parent.nodeId, eligibleContent.map((item) => withPage(metadataNode(
      context, item, logicalNodeId(item.locator), options.parent.nodeId, true,
    ), options.cursor, true)), nextCursor, false);
  }
  const page = await fetchWikiChildren(context, locator.spaceId, locator.objectId, cursor.platformCursor, remainingLimit);
  const metadata = await Promise.all(page.nodes.map(async (node) => await wikiMetadata(context, node, locator.rootId ?? locator.objectId)));
  const eligible = metadata.filter((item) => scanPermits(context, logicalPath(item.locator), item.kind === "directory"));
  const hasMore = page.nextCursor !== null;
  const nextCursor = hasMore ? encodeCursor(cursorPayload(
    options, "platform", 0, page.nextCursor, cursor.pageSequence + 1,
  )) : null;
  return skeletonPage(options, options.parent.nodeId, [...eligibleContent, ...eligible].map((item) => withPage(metadataNode(
    context, item, logicalNodeId(item.locator), options.parent.nodeId, true,
  ), options.cursor, hasMore)), nextCursor, !hasMore);
}

async function metadataForLocator(context: FeishuContext, locator: FeishuLocator): Promise<FeishuMetadata> {
  if (locator.kind === "source-root") return sourceRootMetadata(context);
  if (locator.kind === "document") return await documentMetadata(context, locator.objectId);
  if (locator.kind === "wiki") {
    if (locator.rootId === null) throw invalidLocator();
    const node = await fetchWikiNode(context, locator.objectId);
    await assertWikiAncestry(context, node, locator.rootId);
    return await wikiMetadata(context, node, locator.rootId);
  }
  if (locator.kind === "page-content") {
    if (locator.rootId === null) throw invalidLocator();
    const node = await fetchWikiNode(context, locator.objectId);
    await assertWikiAncestry(context, node, locator.rootId);
    const metadata = wikiPageContentMetadata(await wikiMetadata(context, node, locator.rootId));
    if (metadata === null) throw invalidLocator();
    return metadata;
  }
  if (locator.kind === "base") return await baseMetadata(context, locator.objectId);
  throw invalidLocator();
}

function sourceRootMetadata(context: FeishuContext): FeishuMetadata {
  const locator: FeishuLocator = {
    schema: "openlifewiki.locator/feishu/v1", kind: "source-root", rootKind: null, rootId: null,
    objectId: context.source.rootNodeId, parentObjectId: null, spaceId: null, objectToken: null,
    objectType: null, docToken: null, hasChildren: true,
  };
  return {
    locator, title: "Feishu", kind: "directory",
    version: sha256Canonical({ provider: "feishu-root", scopeHash: progressiveConnectorScopeHash(context.source) }),
    size: null, bodyReadable: false,
  };
}

async function approvedRootMetadata(context: FeishuContext, kind: RootKind, id: string): Promise<FeishuMetadata> {
  if (kind === "document") return await documentMetadata(context, id);
  if (kind === "wiki") return await wikiMetadata(context, await fetchWikiNode(context, id), id);
  return await baseMetadata(context, id);
}

async function documentMetadata(context: FeishuContext, token: string): Promise<FeishuMetadata> {
  if (!context.scope.documentIds.includes(token)) throw feishuError("FEISHU_SCOPE_ESCAPE", "The Feishu document is outside the approved object set");
  const meta = await fetchDriveMetadata(context, token);
  const locator: FeishuLocator = {
    schema: "openlifewiki.locator/feishu/v1", kind: "document", rootKind: "document", rootId: token,
    objectId: token, parentObjectId: context.source.rootNodeId, spaceId: null, objectToken: token,
    objectType: meta.type, docToken: token, hasChildren: false,
  };
  return { locator, title: meta.title, kind: "file", version: meta.version, size: meta.size, bodyReadable: isDocumentType(meta.type) };
}

async function wikiMetadata(context: FeishuContext, node: WikiNode, rootId: string): Promise<FeishuMetadata> {
  if (!context.scope.wikiNodeIds.includes(rootId)) throw feishuError("FEISHU_SCOPE_ESCAPE", "The Feishu Wiki node is outside the approved object set");
  let drive: Awaited<ReturnType<typeof fetchDriveMetadata>> | null = null;
  if (isDocumentType(node.objectType)) drive = await fetchDriveMetadata(context, node.objectToken);
  const locator: FeishuLocator = {
    schema: "openlifewiki.locator/feishu/v1", kind: "wiki", rootKind: "wiki", rootId,
    objectId: node.nodeToken, parentObjectId: node.parentNodeToken, spaceId: node.spaceId,
    objectToken: node.objectToken, objectType: node.objectType,
    docToken: isDocumentType(node.objectType) ? node.objectToken : null, hasChildren: node.hasChildren,
  };
  const version = sha256Canonical({
    provider: "feishu-wiki-node", rootId, nodeToken: node.nodeToken, objectToken: node.objectToken,
    objectType: node.objectType, parentNodeToken: node.parentNodeToken, hasChildren: node.hasChildren,
    contentVersion: drive?.version ?? null,
  });
  return {
    locator, title: node.title || drive?.title || node.nodeToken,
    kind: node.hasChildren ? "directory" : "file", version, size: drive?.size ?? null,
    bodyReadable: !node.hasChildren && isDocumentType(node.objectType),
  };
}

function wikiPageContentMetadata(parent: FeishuMetadata): FeishuMetadata | null {
  const locator = parent.locator;
  if (locator.kind !== "wiki" || locator.hasChildren !== true
    || locator.docToken === null || !isDocumentType(locator.objectType)) return null;
  const contentLocator: FeishuLocator = {
    ...locator,
    kind: "page-content",
    parentObjectId: locator.objectId,
    hasChildren: false,
  };
  return {
    locator: contentLocator,
    title: "Page content",
    kind: "file",
    version: sha256Canonical({ provider: "feishu-wiki-page-content", pageVersion: parent.version }),
    size: parent.size,
    bodyReadable: true,
  };
}

async function baseMetadata(context: FeishuContext, token: string): Promise<FeishuMetadata> {
  if (!context.scope.baseIds.includes(token)) throw feishuError("FEISHU_SCOPE_ESCAPE", "The Feishu Base is outside the approved object set");
  let result;
  try {
    result = await runLark(context.runner, context.scope.profile, [
      "base", "+base-get", "--base-token", token, "--as", "user", "--format", "json",
    ], 30_000);
  } catch {
    throw feishuError("FEISHU_METADATA_FAILED", "The approved Feishu Base metadata could not be read");
  }
  const app = nestedRecord(parseObject(result.stdout), ["data", "app"])
    ?? nestedRecord(parseObject(result.stdout), ["app"])
    ?? parseObject(result.stdout);
  if (app === undefined || app.app_token !== token || typeof app.name !== "string") {
    throw feishuError("FEISHU_METADATA_INVALID", "The approved Feishu Base metadata response was invalid");
  }
  const locator: FeishuLocator = {
    schema: "openlifewiki.locator/feishu/v1", kind: "base", rootKind: "base", rootId: token,
    objectId: token, parentObjectId: context.source.rootNodeId, spaceId: null, objectToken: token,
    objectType: "base", docToken: null, hasChildren: true,
  };
  return {
    locator, title: app.name, kind: "directory",
    version: sha256Canonical({ provider: "feishu-base", token, name: app.name, revision: scalar(app.revision) }),
    size: null, bodyReadable: false,
  };
}

async function fetchDriveMetadata(context: FeishuContext, token: string): Promise<{
  readonly title: string; readonly type: string; readonly version: string; readonly size: number | null;
}> {
  let result;
  try {
    result = await runLark(context.runner, context.scope.profile, [
      "drive", "metas", "batch_query", "--data",
      JSON.stringify({ request_docs: [{ doc_token: token, doc_type: "docx" }], with_url: false }),
      "--as", "user", "--format", "json",
    ], 30_000);
  } catch {
    throw feishuError("FEISHU_METADATA_FAILED", "The approved Feishu document metadata could not be read");
  }
  const value = parseObject(result.stdout);
  const metas = arrayAt(value, ["metas"]) ?? arrayAt(value, ["data", "metas"]);
  const failed = arrayAt(value, ["failed_list"]) ?? arrayAt(value, ["data", "failed_list"]);
  const meta = metas?.length === 1 && isRecord(metas[0]) ? metas[0] : undefined;
  if (meta === undefined || failed === undefined || failed.length !== 0 || meta.doc_token !== token
    || typeof meta.doc_type !== "string" || typeof meta.title !== "string"
    || typeof meta.latest_modify_time !== "string") {
    throw feishuError("FEISHU_METADATA_INVALID", "The approved Feishu document metadata response was incomplete");
  }
  if ("size" in meta && (!Number.isSafeInteger(meta.size) || Number(meta.size) < 0)) {
    throw feishuError("FEISHU_METADATA_INVALID", "The approved Feishu document size metadata was invalid");
  }
  const size = "size" in meta ? Number(meta.size) : null;
  return {
    title: meta.title,
    type: meta.doc_type,
    version: sha256Canonical({ provider: "feishu-drive-meta", token, type: meta.doc_type, modified: meta.latest_modify_time }),
    size,
  };
}

async function fetchWikiNode(context: FeishuContext, token: string): Promise<WikiNode> {
  let result;
  try {
    result = await runLark(context.runner, context.scope.profile, [
      "wiki", "+node-get", "--node-token", token, "--as", "user", "--format", "json",
    ], 30_000);
  } catch {
    throw feishuError("FEISHU_METADATA_FAILED", "The approved Feishu Wiki node metadata could not be read");
  }
  const value = parseObject(result.stdout);
  const node = nestedRecord(value, ["data", "node"]) ?? nestedRecord(value, ["node"]);
  const parsed = parseWikiNode(node);
  if (parsed === undefined || parsed.nodeToken !== token) {
    throw feishuError("FEISHU_METADATA_INVALID", "The approved Feishu Wiki node response was invalid");
  }
  return parsed;
}

async function fetchWikiChildren(
  context: FeishuContext,
  spaceId: string,
  parentToken: string,
  pageToken: string | null,
  limit: number,
): Promise<{ readonly nodes: readonly WikiNode[]; readonly nextCursor: string | null }> {
  const args = [
    "wiki", "+node-list", "--space-id", spaceId, "--parent-node-token", parentToken,
    "--page-size", String(limit), ...(pageToken === null ? [] : ["--page-token", pageToken]),
    "--as", "user", "--format", "json",
  ];
  let result;
  try {
    result = await runLark(context.runner, context.scope.profile, args, 30_000);
  } catch {
    throw feishuError("FEISHU_ENUMERATION_FAILED", "The approved Feishu Wiki layer could not be enumerated");
  }
  const value = parseObject(result.stdout);
  const data = nestedRecord(value, ["data"]) ?? value;
  const items = Array.isArray(data?.items) ? data.items : undefined;
  if (data === undefined || items === undefined || typeof data.has_more !== "boolean") {
    throw feishuError("FEISHU_ENUMERATION_INCOMPLETE", "The Feishu Wiki page response was incomplete");
  }
  const nodes = items.map(parseWikiNode);
  if (nodes.some((node) => node === undefined)) {
    throw feishuError("FEISHU_ENUMERATION_INCOMPLETE", "The Feishu Wiki page contained an invalid direct child");
  }
  const parsed = nodes as WikiNode[];
  if (parsed.some((node) => node.spaceId !== spaceId || node.parentNodeToken !== parentToken)
    || new Set(parsed.map(({ nodeToken }) => nodeToken)).size !== parsed.length) {
    throw feishuError("FEISHU_ENUMERATION_INCOMPLETE", "The Feishu Wiki page escaped or duplicated its direct-child layer");
  }
  const next = typeof data.page_token === "string" && data.page_token.length > 0 ? data.page_token : null;
  if (data.has_more !== (next !== null)) {
    throw feishuError("FEISHU_ENUMERATION_INCOMPLETE", "The Feishu Wiki continuation state was incomplete");
  }
  return { nodes: parsed, nextCursor: next };
}

async function assertWikiAncestry(context: FeishuContext, node: WikiNode, rootId: string): Promise<void> {
  if (!context.scope.wikiNodeIds.includes(rootId)) throw feishuError("FEISHU_SCOPE_ESCAPE", "The Feishu Wiki root is not approved");
  let current = node;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64; depth += 1) {
    if (current.nodeToken === rootId) return;
    if (visited.has(current.nodeToken) || current.parentNodeToken === null) break;
    visited.add(current.nodeToken);
    current = await fetchWikiNode(context, current.parentNodeToken);
  }
  throw feishuError("FEISHU_SCOPE_ESCAPE", "The Feishu Wiki node is outside the approved root");
}

async function fetchDocumentBody(context: FeishuContext, token: string, maxBytes: number): Promise<Uint8Array> {
  let result;
  try {
    result = await runLark(context.runner, context.scope.profile, [
      "docs", "+fetch", "--doc", token, "--as", "user", "--format", "json",
      "--scope", "full", "--detail", "simple", "--doc-format", "markdown",
    ], 60_000, maxBytes);
  } catch (error) {
    if (outputLimitExceeded(error)) {
      throw feishuError("FEISHU_BODY_BUDGET_EXCEEDED", "The selected Feishu document exceeded the approved body budget");
    }
    throw feishuError("FEISHU_BODY_READ_FAILED", "The approved Feishu document body could not be read");
  }
  const value = parseObject(result.stdout);
  const document = nestedRecord(value, ["data", "document"]);
  const content = typeof document?.content === "string" ? document.content : undefined;
  const revisionId = document?.revision_id;
  if (content === undefined || !wellFormedUtf16(content)
    || !Number.isSafeInteger(revisionId) || Number(revisionId) < 0) {
    throw feishuError("FEISHU_BODY_INVALID", "The approved Feishu document body response was invalid");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw feishuError("FEISHU_BODY_BUDGET_EXCEEDED", "The selected Feishu document exceeded the approved body budget");
  }
  return bytes;
}

function outputLimitExceeded(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
    current = current.cause;
  }
  return false;
}

async function* bytesAsChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += BODY_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, bytes.byteLength));
  }
}

function metadataNode(
  context: FeishuContext,
  metadata: FeishuMetadata,
  nodeId: string,
  parentId: string | null,
  permitted: boolean,
): SkeletonNode {
  const readable = permitted;
  return {
    schema: "openlifewiki.skeleton-node/v1", sourceId: context.source.sourceId,
    nodeId, parentId, kind: metadata.kind, title: metadata.title, locator: encodeLocator(metadata.locator),
    childCount: metadata.kind === "directory" ? { value: null, kind: "unknown" } : { value: 0, kind: "known" },
    modifiedRange: null, permission: readable ? "readable" : "denied",
    scanability: readable && metadata.bodyReadable ? "metadata-and-body" : "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: metadata.size === null ? { bytes: null, kind: "unknown" } : { bytes: metadata.size, kind: "known" },
    nodeVersion: metadata.version,
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
    schema: "openlifewiki.skeleton-page/v1", sourceId: options.sourceId, parentNodeId,
    requestScopeHash: options.scopeHash, nodes, nextCursor, pageComplete,
    observedAt: options.now().toISOString(), skeletonVersion: options.plan.skeletonVersion,
  };
}

function withPage(node: SkeletonNode, cursor: string | null, hasMore: boolean): SkeletonNode {
  return { ...node, page: { cursor, hasMore } };
}

function approvedRootDescriptors(scope: FeishuScope): readonly { readonly kind: RootKind; readonly id: string; readonly path: string }[] {
  return [
    ...scope.baseIds.map((id) => ({ kind: "base" as const, id, path: `/base/${id}` })),
    ...scope.documentIds.map((id) => ({ kind: "document" as const, id, path: `/document/${id}` })),
    ...scope.wikiNodeIds.map((id) => ({ kind: "wiki" as const, id, path: `/wiki/${id}` })),
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function logicalNodeId(locator: FeishuLocator): string {
  return sha256Canonical({
    provider: "feishu-logical-object", rootKind: locator.rootKind, rootId: locator.rootId,
    kind: locator.kind, objectId: locator.objectId,
  });
}

function logicalPath(locator: FeishuLocator): string {
  if (locator.kind === "source-root") return "/";
  const root = `/${locator.rootKind ?? "unknown"}/${locator.rootId ?? "unknown"}`;
  if (locator.kind === "page-content") {
    const page = locator.objectId === locator.rootId ? root : `${root}/wiki/${locator.objectId}`;
    return `${page}/page-content`;
  }
  return locator.objectId === locator.rootId ? root : `${root}/${locator.kind}/${locator.objectId}`;
}

function encodeLocator(locator: FeishuLocator): string {
  return `openlifewiki-feishu://node/${Buffer.from(JSON.stringify(locator), "utf8").toString("base64url")}`;
}

function parseLocator(raw: string, scope: FeishuScope): FeishuLocator {
  try {
    const url = new URL(raw);
    if (url.protocol !== "openlifewiki-feishu:" || url.hostname !== "node") throw new Error();
    const locator = JSON.parse(Buffer.from(url.pathname.slice(1), "base64url").toString("utf8")) as unknown;
    if (!isRecord(locator) || locator.schema !== "openlifewiki.locator/feishu/v1"
      || !isObjectKind(locator.kind) || !(locator.rootKind === null || isRootKind(locator.rootKind))
      || !(locator.rootId === null || typeof locator.rootId === "string") || typeof locator.objectId !== "string"
      || !(locator.parentObjectId === null || typeof locator.parentObjectId === "string")
      || !(locator.spaceId === null || typeof locator.spaceId === "string")
      || !(locator.objectToken === null || typeof locator.objectToken === "string")
      || !(locator.objectType === null || typeof locator.objectType === "string")
      || !(locator.docToken === null || typeof locator.docToken === "string")
      || !(locator.hasChildren === null || typeof locator.hasChildren === "boolean")) throw new Error();
    const parsed = locator as unknown as FeishuLocator;
    if (!locatorInScope(parsed, scope)) throw new Error();
    return parsed;
  } catch {
    throw invalidLocator();
  }
}

function locatorInScope(locator: FeishuLocator, scope: FeishuScope): boolean {
  if (locator.kind === "source-root") return locator.rootKind === null && locator.rootId === null;
  if (locator.rootKind === "document") {
    return locator.kind === "document" && locator.rootId === locator.objectId
      && locator.rootId !== null && scope.documentIds.includes(locator.rootId);
  }
  if (locator.rootKind === "wiki") return (locator.kind === "wiki" || locator.kind === "page-content")
    && locator.rootId !== null && scope.wikiNodeIds.includes(locator.rootId);
  if (locator.rootKind === "base") return locator.kind === "base"
    && locator.rootId !== null && scope.baseIds.includes(locator.rootId);
  return false;
}

function bodyDocumentToken(locator: FeishuLocator): string | null {
  if (locator.kind === "document") return locator.docToken;
  if (locator.kind === "page-content" && isDocumentType(locator.objectType)) return locator.docToken;
  if (locator.kind === "wiki" && locator.hasChildren === false && isDocumentType(locator.objectType)) return locator.docToken;
  return null;
}

function assertActionBinding(binding: ProgressiveConnectorBinding): void {
  assertScanPlan(binding.plan);
  const { authorizationHash, ...payload } = binding.source;
  const sourceIndex = binding.plan.sourceIds.indexOf(binding.sourceId);
  if (binding.source.connectorType !== "feishu" || sha256Canonical(payload) !== authorizationHash
    || binding.sourceId !== binding.source.sourceId || binding.authorizationHash !== authorizationHash
    || binding.rootNodeId !== binding.source.rootNodeId || binding.scopeHash !== progressiveConnectorScopeHash(binding.source)
    || sourceIndex < 0 || binding.plan.authorizationHashes[sourceIndex] !== binding.authorizationHash
    || binding.plan.rootNodeIds[sourceIndex] !== binding.rootNodeId) {
    throw feishuError("FEISHU_ACTION_BINDING_INVALID", "Feishu action binding is invalid or stale");
  }
  parseFeishuScope(binding.source.scope);
}

function assertNodeBinding(binding: ProgressiveConnectorBinding, node: SkeletonNode): void {
  if (node.sourceId !== binding.sourceId) throw feishuError("FEISHU_ACTION_BINDING_INVALID", "Feishu node Source binding is invalid");
  if (node.nodeId === binding.rootNodeId) return;
  const locator = parseLocator(node.locator, parseFeishuScope(binding.source.scope));
  if (logicalNodeId(locator) !== node.nodeId) throw feishuError("FEISHU_ACTION_BINDING_INVALID", "Feishu node identity binding is invalid");
}

function assertTraversalBinding(options: ProgressiveConnectorChildrenOptions): void {
  assertEnumerationIntent(options.intent, { plan: options.plan, trustedDecisionReceipts: options.trustedDecisionReceipts });
  if (!options.trustedReceiptHashes.includes(options.intent.receiptHash)
    || options.trustedDecisionReceipts.some(({ receiptHash }) => !options.trustedReceiptHashes.includes(receiptHash))
    || options.intent.sourceId !== options.sourceId || options.intent.authorizationHash !== options.authorizationHash
    || options.intent.targetNodeId !== options.parent.nodeId || options.intent.targetNodeVersion !== options.parent.nodeVersion) {
    throw feishuError("FEISHU_TRAVERSAL_DENIED", "Feishu enumeration intent is absent, untrusted or mismatched");
  }
  const previous = options.previousPageReceipt;
  if (options.cursor === null) {
    if (previous !== null) throw feishuError("FEISHU_PAGE_CHAIN_INVALID", "The first Feishu page cannot claim a previous receipt");
    return;
  }
  if (previous === null || !options.trustedReceiptHashes.includes(previous.receiptHash)) {
    throw feishuError("FEISHU_PAGE_CHAIN_INVALID", "A trusted previous Feishu page receipt is required");
  }
  const { receiptHash, ...payload } = previous;
  if (sha256Canonical(payload) !== receiptHash || previous.scanId !== options.plan.scanId
    || previous.scanPlanHash !== options.plan.scanPlanHash || previous.skeletonVersion !== options.plan.skeletonVersion
    || previous.sourceId !== options.sourceId || previous.intentId !== options.intent.intentId
    || previous.nextCursor !== options.cursor || previous.state !== "open") {
    throw feishuError("FEISHU_PAGE_CHAIN_INVALID", "The previous Feishu page receipt is invalid or stale");
  }
}

function scanPermits(context: FeishuContext, path: string, container: boolean): boolean {
  const permitted = isScanPathPermitted({
    path,
    container,
    includeSets: [context.source.include, ...context.plan.policy.includeSets],
    exclude: [...context.source.exclude, ...context.plan.policy.exclude],
  });
  const sensitivity = context.source.sensitivity.rules.find(({ match }) => matchesScanPattern(path, match))?.level
    ?? context.source.sensitivity.default;
  return permitted
    && (sensitivity === "normal" || context.plan.policy.sensitivity.default === "sensitive");
}

type DecodedCursor = Pick<CursorPayload, "mode" | "offset" | "platformCursor" | "pageSequence">;

function cursorExpected(options: ProgressiveConnectorChildrenOptions): Omit<CursorPayload, "schema" | "mode" | "offset" | "platformCursor" | "pageSequence"> {
  return {
    sourceId: options.sourceId, scanPlanHash: options.plan.scanPlanHash,
    skeletonVersion: options.plan.skeletonVersion, intentId: options.intent.intentId,
    scopeHash: options.scopeHash, parentNodeId: options.parent.nodeId, parentNodeVersion: options.parent.nodeVersion,
  };
}

function cursorPayload(
  options: ProgressiveConnectorChildrenOptions,
  mode: CursorPayload["mode"],
  offset: number,
  platformCursor: string | null,
  pageSequence: number,
): CursorPayload {
  return { schema: "openlifewiki.feishu-cursor/v1", ...cursorExpected(options), mode, offset, platformCursor, pageSequence };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ payload, hash: sha256Canonical(payload) }), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null,
  expected: ReturnType<typeof cursorExpected>,
): DecodedCursor {
  if (cursor === null) return { mode: "local", offset: 0, platformCursor: null, pageSequence: 1 };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { payload?: CursorPayload; hash?: string };
    const payload = value.payload;
    if (payload === undefined || payload.schema !== "openlifewiki.feishu-cursor/v1"
      || value.hash !== sha256Canonical(payload) || payload.sourceId !== expected.sourceId
      || payload.scanPlanHash !== expected.scanPlanHash || payload.skeletonVersion !== expected.skeletonVersion
      || payload.intentId !== expected.intentId || payload.scopeHash !== expected.scopeHash
      || payload.parentNodeId !== expected.parentNodeId || payload.parentNodeVersion !== expected.parentNodeVersion
      || (payload.mode !== "local" && payload.mode !== "platform") || !Number.isSafeInteger(payload.offset)
      || payload.offset < 0 || !(payload.platformCursor === null || typeof payload.platformCursor === "string")
      || !Number.isSafeInteger(payload.pageSequence) || payload.pageSequence < 2) throw new Error();
    return payload;
  } catch {
    throw invalidCursor();
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw feishuError("FEISHU_LIMIT_INVALID", `Feishu page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function parseFeishuScope(scope: Readonly<Record<string, unknown>>): FeishuScope {
  if (scope.schema !== "openlifewiki.scope/feishu/v1" || typeof scope.profile !== "string" || scope.profile.length === 0
    || typeof scope.expectedTenantId !== "string" || scope.expectedTenantId.length === 0
    || !stringArray(scope.documentIds) || !stringArray(scope.wikiNodeIds) || !stringArray(scope.baseIds)
    || scope.documentIds.length + scope.wikiNodeIds.length + scope.baseIds.length === 0) throw invalidScope();
  const all = [...scope.documentIds, ...scope.wikiNodeIds, ...scope.baseIds];
  if (new Set(all).size !== all.length) throw invalidScope();
  return {
    schema: "openlifewiki.scope/feishu/v1", profile: scope.profile, expectedTenantId: scope.expectedTenantId,
    documentIds: [...scope.documentIds], wikiNodeIds: [...scope.wikiNodeIds], baseIds: [...scope.baseIds],
  };
}

function requiredFeishuScopes(scope: FeishuScope): readonly string[] {
  const required = new Set<string>();
  if (scope.documentIds.length > 0 || scope.wikiNodeIds.length > 0) {
    required.add("docs:document.content:read");
    required.add("drive:drive.metadata:readonly");
  }
  if (scope.wikiNodeIds.length > 0) required.add("wiki:node:read");
  if (scope.baseIds.length > 0) {
    required.add("base:app:read"); required.add("base:table:read"); required.add("base:record:read");
  }
  return [...required].sort();
}

function parseAuthStatus(raw: string): FeishuAuthStatus | undefined {
  const value = parseObject(raw);
  const user = nestedRecord(value, ["identities", "user"]);
  if (value === undefined || user === undefined || typeof value.appId !== "string" || typeof value.verified !== "boolean"
    || typeof user.status !== "string" || typeof user.available !== "boolean" || typeof user.verified !== "boolean"
    || typeof user.openId !== "string" || typeof user.userName !== "string" || typeof user.tokenStatus !== "string"
    || typeof user.scope !== "string") return undefined;
  return { appId: value.appId, verified: value.verified, user: {
    status: user.status, available: user.available, verified: user.verified, openId: user.openId,
    userName: user.userName, tokenStatus: user.tokenStatus, scopes: user.scope.split(/\s+/u).filter(Boolean),
  } };
}

function parseCurrentUser(raw: string): FeishuCurrentUser | undefined {
  const user = nestedRecord(parseObject(raw), ["data", "user"]);
  if (user === undefined || typeof user.name !== "string" || typeof user.open_id !== "string"
    || typeof user.tenant_key !== "string") return undefined;
  return { name: user.name, openId: user.open_id, tenantKey: user.tenant_key };
}

function scopeCheckPassed(raw: string, required: readonly string[]): boolean {
  const value = parseObject(raw);
  return value?.ok === true && Array.isArray(value.granted)
    && (value.missing === null || Array.isArray(value.missing) && value.missing.length === 0)
    && required.every((scope) => feishuScopeGranted(value.granted as unknown[], scope));
}

function feishuScopeGranted(granted: readonly unknown[], required: string): boolean {
  return granted.includes(required)
    || required === "drive:drive.metadata:readonly" && granted.includes("drive:drive");
}

function parseWikiNode(value: unknown): WikiNode | undefined {
  if (!isRecord(value) || typeof value.space_id !== "string" || typeof value.node_token !== "string"
    || typeof value.obj_token !== "string" || typeof value.obj_type !== "string"
    || !(value.parent_node_token === undefined || value.parent_node_token === null || typeof value.parent_node_token === "string")
    || typeof value.has_child !== "boolean" || typeof value.title !== "string") return undefined;
  return {
    spaceId: value.space_id, nodeToken: value.node_token, objectToken: value.obj_token,
    objectType: value.obj_type,
    parentNodeToken: typeof value.parent_node_token === "string" && value.parent_node_token.length > 0
      ? value.parent_node_token : null,
    hasChildren: value.has_child, title: value.title,
  };
}

function status(
  source: ConnectorProbeOptions["source"], observedAt: string, profile: string, version: string | undefined,
  connection: ConnectorStatus["status"], identity: FeishuIdentity | null, blocking: ConnectorStatus["blocking"],
): ConnectorStatus {
  return {
    schema: "openlifewiki.connector-status/v1", sourceId: source.sourceId, connectorType: "feishu",
    providerName: PROVIDER_NAME, providerProject: PROVIDER_PROJECT, ...(version === undefined ? {} : { providerVersion: version }),
    identity: identity === null ? { profile, account: "unverified", tenant: "unverified", effectiveScope: "unverified" } : {
      profile, account: redacted(identity.user.name), tenant: redacted(identity.user.tenantKey),
      effectiveScope: identity.requiredScopes.join(","), fingerprint: identityFingerprint(profile, identity),
    },
    authorizedScope: source.scope, status: connection, lastProbe: observedAt, changedItems: 0, blocking,
  };
}

function identityFingerprint(profile: string, identity: FeishuIdentity): string {
  return sha256Canonical({
    provider: "feishu", profile, appId: identity.auth.appId,
    tenantKey: identity.user.tenantKey, openId: identity.user.openId,
  });
}

async function runLark(
  runner: CommandRunner,
  profile: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes?: number,
) {
  return await runner.run("lark-cli", ["--profile", profile, ...args], {
    env: safeEnvironment(),
    timeoutMs,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nestedRecord(value: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function arrayAt(value: unknown, path: readonly string[]): readonly unknown[] | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return Array.isArray(current) ? current : undefined;
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isDocumentType(value: unknown): boolean {
  return value === "doc" || value === "docx";
}

function isRootKind(value: unknown): value is RootKind {
  return value === "document" || value === "wiki" || value === "base";
}

function isObjectKind(value: unknown): value is ObjectKind {
  return value === "source-root" || value === "document" || value === "wiki"
    || value === "page-content" || value === "base";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isProgressiveProbe(
  options: ConnectorProbeOptions | ProgressiveConnectorProbeOptions,
): options is ProgressiveConnectorProbeOptions {
  return "authorizationHash" in options && "scopeHash" in options;
}

function scopeProfile(scope: Readonly<Record<string, unknown>>): string {
  return typeof scope.profile === "string" ? scope.profile : "unverified";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function feishuProviderErrorCode(error: unknown): string | undefined {
  const code = errorCode(error);
  return code?.startsWith("FEISHU_") === true ? code : undefined;
}

function invalidScope(): Error & { readonly code: string } {
  return feishuError("FEISHU_SCOPE_INVALID", "Feishu scope is invalid");
}

function invalidLocator(): Error & { readonly code: string } {
  return feishuError("FEISHU_ACTION_BINDING_INVALID", "Feishu node locator is invalid or outside the approved scope");
}

function invalidCursor(): Error & { readonly code: string } {
  return feishuError("FEISHU_CURSOR_INVALID", "Feishu cursor is invalid or stale");
}

function feishuError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
