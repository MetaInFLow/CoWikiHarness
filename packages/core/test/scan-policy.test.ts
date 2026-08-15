import { describe, expect, it } from "vitest";

import {
  createPriorityDocumentReference,
  createScanPlan,
  createScanPlanPolicyMaterial,
  sha256Canonical,
  type AuthorizedSourceV1,
  type PriorityDocumentReferenceV1,
  type ScanNarrowingPolicyV1,
  type SkeletonNode,
} from "@openlifewiki/protocol";

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
      includeSets: [ownerPolicy.include, host.include, wiki.include],
      exclude: [
        "/product/private/**",
        "/product/current/drafts/**",
        "/product/current/strategy/old/**",
      ],
      budget: { maxNodes: 50, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    });
  });

  it("keeps a broad lower-priority include as an AND group and rejects other widening", () => {
    expect(resolveScanPolicy({
      ownerPolicy,
      hostPolicy: { ...ownerPolicy, include: ["/**"] },
      wikiPolicy: null,
    }).includeSets).toEqual([["/product/**"], ["/**"]]);
    const cases = [
      { ...ownerPolicy, sensitivity: { default: "normal" as const, rules: [] }, budget: { maxNodes: 101 } },
      { ...ownerPolicy, indexing: { default: "excluded" as const, rules: [{ match: "/archive/**", disposition: "qmd-current" as const }] } },
    ];
    for (const hostPolicy of cases) {
      expect(() => resolveScanPolicy({ ownerPolicy, hostPolicy, wikiPolicy: null })).toThrow(/narrow/i);
    }
  });

  it("derives exact per-target sensitivity, indexing and authorized priority effects", () => {
    const source = localSource();
    const node = localNode();
    const priority = createPriorityDocumentReference({
      sourceId: source.sourceId,
      authorizationHash: source.authorizationHash,
      normalizedLocator: node.locator,
      relationMode: "hierarchical",
    });
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
    const plan = policyPlan(source, policy, [priority]);
    const common = {
      plan,
      source,
      remainingBudget: { nodes: 10, bodyBytes: 1_000, agentCalls: 2 },
      targets: [{ node }],
    };
    const resolved = resolveAgentScanPolicy(common);
    expect(resolved.targetEffects).toEqual([expect.objectContaining({
      targetNodeId: "finance", effectiveSensitivity: "sensitive",
      ownerApprovalRequired: true, indexingDisposition: "qmd-current",
      priorityRelation: "exact", matchedPriorityReferenceHashes: [priority.referenceHash],
    })]);
    const withoutPriority = resolveAgentScanPolicy({
      ...common,
      plan: policyPlan(source, policy, []),
    });
    expect(sha256Canonical(withoutPriority)).not.toBe(sha256Canonical(resolved));
  });
});

function localSource(): AuthorizedSourceV1 {
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint: "owner",
    previewHash: "preview",
    configHash: "config",
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source_local",
    connectorType: "local-folder" as const,
    rootNodeId: "root",
    identityFingerprint: "identity",
    approval: { ...approvalUnsigned, approvalHash: sha256Canonical(approvalUnsigned) },
    scope: { root: "/approved", symlinkPolicy: "deny" },
    include: ["/**"], exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] as [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
}

function localNode(): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1", sourceId: "source_local", nodeId: "finance",
    parentId: "root", kind: "file", title: "Forecast",
    locator: "file:///approved/product/finance/forecast.md",
    childCount: { value: 0, kind: "known" }, modifiedRange: null, permission: "readable",
    scanability: "metadata-and-body", page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 100, kind: "known" }, nodeVersion: `sha256:${"e".repeat(64)}`,
  };
}

function policyPlan(
  source: AuthorizedSourceV1,
  policy: ScanNarrowingPolicyV1,
  priorityDocumentRefs: readonly PriorityDocumentReferenceV1[],
) {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1", scanId: `scan_${priorityDocumentRefs?.length ?? 0}`,
    sourceIds: [source.sourceId], authorizationHashes: [source.authorizationHash], rootNodeIds: [source.rootNodeId],
    skeletonVersion: `sha256:${"b".repeat(64)}`, agentProfileId: "agent_codex_native",
    hostConfigRevision: 0, selectedAgentConfigHash: `sha256:${"c".repeat(64)}`,
    skillHash: `sha256:${"d".repeat(64)}`, scanIntent: "Build knowledge.",
    ...createScanPlanPolicyMaterial({ ownerPolicy: policy, priorityDocumentRefs }),
  });
}
