import { describe, expect, it } from "vitest";

import {
  createScanPlan,
  createScanPlanPolicyMaterial,
  sha256Canonical,
  type AuthorizedSourceV1,
  type SkeletonNode,
} from "@openlifewiki/protocol";

import { resolveAgentScanPolicy } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("canonical per-target scan policy binding", () => {
  it("derives sensitivity and indexing from the exact approved Source, node and Plan", () => {
    const source = authorizedLocalSource();
    const plan = scanPlan(source);
    const node = localLeaf();

    const resolved = resolveAgentScanPolicy({
      plan,
      source,
      remainingBudget: { nodes: 9, bodyBytes: 900, agentCalls: 1 },
      targets: [{ node }],
    });

    expect(resolved.targetEffects).toEqual([expect.objectContaining({
      targetNodeId: node.nodeId,
      eligible: true,
      effectiveSensitivity: "sensitive",
      ownerApprovalRequired: true,
      indexingDisposition: "metadata-only",
    })]);
  });

  it("rejects forged approval flags and mismatched Source or node bindings", () => {
    const source = authorizedLocalSource();
    const plan = scanPlan(source);
    const node = localLeaf();
    const common = {
      plan,
      source,
      remainingBudget: { nodes: 9, bodyBytes: 900, agentCalls: 1 },
    };

    expect(() => resolveAgentScanPolicy({
      ...common,
      targets: [{
        node,
        ownerApprovedSensitive: true,
      }],
    } as never)).toThrow(/unexpected|approval/i);
    expect(() => resolveAgentScanPolicy({
      ...common,
      source: { ...source, authorizationHash: HASH_A },
      targets: [{ node }],
    })).toThrow(/authorization/i);
    expect(() => resolveAgentScanPolicy({
      ...common,
      targets: [{
        node: { ...node, sourceId: "other_source" },
      }],
    })).toThrow(/source/i);
  });
});

function authorizedLocalSource(): AuthorizedSourceV1 {
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint: HASH_A,
    previewHash: HASH_A,
    configHash: HASH_A,
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source_local",
    connectorType: "local-folder" as const,
    rootNodeId: "root",
    identityFingerprint: HASH_A,
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    scope: {
      schema: "openlifewiki.scope/local-folder/v1",
      root: "/approved",
      symlinkPolicy: "deny",
    },
    include: ["/**"],
    exclude: [] as string[],
    sensitivity: {
      default: "normal" as const,
      rules: [{ match: "/finance/**", level: "sensitive" as const }],
    },
    budget: { maxNodes: 10, maxBodyBytes: 1_000, maxAgentCalls: 2 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function scanPlan(source: AuthorizedSourceV1) {
  const ownerPolicy = {
    schema: "openlifewiki.scan-narrowing-policy/v1" as const,
    include: ["/**"],
    exclude: [] as string[],
    sensitivity: { default: "normal" as const, rules: [] as [] },
    budget: { maxNodes: 10, maxBodyBytes: 1_000, maxAgentCalls: 2 },
    indexing: {
      default: "qmd-current" as const,
      rules: [{ match: "/finance/**", disposition: "metadata-only" as const }],
    },
  };
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_policy_binding",
    sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash],
    rootNodeIds: [source.rootNodeId],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    hostConfigRevision: 0,
    selectedAgentConfigHash: HASH_A,
    skillHash: HASH_A,
    scanIntent: "Scan approved knowledge.",
    ...createScanPlanPolicyMaterial({ ownerPolicy }),
  });
}

function localLeaf(): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: "source_local",
    nodeId: "finance_forecast",
    parentId: "root",
    kind: "file",
    title: "Forecast",
    locator: "file:///approved/finance/forecast.md",
    childCount: { value: 0, kind: "known" },
    modifiedRange: null,
    permission: "readable",
    scanability: "metadata-and-body",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 100, kind: "known" },
    nodeVersion: HASH_A,
  };
}
