import {
  sha256Canonical,
  type AgentScanInputContext,
  type MetadataSample,
  type SkeletonNode,
} from "@openlifewiki/protocol";

import type { AgentLayerSummary } from "./agent-driver.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_MEMBERS = 64;
const MAX_METADATA_SAMPLES = 32;
const MAX_METADATA_STRING = 4_096;
const SKELETON_KEYS = [
  "childCount",
  "kind",
  "locator",
  "modifiedRange",
  "nodeId",
  "nodeVersion",
  "page",
  "parentId",
  "permission",
  "scanability",
  "schema",
  "sizeEstimate",
  "sourceId",
  "title",
] as const;

export function isValidAgentLayerSummary(
  summary: unknown,
  input: AgentScanInputContext,
): summary is AgentLayerSummary {
  try {
    if (!recordWithKeys(summary, ["children", "coverage", "metadataSamples", "overview", "parent", "policy", "schema"])
      || summary.schema !== "openlifewiki.layer-summary/v1"
      || !isSafeMetadataValue(summary, 0, false)
      || !recordWithKeys(summary.overview, ["description", "providerDescription", "title"])
      || !nonEmpty(summary.overview.title)
      || !nonEmpty(summary.overview.description)
      || !(summary.overview.providerDescription === null || nonEmpty(summary.overview.providerDescription))
      || !isSkeletonNode(summary.parent)
      || summary.parent.sourceId !== input.layer.sourceId
      || summary.parent.nodeId !== input.layer.parentNodeId
      || summary.parent.nodeVersion !== input.layer.parentNodeVersion
      || !Array.isArray(summary.children)
      || summary.children.length !== input.completeChildren.length
      || !canonicalEqual(summary.coverage, input.layer.coverage)
      || !recordWithKeys(summary.policy, ["indexing", "remainingBudget", "scanIntent"])
      || summary.policy.scanIntent !== input.scanIntent
      || !canonicalEqual(summary.policy.indexing, input.indexing)
      || !canonicalEqual(summary.policy.remainingBudget, input.remainingBudget)) return false;
    if (!summary.children.every((child, index) => (
      validChild(child, input.completeChildren[index], input.layer.sourceId)
    ))) return false;
    const allowed = new Set([input.layer.parentNodeId, ...input.completeChildren.map(({ target }) => target.nodeId)]);
    return Array.isArray(summary.metadataSamples)
      && summary.metadataSamples.length <= MAX_METADATA_SAMPLES
      && summary.metadataSamples.every((sample) => isMetadataSample(sample) && allowed.has(sample.nodeId))
      && sha256Canonical(summary) === input.layer.summaryHash;
  } catch {
    return false;
  }
}

function validChild(
  child: unknown,
  trusted: AgentScanInputContext["completeChildren"][number] | undefined,
  sourceId: string,
): boolean {
  return trusted !== undefined
    && recordWithKeys(child, ["metadataHash", "skeleton", "target"])
    && isHash(child.metadataHash)
    && isSkeletonNode(child.skeleton)
    && child.metadataHash === trusted.metadataHash
    && child.metadataHash === sha256Canonical(child.skeleton)
    && canonicalEqual(child.target, trusted.target)
    && child.skeleton.sourceId === sourceId
    && child.skeleton.nodeId === trusted.target.nodeId
    && child.skeleton.parentId === trusted.target.parentId
    && child.skeleton.nodeVersion === trusted.target.nodeVersion;
}

function isSkeletonNode(value: unknown): value is SkeletonNode {
  if (!recordWithKeys(value, SKELETON_KEYS)) return false;
  const count = value.childCount;
  const page = value.page;
  const size = value.sizeEstimate;
  const range = value.modifiedRange;
  return value.schema === "openlifewiki.skeleton-node/v1"
    && [value.sourceId, value.nodeId, value.kind, value.title, value.nodeVersion].every(nonEmpty)
    && (value.parentId === null || nonEmpty(value.parentId))
    && safeLocator(value.locator)
    && recordWithKeys(count, ["kind", "value"])
    && validEstimate(count)
    && (range === null || (recordWithKeys(range, ["from", "to"]) && nonEmpty(range.from) && nonEmpty(range.to)))
    && ["readable", "approval-required", "denied", "unknown"].includes(String(value.permission))
    && ["metadata-only", "metadata-and-body"].includes(String(value.scanability))
    && recordWithKeys(page, ["cursor", "hasMore"])
    && (page.cursor === null || typeof page.cursor === "string")
    && typeof page.hasMore === "boolean"
    && recordWithKeys(size, ["bytes", "kind"])
    && validEstimate(size);
}

function isMetadataSample(value: unknown): value is MetadataSample {
  return recordWithKeys(value, ["fields", "inputSetHash", "nodeId", "schema"])
    && value.schema === "openlifewiki.metadata-sample/v1"
    && nonEmpty(value.nodeId)
    && isHash(value.inputSetHash)
    && isPlainRecord(value.fields)
    && Object.keys(value.fields).length > 0
    && Object.keys(value.fields).length <= MAX_METADATA_MEMBERS
    && isSafeMetadataValue(value.fields, 0, true);
}

function isSafeMetadataValue(value: unknown, depth: number, rejectBodyKeys: boolean): boolean {
  if (depth > MAX_METADATA_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_METADATA_STRING;
  if (Array.isArray(value)) {
    return value.every((item) => isSafeMetadataValue(item, depth + 1, rejectBodyKeys));
  }
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_METADATA_MEMBERS && entries.every(([key, child]) => (
    key.length > 0
    && key.length <= 128
    && (!rejectBodyKeys || !hasProhibitedBodyKey(key))
    && isSafeMetadataValue(child, depth + 1, rejectBodyKeys)
  ));
}

function hasProhibitedBodyKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return tokens.some((token) => ["body", "content", "excerpt", "raw", "text"].includes(token));
}

function safeLocator(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function validEstimate(value: Record<string, unknown>): boolean {
  return ["known", "estimated", "unknown"].includes(String(value.kind))
    && (value.value === null || value.bytes === null
      || Number.isSafeInteger(value.value ?? value.bytes) && Number(value.value ?? value.bytes) >= 0);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function recordWithKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length
    && actual.every((key, index) => key === canonicalExpected[index]);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
