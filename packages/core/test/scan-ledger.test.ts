import { describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  createAgentScanInvocationReceipt,
  createEnumerationIntent,
  createScanPlan,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanResult,
  type AgentScanInputContext,
  type EnumerationIntent,
  type LayerSummaryReceipt,
  type ScanDecision,
  type ScanPlan,
  type ScanSystemOutcomeReceipt,
} from "@openlifewiki/protocol";

import { appendLayerOutcomeBatch, createScanLedger } from "../src/index.js";

const AT = "2026-07-27T10:00:00Z";
const HASH_A = sha256Canonical("a");
const HASH_B = sha256Canonical("b");

function receipt<T extends object>(payload: T): T & { readonly receiptHash: string } {
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function fixture() {
  const plan: ScanPlan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-1",
    sourceIds: ["source-local"],
    authorizationHashes: [HASH_A],
    rootNodeIds: ["root"],
    skeletonVersion: HASH_B,
    agentProfileId: "agent_codex_native",
    skillHash: sha256Canonical("skill"),
    scanIntent: "Build reusable current knowledge.",
    priorityDocumentRefs: [],
    policy: {
      include: ["/**"],
      exclude: [],
      sensitivity: "normal",
      budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
  const intent: EnumerationIntent = createEnumerationIntent({
    plan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: "intent-root",
      sourceId: "source-local",
      targetNodeId: "root",
      targetNodeVersion: "root-v1",
      authorizationHash: HASH_A,
      origin: "authorized-root",
      parentLayerNodeId: null,
      childSetHash: null,
      inputSetHash: sha256Canonical("root-input"),
      createdAt: AT,
    },
  });
  const decisionTargets = [
    { nodeId: "folder", parentId: "root", nodeVersion: "folder-v1", kind: "container" as const },
    { nodeId: "leaf", parentId: "root", nodeVersion: "leaf-v1", kind: "leaf" as const },
  ];
  const completeChildren = [
    { target: decisionTargets[0]!, metadataHash: sha256Canonical("folder-meta") },
    { target: decisionTargets[1]!, metadataHash: sha256Canonical("leaf-meta") },
    {
      target: { nodeId: "private", parentId: "root", nodeVersion: "private-v1", kind: "leaf" as const },
      metadataHash: sha256Canonical("private-meta"),
    },
  ];
  const layer = {
    sourceId: "source-local",
    parentNodeId: "root",
    parentNodeVersion: "root-v1",
    summaryHash: sha256Canonical("summary"),
    childSetHash: sha256Canonical(completeChildren),
    decisionTargetSetHash: sha256Canonical(decisionTargets),
    coverage: {
      directChildrenEnumerated: 3,
      pageComplete: true,
      openCursor: false,
      unknownChildCount: false,
    },
    systemOutcomes: [{ targetNodeId: "private", outcome: "blocked" as const, code: "PERMISSION_DENIED" }],
  };
  const scanInput: AgentScanInputContext = {
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    layer,
    completeChildren,
    decisionTargets,
    remainingBudget: { nodes: 100, bodyBytes: 1000, agentCalls: 10 },
    sensitivityByTarget: decisionTargets.map(({ nodeId }) => ({
      targetNodeId: nodeId,
      effective: "normal" as const,
      ownerApprovalRequired: false,
    })),
    scanIntent: plan.scanIntent,
    indexing: {
      default: plan.policy.indexing.default,
      rules: plan.policy.indexing.rules.map((rule) => ({ ...rule })),
    },
    skillHash: plan.skillHash,
    wikiHash: sha256Canonical("wiki"),
    hostPolicyHash: sha256Canonical("host-policy"),
  };
  const inputSetHash = buildAgentScanInputSetHash(scanInput);
  const summary: LayerSummaryReceipt = receipt({
    schema: "openlifewiki.layer-summary-receipt/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    sourceId: "source-local",
    intentId: intent.intentId,
    summaryHash: layer.summaryHash,
    childSetHash: layer.childSetHash,
    inputSetHash,
    persistedAt: AT,
  });
  const decisions: ScanDecision[] = decisionTargets.map((target, index) => receipt({
    schema: "openlifewiki.scan-decision/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    authorizationHash: HASH_A,
    sourceId: "source-local",
    parentNodeId: "root",
    parentNodeVersion: "root-v1",
    childSetHash: layer.childSetHash,
    nodeId: target.nodeId,
    nodeVersion: target.nodeVersion,
    targetKind: target.kind,
    summaryHash: layer.summaryHash,
    inputSetHash,
    decision: index === 0 ? "descend" as const : "skip" as const,
    reason: index === 0 ? "Useful branch" : "Out of scope",
    actor: "agent_codex_native",
    estimatedCost: index === 0
      ? { nodes: 1, bodyBytes: 0, agentCalls: 1 }
      : { nodes: 0, bodyBytes: 0, agentCalls: 0 },
    persistedAt: AT,
  }));
  const systemOutcomes: ScanSystemOutcomeReceipt[] = [receipt({
    schema: "openlifewiki.scan-system-outcome/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    sourceId: "source-local",
    nodeId: "private",
    outcome: "blocked" as const,
    phase: "discovery" as const,
    code: "PERMISSION_DENIED",
    persistedAt: AT,
  })];
  const agentResult: AgentScanResult = {
    schema: "openlifewiki.agent-scan-result/v1",
    operationId: "operation-1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    skillHash: plan.skillHash,
    inputSetHash,
    agent: {
      id: "agent_codex_native",
      runtime: "codex",
      mode: "native-cli",
      driverContractVersion: "v1",
    },
    layer,
    childOutcomes: decisionTargets.map((target, index) => ({
      target,
      outcome: index === 0 ? "descend" as const : "skip" as const,
      reason: index === 0 ? "Useful branch" : "Out of scope",
      estimatedCost: index === 0
        ? { nodes: 1, bodyBytes: 0, agentCalls: 1 }
        : { nodes: 0, bodyBytes: 0, agentCalls: 0 },
      revisitCondition: null,
      question: null,
    })),
    status: "decision-ready",
  };
  const agentInvocationReceipt = createAgentScanInvocationReceipt({
    plan,
    scanInput,
    result: agentResult,
    runtimeVersion: "1.0.0",
    outputSchemaHash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
    invokedAt: AT,
  });
  const trustedReceiptHashes = [
    intent.receiptHash,
    summary.receiptHash,
    ...systemOutcomes.map(({ receiptHash }) => receiptHash),
    agentInvocationReceipt.receiptHash,
  ];
  return {
    plan, intent, scanInput, summary, decisions, systemOutcomes,
    agentResult, agentInvocationReceipt, trustedReceiptHashes,
  };
}

describe("ScanLedger", () => {
  it("atomically appends one complete hash-bound layer outcome batch", () => {
    const input = fixture();
    const empty = createScanLedger(input.plan);
    const appended = appendLayerOutcomeBatch({
      ledger: empty,
      plan: input.plan,
      expectedHeadHash: null,
      sequence: 1,
      intent: input.intent,
      scanInput: input.scanInput,
      summary: input.summary,
      agentResult: input.agentResult,
      agentInvocationReceipt: input.agentInvocationReceipt,
      agentDecisions: input.decisions,
      systemOutcomes: input.systemOutcomes,
      trustedReceiptHashes: input.trustedReceiptHashes,
      committedAt: AT,
    });

    expect(appended.entries).toHaveLength(1);
    expect(appended.headHash).toBe(appended.entries[0]!.entryHash);
    expect(appended.entries[0]!.previousEntryHash).toBeNull();
    expect(empty.entries).toEqual([]);
    expect(() => appendLayerOutcomeBatch({
      ledger: appended,
      plan: input.plan,
      expectedHeadHash: appended.headHash,
      sequence: 2,
      intent: input.intent,
      scanInput: input.scanInput,
      summary: input.summary,
      agentResult: input.agentResult,
      agentInvocationReceipt: input.agentInvocationReceipt,
      agentDecisions: input.decisions,
      systemOutcomes: input.systemOutcomes,
      trustedReceiptHashes: input.trustedReceiptHashes,
      committedAt: AT,
    })).toThrow(/already|duplicate/i);
  });

  it.each([
    ["missing", (value: ReturnType<typeof fixture>) => ({ decisions: value.decisions.slice(0, 1) })],
    ["duplicate", (value: ReturnType<typeof fixture>) => ({ decisions: [value.decisions[0]!, value.decisions[0]!] })],
    ["extra", (value: ReturnType<typeof fixture>) => ({ decisions: [...value.decisions, value.decisions[0]!] })],
    ["wrong target", (value: ReturnType<typeof fixture>) => {
      const { receiptHash: _receiptHash, ...payload } = value.decisions[1]!;
      return { decisions: [value.decisions[0]!, receipt({ ...payload, nodeId: "invented" })] };
    }],
  ])("rejects a %s Agent decision set without partially appending", (_label, mutate) => {
    const input = fixture();
    const empty = createScanLedger(input.plan);
    const change = mutate(input);
    expect(() => appendLayerOutcomeBatch({
      ledger: empty,
      plan: input.plan,
      expectedHeadHash: null,
      sequence: 1,
      intent: input.intent,
      scanInput: input.scanInput,
      summary: input.summary,
      agentResult: input.agentResult,
      agentInvocationReceipt: input.agentInvocationReceipt,
      agentDecisions: change.decisions,
      systemOutcomes: input.systemOutcomes,
      trustedReceiptHashes: input.trustedReceiptHashes,
      committedAt: AT,
    })).toThrow();
    expect(empty.entries).toEqual([]);
  });

  it("rejects stale CAS, wrong sequence and forged plan-bound receipts", () => {
    const input = fixture();
    const empty = createScanLedger(input.plan);
    const base = {
      ledger: empty,
      plan: input.plan,
      expectedHeadHash: null,
      sequence: 1,
      intent: input.intent,
      scanInput: input.scanInput,
      summary: input.summary,
      agentResult: input.agentResult,
      agentInvocationReceipt: input.agentInvocationReceipt,
      agentDecisions: input.decisions,
      systemOutcomes: input.systemOutcomes,
      trustedReceiptHashes: input.trustedReceiptHashes,
      committedAt: AT,
    };
    expect(() => appendLayerOutcomeBatch({ ...base, expectedHeadHash: HASH_A })).toThrow(/head/i);
    expect(() => appendLayerOutcomeBatch({ ...base, sequence: 2 })).toThrow(/sequence/i);
    expect(() => appendLayerOutcomeBatch({
      ...base,
      summary: { ...input.summary, skeletonVersion: HASH_A },
    })).toThrow(/receiptHash|skeleton/i);

    const { receiptHash: _decisionHash, ...decisionPayload } = input.decisions[0]!;
    const wrongSource = receipt({ ...decisionPayload, sourceId: "source-other" });
    expect(() => appendLayerOutcomeBatch({
      ...base,
      agentDecisions: [wrongSource, input.decisions[1]!],
    })).toThrow(/source|target|authorization/i);
    const invalidDecision = receipt({ ...decisionPayload, decision: "read-all" as never });
    expect(() => appendLayerOutcomeBatch({
      ...base,
      agentDecisions: [invalidDecision, input.decisions[1]!],
    })).toThrow(/decision/i);
    expect(() => appendLayerOutcomeBatch({
      ...base,
      systemOutcomes: [],
    })).toThrow(/system/i);
    expect(() => appendLayerOutcomeBatch({
      ...base,
      trustedReceiptHashes: input.trustedReceiptHashes.filter(
        (hash) => hash !== input.intent.receiptHash,
      ),
    })).toThrow(/trusted/i);
    for (const requiredHash of [
      input.summary.receiptHash,
      input.systemOutcomes[0]!.receiptHash,
      input.agentInvocationReceipt.receiptHash,
    ]) {
      expect(() => appendLayerOutcomeBatch({
        ...base,
        trustedReceiptHashes: input.trustedReceiptHashes.filter((hash) => hash !== requiredHash),
      })).toThrow(/trusted/i);
    }
    const mismatchedDecision = receipt({
      ...decisionPayload,
      reason: "Invented after Agent validation",
    });
    expect(() => appendLayerOutcomeBatch({
      ...base,
      agentDecisions: [mismatchedDecision, input.decisions[1]!],
    })).toThrow(/Agent result|reason/i);
    const mismatchedActor = receipt({ ...decisionPayload, actor: "agent_other" });
    expect(() => appendLayerOutcomeBatch({
      ...base,
      agentDecisions: [mismatchedActor, input.decisions[1]!],
    })).toThrow(/Agent result|actor/i);
    expect(() => appendLayerOutcomeBatch({
      ...base,
      agentResult: {
        ...input.agentResult,
        childOutcomes: input.agentResult.childOutcomes.map((outcome, index) =>
          index === 0 ? { ...outcome, reason: "Changed after invocation" } : outcome
        ),
      },
    })).toThrow(/resultHash|invocation/i);
  });
});
