import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_RUNTIMES,
  CONNECTOR_STATUSES,
  CONNECTOR_TYPES,
  MCP_ROLES,
  type AgentHostConfig,
  type AuthorizedSourceV1,
  type ConnectorDescriptor,
  type EnumerationIntent,
  type IndexingDisposition,
  type LeafSelectionReceipt,
  type McpPrincipal,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanDiscoveryNode,
  type ScanDiscoverySlot,
  type ScanPlan,
  type ScanProgress,
  type ScanProgressMember,
  type SkeletonNode,
  type SkeletonPage,
  type WikiApproval,
  type WikiProposal,
  createEnumerationIntent,
  createScanPlan,
  sha256Canonical,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

const notionPlaceholder = {
  schema: "openlifewiki.connector-descriptor/v1",
  connectorType: "notion",
  displayName: "Notion",
  classification: ["source", "notion"],
  supportStatus: "placeholder",
  provider: {
    project: "notion/notion",
    publicSurface: "public-api",
    executable: null,
    versionCommand: [],
  },
  capabilities: {
    hierarchy: true,
    pagination: "cursor",
    modifiedVersion: "provider-version",
    representativeMetadata: true,
    leafBodies: true,
    nodeKinds: ["page"],
  },
  scopeSchema: "openlifewiki.scope/notion/v1",
} as const satisfies ConnectorDescriptor;

describe("V1 protocol contracts", () => {
  it("freezes the supported connector and status values", () => {
    expect(CONNECTOR_TYPES).toEqual(["local-folder", "github", "feishu", "codex-history"]);
    expect(CONNECTOR_STATUSES).toEqual(["connected", "auth-required", "missing", "blocked"]);
  });

  it("allows future connector descriptors to remain explicit placeholders", () => {
    expect(notionPlaceholder.connectorType).toBe("notion");
    expect(notionPlaceholder.supportStatus).toBe("placeholder");
  });

  it("freezes six agent runtimes and the two MCP roles", () => {
    expect(AGENT_RUNTIMES).toEqual(["codex", "claude", "gemini", "pi", "openclaw", "hermes"]);
    expect(MCP_ROLES).toEqual(["visitor", "admin"]);
  });

  it("exposes the complete modular V1 contract surface", () => {
    expectTypeOf<AgentHostConfig>().toBeObject();
    expectTypeOf<AuthorizedSourceV1>().toBeObject();
    expectTypeOf<EnumerationIntent>().toBeObject();
    expectTypeOf<IndexingDisposition>().toEqualTypeOf<
      "qmd-current" | "metadata-only" | "excluded"
    >();
    expectTypeOf<LeafSelectionReceipt>().toBeObject();
    expectTypeOf<McpPrincipal>().toBeObject();
    expectTypeOf<ScanCheckpoint>().toBeObject();
    expectTypeOf<ScanDecision>().toBeObject();
    expectTypeOf<ScanDiscoveryNode>().toBeObject();
    expectTypeOf<ScanDiscoverySlot>().toBeObject();
    expectTypeOf<ScanPlan>().toBeObject();
    expectTypeOf<ScanProgress>().toBeObject();
    expectTypeOf<ScanProgressMember>().toBeObject();
    expectTypeOf<SkeletonNode>().toBeObject();
    expectTypeOf<SkeletonPage>().toBeObject();
    expectTypeOf<WikiApproval>().toBeObject();
    expectTypeOf<WikiProposal>().toBeObject();
  });

  it("constructs a hash-bound ScanPlan with bounded intent and indexing policy", () => {
    const plan = createScanPlan({
      schema: "openlifewiki.scan-plan/v1",
      scanId: "scan-1",
      sourceIds: ["source-1"],
      authorizationHashes: [HASH_A],
      rootNodeIds: ["root"],
      skeletonVersion: HASH_B,
      agentProfileId: "agent-codex",
      skillHash: HASH_C,
      scanIntent: "Build the current reusable knowledge Wiki.",
      priorityDocumentRefs: [],
      policy: {
        include: ["/**"],
        exclude: [],
        sensitivity: "normal",
        budget: { maxNodes: 100 },
        indexing: {
          default: "qmd-current",
          rules: [{ match: "/archive/**", disposition: "metadata-only" }],
        },
      },
    });

    const { scanPlanHash: _scanPlanHash, ...planPayload } = plan;
    expect(plan.scanPlanHash).toBe(sha256Canonical(planPayload));
    expect(plan.policy.indexing.default).toBe("qmd-current");
    expect(() => createScanPlan({
      ...planPayload,
      scanIntent: "",
    })).toThrow(/scanIntent/);
    expect(() => createScanPlan({
      ...planPayload,
      scanIntent: "x".repeat(8_193),
    })).toThrow(/scanIntent/);
  });

  it("constructs enumeration only from an authorized root or trusted descend receipt", () => {
    const plan = createScanPlan({
      schema: "openlifewiki.scan-plan/v1",
      scanId: "scan-1",
      sourceIds: ["source-1"],
      authorizationHashes: [HASH_A],
      rootNodeIds: ["node-root"],
      skeletonVersion: HASH_B,
      agentProfileId: "agent-codex",
      skillHash: HASH_C,
      scanIntent: "Build the current reusable knowledge Wiki.",
      priorityDocumentRefs: [],
      policy: {
        include: ["/**"],
        exclude: [],
        sensitivity: "normal",
        budget: { maxNodes: 100 },
        indexing: { default: "qmd-current", rules: [] },
      },
    });
    const decisionPayload = {
      schema: "openlifewiki.scan-decision/v1",
      scanId: plan.scanId,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
      authorizationHash: HASH_A,
      sourceId: "source-1",
      parentNodeId: "node-root",
      parentNodeVersion: "root-v1",
      childSetHash: HASH_D,
      nodeId: "node-product",
      nodeVersion: "node-v1",
      targetKind: "container",
      summaryHash: HASH_C,
      inputSetHash: HASH_B,
      decision: "descend",
      reason: "The branch matches the approved scan intent.",
      revisitCondition: null,
      question: null,
      actor: "agent-codex",
      estimatedCost: { nodes: 10, bodyBytes: 0, agentCalls: 1 },
      persistedAt: "2026-07-27T10:00:00Z",
    } as const;
    const decision = {
      ...decisionPayload,
      receiptHash: sha256Canonical(decisionPayload),
    } satisfies ScanDecision;
    expect(() => createEnumerationIntent({
      plan,
      trustedDecisionReceiptHashes: [],
      decisionReceipt: null,
      intent: {
        schema: "openlifewiki.enumeration-intent/v1",
        intentId: "intent-invented-root",
        sourceId: "source-1",
        targetNodeId: "invented-root",
        targetNodeVersion: "root-v1",
        authorizationHash: HASH_A,
        origin: "authorized-root",
        parentLayerNodeId: null,
        childSetHash: null,
        inputSetHash: HASH_B,
        createdAt: "2026-07-27T10:00:00Z",
      },
    })).toThrow(/ScanPlan root/i);
    const intent = createEnumerationIntent({
      plan,
      trustedDecisionReceiptHashes: [decision.receiptHash],
      decisionReceipt: decision,
      intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: "intent-product",
      sourceId: "source-1",
      targetNodeId: "node-product",
      targetNodeVersion: "node-v1",
      authorizationHash: plan.authorizationHashes[0]!,
      origin: "container-descend",
      parentLayerNodeId: "node-root",
      childSetHash: HASH_D,
      inputSetHash: HASH_B,
      createdAt: "2026-07-27T10:00:00Z",
      },
    });

    expect(intent.targetNodeId).toBe("node-product");
    expect(intent.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const {
      scanId: _scanId,
      scanPlanHash: _intentPlanHash,
      skeletonVersion: _skeletonVersion,
      decisionReceiptHash: _decisionReceiptHash,
      receiptHash: _receiptHash,
      ...intentDraft
    } = intent;
    expect(() => createEnumerationIntent({
      plan,
      trustedDecisionReceiptHashes: [],
      decisionReceipt: decision,
      intent: intentDraft,
    })).toThrow(/trusted/i);
    expect(() => createEnumerationIntent({
      plan,
      trustedDecisionReceiptHashes: [decision.receiptHash],
      decisionReceipt: decision,
      intent: {
        ...intentDraft,
        targetNodeId: "node-invented",
      },
    })).toThrow(/target/i);
  });
});
