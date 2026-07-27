import { describe, expect, it } from "vitest";

import {
  assertEnumerationPageReceipt,
  assertLayerSummaryReceipt,
  assertLeafSelectionReceipt,
  assertScanCheckpoint,
  assertScanSystemOutcomeReceipt,
  createEnumerationIntent,
  createEnumerationPageReceipt,
  createLayerSummaryReceipt,
  createLeafSelectionReceipt,
  createScanCheckpoint,
  createScanPlan,
  createScanSystemOutcomeReceipt,
  sha256Canonical,
  type AgentScanInputContext,
  type ScanDecision,
  type SkeletonNode,
  type SkeletonPage,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const AT = "2026-07-27T00:00:00.000Z";

describe("canonical progressive scan receipts", () => {
  it("derives a complete enumeration page from the trusted provider page and prior chain", () => {
    const context = enumerationContext();
    const firstPage: SkeletonPage = {
      ...context.page,
      nodes: [{ ...context.children[0]!, page: { cursor: null, hasMore: true } }],
      nextCursor: "cursor-2",
      pageComplete: false,
    };
    const first = createEnumerationPageReceipt({
      ...context,
      page: firstPage,
      priorNodes: [],
      previousPageReceipt: null,
      eventSequence: 3,
    });
    expect(first).toMatchObject({
      pageSequence: 1,
      eventSequence: 3,
      state: "open",
      nextCursor: "cursor-2",
      childSetHash: null,
    });

    const secondPage: SkeletonPage = {
      ...context.page,
      nodes: [context.children[1]!],
      nextCursor: null,
      pageComplete: true,
    };
    const second = createEnumerationPageReceipt({
      ...context,
      page: secondPage,
      priorNodes: [context.children[0]!],
      previousPageReceipt: first,
      eventSequence: 4,
    });
    expect(second).toMatchObject({
      pageSequence: 2,
      previousPageReceiptHash: first.receiptHash,
      discoveredNodeIds: ["leaf-2"],
      knownUnenumeratedSlotIds: [],
      state: "complete",
      childCountKind: "known",
    });
    expect(second.childSetHash).toBe(sha256Canonical(trustedChildren(context.children)));
    expect(() => assertEnumerationPageReceipt(second, {
      ...context,
      page: secondPage,
      priorNodes: [context.children[0]!],
      previousPageReceipt: first,
      eventSequence: 4,
    })).not.toThrow();
  });

  it("rejects page drift, duplicate logical nodes, cursor gaps and forged hashes", () => {
    const context = enumerationContext();
    expect(() => createEnumerationPageReceipt({
      ...context,
      page: { ...context.page, parentNodeId: "other" },
      priorNodes: [], previousPageReceipt: null, eventSequence: 1,
    })).toThrow(/parent/i);
    expect(() => createEnumerationPageReceipt({
      ...context,
      page: { ...context.page, nodes: [context.children[0]!, context.children[0]!] },
      priorNodes: [], previousPageReceipt: null, eventSequence: 1,
    })).toThrow(/duplicate/i);
    const open = createEnumerationPageReceipt({
      ...context,
      page: {
        ...context.page,
        nodes: [{ ...context.children[0]!, page: { cursor: null, hasMore: true } }],
        nextCursor: "cursor-2",
        pageComplete: false,
      },
      priorNodes: [], previousPageReceipt: null, eventSequence: 1,
    });
    expect(() => createEnumerationPageReceipt({
      ...context,
      page: { ...context.page, nodes: [{ ...context.children[1]!, page: { cursor: "wrong", hasMore: false } }] },
      priorNodes: [context.children[0]!], previousPageReceipt: open, eventSequence: 2,
    })).toThrow(/cursor/i);
    expect(() => assertEnumerationPageReceipt({ ...open, eventSequence: 99 }, {
      ...context,
      page: {
        ...context.page,
        nodes: [{ ...context.children[0]!, page: { cursor: null, hasMore: true } }],
        nextCursor: "cursor-2",
        pageComplete: false,
      },
      priorNodes: [], previousPageReceipt: null, eventSequence: 1,
    })).toThrow(/hash|binding/i);
  });

  it("canonically binds summary, system outcome and leaf selection to the active plan", () => {
    const context = enumerationContext();
    const scanInput = scanInputFor(context.plan, context.parent, context.children);
    const summary = createLayerSummaryReceipt({
      plan: context.plan,
      intent: context.intent,
      trustedDecisionReceipts: [],
      scanInput,
      persistedAt: AT,
    });
    expect(() => assertLayerSummaryReceipt(summary, {
      plan: context.plan, intent: context.intent, trustedDecisionReceipts: [], scanInput, persistedAt: AT,
    })).not.toThrow();

    const outcome = createScanSystemOutcomeReceipt({
      plan: context.plan,
      sourceId: "source_local",
      nodeId: "leaf-2",
      outcome: "blocked",
      phase: "discovery",
      code: "PERMISSION_DENIED",
      persistedAt: AT,
    });
    expect(() => assertScanSystemOutcomeReceipt(outcome, { plan: context.plan })).not.toThrow();

    const decision = leafDecision(context.plan, context.parent, context.children[0]!, scanInput);
    const selection = createLeafSelectionReceipt({
      plan: context.plan,
      trustedDecisionReceiptHashes: [decision.receiptHash],
      decisionReceipt: decision,
      actor: "openlifewiki",
      reason: "Selected by the durable Agent decision",
      persistedAt: AT,
    });
    expect(() => assertLeafSelectionReceipt(selection, {
      plan: context.plan,
      trustedDecisionReceipts: [decision],
    })).not.toThrow();
    expect(() => createLeafSelectionReceipt({
      plan: context.plan,
      trustedDecisionReceiptHashes: [],
      decisionReceipt: decision,
      actor: "openlifewiki",
      reason: "untrusted",
      persistedAt: AT,
    })).toThrow(/trusted/i);
  });

  it("rejects illegal checkpoint phase fields and exact-key/hash tampering", () => {
    const { plan } = enumerationContext();
    const checkpoint = createScanCheckpoint({
      plan,
      sourceId: "source_local",
      authorizationHash: HASH_A,
      nodeId: "leaf-1",
      nodeVersion: "v1",
      phase: "body-processed",
      indexingDisposition: "qmd-current",
      inputSetHash: HASH_B,
      selectionReceiptHash: HASH_A,
      bodyObservationReceiptHash: HASH_B,
    });
    expect(() => assertScanCheckpoint(checkpoint, { plan })).not.toThrow();
    expect(() => createScanCheckpoint({
      plan,
      sourceId: "source_local",
      authorizationHash: HASH_A,
      nodeId: "leaf-1",
      nodeVersion: "v1",
      phase: "discovered",
      indexingDisposition: "metadata-only",
      inputSetHash: HASH_B,
      selectionReceiptHash: HASH_A,
    })).toThrow(/phase/i);
    expect(() => createScanCheckpoint({
      plan,
      sourceId: "source_local",
      authorizationHash: HASH_A,
      nodeId: "leaf-1",
      nodeVersion: "v1",
      phase: "qmd-committed",
      indexingDisposition: "qmd-current",
      inputSetHash: HASH_B,
      qmdGenerationId: "generation-1",
    })).toThrow(/phase/i);
    expect(() => createScanCheckpoint({
      plan,
      sourceId: "source_local",
      authorizationHash: HASH_A,
      nodeId: "leaf-1",
      nodeVersion: "v1",
      phase: "qmd-committed",
      indexingDisposition: "metadata-only",
      inputSetHash: HASH_B,
      selectionReceiptHash: HASH_A,
      bodyObservationReceiptHash: HASH_B,
      qmdGenerationId: "generation-1",
    })).toThrow(/phase/i);
    expect(() => assertScanCheckpoint({ ...checkpoint, body: "secret" }, { plan }))
      .toThrow(/key|hash|invalid/i);
  });
});

function enumerationContext() {
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_frontier",
    sourceIds: ["source_local"],
    authorizationHashes: [HASH_A],
    rootNodeIds: ["root"],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: HASH_A,
    scanIntent: "Index useful documents.",
    priorityDocumentRefs: [],
    policy: {
      include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
  const parent = node("root", null, "directory", "metadata-only", 2, null, false);
  const children = [
    node("leaf-1", "root", "file", "metadata-and-body", 0, null, false),
    node("leaf-2", "root", "file", "metadata-and-body", 0, "cursor-2", false),
  ] as const;
  const intent = createEnumerationIntent({
    plan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: "intent_root",
      sourceId: "source_local",
      targetNodeId: "root",
      targetNodeVersion: parent.nodeVersion,
      authorizationHash: HASH_A,
      origin: "authorized-root",
      parentLayerNodeId: null,
      childSetHash: null,
      inputSetHash: HASH_A,
      createdAt: AT,
    },
  });
  const page: SkeletonPage = {
    schema: "openlifewiki.skeleton-page/v1",
    sourceId: "source_local",
    parentNodeId: "root",
    requestScopeHash: HASH_A,
    nodes: children,
    nextCursor: null,
    pageComplete: true,
    observedAt: AT,
    skeletonVersion: HASH_B,
  };
  return { plan, intent, trustedDecisionReceipts: [], parent, children, page, expectedScopeHash: HASH_A };
}

function node(
  nodeId: string,
  parentId: string | null,
  kind: string,
  scanability: "metadata-only" | "metadata-and-body",
  childCount: number,
  cursor: string | null,
  hasMore: boolean,
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: "source_local",
    nodeId,
    parentId,
    kind,
    title: nodeId,
    locator: `file:///approved/${nodeId}`,
    childCount: { value: childCount, kind: "known" },
    modifiedRange: null,
    permission: "readable",
    scanability,
    page: { cursor, hasMore },
    sizeEstimate: { bytes: 10, kind: "known" },
    nodeVersion: "v1",
  };
}

function trustedChildren(nodes: readonly SkeletonNode[]) {
  return nodes.map((item) => ({
    target: {
      nodeId: item.nodeId,
      parentId: item.parentId!,
      nodeVersion: item.nodeVersion,
      kind: item.scanability === "metadata-and-body" ? "leaf" as const : "container" as const,
    },
    metadataHash: sha256Canonical(item),
  }));
}

function scanInputFor(
  plan: ReturnType<typeof enumerationContextShallow>,
  parent: SkeletonNode,
  children: readonly SkeletonNode[],
): AgentScanInputContext {
  const completeChildren = trustedChildren(children);
  const decisionTargets = completeChildren.map(({ target }) => target);
  const input = {
    scanId: "scan_frontier",
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: HASH_B,
    layer: {
      sourceId: "source_local",
      parentNodeId: parent.nodeId,
      parentNodeVersion: parent.nodeVersion,
      summaryHash: HASH_A,
      childSetHash: sha256Canonical(completeChildren),
      decisionTargetSetHash: sha256Canonical(decisionTargets),
      coverage: { directChildrenEnumerated: children.length, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren,
    decisionTargets,
    remainingBudget: { nodes: 10, bodyBytes: 1000, agentCalls: 10 },
    sensitivityByTarget: decisionTargets.map(({ nodeId }) => ({ targetNodeId: nodeId, effective: "normal" as const, ownerApprovalRequired: false })),
    scanIntent: "Index useful documents.",
    indexing: { default: "qmd-current" as const, rules: [] },
    skillHash: HASH_A,
    wikiHash: HASH_A,
    hostPolicyHash: HASH_A,
  };
  return input;
}

function enumerationContextShallow() {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1", scanId: "scan_frontier", sourceIds: ["source_local"],
    authorizationHashes: [HASH_A], rootNodeIds: ["root"], skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native", skillHash: HASH_A, scanIntent: "Index useful documents.",
    priorityDocumentRefs: [], policy: { include: ["**/*.md"], exclude: [], sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] } },
  });
}

function leafDecision(
  plan: ReturnType<typeof enumerationContextShallow>,
  parent: SkeletonNode,
  leaf: SkeletonNode,
  input: AgentScanInputContext,
): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: HASH_A, sourceId: "source_local",
    parentNodeId: parent.nodeId, parentNodeVersion: parent.nodeVersion, childSetHash: input.layer.childSetHash,
    nodeId: leaf.nodeId, nodeVersion: leaf.nodeVersion, targetKind: "leaf", summaryHash: input.layer.summaryHash,
    inputSetHash: sha256Canonical(input), decision: "descend", reason: "Useful leaf", revisitCondition: null,
    question: null, actor: plan.agentProfileId, estimatedCost: { nodes: 1, bodyBytes: 10, agentCalls: 0 }, persistedAt: AT,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}
