import {
  agentScanInputContextSchema,
  assertScanPlan,
  getAgentIoSchemaHash,
  parseAgentScanResult,
  sha256Canonical,
  type AgentScanInvocationReceipt,
  type AgentScanInputContext,
  type AgentScanResult,
  type EnumerationIntent,
  type LayerSummaryReceipt,
  type ScanDecision,
  type ScanPlan,
  type ScanSystemOutcomeReceipt,
} from "@openlifewiki/protocol";

export interface ScanLedgerEntry {
  readonly schema: "openlifewiki.scan-ledger-entry/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sequence: number;
  readonly previousEntryHash: string | null;
  readonly sourceId: string;
  readonly intentId: string;
  readonly parentNodeId: string;
  readonly summaryReceiptHash: string;
  readonly agentInvocationReceiptHash: string;
  readonly agentResultHash: string;
  readonly agentDecisionReceiptHashes: readonly string[];
  readonly systemOutcomeReceiptHashes: readonly string[];
  readonly batchHash: string;
  readonly committedAt: string;
  readonly entryHash: string;
}

export interface ScanLedger {
  readonly schema: "openlifewiki.scan-ledger/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly entries: readonly ScanLedgerEntry[];
  readonly headHash: string | null;
}

export interface AppendLayerOutcomeBatchInput {
  readonly ledger: ScanLedger;
  readonly plan: ScanPlan;
  readonly expectedHeadHash: string | null;
  readonly sequence: number;
  readonly intent: EnumerationIntent;
  readonly scanInput: AgentScanInputContext;
  readonly summary: LayerSummaryReceipt;
  readonly agentResult: AgentScanResult;
  readonly agentInvocationReceipt: AgentScanInvocationReceipt;
  readonly agentDecisions: readonly ScanDecision[];
  readonly systemOutcomes: readonly ScanSystemOutcomeReceipt[];
  readonly trustedReceiptHashes: readonly string[];
  readonly committedAt: string;
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function assertReceiptIntegrity(receipt: Readonly<Record<string, unknown>>, label: string): void {
  const { receiptHash, ...payload } = receipt;
  if (typeof receiptHash !== "string" || sha256Canonical(payload) !== receiptHash) {
    throw new Error(`${label} receiptHash mismatch`);
  }
}

function assertPlanBinding(
  receipt: { readonly scanId: string; readonly scanPlanHash: string; readonly skeletonVersion: string },
  plan: ScanPlan,
  label: string,
): void {
  if (receipt.scanId !== plan.scanId
    || receipt.scanPlanHash !== plan.scanPlanHash
    || receipt.skeletonVersion !== plan.skeletonVersion) {
    throw new Error(`${label} does not bind the active plan and skeleton`);
  }
}

function assertLedgerIntegrity(ledger: ScanLedger): void {
  if (ledger.schema !== "openlifewiki.scan-ledger/v1") {
    throw new Error("Scan ledger schema is invalid");
  }
  let previous: string | null = null;
  ledger.entries.forEach((entry, index) => {
    const { entryHash, ...payload } = entry;
    if (entry.sequence !== index + 1 || entry.previousEntryHash !== previous) {
      throw new Error("Scan ledger sequence or hash chain is invalid");
    }
    if (sha256Canonical(payload) !== entryHash) throw new Error("Scan ledger entryHash mismatch");
    previous = entryHash;
  });
  if (ledger.headHash !== previous) throw new Error("Scan ledger head does not match its hash chain");
}

export function createScanLedger(plan: ScanPlan): ScanLedger {
  assertScanPlan(plan);
  return freeze({
    schema: "openlifewiki.scan-ledger/v1",
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    entries: [],
    headHash: null,
  });
}

function assertExactLayerOutcomeBatch(input: AppendLayerOutcomeBatchInput): void {
  const { plan, intent, summary } = input;
  const scanInput = agentScanInputContextSchema.parse(input.scanInput);
  const trusted = new Set(input.trustedReceiptHashes);
  assertReceiptIntegrity(intent as unknown as Readonly<Record<string, unknown>>, "Enumeration intent");
  assertReceiptIntegrity(summary as unknown as Readonly<Record<string, unknown>>, "Layer summary");
  assertReceiptIntegrity(
    input.agentInvocationReceipt as unknown as Readonly<Record<string, unknown>>,
    "Agent invocation",
  );
  if (!trusted.has(intent.receiptHash)
    || !trusted.has(summary.receiptHash)
    || !trusted.has(input.agentInvocationReceipt.receiptHash)) {
    throw new Error("Layer intent, summary or Agent invocation is outside the trusted receipt ledger");
  }
  assertPlanBinding(intent, plan, "Enumeration intent");
  assertPlanBinding(summary, plan, "Layer summary");
  assertPlanBinding(input.agentInvocationReceipt, plan, "Agent invocation");

  const invocation = input.agentInvocationReceipt;
  const validatedAgentResult = parseAgentScanResult(input.agentResult, {
    schema: "openlifewiki.agent-scan-result/v1",
    agent: invocation.agent,
    inputSetHash: invocation.inputSetHash,
    skillHash: invocation.skillHash,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    operationId: invocation.operationId,
    scanId: plan.scanId,
    scanInput,
  });
  if (invocation.sourceId !== scanInput.layer.sourceId
    || invocation.layerHash !== sha256Canonical(scanInput.layer)
    || invocation.skillHash !== plan.skillHash
    || invocation.agent.id !== plan.agentProfileId
    || invocation.outputSchemaId !== "openlifewiki.agent-scan-result/v1"
    || invocation.outputSchemaHash !== getAgentIoSchemaHash(invocation.outputSchemaId)
    || invocation.resultHash !== sha256Canonical(validatedAgentResult)
    || invocation.runtimeVersion.length === 0) {
    throw new Error("Agent invocation receipt does not bind the validated Agent result");
  }

  const sourceIndex = plan.sourceIds.indexOf(scanInput.layer.sourceId);
  if (sourceIndex < 0
    || intent.sourceId !== scanInput.layer.sourceId
    || summary.sourceId !== scanInput.layer.sourceId
    || intent.targetNodeId !== scanInput.layer.parentNodeId
    || intent.targetNodeVersion !== scanInput.layer.parentNodeVersion
    || intent.authorizationHash !== plan.authorizationHashes[sourceIndex]) {
    throw new Error("Layer source, authorization or parent target does not match its intent");
  }
  if (scanInput.scanId !== plan.scanId
    || scanInput.scanPlanHash !== plan.scanPlanHash
    || scanInput.skeletonVersion !== plan.skeletonVersion) {
    throw new Error("Trusted layer input does not bind the active plan and skeleton");
  }
  if (!scanInput.layer.coverage.pageComplete
    || scanInput.layer.coverage.openCursor
    || scanInput.layer.coverage.unknownChildCount) {
    throw new Error("A layer outcome batch requires complete known child coverage");
  }
  if (summary.intentId !== intent.intentId
    || summary.summaryHash !== scanInput.layer.summaryHash
    || summary.childSetHash !== scanInput.layer.childSetHash
    || summary.inputSetHash !== sha256Canonical(scanInput)) {
    throw new Error("Layer summary hash or input binding mismatch");
  }

  const completeIds = new Set<string>();
  for (const child of scanInput.completeChildren) {
    if (completeIds.has(child.target.nodeId)) throw new Error("Complete child set contains a duplicate target");
    if (child.target.parentId !== scanInput.layer.parentNodeId) {
      throw new Error("Complete child is outside the direct layer");
    }
    completeIds.add(child.target.nodeId);
  }
  if (sha256Canonical(scanInput.completeChildren) !== scanInput.layer.childSetHash
    || scanInput.completeChildren.length !== scanInput.layer.coverage.directChildrenEnumerated) {
    throw new Error("Complete child set does not match childSetHash or coverage");
  }
  if (sha256Canonical(scanInput.decisionTargets) !== scanInput.layer.decisionTargetSetHash) {
    throw new Error("Decision target set does not match decisionTargetSetHash");
  }
  if (input.agentDecisions.length !== scanInput.decisionTargets.length) {
    throw new Error("Agent decisions must exactly cover the trusted decision target set");
  }

  const decisionIds = new Set<string>();
  scanInput.decisionTargets.forEach((target, index) => {
    const decision = input.agentDecisions[index];
    const agentOutcome = validatedAgentResult.childOutcomes[index];
    if (decision === undefined) throw new Error("Agent decision is missing");
    if (agentOutcome === undefined) throw new Error("Validated Agent result outcome is missing");
    assertReceiptIntegrity(decision as unknown as Readonly<Record<string, unknown>>, "Scan decision");
    assertPlanBinding(decision, plan, "Scan decision");
    if (decision.schema !== "openlifewiki.scan-decision/v1"
      || !(["descend", "skip", "defer", "ask-user"] as const).includes(decision.decision)) {
      throw new Error("Scan decision has an invalid schema or decision value");
    }
    const costs = Object.values(decision.estimatedCost);
    if (costs.length !== 3 || costs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Scan decision has invalid estimated cost");
    }
    if (decision.decision === "skip" && costs.some((value) => value !== 0)) {
      throw new Error("Skip decision cannot reserve follow-up cost");
    }
    if (decisionIds.has(decision.nodeId)) throw new Error("Agent decision target is duplicated");
    decisionIds.add(decision.nodeId);
    if (!completeIds.has(decision.nodeId)
      || decision.sourceId !== scanInput.layer.sourceId
      || decision.authorizationHash !== plan.authorizationHashes[sourceIndex]
      || decision.parentNodeId !== scanInput.layer.parentNodeId
      || decision.parentNodeVersion !== scanInput.layer.parentNodeVersion
      || decision.nodeId !== target.nodeId
      || decision.nodeVersion !== target.nodeVersion
      || decision.targetKind !== target.kind
      || decision.childSetHash !== scanInput.layer.childSetHash
      || decision.summaryHash !== scanInput.layer.summaryHash
      || decision.inputSetHash !== summary.inputSetHash) {
      throw new Error("Agent decision does not match its exact trusted target or layer hashes");
    }
    if (decision.actor !== validatedAgentResult.agent.id
      || decision.decision !== agentOutcome.outcome
      || decision.reason !== agentOutcome.reason
      || sha256Canonical(decision.estimatedCost) !== sha256Canonical(agentOutcome.estimatedCost)) {
      throw new Error("Scan decision actor, outcome, reason or cost does not match the validated Agent result");
    }
  });

  if (input.systemOutcomes.length !== scanInput.layer.systemOutcomes.length) {
    throw new Error("System outcomes must exactly cover the trusted system target set");
  }
  const systemIds = new Set<string>();
  scanInput.layer.systemOutcomes.forEach((expected, index) => {
    const outcome = input.systemOutcomes[index];
    if (outcome === undefined) throw new Error("System outcome is missing");
    assertReceiptIntegrity(outcome as unknown as Readonly<Record<string, unknown>>, "System outcome");
    if (!trusted.has(outcome.receiptHash)) {
      throw new Error("System outcome is outside the trusted receipt ledger");
    }
    assertPlanBinding(outcome, plan, "System outcome");
    if (outcome.schema !== "openlifewiki.scan-system-outcome/v1"
      || !(["blocked", "failed", "unknown"] as const).includes(outcome.outcome)
      || !(["discovery", "summarization", "selectedScan", "committedIndex"] as const)
        .includes(outcome.phase)) {
      throw new Error("System outcome has an invalid schema, outcome or phase");
    }
    if (systemIds.has(outcome.nodeId) || decisionIds.has(outcome.nodeId)) {
      throw new Error("Layer outcome target is duplicated");
    }
    systemIds.add(outcome.nodeId);
    if (!completeIds.has(outcome.nodeId)
      || outcome.sourceId !== scanInput.layer.sourceId
      || outcome.nodeId !== expected.targetNodeId
      || outcome.outcome !== expected.outcome
      || outcome.code !== expected.code) {
      throw new Error("System outcome does not match its exact trusted target");
    }
  });
  if (decisionIds.size + systemIds.size !== completeIds.size) {
    throw new Error("Agent and system outcomes do not cover the exact complete child set");
  }
}

export function appendLayerOutcomeBatch(input: AppendLayerOutcomeBatchInput): ScanLedger {
  assertScanPlan(input.plan);
  assertLedgerIntegrity(input.ledger);
  if (input.ledger.scanId !== input.plan.scanId
    || input.ledger.scanPlanHash !== input.plan.scanPlanHash
    || input.ledger.skeletonVersion !== input.plan.skeletonVersion) {
    throw new Error("Scan ledger does not bind the active plan and skeleton");
  }
  if (input.expectedHeadHash !== input.ledger.headHash) throw new Error("Scan ledger head CAS mismatch");
  if (!Number.isSafeInteger(input.sequence) || input.sequence !== input.ledger.entries.length + 1) {
    throw new Error("Scan ledger sequence mismatch");
  }
  if (input.ledger.entries.some((entry) =>
    (entry.sourceId === input.intent.sourceId && entry.intentId === input.intent.intentId)
    || entry.summaryReceiptHash === input.summary.receiptHash
  )) {
    throw new Error("Layer outcome batch was already committed");
  }
  if (!Number.isFinite(Date.parse(input.committedAt))) {
    throw new Error("Layer outcome committedAt is invalid");
  }
  assertExactLayerOutcomeBatch(input);

  const batch = {
    summaryReceiptHash: input.summary.receiptHash,
    agentInvocationReceiptHash: input.agentInvocationReceipt.receiptHash,
    agentResultHash: input.agentInvocationReceipt.resultHash,
    agentDecisionReceiptHashes: input.agentDecisions.map(({ receiptHash }) => receiptHash),
    systemOutcomeReceiptHashes: input.systemOutcomes.map(({ receiptHash }) => receiptHash),
  };
  const entryPayload = {
    schema: "openlifewiki.scan-ledger-entry/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    sequence: input.sequence,
    previousEntryHash: input.ledger.headHash,
    sourceId: input.scanInput.layer.sourceId,
    intentId: input.intent.intentId,
    parentNodeId: input.scanInput.layer.parentNodeId,
    ...batch,
    batchHash: sha256Canonical(batch),
    committedAt: input.committedAt,
  };
  const entry: ScanLedgerEntry = { ...entryPayload, entryHash: sha256Canonical(entryPayload) };
  return freeze({
    ...input.ledger,
    entries: [...input.ledger.entries, entry],
    headHash: entry.entryHash,
  });
}
