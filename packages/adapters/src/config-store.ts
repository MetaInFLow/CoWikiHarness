import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";

import {
  parseOpenLifeWikiConfigV1,
  parseOpenLifeWikiConfigV2,
  sha256Canonical,
  type AuthorizedSource,
  type OpenLifeWikiConfig,
  type OpenLifeWikiConfigCompatibilityV1,
  type OpenLifeWikiConfigV1,
  type OpenLifeWikiConfigV2,
} from "@openlifewiki/protocol";

import { AdapterError } from "./errors.js";
import { writeJsonAtomic } from "./state-store.js";

export interface ConfigSnapshot<TConfig extends OpenLifeWikiConfig = OpenLifeWikiConfig> {
  readonly config: TConfig;
  readonly raw: Uint8Array;
  readonly hash: string;
}

export interface ConfigV1MigrationPreview {
  readonly schema: "openlifewiki.config-migration-preview/v1";
  readonly fromSchema: "openlifewiki.config/v1";
  readonly toSchema: "openlifewiki.config/v2";
  readonly ownerId: string;
  readonly sourceConfigHash: string;
  readonly targetConfigHash: string;
  readonly v1AuthorizationsAdded: 0;
  readonly preservedP0Sources: number;
  readonly preservedAgentBindings: number;
  readonly previewHash: string;
}

export interface ConfigV1MigrationApproval {
  readonly approvedBy: string;
  readonly sourceConfigHash: string;
  readonly previewHash: string;
}

export async function readConfigSnapshot(path: string): Promise<ConfigSnapshot | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return parseSnapshot(raw);
}

export async function readConfig(path: string): Promise<OpenLifeWikiConfig | undefined> {
  return (await readConfigSnapshot(path))?.config;
}

export async function writeConfig(path: string, config: OpenLifeWikiConfig): Promise<void> {
  await withConfigLock(path, async () => {
    if (config.schema === "openlifewiki.config/v2") {
      const parsed = parseConfigV2(config);
      if (parsed.revision !== 0) {
        throw new AdapterError("CONFIG_CONFLICT", "A new config/v2 must begin at revision 0");
      }
      if (await readConfigSnapshot(path) !== undefined) {
        throw new AdapterError("CONFIG_CONFLICT", "Existing config/v2 writes require revision compare-and-swap");
      }
      await writeJsonAtomic(path, parsed);
      return;
    }
    const existing = await readConfigSnapshot(path);
    if (existing?.config.schema === "openlifewiki.config/v2") {
      throw new AdapterError("CONFIG_CONFLICT", "config/v2 cannot be replaced by a legacy configuration");
    }
    await writeJsonAtomic(path, parseConfigV1(config));
  });
}

export function emptyConfig(): OpenLifeWikiConfigV2 {
  return {
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources: [],
    hostConfig: null,
    scanPolicy: null,
    compatibility: { p0Sources: [], agentBindings: [] },
  };
}

export function currentOwnerIdentityFingerprint(): string {
  const owner = userInfo();
  return sha256Canonical({ actor: "human:owner", uid: owner.uid, username: owner.username });
}

export function getP0Sources(config: OpenLifeWikiConfig): readonly AuthorizedSource[] {
  return config.schema === "openlifewiki.config/v1"
    ? config.sources
    : config.compatibility.p0Sources;
}

export function getAgentBindings(config: OpenLifeWikiConfig): readonly string[] {
  return config.schema === "openlifewiki.config/v1"
    ? config.agentBindings
    : config.compatibility.agentBindings;
}

export async function previewConfigV1Migration(
  path: string,
  ownerId: string,
): Promise<ConfigV1MigrationPreview> {
  assertOwnerId(ownerId);
  const snapshot = await readConfigSnapshot(path);
  if (snapshot === undefined) {
    throw new AdapterError("CONFIG_INVALID", "Configuration is missing");
  }
  if (snapshot.config.schema !== "openlifewiki.config/v1") {
    throw new AdapterError("CONFIG_CONFLICT", "Only config/v1 can be migrated to config/v2");
  }
  return buildMigrationPreview(snapshot as ConfigSnapshot<OpenLifeWikiConfigV1>, ownerId);
}

export async function executeConfigV1Migration(
  path: string,
  options: {
    readonly expectedOwnerId: string;
    readonly approval: ConfigV1MigrationApproval;
  },
): Promise<ConfigSnapshot<OpenLifeWikiConfigV2>> {
  assertOwnerId(options.expectedOwnerId);
  if (options.approval.approvedBy !== options.expectedOwnerId) {
    throw new AdapterError("CONFIG_MIGRATION_REJECTED", "Migration approval does not match the Owner");
  }
  return await withConfigLock(path, async () => {
    const snapshot = await readConfigSnapshot(path);
    if (snapshot === undefined || snapshot.config.schema !== "openlifewiki.config/v1") {
      throw new AdapterError("CONFIG_CONFLICT", "The migration source is no longer config/v1");
    }
    if (snapshot.hash !== options.approval.sourceConfigHash) {
      throw new AdapterError("CONFIG_CONFLICT", "The migration source bytes changed after preview");
    }
    const preview = buildMigrationPreview(
      snapshot as ConfigSnapshot<OpenLifeWikiConfigV1>,
      options.expectedOwnerId,
    );
    if (preview.previewHash !== options.approval.previewHash) {
      throw new AdapterError("CONFIG_MIGRATION_REJECTED", "Migration approval does not match the exact preview");
    }
    const target = migrationTarget(snapshot.config);
    await writeJsonAtomic(path, target);
    return await readRequiredV2Snapshot(path);
  });
}

export async function updateConfigV2(
  path: string,
  expectedRevision: number,
  updater: (config: OpenLifeWikiConfigV2) => OpenLifeWikiConfigV2,
): Promise<ConfigSnapshot<OpenLifeWikiConfigV2>> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new AdapterError("CONFIG_CONFLICT", "Expected config revision must be a non-negative integer");
  }
  return await withConfigLock(path, async () => {
    const snapshot = await readRequiredV2Snapshot(path);
    if (snapshot.config.revision !== expectedRevision) {
      throw new AdapterError(
        "CONFIG_CONFLICT",
        `Config revision changed: expected ${expectedRevision}, received ${snapshot.config.revision}`,
      );
    }
    const current = structuredClone(snapshot.config);
    const proposed = updater(structuredClone(current));
    if (proposed.schema !== "openlifewiki.config/v2" || proposed.revision !== expectedRevision) {
      throw new AdapterError("CONFIG_INVALID", "Config updater cannot change schema or revision");
    }
    const next = parseConfigV2({ ...proposed, revision: expectedRevision + 1 });
    await writeJsonAtomic(path, next);
    return await readRequiredV2Snapshot(path);
  });
}

export async function updateP0Compatibility(
  path: string,
  expectedRevision: number,
  updater: (
    compatibility: OpenLifeWikiConfigCompatibilityV1,
  ) => OpenLifeWikiConfigCompatibilityV1,
): Promise<ConfigSnapshot<OpenLifeWikiConfigV2>> {
  return await updateConfigV2(path, expectedRevision, (config) => ({
    ...config,
    compatibility: updater(structuredClone(config.compatibility)),
  }));
}

function parseSnapshot(raw: Buffer): ConfigSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new AdapterError("CONFIG_INVALID", "Configuration is not valid JSON", { cause: error });
  }
  try {
    if (typeof value !== "object" || value === null || !("schema" in value)) {
      throw new Error("missing schema");
    }
    const schema = (value as { schema?: unknown }).schema;
    const config = schema === "openlifewiki.config/v1"
      ? parseOpenLifeWikiConfigV1(value)
      : schema === "openlifewiki.config/v2"
        ? parseOpenLifeWikiConfigV2(value)
        : undefined;
    if (config === undefined) throw new Error("unsupported schema");
    if (config.schema === "openlifewiki.config/v2") assertConfigOwner(config);
    return { config, raw: new Uint8Array(raw), hash: sha256Bytes(raw) };
  } catch (error) {
    throw new AdapterError("CONFIG_INVALID", "Existing configuration is invalid", { cause: error });
  }
}

function parseConfigV1(value: unknown): OpenLifeWikiConfigV1 {
  try {
    return parseOpenLifeWikiConfigV1(value);
  } catch (error) {
    throw new AdapterError("CONFIG_INVALID", "Existing configuration is invalid", { cause: error });
  }
}

function parseConfigV2(value: unknown): OpenLifeWikiConfigV2 {
  try {
    const config = parseOpenLifeWikiConfigV2(value);
    assertConfigOwner(config);
    return config;
  } catch (error) {
    throw new AdapterError("CONFIG_INVALID", "Configuration does not match openlifewiki.config/v2", {
      cause: error,
    });
  }
}

function assertConfigOwner(config: OpenLifeWikiConfigV2): void {
  if (config.sources.some(({ approval }) => (
    approval.ownerIdentityFingerprint !== currentOwnerIdentityFingerprint()
  ))) {
    throw new Error("Source approval belongs to a different local Owner");
  }
}

function migrationTarget(source: OpenLifeWikiConfigV1): OpenLifeWikiConfigV2 {
  return parseConfigV2({
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources: [],
    hostConfig: null,
    scanPolicy: null,
    compatibility: {
      p0Sources: source.sources,
      agentBindings: source.agentBindings,
    },
  });
}

function buildMigrationPreview(
  snapshot: ConfigSnapshot<OpenLifeWikiConfigV1>,
  ownerId: string,
): ConfigV1MigrationPreview {
  const target = migrationTarget(snapshot.config);
  const unsigned = {
    schema: "openlifewiki.config-migration-preview/v1" as const,
    fromSchema: "openlifewiki.config/v1" as const,
    toSchema: "openlifewiki.config/v2" as const,
    ownerId,
    sourceConfigHash: snapshot.hash,
    targetConfigHash: sha256Canonical(target),
    v1AuthorizationsAdded: 0 as const,
    preservedP0Sources: snapshot.config.sources.length,
    preservedAgentBindings: snapshot.config.agentBindings.length,
  };
  return { ...unsigned, previewHash: sha256Canonical(unsigned) };
}

async function readRequiredV2Snapshot(path: string): Promise<ConfigSnapshot<OpenLifeWikiConfigV2>> {
  const snapshot = await readConfigSnapshot(path);
  if (snapshot === undefined || snapshot.config.schema !== "openlifewiki.config/v2") {
    throw new AdapterError("CONFIG_CONFLICT", "A config/v2 snapshot is required");
  }
  return snapshot as ConfigSnapshot<OpenLifeWikiConfigV2>;
}

async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let acquired = false;
  let ownerToken: string | undefined;
  let ownerInode: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const details = await stat(lockPath);
        const token = randomUUID();
        await writeJsonAtomic(join(lockPath, "owner.json"), {
          schema: "openlifewiki.config-lock/v1",
          pid: process.pid,
          token,
          inode: details.ino,
          createdAt: new Date().toISOString(),
        });
        ownerToken = token;
        ownerInode = details.ino;
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const observed = await readLockIdentity(lockPath);
      if (observed !== undefined && isStaleLock(observed) && await takeOverStaleLock(lockPath, observed)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!acquired) {
    throw new AdapterError("CONFIG_CONFLICT", "Configuration is locked by another writer");
  }
  try {
    return await operation();
  } finally {
    if (ownerToken !== undefined && ownerInode !== undefined) {
      await releaseOwnedLock(lockPath, ownerToken, ownerInode);
    }
  }
}

interface ConfigLockIdentity {
  readonly pid: number | null;
  readonly token: string | null;
  readonly inode: number;
  readonly mtimeMs: number;
}

async function readLockIdentity(lockPath: string): Promise<ConfigLockIdentity | undefined> {
  try {
    const details = await stat(lockPath);
    try {
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        pid?: unknown; token?: unknown; inode?: unknown;
      };
      return {
        pid: typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null,
        token: typeof owner.token === "string" ? owner.token : null,
        inode: details.ino,
        mtimeMs: details.mtimeMs,
      };
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      return { pid: null, token: null, inode: details.ino, mtimeMs: details.mtimeMs };
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isStaleLock(identity: ConfigLockIdentity): boolean {
  return identity.pid === null
    ? Date.now() - identity.mtimeMs > 4_000
    : !processIsAlive(identity.pid);
}

async function takeOverStaleLock(lockPath: string, observed: ConfigLockIdentity): Promise<boolean> {
  const current = await readLockIdentity(lockPath);
  if (!sameLock(current, observed)) return false;
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const moved = await readLockIdentity(quarantine);
  if (!sameLock(moved, observed)) {
    try {
      await rename(quarantine, lockPath);
    } catch {
      // A different owner already restored the live lock.
    }
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function releaseOwnedLock(lockPath: string, token: string, inode: number): Promise<void> {
  const current = await readLockIdentity(lockPath);
  if (current?.token !== token || current.inode !== inode) return;
  await rm(lockPath, { recursive: true, force: true });
}

function sameLock(left: ConfigLockIdentity | undefined, right: ConfigLockIdentity): boolean {
  return left !== undefined && left.inode === right.inode && left.token === right.token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertOwnerId(ownerId: string): void {
  if (ownerId.trim().length === 0) {
    throw new AdapterError("CONFIG_MIGRATION_REJECTED", "Migration requires an exact Owner identity");
  }
}

function sha256Bytes(raw: Uint8Array): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
