import { describe, expect, it } from "vitest";

import { sha256Canonical } from "@openlifewiki/protocol";

import { resolveAgentScanPolicy, resolveScanPolicy } from "../src/index.js";

const ownerPolicy = {
  schema: "openlifewiki.scan-narrowing-policy/v1" as const,
  include: ["/product/**"],
  exclude: ["/product/private/**"],
  sensitivity: { default: "normal" as const, rules: [] },
  budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
  indexing: { default: "qmd-current" as const, rules: [] },
};

describe("progressive scan narrowing policy", () => {
  it("applies Host then WIKI narrowing with intersection, union, most restrictive sensitivity and minimum budget", () => {
    const host = {
      ...ownerPolicy,
      include: ["/product/current/**"],
      exclude: ["/product/current/drafts/**"],
      budget: { maxNodes: 80, maxAgentCalls: 10 },
    };
    const wiki = {
      ...ownerPolicy,
      include: ["/product/current/strategy/**"],
      exclude: ["/product/current/strategy/old/**"],
      sensitivity: {
        default: "normal" as const,
        rules: [{ match: "/product/current/strategy/finance/**", level: "sensitive" as const }],
      },
      budget: { maxNodes: 50 },
      indexing: { default: "metadata-only" as const, rules: [] },
    };

    expect(resolveScanPolicy({ ownerPolicy, hostPolicy: host, wikiPolicy: wiki })).toEqual({
      ...wiki,
      exclude: [
        "/product/private/**",
        "/product/current/drafts/**",
        "/product/current/strategy/old/**",
      ],
      budget: { maxNodes: 50, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    });
  });

  it("rejects lower-priority attempts to broaden include, sensitivity, budget or indexing", () => {
    const cases = [
      { ...ownerPolicy, include: ["/**"] },
      { ...ownerPolicy, sensitivity: { default: "normal" as const, rules: [] }, budget: { maxNodes: 101 } },
      { ...ownerPolicy, indexing: { default: "excluded" as const, rules: [{ match: "/archive/**", disposition: "qmd-current" as const }] } },
    ];
    for (const hostPolicy of cases) {
      expect(() => resolveScanPolicy({ ownerPolicy, hostPolicy, wikiPolicy: null })).toThrow(/narrow/i);
    }
  });

  it("derives exact per-target sensitivity, indexing and authorized priority effects", () => {
    const priorityHash = `sha256:${"a".repeat(64)}`;
    const policy = {
      ...ownerPolicy,
      sensitivity: {
        default: "normal" as const,
        rules: [{ match: "/product/finance/**", level: "sensitive" as const }],
      },
      indexing: {
        default: "qmd-current" as const,
        rules: [{ match: "/product/archive/**", disposition: "metadata-only" as const }],
      },
    };
    const common = {
      policy,
      policyResolutionHash: `sha256:${"b".repeat(64)}`,
      hostBindingHash: `sha256:${"c".repeat(64)}`,
      wikiBindingHash: `sha256:${"d".repeat(64)}`,
      priorityReferenceHashes: [priorityHash],
      remainingBudget: { nodes: 10, bodyBytes: 1_000, agentCalls: 2 },
      targets: [{
        targetNodeId: "finance", policyPath: "/product/finance/forecast.md",
        priorityRelation: "exact" as const, matchedPriorityReferenceHashes: [priorityHash],
        ownerApprovedSensitive: false,
      }],
    };
    const resolved = resolveAgentScanPolicy(common);
    expect(resolved.targetEffects).toEqual([expect.objectContaining({
      targetNodeId: "finance", effectiveSensitivity: "sensitive",
      ownerApprovalRequired: true, indexingDisposition: "qmd-current",
      priorityRelation: "exact", matchedPriorityReferenceHashes: [priorityHash],
    })]);
    const withoutPriority = resolveAgentScanPolicy({
      ...common,
      priorityReferenceHashes: [],
      targets: [{ ...common.targets[0]!, priorityRelation: "none" as const, matchedPriorityReferenceHashes: [] }],
    });
    expect(sha256Canonical(withoutPriority)).not.toBe(sha256Canonical(resolved));
    expect(() => resolveAgentScanPolicy({
      ...common,
      priorityReferenceHashes: [],
    })).toThrow(/priority/i);
  });
});
