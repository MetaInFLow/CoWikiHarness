import { z } from "zod";

import {
  agentScanInputContextSchema,
  type AgentIoAgent,
  type AgentScanInputContext,
  type AgentScanResult,
} from "./agent-io.js";
import type { SkeletonNode, SkeletonPage } from "./connector.js";
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
  readonly revisitCondition: string | null;
  readonly question: string | null;
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

export interface TemporaryQmdGenerationFailureReceipt {
  readonly schema: "openlifewiki.temporary-qmd-generation-failure-receipt/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly generationId: string;
  readonly phase: "build";
  readonly failedAt: string;
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

export function createTemporaryQmdGenerationFailureReceipt(input: {
  readonly plan: ScanPlan;
  readonly generationId: string;
  readonly phase: "build";
  readonly failedAt: string;
}): TemporaryQmdGenerationFailureReceipt {
  assertScanPlan(input.plan);
  const draft = z.strictObject({
    generationId: scanIdentifier,
    phase: z.literal("build"),
    failedAt: z.iso.datetime({ offset: true }),
  }).parse({
    generationId: input.generationId,
    phase: input.phase,
    failedAt: input.failedAt,
  });
  const payload = {
    schema: "openlifewiki.temporary-qmd-generation-failure-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    ...draft,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function createTemporaryQmdGenerationDeletionReceipt(input: {
  readonly plan: ScanPlan;
  readonly failureReceipt: TemporaryQmdGenerationFailureReceipt;
  readonly trustedReceiptHashes: readonly string[];
  readonly deletedAt: string;
}): TemporaryQmdGenerationDeletionReceipt {
  assertScanPlan(input.plan);
  const failure = input.failureReceipt;
  assertReceiptHash(
    failure as unknown as Readonly<Record<string, unknown>>,
    "Temporary QMD generation failure",
  );
  if (!input.trustedReceiptHashes.includes(failure.receiptHash)) {
    throw new Error("Temporary QMD generation failure is outside the trusted receipt ledger");
  }
  if (failure.schema !== "openlifewiki.temporary-qmd-generation-failure-receipt/v1"
    || failure.phase !== "build"
    || failure.scanId !== input.plan.scanId
    || failure.scanPlanHash !== input.plan.scanPlanHash
    || failure.skeletonVersion !== input.plan.skeletonVersion) {
    throw new Error("Temporary QMD generation failure does not bind the active plan");
  }
  const deletedAt = z.iso.datetime({ offset: true }).parse(input.deletedAt);
  const payload = {
    schema: "openlifewiki.temporary-qmd-generation-deletion-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    generationId: failure.generationId,
    failureReceiptHash: failure.receiptHash,
    deletedAt,
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

const skeletonEstimateSchema = z.strictObject({
  value: z.number().int().nonnegative().nullable().optional(),
  bytes: z.number().int().nonnegative().nullable().optional(),
  kind: z.enum(["known", "estimated", "unknown"]),
}).superRefine((value, context) => {
  const estimate = value.value ?? value.bytes;
  if (("value" in value) === ("bytes" in value)) {
    context.addIssue({ code: "custom", message: "Skeleton estimate requires exactly one value field" });
  }
  if (value.kind === "known" && estimate === null) {
    context.addIssue({ code: "custom", message: "Known Skeleton estimate requires a value" });
  }
});
const skeletonNodeSchema = z.strictObject({
  schema: z.literal("openlifewiki.skeleton-node/v1"),
  sourceId: scanIdentifier,
  nodeId: scanIdentifier,
  parentId: scanIdentifier.nullable(),
  kind: scanBoundedText,
  title: scanBoundedText,
  locator: z.string().min(1).max(4_096).refine((value) => {
    try {
      const url = new URL(value);
      return url.username.length === 0 && url.password.length === 0;
    } catch {
      return false;
    }
  }, "Skeleton locator is invalid or contains credentials"),
  childCount: skeletonEstimateSchema,
  modifiedRange: z.strictObject({ from: scanBoundedText, to: scanBoundedText }).nullable(),
  permission: z.enum(["readable", "approval-required", "denied", "unknown"]),
  scanability: z.enum(["metadata-only", "metadata-and-body"]),
  page: z.strictObject({ cursor: z.string().max(8_192).nullable(), hasMore: z.boolean() }),
  sizeEstimate: skeletonEstimateSchema,
  nodeVersion: scanBoundedText,
});
const skeletonPageSchema = z.strictObject({
  schema: z.literal("openlifewiki.skeleton-page/v1"),
  sourceId: scanIdentifier,
  parentNodeId: scanIdentifier,
  requestScopeHash: scanHash,
  nodes: z.array(skeletonNodeSchema),
  nextCursor: z.string().min(1).max(8_192).nullable(),
  pageComplete: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }),
  skeletonVersion: scanHash,
});

export function assertSkeletonNode(input: unknown): asserts input is SkeletonNode {
  skeletonNodeSchema.parse(input);
}

export function assertSkeletonPage(input: unknown): asserts input is SkeletonPage {
  skeletonPageSchema.parse(input);
}

export function buildSkeletonTrustedChildren(nodes: readonly SkeletonNode[]): AgentScanInputContext["completeChildren"] {
  return nodes.map((node) => {
    assertSkeletonNode(node);
    if (node.parentId === null) throw new Error("Layer child requires a parent");
    return {
      target: {
        nodeId: node.nodeId,
        parentId: node.parentId,
        nodeVersion: node.nodeVersion,
        kind: node.scanability === "metadata-and-body" ? "leaf" as const : "container" as const,
      },
      metadataHash: sha256Canonical(node),
    };
  });
}

export interface CreateEnumerationPageReceiptInput {
  readonly plan: ScanPlan;
  readonly intent: EnumerationIntent;
  readonly trustedDecisionReceipts: readonly ScanDecision[];
  readonly parent: SkeletonNode;
  readonly page: SkeletonPage;
  readonly expectedScopeHash: string;
  readonly priorNodes: readonly SkeletonNode[];
  readonly previousPageReceipt: EnumerationPageReceipt | null;
  readonly eventSequence: number;
}

export function createEnumerationPageReceipt(input: CreateEnumerationPageReceiptInput): EnumerationPageReceipt {
  assertScanPlan(input.plan);
  assertEnumerationIntent(input.intent, {
    plan: input.plan,
    trustedDecisionReceipts: input.trustedDecisionReceipts,
  });
  const parent = skeletonNodeSchema.parse(input.parent) as SkeletonNode;
  const page = skeletonPageSchema.parse(input.page) as SkeletonPage;
  const priorNodes = input.priorNodes.map((node) => skeletonNodeSchema.parse(node) as SkeletonNode);
  const previous = input.previousPageReceipt;
  const sourceIndex = input.plan.sourceIds.indexOf(input.intent.sourceId);
  if (sourceIndex < 0
    || input.intent.scanId !== input.plan.scanId
    || input.intent.scanPlanHash !== input.plan.scanPlanHash
    || input.intent.skeletonVersion !== input.plan.skeletonVersion
    || input.intent.authorizationHash !== input.plan.authorizationHashes[sourceIndex]
    || input.intent.targetNodeId !== parent.nodeId
    || input.intent.targetNodeVersion !== parent.nodeVersion
    || parent.sourceId !== input.intent.sourceId
    || page.sourceId !== input.intent.sourceId
    || page.parentNodeId !== parent.nodeId
    || page.skeletonVersion !== input.plan.skeletonVersion
    || page.requestScopeHash !== input.expectedScopeHash) {
    throw new Error("Enumeration page source, parent, scope or plan binding is invalid");
  }
  if (!scanHash.safeParse(input.expectedScopeHash).success) throw new Error("Enumeration page scope hash is invalid");
  if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 1) {
    throw new Error("Enumeration page eventSequence is invalid");
  }
  if (page.pageComplete !== (page.nextCursor === null)) {
    throw new Error("Enumeration page completion and cursor are inconsistent");
  }
  const expectedCursor = previous?.nextCursor ?? null;
  if (previous !== null) {
    assertReceiptHash(previous as unknown as Readonly<Record<string, unknown>>, "Previous enumeration page");
    if (previous.scanId !== input.plan.scanId
      || previous.schema !== "openlifewiki.enumeration-page-receipt/v1"
      || previous.scanPlanHash !== input.plan.scanPlanHash
      || previous.skeletonVersion !== input.plan.skeletonVersion
      || previous.sourceId !== input.intent.sourceId
      || previous.intentId !== input.intent.intentId
      || previous.state !== "open"
      || previous.nextCursor === null
      || previous.eventSequence >= input.eventSequence) {
      throw new Error("Enumeration page previous receipt chain is invalid");
    }
  }
  const allNodes = [...priorNodes, ...page.nodes];
  const nodeIds = new Set<string>();
  for (const node of allNodes) {
    if (node.sourceId !== input.intent.sourceId || node.parentId !== parent.nodeId) {
      throw new Error("Enumeration page node is outside the exact direct-child layer");
    }
    if (nodeIds.has(node.nodeId)) throw new Error("Enumeration page contains a duplicate logical node");
    nodeIds.add(node.nodeId);
  }
  if (page.nodes.some((node) => node.page.cursor !== expectedCursor
    || node.page.hasMore !== (page.nextCursor !== null))) {
    throw new Error("Enumeration page node cursor binding is invalid");
  }
  if (previous !== null
    && previous.discoveredNodeIds.some((nodeId) => !priorNodes.some((node) => node.nodeId === nodeId))) {
    throw new Error("Enumeration page prior node chain is incomplete");
  }
  const declaredCount = parent.childCount.kind === "known" ? parent.childCount.value : null;
  if (declaredCount !== null && (allNodes.length > declaredCount || page.pageComplete && allNodes.length !== declaredCount)) {
    throw new Error("Enumeration page child count drifted across pages");
  }
  const unenumerated = page.pageComplete || declaredCount === null ? 0 : declaredCount - allNodes.length;
  const knownUnenumeratedSlotIds = Array.from({ length: unenumerated }, (_, offset) => sha256Canonical({
    scanId: input.plan.scanId,
    sourceId: input.intent.sourceId,
    intentId: input.intent.intentId,
    ordinal: allNodes.length + offset,
  }));
  const payload = {
    schema: "openlifewiki.enumeration-page-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    sourceId: input.intent.sourceId,
    intentId: input.intent.intentId,
    pageSequence: previous === null ? 1 : previous.pageSequence + 1,
    eventSequence: input.eventSequence,
    previousPageReceiptHash: previous?.receiptHash ?? null,
    discoveredNodeIds: page.nodes.map(({ nodeId }) => nodeId),
    knownUnenumeratedSlotIds,
    nextCursor: page.nextCursor,
    childCountKind: page.pageComplete ? "known" as const : parent.childCount.kind,
    state: page.pageComplete ? "complete" as const : "open" as const,
    childSetHash: page.pageComplete ? sha256Canonical(buildSkeletonTrustedChildren(allNodes)) : null,
    observedAt: page.observedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function assertEnumerationPageReceipt(
  input: unknown,
  context: CreateEnumerationPageReceiptInput,
): asserts input is EnumerationPageReceipt {
  if (typeof input !== "object" || input === null) throw new Error("Enumeration page receipt required");
  const canonical = createEnumerationPageReceipt(context);
  if (sha256Canonical(input) !== sha256Canonical(canonical)) {
    throw new Error("Enumeration page receipt hash or binding mismatch");
  }
}

export interface CreateLayerSummaryReceiptInput {
  readonly plan: ScanPlan;
  readonly intent: EnumerationIntent;
  readonly trustedDecisionReceipts: readonly ScanDecision[];
  readonly scanInput: AgentScanInputContext;
  readonly persistedAt: string;
}

export function createLayerSummaryReceipt(input: CreateLayerSummaryReceiptInput): LayerSummaryReceipt {
  assertScanPlan(input.plan);
  assertEnumerationIntent(input.intent, {
    plan: input.plan,
    trustedDecisionReceipts: input.trustedDecisionReceipts,
  });
  const scanInput = agentScanInputContextSchema.parse(input.scanInput);
  const persistedAt = z.iso.datetime({ offset: true }).parse(input.persistedAt);
  if (input.intent.scanId !== input.plan.scanId
    || input.intent.scanPlanHash !== input.plan.scanPlanHash
    || input.intent.skeletonVersion !== input.plan.skeletonVersion
    || scanInput.scanId !== input.plan.scanId
    || scanInput.scanPlanHash !== input.plan.scanPlanHash
    || scanInput.skeletonVersion !== input.plan.skeletonVersion
    || scanInput.layer.sourceId !== input.intent.sourceId
    || scanInput.layer.parentNodeId !== input.intent.targetNodeId
    || scanInput.layer.parentNodeVersion !== input.intent.targetNodeVersion
    || !scanInput.layer.coverage.pageComplete
    || scanInput.layer.coverage.openCursor
    || scanInput.layer.coverage.unknownChildCount
    || scanInput.layer.childSetHash !== sha256Canonical(scanInput.completeChildren)) {
    throw new Error("Layer summary does not bind one completed trusted layer");
  }
  const payload = {
    schema: "openlifewiki.layer-summary-receipt/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    sourceId: input.intent.sourceId,
    intentId: input.intent.intentId,
    summaryHash: scanInput.layer.summaryHash,
    childSetHash: scanInput.layer.childSetHash,
    inputSetHash: sha256Canonical(scanInput),
    persistedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function assertLayerSummaryReceipt(
  input: unknown,
  context: CreateLayerSummaryReceiptInput,
): asserts input is LayerSummaryReceipt {
  if (typeof input !== "object" || input === null) throw new Error("Layer summary receipt required");
  const canonical = createLayerSummaryReceipt(context);
  if (sha256Canonical(input) !== sha256Canonical(canonical)) {
    throw new Error("Layer summary receipt hash or binding mismatch");
  }
}

export function createScanSystemOutcomeReceipt(input: {
  readonly plan: ScanPlan;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly outcome: ScanSystemOutcomeReceipt["outcome"];
  readonly phase: ScanProgressDimension;
  readonly code: string;
  readonly persistedAt: string;
}): ScanSystemOutcomeReceipt {
  assertScanPlan(input.plan);
  const { plan, ...candidate } = input;
  const draft = z.strictObject({
    sourceId: scanIdentifier,
    nodeId: scanIdentifier,
    outcome: z.enum(["blocked", "failed", "unknown"]),
    phase: z.enum(["discovery", "summarization", "selectedScan", "committedIndex"]),
    code: scanIdentifier,
    persistedAt: z.iso.datetime({ offset: true }),
  }).parse(candidate);
  if (!plan.sourceIds.includes(draft.sourceId)) throw new Error("System outcome Source is outside the ScanPlan");
  const payload = {
    schema: "openlifewiki.scan-system-outcome/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    ...draft,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function assertScanSystemOutcomeReceipt(
  input: unknown,
  context: { readonly plan: ScanPlan },
): asserts input is ScanSystemOutcomeReceipt {
  if (typeof input !== "object" || input === null) throw new Error("System outcome receipt required");
  const candidate = input as ScanSystemOutcomeReceipt;
  const canonical = createScanSystemOutcomeReceipt({
    plan: context.plan,
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    outcome: candidate.outcome,
    phase: candidate.phase,
    code: candidate.code,
    persistedAt: candidate.persistedAt,
  });
  if (sha256Canonical(input) !== sha256Canonical(canonical)) throw new Error("System outcome receipt hash or binding mismatch");
}

export function createLeafSelectionReceipt(input: {
  readonly plan: ScanPlan;
  readonly trustedDecisionReceiptHashes: readonly string[];
  readonly decisionReceipt: ScanDecision;
  readonly actor: string;
  readonly reason: string;
  readonly persistedAt: string;
}): LeafSelectionReceipt {
  assertScanPlan(input.plan);
  const decision = input.decisionReceipt;
  assertScanDecisionIntegrity(decision);
  if (!input.trustedDecisionReceiptHashes.includes(decision.receiptHash)) {
    throw new Error("Leaf decision is outside the trusted receipt ledger");
  }
  const sourceIndex = input.plan.sourceIds.indexOf(decision.sourceId);
  if (sourceIndex < 0
    || decision.scanId !== input.plan.scanId
    || decision.scanPlanHash !== input.plan.scanPlanHash
    || decision.skeletonVersion !== input.plan.skeletonVersion
    || decision.authorizationHash !== input.plan.authorizationHashes[sourceIndex]
    || decision.decision !== "descend"
    || decision.targetKind !== "leaf") {
    throw new Error("Leaf selection requires an exact trusted leaf descend decision");
  }
  const fields = z.strictObject({
    actor: scanIdentifier,
    reason: scanBoundedText,
    persistedAt: z.iso.datetime({ offset: true }),
  }).parse({ actor: input.actor, reason: input.reason, persistedAt: input.persistedAt });
  const payload = {
    schema: "openlifewiki.leaf-selection/v1" as const,
    scanId: input.plan.scanId,
    sourceId: decision.sourceId,
    nodeId: decision.nodeId,
    nodeVersion: decision.nodeVersion,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    authorizationHash: decision.authorizationHash,
    inputSetHash: decision.inputSetHash,
    decisionReceiptHash: decision.receiptHash,
    ...fields,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function assertLeafSelectionReceipt(input: unknown, context: {
  readonly plan: ScanPlan;
  readonly trustedDecisionReceipts: readonly ScanDecision[];
}): asserts input is LeafSelectionReceipt {
  if (typeof input !== "object" || input === null) throw new Error("Leaf selection receipt required");
  const candidate = input as LeafSelectionReceipt;
  const decision = context.trustedDecisionReceipts.find(({ receiptHash }) => receiptHash === candidate.decisionReceiptHash);
  if (decision === undefined) throw new Error("Leaf selection decision is not trusted");
  const canonical = createLeafSelectionReceipt({
    plan: context.plan,
    trustedDecisionReceiptHashes: context.trustedDecisionReceipts.map(({ receiptHash }) => receiptHash),
    decisionReceipt: decision,
    actor: candidate.actor,
    reason: candidate.reason,
    persistedAt: candidate.persistedAt,
  });
  if (sha256Canonical(input) !== sha256Canonical(canonical)) throw new Error("Leaf selection receipt hash or binding mismatch");
}

export type ScanCheckpointDraft = Omit<
  ScanCheckpoint,
  "schema" | "scanId" | "scanPlanHash" | "skeletonVersion" | "receiptHash"
>;

export function createScanCheckpoint(input: ScanCheckpointDraft & { readonly plan: ScanPlan }): ScanCheckpoint {
  assertScanPlan(input.plan);
  const { plan, ...candidate } = input;
  const draft = z.strictObject({
    sourceId: scanIdentifier,
    authorizationHash: scanHash,
    nodeId: scanIdentifier,
    nodeVersion: scanBoundedText,
    phase: z.enum(["discovered", "summarized", "decided", "body-processed", "qmd-committed"]),
    indexingDisposition: indexingDispositionSchema,
    inputSetHash: scanHash,
    selectionReceiptHash: scanHash.optional(),
    bodyObservationReceiptHash: scanHash.optional(),
    qmdGenerationId: scanIdentifier.optional(),
  }).parse(candidate);
  const sourceIndex = plan.sourceIds.indexOf(draft.sourceId);
  if (sourceIndex < 0 || draft.authorizationHash !== plan.authorizationHashes[sourceIndex]) {
    throw new Error("Scan checkpoint Source authorization is outside the ScanPlan");
  }
  const hasSelection = draft.selectionReceiptHash !== undefined;
  const hasBody = draft.bodyObservationReceiptHash !== undefined;
  if (hasSelection !== hasBody
    || (["discovered", "summarized", "decided"].includes(draft.phase)
      && (hasSelection || draft.qmdGenerationId !== undefined))
    || draft.phase === "body-processed" && (!hasSelection || draft.qmdGenerationId !== undefined)
    || draft.phase === "qmd-committed" && draft.qmdGenerationId === undefined) {
    throw new Error("Scan checkpoint phase fields are invalid");
  }
  const payload = {
    schema: "openlifewiki.scan-checkpoint/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    sourceId: draft.sourceId,
    authorizationHash: draft.authorizationHash,
    nodeId: draft.nodeId,
    nodeVersion: draft.nodeVersion,
    phase: draft.phase,
    indexingDisposition: draft.indexingDisposition,
    inputSetHash: draft.inputSetHash,
    ...(draft.selectionReceiptHash === undefined ? {} : { selectionReceiptHash: draft.selectionReceiptHash }),
    ...(draft.bodyObservationReceiptHash === undefined ? {} : { bodyObservationReceiptHash: draft.bodyObservationReceiptHash }),
    ...(draft.qmdGenerationId === undefined ? {} : { qmdGenerationId: draft.qmdGenerationId }),
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

export function assertScanCheckpoint(
  input: unknown,
  context: { readonly plan: ScanPlan },
): asserts input is ScanCheckpoint {
  if (typeof input !== "object" || input === null) throw new Error("Scan checkpoint required");
  const candidate = input as ScanCheckpoint;
  const canonical = createScanCheckpoint({
    plan: context.plan,
    sourceId: candidate.sourceId,
    authorizationHash: candidate.authorizationHash,
    nodeId: candidate.nodeId,
    nodeVersion: candidate.nodeVersion,
    phase: candidate.phase,
    indexingDisposition: candidate.indexingDisposition,
    inputSetHash: candidate.inputSetHash,
    ...(candidate.selectionReceiptHash === undefined ? {} : { selectionReceiptHash: candidate.selectionReceiptHash }),
    ...(candidate.bodyObservationReceiptHash === undefined ? {} : { bodyObservationReceiptHash: candidate.bodyObservationReceiptHash }),
    ...(candidate.qmdGenerationId === undefined ? {} : { qmdGenerationId: candidate.qmdGenerationId }),
  });
  if (sha256Canonical(input) !== sha256Canonical(canonical)) throw new Error("Scan checkpoint hash or binding mismatch");
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
