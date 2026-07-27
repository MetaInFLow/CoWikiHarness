import {
  agentResolvedScanPolicySchema,
  scanNarrowingPolicySchema,
  sha256Canonical,
  type AgentScanInputContext,
  type IndexingDisposition,
  type ScanNarrowingPolicyV1,
} from "@openlifewiki/protocol";

export interface AgentPolicyTargetInput {
  readonly targetNodeId: string;
  readonly policyPath: string;
  readonly priorityRelation: "none" | "exact" | "ancestor";
  readonly matchedPriorityReferenceHashes: readonly string[];
  readonly ownerApprovedSensitive: boolean;
}

export function resolveAgentScanPolicy(input: {
  readonly policy: ScanNarrowingPolicyV1;
  readonly policyResolutionHash: string;
  readonly hostBindingHash: string;
  readonly wikiBindingHash: string;
  readonly priorityReferenceHashes: readonly string[];
  readonly remainingBudget: AgentScanInputContext["resolvedPolicy"]["remainingBudget"];
  readonly targets: readonly AgentPolicyTargetInput[];
}): AgentScanInputContext["resolvedPolicy"] {
  const policy = scanNarrowingPolicySchema.parse(input.policy);
  const trustedPriorities = new Set(input.priorityReferenceHashes);
  if (trustedPriorities.size !== input.priorityReferenceHashes.length) {
    throw new Error("Resolved Agent policy priority references must be unique");
  }
  const targetIds = new Set<string>();
  const targetEffects = input.targets.map((target) => {
    if (targetIds.has(target.targetNodeId)) throw new Error("Resolved Agent policy targets must be unique");
    targetIds.add(target.targetNodeId);
    if (new Set(target.matchedPriorityReferenceHashes).size !== target.matchedPriorityReferenceHashes.length
      || target.matchedPriorityReferenceHashes.some((hash) => !trustedPriorities.has(hash))
      || (target.priorityRelation === "none") !== (target.matchedPriorityReferenceHashes.length === 0)) {
      throw new Error("Resolved Agent policy target has an invalid priority binding");
    }
    const sensitivityRules = policy.sensitivity.rules.filter(({ match }) => matchesPolicyPath(target.policyPath, match));
    const effectiveSensitivity = sensitivityRules.some(({ level }) => level === "sensitive")
      || policy.sensitivity.default === "sensitive" ? "sensitive" as const : "normal" as const;
    const indexingRules = policy.indexing.rules.filter(({ match }) => matchesPolicyPath(target.policyPath, match));
    const indexingDisposition = indexingRules.reduce<IndexingDisposition>(
      (current, rule) => indexingRank(rule.disposition) > indexingRank(current) ? rule.disposition : current,
      policy.indexing.default,
    );
    return {
      targetNodeId: target.targetNodeId,
      eligible: true as const,
      effectiveSensitivity,
      ownerApprovalRequired: effectiveSensitivity === "sensitive" && !target.ownerApprovedSensitive,
      indexingDisposition,
      priorityRelation: target.priorityRelation,
      matchedPriorityReferenceHashes: [...target.matchedPriorityReferenceHashes],
      matchedNarrowingRuleHashes: [
        ...sensitivityRules.map((rule) => sha256Canonical({ kind: "sensitivity", rule })),
        ...indexingRules.map((rule) => sha256Canonical({ kind: "indexing", rule })),
      ],
    };
  });
  return agentResolvedScanPolicySchema.parse({
    resolutionHash: input.policyResolutionHash,
    hostBindingHash: input.hostBindingHash,
    wikiBindingHash: input.wikiBindingHash,
    priorityReferenceHashes: [...input.priorityReferenceHashes],
    include: [...policy.include],
    exclude: [...policy.exclude],
    remainingBudget: input.remainingBudget,
    indexing: policy.indexing,
    targetEffects,
  });
}

export function resolveScanPolicy(input: {
  readonly ownerPolicy: ScanNarrowingPolicyV1;
  readonly hostPolicy: ScanNarrowingPolicyV1 | null;
  readonly wikiPolicy: ScanNarrowingPolicyV1 | null;
}): ScanNarrowingPolicyV1 {
  let resolved = scanNarrowingPolicySchema.parse(input.ownerPolicy);
  if (input.hostPolicy !== null) resolved = applyNarrowing(resolved, input.hostPolicy, "Host");
  if (input.wikiPolicy !== null) resolved = applyNarrowing(resolved, input.wikiPolicy, "WIKI.md");
  return Object.freeze(resolved);
}

function applyNarrowing(
  current: ScanNarrowingPolicyV1,
  candidateInput: ScanNarrowingPolicyV1,
  label: string,
): ScanNarrowingPolicyV1 {
  const candidate = scanNarrowingPolicySchema.parse(candidateInput);
  if (candidate.include.some((pattern) => !current.include.some((ceiling) => narrowsPattern(pattern, ceiling)))) {
    throw new Error(`${label} policy include must narrow the current policy`);
  }
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

function narrowsPattern(candidate: string, ceiling: string): boolean {
  if (candidate === ceiling || ceiling === "/**" || ceiling === "**") return true;
  const prefix = ceiling.replace(/\/\*\*\/?$/u, "").replace(/\/$/u, "");
  return prefix.length > 0 && (candidate === prefix || candidate.startsWith(`${prefix}/`));
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
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "u").test(path);
}
