import type {
  AuthorizedSourceV1,
  ConnectorStatus,
  ConnectorType,
  OpenLifeWikiConfigV2,
} from "@openlifewiki/protocol";
import { sha256Canonical } from "@openlifewiki/protocol";

import { currentOwnerIdentityFingerprint, readConfigSnapshot, updateConfigV2 } from "./config-store.js";
import { AdapterError } from "./errors.js";

const OWNER_ACTOR = "human:owner" as const;
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface SourceAuthorizationRequest {
  readonly schema: "openlifewiki.source-authorization-request/v1";
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly rootNodeId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly sensitivity: AuthorizedSourceV1["sensitivity"];
  readonly budget: AuthorizedSourceV1["budget"];
}

export type SourceProbe = (options: {
  readonly source: Pick<AuthorizedSourceV1, "sourceId" | "connectorType" | "rootNodeId" | "scope" | "providerObservation">;
  readonly now: () => Date;
}) => Promise<ConnectorStatus>;

export interface SourceAuthorizationPreview {
  readonly schema: "openlifewiki.source-authorization-preview/v1";
  readonly action: "authorize" | "narrow" | "reauthorize";
  readonly configRevision: number;
  readonly configHash: string;
  readonly normalizedRequest: SourceAuthorizationRequest;
  readonly previousAuthorizationHash: string | null;
  readonly provider: {
    readonly name: string;
    readonly version: string;
    readonly status: "connected";
    readonly identityFingerprint: string;
    readonly identity: Readonly<Record<string, string>>;
    readonly contractHash: string | null;
  };
  readonly previewHash: string;
}

export interface SourceRevocationPreview {
  readonly schema: "openlifewiki.source-revocation-preview/v1";
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly configRevision: number;
  readonly configHash: string;
  readonly authorizationHash: string;
  readonly previewHash: string;
}

export interface SourceRevocationApproval {
  readonly schema: "openlifewiki.source-owner-revocation/v1";
  readonly approvedBy: "human:owner";
  readonly approvedAt: string;
  readonly ownerIdentityFingerprint: string;
  readonly previewHash: string;
  readonly configHash: string;
  readonly configRevision: number;
  readonly sourceId: string;
  readonly authorizationHash: string;
  readonly approvalHash: string;
}

export async function previewSourceAuthorization(options: {
  readonly configPath: string;
  readonly request: unknown;
  readonly probe: SourceProbe;
  readonly now?: () => Date;
}): Promise<SourceAuthorizationPreview> {
  const snapshot = await requireV2(options.configPath);
  let request: SourceAuthorizationRequest;
  try {
    request = normalizeSourceAuthorizationRequest(options.request);
  } catch (error) {
    throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", "Source authorization request is invalid", { cause: error });
  }
  const existing = snapshot.config.sources.find(({ sourceId }) => sourceId === request.sourceId);
  const sameConnector = snapshot.config.sources.find(({ connectorType }) => connectorType === request.connectorType);
  if (sameConnector !== undefined && sameConnector.sourceId !== request.sourceId) {
    throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", `Connector ${request.connectorType} already has an authorized Source`);
  }
  if (existing !== undefined && existing.connectorType !== request.connectorType) {
    throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", "A Source ID cannot change Connector type");
  }

  const now = options.now ?? (() => new Date());
  const status = await options.probe({ source: request, now });
  if (status.status !== "connected") {
    throw new AdapterError(
      "SOURCE_PROBE_BLOCKED",
      status.blocking?.remediation ?? "Connector probe did not pass",
      { publicDetails: { connectorStatus: status } },
    );
  }
  const identityFingerprint = status.identity?.fingerprint;
  if (identityFingerprint === undefined || identityFingerprint.length === 0) {
    throw new AdapterError("SOURCE_PROBE_BLOCKED", "Connector probe returned no stable identity fingerprint");
  }
  const providerVersion = status.providerVersion;
  if (providerVersion === undefined || providerVersion.length === 0) {
    throw new AdapterError("SOURCE_PROBE_BLOCKED", "Connector probe returned no provider version");
  }

  const action: SourceAuthorizationPreview["action"] = existing === undefined
    ? "authorize"
    : isNarrower(existing, request) ? "narrow" : "reauthorize";
  const unsigned = {
    schema: "openlifewiki.source-authorization-preview/v1" as const,
    action,
    configRevision: snapshot.config.revision,
    configHash: snapshot.hash,
    normalizedRequest: request,
    previousAuthorizationHash: existing?.authorizationHash ?? null,
    provider: {
      name: status.providerName,
      version: providerVersion,
      status: "connected" as const,
      identityFingerprint,
      identity: status.identity ?? {},
      contractHash: status.providerContractHash ?? null,
    },
  };
  return { ...unsigned, previewHash: sha256Canonical(unsigned) };
}

export async function executeSourceAuthorization(options: {
  readonly configPath: string;
  readonly request: unknown;
  readonly expectedPreviewHash: string;
  readonly probe: SourceProbe;
  readonly now?: () => Date;
}): Promise<{ readonly source: AuthorizedSourceV1; readonly config: OpenLifeWikiConfigV2 }> {
  requireDigest(options.expectedPreviewHash);
  const now = options.now ?? (() => new Date());
  const preview = await previewSourceAuthorization({
    configPath: options.configPath,
    request: options.request,
    probe: options.probe,
    now,
  });
  if (preview.previewHash !== options.expectedPreviewHash) {
    throw new AdapterError("PLAN_CHANGED", "Source authorization inputs changed after preview");
  }
  const approvedAt = now().toISOString();
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: preview.action,
    approvedBy: OWNER_ACTOR,
    approvedAt,
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    previewHash: preview.previewHash,
    configHash: preview.configHash,
    configRevision: preview.configRevision,
    previousAuthorizationHash: preview.previousAuthorizationHash,
  };
  const approval: AuthorizedSourceV1["approval"] = {
    ...approvalUnsigned,
    approvalHash: sha256Canonical(approvalUnsigned),
  };
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: preview.normalizedRequest.sourceId,
    connectorType: preview.normalizedRequest.connectorType,
    rootNodeId: preview.normalizedRequest.rootNodeId,
    identityFingerprint: preview.provider.identityFingerprint,
    approval,
    providerObservation: {
      providerName: preview.provider.name,
      providerVersion: preview.provider.version,
      contractHash: preview.provider.contractHash,
    },
    scope: preview.normalizedRequest.scope,
    include: preview.normalizedRequest.include,
    exclude: preview.normalizedRequest.exclude,
    sensitivity: preview.normalizedRequest.sensitivity,
    budget: preview.normalizedRequest.budget,
    approvedBy: OWNER_ACTOR,
    approvedAt,
  };
  const source: AuthorizedSourceV1 = { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
  const updated = await updateConfigV2(options.configPath, preview.configRevision, (config) => ({
    ...config,
    sources: [...config.sources.filter(({ sourceId }) => sourceId !== source.sourceId), source],
  }));
  return { source, config: updated.config };
}

export async function previewSourceRevocation(options: {
  readonly configPath: string;
  readonly sourceId: string;
}): Promise<SourceRevocationPreview> {
  const snapshot = await requireV2(options.configPath);
  const sourceId = normalizeId(options.sourceId, "sourceId");
  const source = snapshot.config.sources.find((item) => item.sourceId === sourceId);
  if (source === undefined) throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", `Source ${sourceId} is not authorized`);
  const unsigned = {
    schema: "openlifewiki.source-revocation-preview/v1" as const,
    sourceId,
    connectorType: source.connectorType,
    configRevision: snapshot.config.revision,
    configHash: snapshot.hash,
    authorizationHash: source.authorizationHash,
  };
  return { ...unsigned, previewHash: sha256Canonical(unsigned) };
}

export async function executeSourceRevocation(options: {
  readonly configPath: string;
  readonly sourceId: string;
  readonly expectedPreviewHash: string;
}): Promise<{
  readonly sourceId: string;
  readonly revoked: true;
  readonly approval: SourceRevocationApproval;
  readonly config: OpenLifeWikiConfigV2;
}> {
  requireDigest(options.expectedPreviewHash);
  const preview = await previewSourceRevocation(options);
  if (preview.previewHash !== options.expectedPreviewHash) {
    throw new AdapterError("PLAN_CHANGED", "Source revocation inputs changed after preview");
  }
  const updated = await updateConfigV2(options.configPath, preview.configRevision, (config) => ({
    ...config,
    sources: config.sources.filter(({ sourceId }) => sourceId !== preview.sourceId),
  }));
  const approvedAt = new Date().toISOString();
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-revocation/v1" as const,
    approvedBy: OWNER_ACTOR,
    approvedAt,
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    previewHash: preview.previewHash,
    configHash: preview.configHash,
    configRevision: preview.configRevision,
    sourceId: preview.sourceId,
    authorizationHash: preview.authorizationHash,
  };
  const approval: SourceRevocationApproval = {
    ...approvalUnsigned,
    approvalHash: sha256Canonical(approvalUnsigned),
  };
  return {
    sourceId: preview.sourceId,
    revoked: true,
    approval,
    config: updated.config,
  };
}

export function normalizeSourceAuthorizationRequest(value: unknown): SourceAuthorizationRequest {
  const request = strictRecord(value, [
    "schema", "sourceId", "connectorType", "rootNodeId", "scope",
    "include", "exclude", "sensitivity", "budget",
  ], "Source authorization request");
  if (request.schema !== "openlifewiki.source-authorization-request/v1") {
    throw new Error("Source authorization request schema is invalid");
  }
  if (!isConnectorType(request.connectorType)) throw new Error("Connector type is invalid");
  const sourceId = normalizeId(request.sourceId, "sourceId");
  const rootNodeId = normalizeId(request.rootNodeId, "rootNodeId");
  const include = stringList(request.include, "include");
  const exclude = stringList(request.exclude, "exclude");
  const sensitivity = parseSensitivity(request.sensitivity);
  const budget = parseBudget(request.budget);
  return {
    schema: "openlifewiki.source-authorization-request/v1",
    sourceId,
    connectorType: request.connectorType,
    rootNodeId,
    scope: parseScope(request.connectorType, request.scope),
    include,
    exclude,
    sensitivity,
    budget,
  };
}

async function requireV2(path: string) {
  const snapshot = await readConfigSnapshot(path);
  if (snapshot === undefined) throw new AdapterError("INITIALIZATION_REQUIRED", "The openLifeWiki configuration is missing");
  if (snapshot.config.schema !== "openlifewiki.config/v2") {
    throw new AdapterError("CONFIG_MIGRATION_REQUIRED", "Approve the configuration migration before Source authorization");
  }
  return { ...snapshot, config: snapshot.config };
}

function parseScope(connectorType: ConnectorType, value: unknown): Readonly<Record<string, unknown>> {
  if (connectorType === "local-folder") {
    const scope = strictRecord(value, ["schema", "root", "symlinkPolicy"], "Local Folder scope");
    if (scope.schema !== "openlifewiki.scope/local-folder/v1") throw new Error("Local Folder scope schema is invalid");
    const root = nonEmpty(scope.root, "Local Folder root");
    if (scope.symlinkPolicy !== "deny" && scope.symlinkPolicy !== "within-root") throw new Error("Local Folder symlinkPolicy is invalid");
    return { schema: scope.schema, root, symlinkPolicy: scope.symlinkPolicy };
  }
  if (connectorType === "github") {
    const scope = strictRecord(value, ["schema", "hostname", "repository", "path", "ref"], "GitHub scope");
    if (scope.schema !== "openlifewiki.scope/github/v1") throw new Error("GitHub scope schema is invalid");
    const hostname = nonEmpty(scope.hostname, "GitHub hostname").toLowerCase();
    const repository = nonEmpty(scope.repository, "GitHub repository");
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error("GitHub repository must be owner/name");
    const path = scope.path === null ? null : normalizeRelativePath(scope.path, "GitHub path");
    return { schema: scope.schema, hostname, repository, path, ref: nonEmpty(scope.ref, "GitHub ref") };
  }
  if (connectorType === "feishu") {
    const scope = strictRecord(value, [
      "schema", "profile", "expectedTenantId", "documentIds", "wikiNodeIds", "baseIds",
    ], "Feishu scope");
    if (scope.schema !== "openlifewiki.scope/feishu/v1") throw new Error("Feishu scope schema is invalid");
    const documentIds = stringList(scope.documentIds, "Feishu documentIds");
    const wikiNodeIds = stringList(scope.wikiNodeIds, "Feishu wikiNodeIds");
    const baseIds = stringList(scope.baseIds, "Feishu baseIds");
    if (documentIds.length + wikiNodeIds.length + baseIds.length === 0) throw new Error("Feishu scope requires at least one object ID");
    return {
      schema: scope.schema,
      profile: nonEmpty(scope.profile, "Feishu profile"),
      expectedTenantId: nonEmpty(scope.expectedTenantId, "Feishu expectedTenantId"),
      documentIds,
      wikiNodeIds,
      baseIds,
    };
  }
  const scope = strictRecord(value, ["schema", "projectRoots", "threadIds"], "Codex History scope");
  if (scope.schema !== "openlifewiki.scope/codex-history/v1") throw new Error("Codex History scope schema is invalid");
  const projectRoots = stringList(scope.projectRoots, "Codex History projectRoots");
  const threadIds = stringList(scope.threadIds, "Codex History threadIds");
  if (projectRoots.length + threadIds.length === 0) throw new Error("Codex History scope requires a project root or thread ID");
  return { schema: scope.schema, projectRoots, threadIds };
}

function parseSensitivity(value: unknown): AuthorizedSourceV1["sensitivity"] {
  const sensitivity = strictRecord(value, ["default", "rules"], "sensitivity");
  if (sensitivity.default !== "normal" && sensitivity.default !== "sensitive") throw new Error("Sensitivity default is invalid");
  if (!Array.isArray(sensitivity.rules)) throw new Error("Sensitivity rules must be an array");
  return {
    default: sensitivity.default,
    rules: sensitivity.rules.map((value) => {
      const rule = strictRecord(value, ["match", "level"], "sensitivity rule");
      if (rule.level !== "normal" && rule.level !== "sensitive") throw new Error("Sensitivity rule level is invalid");
      return { match: nonEmpty(rule.match, "Sensitivity rule match"), level: rule.level };
    }),
  };
}

function parseBudget(value: unknown): AuthorizedSourceV1["budget"] {
  const budget = strictRecord(value, ["maxNodes", "maxBodyBytes", "maxAgentCalls"], "budget");
  const maxNodes = positiveInteger(budget.maxNodes, "budget maxNodes");
  const maxBodyBytes = positiveInteger(budget.maxBodyBytes, "budget maxBodyBytes");
  const maxAgentCalls = positiveInteger(budget.maxAgentCalls, "budget maxAgentCalls");
  return { maxNodes, maxBodyBytes, maxAgentCalls };
}

function isNarrower(current: AuthorizedSourceV1, next: SourceAuthorizationRequest): boolean {
  if (current.connectorType !== next.connectorType) return false;
  if (next.budget.maxNodes > current.budget.maxNodes
    || next.budget.maxBodyBytes > current.budget.maxBodyBytes
    || next.budget.maxAgentCalls > current.budget.maxAgentCalls) return false;
  if (!next.include.every((value) => current.include.includes(value))) return false;
  if (!current.exclude.every((value) => next.exclude.includes(value))) return false;
  const before = current.scope as Record<string, unknown>;
  const after = next.scope;
  if (next.connectorType === "github") {
    if (before.hostname !== after.hostname || before.repository !== after.repository || before.ref !== after.ref) return false;
    if (before.path === null) return true;
    return typeof before.path === "string" && typeof after.path === "string"
      && (after.path === before.path || after.path.startsWith(`${before.path}/`));
  }
  if (next.connectorType === "feishu") {
    return before.profile === after.profile && before.expectedTenantId === after.expectedTenantId
      && listSubset(after.documentIds, before.documentIds)
      && listSubset(after.wikiNodeIds, before.wikiNodeIds)
      && listSubset(after.baseIds, before.baseIds);
  }
  if (next.connectorType === "codex-history") {
    return listSubset(after.projectRoots, before.projectRoots) && listSubset(after.threadIds, before.threadIds);
  }
  return before.root === after.root && before.symlinkPolicy === after.symlinkPolicy;
}

function listSubset(candidate: unknown, current: unknown): boolean {
  return Array.isArray(candidate) && Array.isArray(current)
    && candidate.every((value) => current.includes(value));
}

function strictRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((field) => !fields.includes(field));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`);
  return record;
}

function normalizeId(value: unknown, label: string): string {
  const id = nonEmpty(value, label);
  if (!SOURCE_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map((item) => nonEmpty(item, label)))].sort();
}

function normalizeRelativePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`${label} must stay within the repository`);
  return path;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function isConnectorType(value: unknown): value is ConnectorType {
  return value === "local-folder" || value === "github" || value === "feishu" || value === "codex-history";
}

function requireDigest(value: string): void {
  if (!SHA256.test(value)) throw new AdapterError("PLAN_CHANGED", "Approval digest is invalid or stale");
}
