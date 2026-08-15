import { matchesGlob } from "node:path";

import {
  agentResolvedScanPolicySchema,
  assertScanPlan,
  resolvedScanPolicySchema,
  scanNarrowingPolicySchema,
  sha256Canonical,
  type AgentScanInputContext,
  type AuthorizedSourceV1,
  type IndexingDisposition,
  type ResolvedScanPolicyV1,
  type ScanPlan,
  type ScanNarrowingPolicyV1,
  type SkeletonNode,
} from "@openlifewiki/protocol";

export interface AgentPolicyTargetInput {
  readonly node: SkeletonNode;
}

export function resolveAgentScanPolicy(input: {
  readonly plan: ScanPlan;
  readonly source: AuthorizedSourceV1;
  readonly remainingBudget: AgentScanInputContext["resolvedPolicy"]["remainingBudget"];
  readonly targets: readonly AgentPolicyTargetInput[];
}): AgentScanInputContext["resolvedPolicy"] {
  assertScanPlan(input.plan);
  assertAuthorizedSource(input.source, input.plan);
  const policy = resolvedScanPolicySchema.parse(input.plan.policy);
  const trustedPriorities = input.plan.priorityDocumentRefs.map(({ referenceHash }) => referenceHash);
  const targetIds = new Set<string>();
  const targetEffects = input.targets.map((target) => {
    assertOnlyKeys(target, ["node"], "Resolved Agent policy target has unexpected approval material");
    const node = target.node;
    if (node.sourceId !== input.source.sourceId) {
      throw new Error("Resolved Agent policy target Source does not match its authorization");
    }
    if (targetIds.has(node.nodeId)) throw new Error("Resolved Agent policy targets must be unique");
    targetIds.add(node.nodeId);
    const policyPath = policyPathForNode(input.source, node);
    if (!targetEligible(input.source, policy, policyPath, node.kind !== "file")) {
      throw new Error("Resolved Agent policy target is outside the approved include/exclude intersection");
    }
    const sourceSensitivityRules = input.source.sensitivity.rules
      .filter(({ match }) => matchesPolicyPath(policyPath, normalizePolicyPattern(match)));
    const planSensitivityRules = policy.sensitivity.rules
      .filter(({ match }) => matchesPolicyPath(policyPath, normalizePolicyPattern(match)));
    const effectiveSensitivity = input.source.sensitivity.default === "sensitive"
      || policy.sensitivity.default === "sensitive"
      || sourceSensitivityRules.some(({ level }) => level === "sensitive")
      || planSensitivityRules.some(({ level }) => level === "sensitive")
      ? "sensitive" as const : "normal" as const;
    const indexingRules = policy.indexing.rules
      .filter(({ match }) => matchesPolicyPath(policyPath, normalizePolicyPattern(match)));
    const indexingDisposition = indexingRules.reduce<IndexingDisposition>(
      (current, rule) => indexingRank(rule.disposition) > indexingRank(current) ? rule.disposition : current,
      policy.indexing.default,
    );
    const priority = priorityMatches(input.plan, input.source.sourceId, node.locator);
    return {
      targetNodeId: node.nodeId,
      eligible: true as const,
      effectiveSensitivity,
      ownerApprovalRequired: effectiveSensitivity === "sensitive",
      indexingDisposition,
      priorityRelation: priority.relation,
      matchedPriorityReferenceHashes: priority.hashes,
      matchedNarrowingRuleHashes: [
        ...sourceSensitivityRules.map((rule) => sha256Canonical({ kind: "source-sensitivity", rule })),
        ...planSensitivityRules.map((rule) => sha256Canonical({ kind: "plan-sensitivity", rule })),
        ...indexingRules.map((rule) => sha256Canonical({ kind: "indexing", rule })),
      ],
    };
  });
  return agentResolvedScanPolicySchema.parse({
    resolutionHash: input.plan.policyResolutionHash,
    hostBindingHash: input.plan.policyBindings.host.bindingHash,
    wikiBindingHash: input.plan.policyBindings.wiki.bindingHash,
    priorityReferenceHashes: trustedPriorities,
    include: [...policy.include],
    includeSets: policy.includeSets.map((patterns) => [...patterns]),
    exclude: [...policy.exclude],
    remainingBudget: input.remainingBudget,
    indexing: policy.indexing,
    targetEffects,
  });
}

function assertAuthorizedSource(source: AuthorizedSourceV1, plan: ScanPlan): void {
  const { authorizationHash, ...payload } = source;
  const sourceIndex = plan.sourceIds.indexOf(source.sourceId);
  if (sha256Canonical(payload) !== authorizationHash) {
    throw new Error("Authorized Source authorizationHash mismatch");
  }
  if (sourceIndex < 0
    || plan.authorizationHashes[sourceIndex] !== authorizationHash
    || plan.rootNodeIds[sourceIndex] !== source.rootNodeId) {
    throw new Error("Authorized Source does not match the exact ScanPlan binding");
  }
}

function targetEligible(
  source: AuthorizedSourceV1,
  policy: ResolvedScanPolicyV1,
  path: string,
  container: boolean,
): boolean {
  const included = (patterns: readonly string[]) => patterns.some((pattern) => (
    includeMatches(path, normalizePolicyPattern(pattern), container)
  ));
  const excluded = [...source.exclude, ...policy.exclude].some((pattern) => (
    excludeMatches(path, normalizePolicyPattern(pattern), container)
  ));
  return included(source.include) && policy.includeSets.every(included) && !excluded;
}

function includeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesPolicyPath(path, pattern)) return true;
  if (!container) return false;
  const wildcard = pattern.search(/[?*]/u);
  const prefix = (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/+$/u, "") || "/";
  return prefix === path || prefix.startsWith(path === "/" ? "/" : `${path}/`)
    || pattern.includes("**") && prefix === "/";
}

function excludeMatches(path: string, pattern: string, container: boolean): boolean {
  if (matchesPolicyPath(path, pattern)) return true;
  if (!container) return false;
  const normalized = pattern.replace(/\/+$/u, "");
  return normalized === `${path}/**` || normalized === `${path}/**/*`;
}

function normalizePolicyPattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function policyPathForNode(source: AuthorizedSourceV1, node: SkeletonNode): string {
  if (source.connectorType === "local-folder") {
    const root = source.scope.root;
    if (typeof root !== "string") throw new Error("Local Source policy root is invalid");
    const url = new URL(node.locator);
    if (url.protocol !== "file:") throw new Error("Local target locator is invalid");
    const rootPath = normalizePathname(root);
    const nodePath = normalizePathname(decodeURIComponent(url.pathname));
    if (nodePath !== rootPath && !nodePath.startsWith(`${rootPath}/`)) {
      throw new Error("Local target is outside its approved policy root");
    }
    return nodePath === rootPath ? "/" : nodePath.slice(rootPath.length);
  }
  if (source.connectorType === "github") {
    const url = new URL(node.locator);
    const path = url.searchParams.get("path");
    const root = typeof source.scope.path === "string" ? source.scope.path : "";
    if (path === null || (root.length > 0 && path !== root && !path.startsWith(`${root}/`))) {
      throw new Error("GitHub target is outside its approved policy root");
    }
    return `/${root.length === 0 ? path : path.slice(root.length).replace(/^\//u, "")}`.replace(/\/$/u, "") || "/";
  }
  const decoded = decodeOpaqueLocator(node.locator);
  if (source.connectorType === "codex-history") {
    if (decoded.kind === "source-root") return "/";
    if (typeof decoded.projectRoot !== "string") throw new Error("Codex target locator is invalid");
    const project = sha256Canonical(decoded.projectRoot).slice("sha256:".length, "sha256:".length + 16);
    return decoded.kind === "project" ? `/project/${project}`
      : `/project/${project}/thread/${String(decoded.threadId)}`;
  }
  if (decoded.kind === "source-root") return "/";
  const rootKind = String(decoded.rootKind ?? "unknown");
  const rootId = String(decoded.rootId ?? "unknown");
  const root = `/${rootKind}/${rootId}`;
  if (decoded.kind === "page-content") {
    const page = decoded.objectId === decoded.rootId ? root : `${root}/wiki/${String(decoded.objectId)}`;
    return `${page}/page-content`;
  }
  return decoded.objectId === decoded.rootId ? root : `${root}/${String(decoded.kind)}/${String(decoded.objectId)}`;
}

function decodeOpaqueLocator(locator: string): Record<string, unknown> {
  const url = new URL(locator);
  const encoded = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("Opaque target locator is invalid");
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(decoded) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Opaque target locator is invalid");
  }
  return value as Record<string, unknown>;
}

function normalizePathname(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.length === 0 ? "/" : normalized;
}

function priorityMatches(
  plan: ScanPlan,
  sourceId: string,
  targetLocator: string,
): { readonly relation: "none" | "exact" | "ancestor"; readonly hashes: readonly string[] } {
  const references = plan.priorityDocumentRefs.filter((reference) => reference.sourceId === sourceId);
  const exact = references.filter(({ normalizedLocator }) => normalizedLocator === targetLocator);
  if (exact.length > 0) return { relation: "exact", hashes: exact.map(({ referenceHash }) => referenceHash) };
  const ancestors = references.filter((reference) => (
    reference.relationMode === "hierarchical" && locatorIsBelow(reference.normalizedLocator, targetLocator)
  ));
  return ancestors.length === 0
    ? { relation: "none", hashes: [] }
    : { relation: "ancestor", hashes: ancestors.map(({ referenceHash }) => referenceHash) };
}

function locatorIsBelow(candidate: string, ancestor: string): boolean {
  const candidateUrl = new URL(candidate);
  const ancestorUrl = new URL(ancestor);
  if (candidateUrl.protocol !== ancestorUrl.protocol || candidateUrl.host !== ancestorUrl.host) return false;
  if (candidateUrl.protocol === "file:") {
    const candidatePath = normalizePathname(decodeURIComponent(candidateUrl.pathname));
    const ancestorPath = normalizePathname(decodeURIComponent(ancestorUrl.pathname));
    return candidatePath.startsWith(`${ancestorPath}/`);
  }
  if (candidateUrl.protocol === "openlifewiki-github:") {
    const candidatePath = candidateUrl.searchParams.get("path") ?? "";
    const ancestorPath = ancestorUrl.searchParams.get("path") ?? "";
    return candidatePath.startsWith(`${ancestorPath.replace(/\/$/u, "")}/`);
  }
  return false;
}

function assertOnlyKeys(value: object, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(message);
}

export function resolveScanPolicy(input: {
  readonly ownerPolicy: ScanNarrowingPolicyV1;
  readonly hostPolicy: ScanNarrowingPolicyV1 | null;
  readonly wikiPolicy: ScanNarrowingPolicyV1 | null;
}): ResolvedScanPolicyV1 {
  const owner = scanNarrowingPolicySchema.parse(input.ownerPolicy);
  let resolved: ResolvedScanPolicyV1 = resolvedScanPolicySchema.parse({
    ...owner,
    includeSets: [[...owner.include]],
  });
  if (input.hostPolicy !== null) resolved = applyNarrowing(resolved, input.hostPolicy, "Host");
  if (input.wikiPolicy !== null) resolved = applyNarrowing(resolved, input.wikiPolicy, "WIKI.md");
  return Object.freeze(resolved);
}

function applyNarrowing(
  current: ResolvedScanPolicyV1,
  candidateInput: ScanNarrowingPolicyV1,
  label: string,
): ResolvedScanPolicyV1 {
  const candidate = scanNarrowingPolicySchema.parse(candidateInput);
  assertBudgetNarrowing(current, candidate, label);
  if (sensitivityRank(candidate.sensitivity.default) < sensitivityRank(current.sensitivity.default)) {
    throw new Error(`${label} policy sensitivity must narrow the current policy`);
  }
  const currentSensitivity = new Map(current.sensitivity.rules.map((rule) => [rule.match, rule.level]));
  for (const rule of candidate.sensitivity.rules) {
    const ceiling = currentSensitivity.get(rule.match) ?? current.sensitivity.default;
    if (sensitivityRank(rule.level) < sensitivityRank(ceiling)) {
      throw new Error(`${label} policy sensitivity rule must narrow the current policy`);
    }
  }
  if (indexingRank(candidate.indexing.default) < indexingRank(current.indexing.default)) {
    throw new Error(`${label} policy indexing must narrow the current policy`);
  }
  const currentIndexing = new Map(current.indexing.rules.map((rule) => [rule.match, rule.disposition]));
  for (const rule of candidate.indexing.rules) {
    const ceiling = currentIndexing.get(rule.match) ?? candidate.indexing.default;
    if (indexingRank(rule.disposition) < indexingRank(ceiling)) {
      throw new Error(`${label} policy indexing rule must narrow the current policy`);
    }
  }
  return {
    schema: "openlifewiki.scan-narrowing-policy/v1",
    include: [...candidate.include],
    includeSets: [...current.includeSets.map((patterns) => [...patterns]), [...candidate.include]],
    exclude: unique([...current.exclude, ...candidate.exclude]),
    sensitivity: {
      default: candidate.sensitivity.default,
      rules: mergeRules(current.sensitivity.rules, candidate.sensitivity.rules),
    },
    budget: {
      ...minimumBudget(current.budget, candidate.budget),
    },
    indexing: {
      default: candidate.indexing.default,
      rules: mergeRules(current.indexing.rules, candidate.indexing.rules),
    },
  };
}

function assertBudgetNarrowing(
  current: ScanNarrowingPolicyV1,
  candidate: ScanNarrowingPolicyV1,
  label: string,
): void {
  for (const key of ["maxNodes", "maxBodyBytes", "maxAgentCalls"] as const) {
    const prior = current.budget[key];
    const next = candidate.budget[key];
    if (prior !== undefined && next !== undefined && next > prior) {
      throw new Error(`${label} policy budget must narrow the current policy`);
    }
  }
}

function minimumBudget(
  current: ScanNarrowingPolicyV1["budget"],
  candidate: ScanNarrowingPolicyV1["budget"],
): ScanNarrowingPolicyV1["budget"] {
  const result: { maxNodes?: number; maxBodyBytes?: number; maxAgentCalls?: number } = {};
  for (const key of ["maxNodes", "maxBodyBytes", "maxAgentCalls"] as const) {
    const values = [current[key], candidate[key]].filter((value): value is number => value !== undefined);
    if (values.length > 0) result[key] = Math.min(...values);
  }
  return result;
}

function sensitivityRank(value: "normal" | "sensitive"): number {
  return value === "normal" ? 0 : 1;
}

function indexingRank(value: IndexingDisposition): number {
  return value === "qmd-current" ? 0 : value === "metadata-only" ? 1 : 2;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function mergeRules<T extends { readonly match: string }>(base: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(base.map((rule) => [rule.match, rule]));
  next.forEach((rule) => merged.set(rule.match, rule));
  return [...merged.values()];
}

function matchesPolicyPath(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern);
}
