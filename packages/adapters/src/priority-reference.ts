import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createPriorityDocumentReference,
  type AuthorizedSourceV1,
  type PriorityDocumentReferenceV1,
} from "@openlifewiki/protocol";

import { AdapterError } from "./errors.js";

export function authorizePriorityDocumentReference(options: {
  readonly source: AuthorizedSourceV1;
  readonly locator: string;
}): PriorityDocumentReferenceV1 {
  const { normalizedLocator, relationMode } = normalizeAuthorizedLocator(options.source, options.locator);
  return createPriorityDocumentReference({
    sourceId: options.source.sourceId,
    authorizationHash: options.source.authorizationHash,
    normalizedLocator,
    relationMode,
  });
}

function normalizeAuthorizedLocator(
  source: AuthorizedSourceV1,
  locator: string,
): { readonly normalizedLocator: string; readonly relationMode: "exact" | "hierarchical" } {
  if (source.connectorType === "local-folder") return localLocator(source, locator);
  if (source.connectorType === "github") return githubLocator(source, locator);
  if (source.connectorType === "feishu") return feishuLocator(source, locator);
  if (source.connectorType === "codex-history") return codexLocator(source, locator);
  throw outside();
}

function localLocator(source: AuthorizedSourceV1, raw: string) {
  try {
    const url = new URL(raw);
    const root = source.scope.root;
    if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash
      || typeof root !== "string" || !isAbsolute(root)) throw new Error();
    const path = resolve(fileURLToPath(url));
    const boundary = resolve(root);
    const fromRoot = relative(boundary, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error();
    return { normalizedLocator: pathToFileURL(path).href, relationMode: "hierarchical" as const };
  } catch {
    throw outside();
  }
}

function githubLocator(source: AuthorizedSourceV1, raw: string) {
  try {
    const url = new URL(raw);
    const scope = source.scope;
    const hostname = scope.hostname;
    const repository = scope.repository;
    const ref = scope.ref;
    const rootPath = scope.path;
    const keys = [...url.searchParams.keys()];
    if (url.protocol !== "openlifewiki-github:" || typeof hostname !== "string"
      || typeof repository !== "string" || typeof ref !== "string"
      || !(rootPath === null || typeof rootPath === "string")
      || url.username || url.password || url.hash
      || url.hostname.toLowerCase() !== hostname.toLowerCase()
      || decodeURIComponent(url.pathname.slice(1)) !== repository
      || keys.length !== 3 || new Set(keys).size !== 3
      || !["ref", "path", "kind"].every((key) => keys.includes(key))
      || url.searchParams.get("ref") !== ref || url.searchParams.get("kind") !== "file") throw new Error();
    const path = normalizeRepoPath(url.searchParams.get("path") ?? "");
    const scopePath = rootPath === null ? "" : normalizeRepoPath(rootPath);
    if (path.length === 0 || (scopePath.length > 0 && path !== scopePath && !path.startsWith(`${scopePath}/`))) throw new Error();
    const normalized = new URL(`openlifewiki-github://${hostname.toLowerCase()}`);
    normalized.pathname = `/${repository.split("/").map(encodeURIComponent).join("/")}`;
    normalized.searchParams.set("ref", ref);
    normalized.searchParams.set("path", path);
    normalized.searchParams.set("kind", "file");
    return { normalizedLocator: normalized.href, relationMode: "hierarchical" as const };
  } catch {
    throw outside();
  }
}

function feishuLocator(source: AuthorizedSourceV1, raw: string) {
  try {
    const value = parseOpaque(raw, "openlifewiki-feishu:");
    const scope = source.scope;
    if (value.schema !== "openlifewiki.locator/feishu/v1"
      || (value.kind !== "document" && value.kind !== "wiki" && value.kind !== "base")
      || value.rootKind !== value.kind || typeof value.rootId !== "string"
      || value.objectId !== value.rootId) throw new Error();
    const approved = value.kind === "document" ? stringArray(scope.documentIds)
      : value.kind === "wiki" ? stringArray(scope.wikiNodeIds)
        : stringArray(scope.baseIds);
    if (!approved.includes(value.rootId)) throw new Error();
    return { normalizedLocator: opaqueLocator("openlifewiki-feishu", value), relationMode: "exact" as const };
  } catch {
    throw outside();
  }
}

function codexLocator(source: AuthorizedSourceV1, raw: string) {
  try {
    const value = parseOpaque(raw, "openlifewiki-codex-history:");
    const scope = source.scope;
    if (value.schema !== "openlifewiki.locator/codex-history/v1" || value.kind !== "thread"
      || typeof value.projectRoot !== "string" || typeof value.threadId !== "string"
      || !stringArray(scope.projectRoots).includes(value.projectRoot)
      || !stringArray(scope.threadIds).includes(value.threadId)) throw new Error();
    return { normalizedLocator: opaqueLocator("openlifewiki-codex-history", value), relationMode: "exact" as const };
  } catch {
    throw outside();
  }
}

function parseOpaque(raw: string, protocol: string): Record<string, unknown> {
  const url = new URL(raw);
  if (url.protocol !== protocol || url.hostname !== "node" || url.search || url.hash || url.username || url.password) {
    throw new Error();
  }
  const value = JSON.parse(Buffer.from(url.pathname.slice(1), "base64url").toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error();
  return value;
}

function opaqueLocator(protocol: string, value: unknown): string {
  return `${protocol}://node/${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function normalizeRepoPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new Error();
  return path;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outside(): AdapterError {
  return new AdapterError("SCAN_INVALID", "Priority document locator is outside the approved Source scope");
}
