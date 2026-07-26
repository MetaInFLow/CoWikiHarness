import { z } from "zod";

import type { AgentIoAgent, AgentScanInputContext, AgentScanResult } from "./agent-io.js";
import { sha256Canonical } from "./hashing.js";
import { getAgentIoSchemaHash, parseAgentScanResult } from "./schema-validator.js";

export type IndexingDisposition = "qmd-current" | "metadata-only" | "excluded";

export interface ScanPlan {
  readonly schema: "openlifewiki.scan-plan/v1";
  readonly scanId: string;
  readonly sourceIds: readonly string[];
  readonly authorizationHashes: readonly string[];
  readonly rootNodeIds: readonly string[];
  readonly skeletonVersion: string;
  readonly agentProfileId: string;
  readonly skillHash: string;
  readonly scanIntent: string;
  readonly priorityDocumentRefs: readonly string[];
  readonly policy: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly sensitivity: "normal" | "sensitive";
    readonly budget: Readonly<Record<string, number>>;
    readonly indexing: {
      readonly default: IndexingDisposition;
      readonly rules: readonly {
        readonly match: string;
        readonly disposition: IndexingDisposition;
      }[];
    };
  };
  readonly scanPlanHash: string;
}

export type ScanDecisionValue = "descend" | "skip" | "defer" | "ask-user";
export type ScanProgressDimension =
  | "discovery"
  | "summarization"
  | "selectedScan"
  | "committedIndex";

export interface EnumerationIntent {
  readonly schema: "openlifewiki.enumeration-intent/v1";
  readonly intentId: string;
  readonly scanId: string;
  readonly sourceId: string;
  readonly targetNodeId: string;
  readonly targetNodeVersion: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly origin: "authorized-root" | "container-descend";
  readonly parentLayerNodeId: string | null;
  readonly childSetHash: string | null;
  readonly inputSetHash: string;
  readonly decisionReceiptHash: string | null;
  readonly createdAt: string;
  readonly receiptHash: string;
}

export interface ScanDecision {
  readonly schema: "openlifewiki.scan-decision/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly sourceId: string;
  readonly parentNodeId: string;
  readonly parentNodeVersion: string;
  readonly childSetHash: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly targetKind: "container" | "leaf";
  readonly summaryHash: string;
  readonly inputSetHash: string;
  readonly decision: ScanDecisionValue;
  readonly reason: string;
  readonly actor: string;
  readonly estimatedCost: {
    readonly nodes: number;
    readonly bodyBytes: number;
    readonly agentCalls: number;
  };
  readonly persistedAt: string;
  readonly receiptHash: string;
}

export interface LeafSelectionReceipt {
  readonly schema: "openlifewiki.leaf-selection/v1";
  readonly scanId: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly inputSetHash: string;
  readonly decisionReceiptHash: string;
  readonly actor: string;
  readonly reason: string;
  readonly persistedAt: string;
  readonly receiptHash: string;
}

export type BodyObservationPurpose = "initial-read" | "qmd-rematerialization";

export interface BodyObservationReceipt {
  readonly schema: "openlifewiki.body-observation-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly inputSetHash: string;
  readonly selectionReceiptHash: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly purpose: BodyObservationPurpose;
  readonly rematerializationAuthorizationHash: string | null;
  readonly previousObservationReceiptHash: string | null;
  readonly observedAt: string;
  readonly receiptHash: string;
}

export interface ScanPhysicalIoCounters {
  readonly initialReadItems: number;
  readonly initialReadBytes: number;
  readonly rematerializedItems: number;
  readonly rematerializedBytes: number;
}

export interface AgentScanInvocationReceipt {
  readonly schema: "openlifewiki.agent-scan-invocation-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly layerHash: string;
  readonly operationId: string;
  readonly inputSetHash: string;
  readonly skillHash: string;
  readonly agent: AgentIoAgent;
  readonly runtimeVersion: string;
  readonly outputSchemaId: "openlifewiki.agent-scan-result/v1";
  readonly outputSchemaHash: string;
  readonly resultHash: string;
  readonly invokedAt: string;
  readonly receiptHash: string;
}

export interface CurrentLeafVersionReceipt {
  readonly schema: "openlifewiki.current-leaf-version-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly authorizationHash: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly selectionReceiptHash: string;
  readonly priorBodyObservationReceiptHash: string;
  readonly expectedNodeVersion: string;
  readonly observedNodeVersion: string;
  readonly expectedPriorContentHash: string;
  readonly expectedPriorBytes: number;
  readonly observedAt: string;
  readonly receiptHash: string;
}

export interface TemporaryQmdGenerationDeletionReceipt {
  readonly schema: "openlifewiki.temporary-qmd-generation-deletion-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly generationId: string;
  readonly failureReceiptHash: string;
  readonly deletedAt: string;
  readonly receiptHash: string;
}

const scanIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const scanHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scanBoundedText = z.string().min(1).max(8_192);
const indexingDispositionSchema = z.enum(["qmd-current", "metadata-only", "excluded"]);
const scanPlanPayloadSchema = z.strictObject({
  schema: z.literal("openlifewiki.scan-plan/v1"),
  scanId: scanIdentifier,
  sourceIds: z.array(scanIdentifier).min(1),
  authorizationHashes: z.array(scanHash).min(1),
  rootNodeIds: z.array(scanIdentifier).min(1),
  skeletonVersion: scanHash,
  agentProfileId: scanIdentifier,
  skillHash: scanHash,
  scanIntent: scanBoundedText,
  priorityDocumentRefs: z.array(scanBoundedText),
  policy: z.strictObject({
    include: z.array(scanBoundedText),
    exclude: z.array(scanBoundedText),
    sensitivity: z.enum(["normal", "sensitive"]),
    budget: z.record(scanIdentifier, z.number().int().nonnegative()),
    indexing: z.strictObject({
      default: indexingDispositionSchema,
      rules: z.array(z.strictObject({
        match: scanBoundedText,
        disposition: indexingDispositionSchema,
      })),
    }),
  }),
});
const scanPlanSchema = scanPlanPayloadSchema.extend({ scanPlanHash: scanHash });
const bodyObservationDraftSchema = z.strictObject({
  schema: z.literal("openlifewiki.body-observation-receipt/v1"),
  sourceId: scanIdentifier,
  nodeId: scanIdentifier,
  nodeVersion: scanBoundedText,
  contentHash: scanHash,
  bytes: z.number().int().nonnegative(),
  purpose: z.enum(["initial-read", "qmd-rematerialization"]),
  rematerializationAuthorizationHash: scanHash.nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});

export type ScanPlanPayload = z.input<typeof scanPlanPayloadSchema>;

function assertUniqueScanValues(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} must be unique`);
}

export function createScanPlan(input: ScanPlanPayload | Omit<ScanPlan, "scanPlanHash">): ScanPlan {
  const payload = scanPlanPayloadSchema.parse(input);
  assertUniqueScanValues(payload.sourceIds, "sourceIds");
  assertUniqueScanValues(payload.authorizationHashes, "authorizationHashes");
  if (payload.sourceIds.length !== payload.authorizationHashes.length) {
    throw new Error("sourceIds and authorizationHashes must have one-to-one membership");
  }
  if (payload.sourceIds.length !== payload.rootNodeIds.length) {
    throw new Error("sourceIds and rootNodeIds must have one-to-one membership");
  }
  return { ...payload, scanPlanHash: sha256Canonical(payload) };
}

export function assertScanPlan(input: unknown): asserts input is ScanPlan {
  const plan = scanPlanSchema.parse(input);
  const { scanPlanHash, ...payload } = plan;
  const canonical = createScanPlan(payload);
  if (canonical.scanPlanHash !== scanPlanHash) throw new Error("scanPlanHash mismatch");
}

export type BodyObservationDraft = z.input<typeof bodyObservationDraftSchema>;

export interface CreateBodyObservationReceiptInput {
  readonly plan: ScanPlan;
  readonly trustedSelectionReceiptHashes: readonly string[];
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly previousObservationReceipt: BodyObservationReceipt | null;
  readonly observation: BodyObservationDraft;
}

function assertReceiptHash(receipt: Readonly<Record<string, unknown>>, label: string): void {
  const { receiptHash, ...payload } = receipt;
  if (typeof receiptHash !== "string" || sha256Canonical(payload) !== receiptHash) {
    throw new Error(`${label} receiptHash mismatch`);
  }
}

export function createBodyObservationReceipt(
  input: CreateBodyObservationReceiptInput,
): BodyObservationReceipt {
  assertScanPlan(input.plan);
  const observation = bodyObservationDraftSchema.parse(input.observation);
  const selection = input.selectionReceipt;
  assertReceiptHash(selection as unknown as Readonly<Record<string, unknown>>, "Leaf selection");
  if (!input.trustedSelectionReceiptHashes.includes(selection.receiptHash)) {
    throw new Error("Leaf selection is outside the trusted receipt ledger");
  }
  const sourceIndex = input.plan.sourceIds.indexOf(observation.sourceId);
  if (sourceIndex < 0
    || selection.schema !== "openlifewiki.leaf-selection/v1"
    || observation.schema !== "openlifewiki.body-observation-receipt/v1"
    || selection.scanId !== input.plan.scanId
    || selection.scanPlanHash !== input.plan.scanPlanHash
    || selection.skeletonVersion !== input.plan.skeletonVersion
    || selection.sourceId !== observation.sourceId
    || selection.nodeId !== observation.nodeId
    || selection.nodeVersion !== observation.nodeVersion
    || selection.authorizationHash !== input.plan.authorizationHashes[sourceIndex]) {
    throw new Error("Body observation does not bind the selected current leaf");
  }

  let previousObservationReceiptHash: string | null = null;
  const previous = input.previousObservationReceipt;
  if (observation.purpose === "initial-read") {
    if (previous !== null) throw new Error("Initial body observation cannot claim a previous observation");
    if (observation.rematerializationAuthorizationHash !== null) {
      throw new Error("Initial body observation cannot claim rematerialization authorization");
    }
  } else {
    if (previous === null) throw new Error("QMD rematerialization requires a previous body observation");
    if (observation.rematerializationAuthorizationHash === null) {
      throw new Error("QMD rematerialization requires policy authorization");
    }
    assertReceiptHash(previous as unknown as Readonly<Record<string, unknown>>, "Previous body observation");
    if (previous.scanId !== input.plan.scanId
      || previous.scanPlanHash !== input.plan.scanPlanHash
      || previous.skeletonVersion !== input.plan.skeletonVersion
      || previous.authorizationHash !== selection.authorizationHash
      || previous.sourceId !== observation.sourceId
      || previous.nodeId !== observation.nodeId
      || previous.nodeVersion !== observation.nodeVersion
      || previous.inputSetHash !== selection.inputSetHash
      || previous.selectionReceiptHash !== selection.receiptHash
      || previous.contentHash !== observation.contentHash) {
      throw new Error("QMD rematerialization does not match the previous current body observation");
    }
    previousObservationReceiptHash = previous.receiptHash;
  }

  const payload = {
    ...observation,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    authorizationHash: selection.authorizationHash,
    inputSetHash: selection.inputSetHash,
    selectionReceiptHash: selection.receiptHash,
    previousObservationReceiptHash,
  } as const;
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export type BodyObservationReceiptValidationContext = Omit<
  CreateBodyObservationReceiptInput,
  "observation"
>;

export function assertBodyObservationReceipt(
  input: unknown,
  context: BodyObservationReceiptValidationContext,
): asserts input is BodyObservationReceipt {
  if (typeof input !== "object" || input === null) throw new Error("Body observation receipt required");
  const candidate = input as BodyObservationReceipt;
  const canonical = createBodyObservationReceipt({
    ...context,
    observation: {
      schema: candidate.schema,
      sourceId: candidate.sourceId,
      nodeId: candidate.nodeId,
      nodeVersion: candidate.nodeVersion,
      contentHash: candidate.contentHash,
      bytes: candidate.bytes,
      purpose: candidate.purpose,
      rematerializationAuthorizationHash: candidate.rematerializationAuthorizationHash,
      observedAt: candidate.observedAt,
    },
  });
  if (sha256Canonical(input) !== sha256Canonical(canonical)) {
    throw new Error("Body observation receiptHash or binding mismatch");
  }
}

export interface CreateAgentScanInvocationReceiptInput {
  readonly plan: ScanPlan;
  readonly scanInput: AgentScanInputContext;
  readonly result: AgentScanResult;
  readonly runtimeVersion: string;
  readonly outputSchemaHash: string;
  readonly invokedAt: string;
}

export function createAgentScanInvocationReceipt(
  input: CreateAgentScanInvocationReceiptInput,
): AgentScanInvocationReceipt {
  assertScanPlan(input.plan);
  const validated = parseAgentScanResult(input.result, {
    schema: "openlifewiki.agent-scan-result/v1",
    agent: input.result.agent,
    inputSetHash: input.result.inputSetHash,
    skillHash: input.plan.skillHash,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    operationId: input.result.operationId,
    scanId: input.plan.scanId,
    scanInput: input.scanInput,
  });
  if (validated.agent.id !== input.plan.agentProfileId) {
    throw new Error("Agent invocation does not match the selected ScanPlan Agent");
  }
  if (input.runtimeVersion.length === 0 || input.runtimeVersion.length > 256) {
    throw new Error("Agent runtime version is invalid");
  }
  const outputSchemaId = "openlifewiki.agent-scan-result/v1" as const;
  if (input.outputSchemaHash !== getAgentIoSchemaHash(outputSchemaId)) {
    throw new Error("Agent output schema hash mismatch");
  }
  if (!Number.isFinite(Date.parse(input.invokedAt))) throw new Error("Agent invokedAt is invalid");
  const payload = {
    schema: "openlifewiki.agent-scan-invocation-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    sourceId: input.scanInput.layer.sourceId,
    layerHash: sha256Canonical(input.scanInput.layer),
    operationId: validated.operationId,
    inputSetHash: validated.inputSetHash,
    skillHash: validated.skillHash,
    agent: validated.agent,
    runtimeVersion: input.runtimeVersion,
    outputSchemaId,
    outputSchemaHash: input.outputSchemaHash,
    resultHash: sha256Canonical(validated),
    invokedAt: input.invokedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export interface CreateCurrentLeafVersionReceiptInput {
  readonly plan: ScanPlan;
  readonly trustedReceiptHashes: readonly string[];
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly priorBodyObservationReceipt: BodyObservationReceipt;
  readonly observedNodeVersion: string;
  readonly observedAt: string;
}

export function createCurrentLeafVersionReceipt(
  input: CreateCurrentLeafVersionReceiptInput,
): CurrentLeafVersionReceipt {
  assertScanPlan(input.plan);
  const trusted = new Set(input.trustedReceiptHashes);
  const selection = input.selectionReceipt;
  const observation = input.priorBodyObservationReceipt;
  assertReceiptHash(selection as unknown as Readonly<Record<string, unknown>>, "Leaf selection");
  assertReceiptHash(observation as unknown as Readonly<Record<string, unknown>>, "Prior body observation");
  if (!trusted.has(selection.receiptHash) || !trusted.has(observation.receiptHash)) {
    throw new Error("Current version inputs are outside the trusted receipt ledger");
  }
  const sourceIndex = input.plan.sourceIds.indexOf(selection.sourceId);
  if (sourceIndex < 0
    || selection.schema !== "openlifewiki.leaf-selection/v1"
    || observation.schema !== "openlifewiki.body-observation-receipt/v1"
    || selection.scanId !== input.plan.scanId
    || selection.scanPlanHash !== input.plan.scanPlanHash
    || selection.skeletonVersion !== input.plan.skeletonVersion
    || selection.authorizationHash !== input.plan.authorizationHashes[sourceIndex]
    || observation.selectionReceiptHash !== selection.receiptHash
    || observation.sourceId !== selection.sourceId
    || observation.nodeId !== selection.nodeId
    || observation.nodeVersion !== selection.nodeVersion
    || observation.contentHash.length === 0) {
    throw new Error("Current version observation does not bind the selected prior body");
  }
  if (input.observedNodeVersion.length === 0 || input.observedNodeVersion.length > 8_192) {
    throw new Error("Observed node version is invalid");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new Error("Current version observedAt is invalid");
  const payload = {
    schema: "openlifewiki.current-leaf-version-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    authorizationHash: selection.authorizationHash,
    sourceId: selection.sourceId,
    nodeId: selection.nodeId,
    selectionReceiptHash: selection.receiptHash,
    priorBodyObservationReceiptHash: observation.receiptHash,
    expectedNodeVersion: selection.nodeVersion,
    observedNodeVersion: input.observedNodeVersion,
    expectedPriorContentHash: observation.contentHash,
    expectedPriorBytes: observation.bytes,
    observedAt: input.observedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function createTemporaryQmdGenerationDeletionReceipt(input: {
  readonly plan: ScanPlan;
  readonly generationId: string;
  readonly failureReceiptHash: string;
  readonly deletedAt: string;
}): TemporaryQmdGenerationDeletionReceipt {
  assertScanPlan(input.plan);
  const draft = z.strictObject({
    generationId: scanIdentifier,
    failureReceiptHash: scanHash,
    deletedAt: z.iso.datetime({ offset: true }),
  }).parse({
    generationId: input.generationId,
    failureReceiptHash: input.failureReceiptHash,
    deletedAt: input.deletedAt,
  });
  const payload = {
    schema: "openlifewiki.temporary-qmd-generation-deletion-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    ...draft,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

const enumerationIntentDraftSchema = z.strictObject({
  schema: z.literal("openlifewiki.enumeration-intent/v1"),
  intentId: scanIdentifier,
  sourceId: scanIdentifier,
  targetNodeId: scanIdentifier,
  targetNodeVersion: scanBoundedText,
  authorizationHash: scanHash,
  origin: z.enum(["authorized-root", "container-descend"]),
  parentLayerNodeId: scanIdentifier.nullable(),
  childSetHash: scanHash.nullable(),
  inputSetHash: scanHash,
  createdAt: z.iso.datetime({ offset: true }),
});

export type EnumerationIntentDraft = z.input<typeof enumerationIntentDraftSchema>;

export interface CreateEnumerationIntentInput {
  readonly plan: ScanPlan;
  readonly trustedDecisionReceiptHashes: readonly string[];
  readonly decisionReceipt: ScanDecision | null;
  readonly intent: EnumerationIntentDraft;
}

function assertScanDecisionIntegrity(decision: ScanDecision): void {
  const { receiptHash, ...payload } = decision;
  if (sha256Canonical(payload) !== receiptHash) throw new Error("decision receiptHash mismatch");
}

export function createEnumerationIntent(input: CreateEnumerationIntentInput): EnumerationIntent {
  assertScanPlan(input.plan);
  const draft = enumerationIntentDraftSchema.parse(input.intent);
  const sourceIndex = input.plan.sourceIds.indexOf(draft.sourceId);
  if (sourceIndex < 0) throw new Error("enumeration source is outside the ScanPlan");
  if (input.plan.authorizationHashes[sourceIndex] !== draft.authorizationHash) {
    throw new Error("enumeration authorization does not match its ScanPlan source");
  }
  if (draft.origin === "authorized-root"
    && input.plan.rootNodeIds[sourceIndex] !== draft.targetNodeId) {
    throw new Error("authorized-root enumeration target does not match its ScanPlan root");
  }

  let decisionReceiptHash: string | null = null;
  if (draft.origin === "authorized-root") {
    if (input.decisionReceipt !== null
      || draft.parentLayerNodeId !== null
      || draft.childSetHash !== null) {
      throw new Error("authorized-root enumeration cannot claim a descend decision");
    }
  } else {
    const decision = input.decisionReceipt;
    if (decision === null) throw new Error("container-descend enumeration requires a decision");
    assertScanDecisionIntegrity(decision);
    if (!input.trustedDecisionReceiptHashes.includes(decision.receiptHash)) {
      throw new Error("container-descend decision receipt is not trusted");
    }
    if (decision.decision !== "descend" || decision.targetKind !== "container") {
      throw new Error("enumeration requires a container descend decision");
    }
    if (decision.scanId !== input.plan.scanId
      || decision.scanPlanHash !== input.plan.scanPlanHash
      || decision.skeletonVersion !== input.plan.skeletonVersion
      || decision.sourceId !== draft.sourceId
      || decision.authorizationHash !== draft.authorizationHash
      || decision.nodeId !== draft.targetNodeId
      || decision.nodeVersion !== draft.targetNodeVersion
      || decision.parentNodeId !== draft.parentLayerNodeId
      || decision.childSetHash !== draft.childSetHash
      || decision.inputSetHash !== draft.inputSetHash) {
      throw new Error("enumeration target does not match its trusted descend decision");
    }
    if (draft.targetNodeId === draft.parentLayerNodeId) {
      throw new Error("enumeration target must advance below the parent layer");
    }
    decisionReceiptHash = decision.receiptHash;
  }

  const payload = {
    ...draft,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    decisionReceiptHash,
  } as const;
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export interface EnumerationIntentValidationContext {
  readonly plan: ScanPlan;
  readonly trustedDecisionReceipts: readonly ScanDecision[];
}

export function assertEnumerationIntent(
  input: unknown,
  context: EnumerationIntentValidationContext,
): asserts input is EnumerationIntent {
  if (typeof input !== "object" || input === null) throw new Error("enumeration intent required");
  const candidate = input as EnumerationIntent;
  const trusted = context.trustedDecisionReceipts.find(
    ({ receiptHash }) => receiptHash === candidate.decisionReceiptHash,
  ) ?? null;
  const canonical = createEnumerationIntent({
    plan: context.plan,
    trustedDecisionReceiptHashes: context.trustedDecisionReceipts.map(({ receiptHash }) => receiptHash),
    decisionReceipt: trusted,
    intent: {
      schema: candidate.schema,
      intentId: candidate.intentId,
      sourceId: candidate.sourceId,
      targetNodeId: candidate.targetNodeId,
      targetNodeVersion: candidate.targetNodeVersion,
      authorizationHash: candidate.authorizationHash,
      origin: candidate.origin,
      parentLayerNodeId: candidate.parentLayerNodeId,
      childSetHash: candidate.childSetHash,
      inputSetHash: candidate.inputSetHash,
      createdAt: candidate.createdAt,
    },
  });
  if (sha256Canonical(input) !== sha256Canonical(canonical)) {
    throw new Error("enumeration intent receiptHash mismatch");
  }
}

export interface ScanCheckpoint {
  readonly schema: "openlifewiki.scan-checkpoint/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly authorizationHash: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly phase: "discovered" | "summarized" | "decided" | "body-processed" | "qmd-committed";
  readonly indexingDisposition: IndexingDisposition;
  readonly inputSetHash: string;
  readonly selectionReceiptHash?: string;
  readonly bodyObservationReceiptHash?: string;
  readonly qmdGenerationId?: string;
  readonly receiptHash: string;
}

export interface EnumerationPageReceipt {
  readonly schema: "openlifewiki.enumeration-page-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly intentId: string;
  readonly pageSequence: number;
  readonly eventSequence: number;
  readonly previousPageReceiptHash: string | null;
  readonly discoveredNodeIds: readonly string[];
  readonly knownUnenumeratedSlotIds: readonly string[];
  readonly nextCursor: string | null;
  readonly childCountKind: "known" | "estimated" | "unknown";
  readonly state: "open" | "complete" | "blocked";
  readonly childSetHash: string | null;
  readonly observedAt: string;
  readonly receiptHash: string;
}

export interface LayerSummaryReceipt {
  readonly schema: "openlifewiki.layer-summary-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly intentId: string;
  readonly summaryHash: string;
  readonly childSetHash: string;
  readonly inputSetHash: string;
  readonly persistedAt: string;
  readonly receiptHash: string;
}

export interface ScanSystemOutcomeReceipt {
  readonly schema: "openlifewiki.scan-system-outcome/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly outcome: "blocked" | "failed" | "unknown";
  readonly phase: ScanProgressDimension;
  readonly code: string;
  readonly persistedAt: string;
  readonly receiptHash: string;
}

export interface ActiveQmdManifestReceipt {
  readonly schema: "openlifewiki.active-qmd-manifest/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly generationId: string;
  readonly entries: readonly {
    readonly sourceId: string;
    readonly nodeId: string;
    readonly nodeVersion: string;
    readonly bodyCheckpointReceiptHash: string;
  }[];
  readonly manifestHash: string;
  readonly activePointerReceiptHash: string;
  readonly publicProbeReceiptHash: string;
  readonly previousGenerationDeletionReceiptHash: string;
  readonly publishedAt: string;
  readonly receiptHash: string;
}

export interface ScanProgressMember {
  readonly sourceId: string;
  readonly id: string;
}

export interface ScanDiscoveryNode extends ScanProgressMember {
  readonly intentId: string;
}

export interface ScanDiscoverySlot {
  readonly sourceId: string;
  readonly intentId: string;
  readonly slotId: string;
}

export interface ScanProgress {
  readonly schema: "openlifewiki.scan-progress/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceIds: readonly string[];
  readonly discovery: {
    readonly completePageNodes: readonly ScanDiscoveryNode[];
    readonly knownUnenumeratedChildSlots: readonly ScanDiscoverySlot[];
    readonly enumerationIntents: readonly ScanProgressMember[];
    readonly openIntents: readonly ScanProgressMember[];
    readonly unknownIntents: readonly ScanProgressMember[];
    readonly estimatedIntents: readonly ScanProgressMember[];
    readonly blockedIntents: readonly ScanProgressMember[];
    readonly pendingLayerIntents: readonly ScanProgressMember[];
  };
  readonly summarization: {
    readonly summarizedIntents: readonly ScanProgressMember[];
    readonly enumerationIntents: readonly ScanProgressMember[];
  };
  readonly selectedScan: {
    readonly processedLeaves: readonly ScanProgressMember[];
    readonly selectedLeaves: readonly ScanProgressMember[];
  };
  readonly committedIndex: {
    readonly committedLeaves: readonly ScanProgressMember[];
    readonly processedQmdCurrentLeaves: readonly ScanProgressMember[];
    readonly generation: string | null;
    readonly manifestHash: string | null;
    readonly activeManifestReceiptHash: string | null;
    readonly generationPublished: boolean;
    readonly publicProbesPassed: boolean;
    readonly previousGenerationDeleted: boolean;
  };
  readonly outcomes: {
    readonly skippedTargets: readonly ScanProgressMember[];
    readonly deferredTargets: readonly ScanProgressMember[];
    readonly blockedTargets: readonly ScanProgressMember[];
    readonly failedTargets: readonly ScanProgressMember[];
    readonly unknownTargets: readonly ScanProgressMember[];
    readonly askUserTargets: readonly ScanProgressMember[];
    readonly unresolvedPhases: readonly ScanProgressDimension[];
  };
  readonly current: {
    readonly path: readonly string[];
    readonly summaryHash: string;
    readonly childOutcomes: readonly {
      readonly targetNodeId: string;
      readonly outcome: ScanDecisionValue;
      readonly reason: string;
    }[];
  } | null;
  readonly denominatorChanges: readonly {
    readonly sequence: number;
    readonly at: string;
    readonly dimension: ScanProgressDimension;
    readonly from: number;
    readonly to: number;
    readonly reason: string;
  }[];
}
