import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  assertBodyObservationReceipt,
  assertAgentScanInputContext,
  assertEnumerationPageReceipt,
  createBodyObservationReceipt,
  createEnumerationIntent,
  createEnumerationPageReceipt,
  createLayerSummaryReceipt,
  createLeafSelectionReceipt,
  createPolicyResolutionHash,
  assertEnumerationIntent,
  assertSkeletonNode,
  assertSkeletonPage,
  assertScanPlan,
  buildSkeletonTrustedChildren,
  sha256Canonical,
  type AgentScanInputContext,
  type AgentScanInvocationReceipt,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type BodyObservationReceipt,
  type ConnectorStatus,
  type EnumerationPageReceipt,
  type EnumerationIntent,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
  type RuntimeLayout,
  type ScanSystemOutcomeReceipt,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";
import {
  appendLayerOutcomeBatch,
  CONNECTOR_DESCRIPTORS,
  createPhysicalIoAccounting,
  createScanLedger,
  createScanState,
  resolveAgentScanPolicy,
  resolveScanPolicy,
  recordPhysicalIo,
  transitionScanState,
  type PhysicalIoAccounting,
  type ScanLedger,
  type ScanState,
  type ScanStateEvent,
  type ScanWorkPhase,
} from "@openlifewiki/core";

import {
  createBodyBudgetReservationReceipt,
  issueActiveBodyReadLease,
  progressiveConnectorScopeHash,
  revokeActiveBodyReadLease,
  type ActiveBodyReadLease,
  type ApprovedLeafBody,
  type BodyBudgetReservationReceipt,
} from "./connectors/connector-provider.js";
import { AdapterError } from "./errors.js";
import { currentOwnerIdentityFingerprint, readConfigSnapshot } from "./config-store.js";
import { authorizePriorityDocumentReference } from "./priority-reference.js";
import { bindHostScanPolicy, loadWikiScanPolicy } from "./scan-policy-loader.js";
import type { AgentLayerSummary } from "./agents/agent-driver.js";
import { assertSafeConnectorIdentityValues, CODEX_PUBLIC_ACCOUNT } from "./connectors/connector-identity.js";
import {
  clearScanScratch,
  cleanupOrphanScanScratch,
  readScanLayerSummary,
  writeScanLayerSummary,
} from "./scan-scratch.js";
import { writeJsonAtomic } from "./state-store.js";

const SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const B2_RECEIPT_KEYS = new Map<string, readonly string[]>([
  ["openlifewiki.enumeration-intent/v1", [
    "authorizationHash", "childSetHash", "createdAt", "decisionReceiptHash", "inputSetHash",
    "intentId", "origin", "parentLayerNodeId", "receiptHash", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId", "targetNodeId", "targetNodeVersion",
  ]],
  ["openlifewiki.enumeration-page-receipt/v1", [
    "childCountKind", "childSetHash", "discoveredMetadataHash", "discoveredNodeIds",
    "eventSequence", "intentId", "knownUnenumeratedSlotIds", "nextCursor", "observedAt",
    "pageSequence", "previousPageReceiptHash", "receiptHash", "requestScopeHash", "scanId", "scanPlanHash",
    "schema", "skeletonVersion", "sourceId", "state",
  ]],
  ["openlifewiki.layer-summary-receipt/v1", [
    "childSetHash", "inputSetHash", "intentId", "persistedAt", "receiptHash", "scanId",
    "scanPlanHash", "schema", "skeletonVersion", "sourceId", "summaryHash",
  ]],
  ["openlifewiki.agent-scan-invocation-receipt/v1", [
    "agent", "inputSetHash", "invokedAt", "layerHash", "operationId", "outputSchemaHash",
    "outputSchemaId", "receiptHash", "resultHash", "runtimeVersion", "scanId", "scanPlanHash",
    "schema", "skeletonVersion", "skillHash", "sourceId",
  ]],
  ["openlifewiki.agent-attempt-reservation/v1", [
    "attemptNumber", "inputSetHash", "operationId", "receiptHash", "reservedAt", "scanId",
    "scanPlanHash", "schema", "selectedAgentConfigHash", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.scan-plan-owner-approval/v1", [
    "approvalHash", "approvedAt", "approvedBy", "hostConfigRevision", "ownerIdentityFingerprint",
    "previewHash", "receiptHash", "scanId", "scanPlanHash", "schema", "skeletonVersion",
  ]],
  ["openlifewiki.scan-decision/v1", [
    "actor", "authorizationHash", "childSetHash", "decision", "estimatedCost", "inputSetHash",
    "nodeId", "nodeVersion", "parentNodeId", "parentNodeVersion", "persistedAt", "question",
    "reason", "receiptHash", "revisitCondition", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId", "summaryHash", "targetKind",
  ]],
  ["openlifewiki.scan-system-outcome/v1", [
    "code", "nodeId", "outcome", "persistedAt", "phase", "receiptHash", "scanId",
    "scanPlanHash", "schema", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-budget-reservation/v1", [
    "authorizationHash", "nodeId", "nodeVersion", "physicalIoAccountingHash", "receiptHash",
    "remainingBeforeBytes", "reservedAt", "reservedBytes", "scanId", "scanPlanHash", "schema",
    "scanTransitionSequence", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.leaf-selection/v1", [
    "actor", "authorizationHash", "decisionReceiptHash", "inputSetHash", "nodeId", "nodeVersion",
    "persistedAt", "reason", "receiptHash", "scanId", "scanPlanHash", "schema",
    "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-observation-receipt/v1", [
    "authorizationHash", "bytes", "contentHash", "inputSetHash", "nodeId", "nodeVersion",
    "observedAt", "previousObservationReceiptHash", "purpose", "receiptHash",
    "rematerializationAuthorizationHash", "scanId", "scanPlanHash", "schema",
    "selectionReceiptHash", "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-read-commit/v1", [
    "committedAt", "nodeId", "nodeVersion", "observationReceiptHash", "receiptHash",
    "reservationReceiptHash", "scanId", "scanPlanHash", "scanTransitionSequence", "schema",
    "skeletonVersion", "sourceId",
  ]],
  ["openlifewiki.body-read-epoch-boundary/v1", [
    "event", "fromTransitionSequence", "persistedAt", "receiptHash", "scanId", "scanPlanHash",
    "schema", "skeletonVersion", "toTransitionSequence",
  ]],
]);
const SNAPSHOT_KEYS = [
  "connectorStatuses",
  "ledger",
  "pendingLayer",
  "physicalIo",
  "plan",
  "receipts",
  "revision",
  "schema",
  "skeleton",
  "snapshotHash",
  "sourceBindings",
  "scratchCleanupRequired",
  "state",
] as const;

export type ScanStoreReceipt = Readonly<object>;

export interface ScanStoreSnapshot {
  readonly schema: "openlifewiki.scan-store-snapshot/v1";
  readonly revision: number;
  readonly plan: ScanPlan;
  readonly state: ScanState;
  readonly sourceBindings: readonly AuthorizedSourceV1[];
  readonly connectorStatuses: readonly ConnectorStatus[];
  readonly scratchCleanupRequired: boolean;
  readonly skeleton: ScanSkeletonStore;
  readonly pendingLayer: PendingScanLayer | null;
  readonly ledger: ScanLedger;
  readonly receipts: readonly ScanStoreReceipt[];
  readonly physicalIo: PhysicalIoAccounting;
  readonly snapshotHash: string;
}

export interface ScanSkeletonNodeRecord {
  readonly schema: "openlifewiki.scan-skeleton-node/v1";
  readonly intentId: string;
  readonly pageReceiptHash: string | null;
  readonly expectedScopeHash: string;
  readonly node: SkeletonNode;
  readonly recordHash: string;
}

export interface ScanSkeletonPageRecord {
  readonly schema: "openlifewiki.scan-skeleton-page/v1";
  readonly intentId: string;
  readonly expectedScopeHash: string;
  readonly receiptHash: string;
  readonly recordHash: string;
}

export interface ScanSkeletonStore {
  readonly schema: "openlifewiki.scan-skeleton/v1";
  readonly nodes: readonly ScanSkeletonNodeRecord[];
  readonly pages: readonly ScanSkeletonPageRecord[];
}

export interface PendingScanLayer {
  readonly schema: "openlifewiki.pending-scan-layer/v1";
  readonly intentId: string;
  readonly scanInput: AgentScanInputContext;
  readonly scanInputHash: string;
  readonly summaryReceipt: LayerSummaryReceipt;
  readonly recordHash: string;
}

export interface AgentAttemptReservationReceipt {
  readonly schema: "openlifewiki.agent-attempt-reservation/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly operationId: string;
  readonly inputSetHash: string;
  readonly selectedAgentConfigHash: string;
  readonly attemptNumber: number;
  readonly reservedAt: string;
  readonly receiptHash: string;
}

export interface ScanPlanOwnerApprovalReceipt {
  readonly schema: "openlifewiki.scan-plan-owner-approval/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly hostConfigRevision: number;
  readonly approvedBy: "human:owner";
  readonly ownerIdentityFingerprint: string;
  readonly previewHash: string;
  readonly approvedAt: string;
  readonly approvalHash: string;
  readonly receiptHash: string;
}

export interface ScanPlanApprovalPreview {
  readonly schema: "openlifewiki.scan-plan-approval-preview/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly hostConfigRevision: number;
  readonly selectedAgentConfigHash: string;
  readonly skillHash: string;
  readonly policyResolutionHash: string;
  readonly sourceIds: readonly string[];
  readonly authorizationHashes: readonly string[];
  readonly rootNodeIds: readonly string[];
  readonly previewHash: string;
}

export function previewScanPlanApproval(plan: ScanPlan): ScanPlanApprovalPreview {
  assertScanPlan(plan);
  const payload = {
    schema: "openlifewiki.scan-plan-approval-preview/v1" as const,
    scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion,
    hostConfigRevision: plan.hostConfigRevision,
    selectedAgentConfigHash: plan.selectedAgentConfigHash,
    skillHash: plan.skillHash,
    policyResolutionHash: plan.policyResolutionHash,
    sourceIds: [...plan.sourceIds],
    authorizationHashes: [...plan.authorizationHashes],
    rootNodeIds: [...plan.rootNodeIds],
  };
  return { ...payload, previewHash: sha256Canonical(payload) };
}

export function createScanPlanOwnerApproval(input: {
  readonly plan: ScanPlan;
  readonly preview: ScanPlanApprovalPreview;
  readonly approvedBy: "human:owner";
  readonly ownerIdentityFingerprint: string;
  readonly approvedAt: string;
}): ScanPlanOwnerApprovalReceipt {
  assertScanPlan(input.plan);
  const expectedPreview = previewScanPlanApproval(input.plan);
  if (sha256Canonical(input.preview) !== sha256Canonical(expectedPreview)) {
    throw new Error("ScanPlan approval preview changed");
  }
  const approvalPayload = {
    schema: "openlifewiki.scan-plan-owner-approval/v1" as const,
    scanId: input.plan.scanId,
    scanPlanHash: input.plan.scanPlanHash,
    skeletonVersion: input.plan.skeletonVersion,
    hostConfigRevision: input.plan.hostConfigRevision,
    approvedBy: input.approvedBy,
    ownerIdentityFingerprint: input.ownerIdentityFingerprint,
    previewHash: input.preview.previewHash,
    approvedAt: input.approvedAt,
  };
  const payload = { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

interface BodyReadCommitReceipt {
  readonly schema: "openlifewiki.body-read-commit/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly reservationReceiptHash: string;
  readonly observationReceiptHash: string;
  readonly scanTransitionSequence: number;
  readonly committedAt: string;
  readonly receiptHash: string;
}

interface BodyReadEpochBoundaryReceipt {
  readonly schema: "openlifewiki.body-read-epoch-boundary/v1";
  readonly scanId: string;
  readonly scanPlanHash: string;
  readonly skeletonVersion: string;
  readonly event: ScanControlEvent["type"];
  readonly fromTransitionSequence: number;
  readonly toTransitionSequence: number;
  readonly persistedAt: string;
  readonly receiptHash: string;
}

type ScanStoreUpdate = ScanStoreSnapshot;

export function scanStoreStatePath(dataDir: string, scanId: string): string {
  assertScanId(scanId);
  return join(dataDir, "scans", scanId, "state.json");
}

export async function createScanStore(options: {
  readonly dataDir: string;
  readonly plan: ScanPlan;
}): Promise<ScanStoreSnapshot> {
  assertScanPlan(options.plan);
  const path = scanStoreStatePath(options.dataDir, options.plan.scanId);
  return await withScanLock(path, async () => {
    if (await fileExists(path)) throw conflict("Scan state already exists");
    const snapshot = createSnapshot({
      revision: 0,
      plan: options.plan,
      state: createScanState(options.plan.scanId),
      sourceBindings: [],
      connectorStatuses: [],
      scratchCleanupRequired: false,
      skeleton: { schema: "openlifewiki.scan-skeleton/v1", nodes: [], pages: [] },
      pendingLayer: null,
      ledger: createScanLedger(options.plan),
      receipts: [],
      physicalIo: createPhysicalIoAccounting(),
    });
    await persist(path, snapshot);
    return snapshot;
  });
}

export async function readScanStore(options: {
  readonly dataDir: string;
  readonly scanId: string;
}): Promise<ScanStoreSnapshot | undefined> {
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalid("Scan state is not valid JSON", error);
  }
  try {
    const snapshot = assertSnapshot(value);
    if (snapshot.plan.scanId !== options.scanId) throw new Error("scanId path binding mismatch");
    return freeze(structuredClone(snapshot));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw invalid("Scan state failed integrity validation", error);
  }
}

export interface ScanWorkspaceView {
  readonly revision: number;
  readonly state: ScanState;
  readonly connectorStatuses: readonly ConnectorStatus[];
  readonly nodes: readonly SkeletonNode[];
  readonly pages: readonly EnumerationPageReceipt[];
  readonly intents: readonly EnumerationIntent[];
  readonly summaries: readonly LayerSummaryReceipt[];
  readonly decisions: readonly ScanDecision[];
  readonly selections: readonly LeafSelectionReceipt[];
  readonly checkpoints: readonly ScanStoreReceipt[];
  readonly manifests: readonly ScanStoreReceipt[];
}

export async function readScanWorkspace(options: {
  readonly dataDir: string;
  readonly scanId: string;
}): Promise<ScanWorkspaceView | undefined> {
  await recoverScanScratchCleanup(options);
  const snapshot = await readScanStore(options);
  if (snapshot === undefined) return undefined;
  return freeze({
    revision: snapshot.revision,
    state: structuredClone(snapshot.state),
    connectorStatuses: structuredClone(snapshot.connectorStatuses),
    nodes: snapshot.skeleton.nodes.map(({ node }) => structuredClone(node)),
    pages: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.enumeration-page-receipt/v1") as EnumerationPageReceipt[]),
    intents: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[]),
    summaries: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.layer-summary-receipt/v1") as LayerSummaryReceipt[]),
    decisions: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.scan-decision/v1") as ScanDecision[]),
    selections: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[]),
    checkpoints: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.scan-checkpoint/v1")),
    manifests: structuredClone(receiptsBySchema(snapshot.receipts, "openlifewiki.active-qmd-manifest/v1")),
  });
}

export async function recoverScanScratchCleanup(options: {
  readonly dataDir: string;
  readonly scanId: string;
}): Promise<ScanStoreSnapshot | undefined> {
  const current = await readScanStore(options);
  if (current === undefined || !current.scratchCleanupRequired) return current;
  const runtimeDir = resolve(dirname(resolve(options.dataDir)), "runtime");
  return await updateScanStore({ ...options, expectedRevision: current.revision }, async (latest) => {
    if (!latest.scratchCleanupRequired) return latest;
    await cleanupOrphanScanScratch({ runtimeDir, scanId: options.scanId });
    return { ...latest, scratchCleanupRequired: false };
  });
}

export async function approveScanPlan(options: {
  readonly dataDir: string;
  readonly layout: RuntimeLayout;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly approval: ScanPlanOwnerApprovalReceipt;
}): Promise<ScanStoreSnapshot> {
  if (resolve(options.dataDir) !== resolve(options.layout.dataDir)) {
    throw invalid("ScanPlan approval layout does not match its data directory");
  }
  return await updateScanStore(options, async (current) => {
    await assertCanonicalScanPlanPolicy(current.plan, options.layout);
    assertScanPlanOwnerApproval(options.approval, current.plan);
    return {
      ...current,
      state: transitionScanState(current.state, { type: "approve-plan" }),
      receipts: [...current.receipts, options.approval],
    };
  });
}

function assertScanPlanOwnerApproval(
  approval: ScanPlanOwnerApprovalReceipt,
  plan: ScanPlan,
): void {
  const { receiptHash, ...payload } = approval;
  const { approvalHash, ...approvalPayload } = payload;
  const preview = previewScanPlanApproval(plan);
  if (sha256Canonical(payload) !== receiptHash
    || sha256Canonical(approvalPayload) !== approvalHash
    || approval.schema !== "openlifewiki.scan-plan-owner-approval/v1"
    || approval.scanId !== plan.scanId
    || approval.scanPlanHash !== plan.scanPlanHash
    || approval.skeletonVersion !== plan.skeletonVersion
    || approval.hostConfigRevision !== plan.hostConfigRevision
    || approval.approvedBy !== "human:owner"
    || approval.ownerIdentityFingerprint !== currentOwnerIdentityFingerprint()
    || approval.previewHash !== preview.previewHash
    || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new Error("ScanPlan Owner approval does not bind the exact current Plan and Owner");
  }
}

const DEFAULT_PROGRESSIVE_SCAN_SKILL = new URL(
  "../../../skills/openlifewiki-progressive-scan/SKILL.md",
  import.meta.url,
);

async function assertCanonicalScanPlanPolicy(
  plan: ScanPlan,
  layout: RuntimeLayout,
): Promise<void> {
  const snapshot = await readConfigSnapshot(layout.configFile);
  if (snapshot === undefined || snapshot.config.schema !== "openlifewiki.config/v2") {
    throw new Error("ScanPlan approval requires canonical config/v2");
  }
  const config = snapshot.config;
  if (config.revision !== plan.hostConfigRevision || config.hostConfig === null
    || config.hostConfig.selectedAgentId !== plan.agentProfileId) {
    throw new Error("ScanPlan Host config revision or selected Agent changed");
  }
  const selectedAgents = config.hostConfig.agents.filter(({ id }) => id === plan.agentProfileId);
  if (selectedAgents.length !== 1 || sha256Canonical(selectedAgents[0]) !== plan.selectedAgentConfigHash) {
    throw new Error("ScanPlan selected Agent config hash changed");
  }
  for (let index = 0; index < plan.sourceIds.length; index += 1) {
    const source = config.sources.find(({ sourceId }) => sourceId === plan.sourceIds[index]);
    if (source === undefined || source.authorizationHash !== plan.authorizationHashes[index]
      || source.rootNodeId !== plan.rootNodeIds[index]) {
      throw new Error("ScanPlan Source authorization changed");
    }
  }
  const host = bindHostScanPolicy(config.scanPolicy);
  const wiki = await loadWikiScanPolicy({ wikiDir: layout.wikiDir });
  if (sha256Canonical(host.binding) !== sha256Canonical(plan.policyBindings.host)
    || sha256Canonical(wiki.binding) !== sha256Canonical(plan.policyBindings.wiki)) {
    throw new Error("ScanPlan Host or WIKI.md policy binding changed");
  }
  const resolvedPolicy = resolveScanPolicy({
    ownerPolicy: plan.ownerPolicy,
    hostPolicy: host.policy,
    wikiPolicy: wiki.policy,
  });
  if (sha256Canonical(resolvedPolicy) !== sha256Canonical(plan.policy)) {
    throw new Error("ScanPlan resolved policy changed");
  }
  const expectedResolutionHash = createPolicyResolutionHash({
    ownerPolicy: plan.ownerPolicy,
    policyBindings: plan.policyBindings,
    priorityDocumentRefs: plan.priorityDocumentRefs,
    policy: resolvedPolicy,
  });
  if (expectedResolutionHash !== plan.policyResolutionHash) {
    throw new Error("ScanPlan policy resolution hash changed");
  }
  for (const reference of plan.priorityDocumentRefs) {
    const source = config.sources.find(({ sourceId }) => sourceId === reference.sourceId);
    if (source === undefined || sha256Canonical(authorizePriorityDocumentReference({
      source,
      locator: reference.normalizedLocator,
    })) !== sha256Canonical(reference)) {
      throw new Error("ScanPlan priority document reference is outside current authorization");
    }
  }
  const skill = await readFile(DEFAULT_PROGRESSIVE_SCAN_SKILL, "utf8");
  if (sha256Canonical(skill) !== plan.skillHash) {
    throw new Error("ScanPlan canonical Skill changed");
  }
}

export async function recordScanProbeConnected(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly sources: readonly AuthorizedSourceV1[];
  readonly statuses: readonly ConnectorStatus[];
}): Promise<ScanStoreSnapshot> {
  return await updateScanStore(options, async (current) => {
    if (current.state.phase !== "Probing") throw new Error("Connected probes require Probing state");
    const configPath = resolve(dirname(resolve(options.dataDir)), "config.json");
    const config = await readConfigSnapshot(configPath);
    if (config === undefined || config.config.schema !== "openlifewiki.config/v2") {
      throw new Error("Connected probes require the authoritative Host config/v2");
    }
    const hostConfig = config.config;
    const authoritativeSources = current.plan.sourceIds.map((sourceId) => (
      hostConfig.sources.find((source) => source.sourceId === sourceId)
    ));
    if (authoritativeSources.some((source) => source === undefined)
      || options.sources.some((source, index) => (
        sha256Canonical(source) !== sha256Canonical(authoritativeSources[index])
      ))) {
      throw new Error("Connected probes differ from the authoritative Host Source configuration");
    }
    assertConnectedProbeSet(current.plan, options.sources, options.statuses);
    return {
      ...current,
      sourceBindings: structuredClone(options.sources),
      connectorStatuses: structuredClone(options.statuses),
      state: transitionScanState(current.state, { type: "probe-connected" }),
    };
  });
}

export async function recordScanSourceRoots(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly roots: readonly {
    readonly source: AuthorizedSourceV1;
    readonly page: SkeletonPage;
    readonly createdAt: string;
  }[];
}): Promise<ScanStoreSnapshot> {
  return await updateScanStore(options, (current) => {
    if (current.state.phase !== "Discovering" || current.skeleton.nodes.length > 0
      || receiptsBySchema(current.receipts, "openlifewiki.enumeration-intent/v1").length > 0) {
      throw new Error("Source roots require an empty Discovering frontier");
    }
    if (options.roots.length !== current.plan.sourceIds.length) {
      throw new Error("Source roots must exactly cover the ScanPlan");
    }
    if (options.roots.some(({ source }, index) => source.sourceId !== current.plan.sourceIds[index])) {
      throw new Error("Source roots must follow the canonical ScanPlan Source order");
    }
    if (options.roots.length > (current.plan.policy.budget.maxNodes ?? 0)
      || options.roots.some(({ source }) => source.budget.maxNodes < 1)) {
      throw new Error("SCAN_NODE_BUDGET_EXCEEDED");
    }
    const intents: EnumerationIntent[] = [];
    const nodes: ScanSkeletonNodeRecord[] = [];
    for (const item of options.roots) {
      assertAuthorizedSourceBinding(item.source, current.plan);
      assertDurableSourceBinding(current, item.source);
      assertSkeletonPage(item.page);
      if (item.page.schema !== "openlifewiki.skeleton-page/v1"
        || item.page.sourceId !== item.source.sourceId
        || item.page.parentNodeId !== item.source.rootNodeId
        || item.page.requestScopeHash !== progressiveConnectorScopeHash(item.source)
        || item.page.skeletonVersion !== current.plan.skeletonVersion
        || !item.page.pageComplete
        || item.page.nextCursor !== null
        || item.page.nodes.length !== 1) {
        throw new Error("Provider root page does not bind the exact authorized Source root");
      }
      const root = item.page.nodes[0]!;
      assertSkeletonNode(root);
      if (root.sourceId !== item.source.sourceId
        || root.nodeId !== item.source.rootNodeId
        || root.parentId !== null
        || root.page.cursor !== null
        || root.page.hasMore) {
        throw new Error("Provider root node identity, version or page binding is invalid");
      }
      const intent = createCanonicalRootIntent(current.plan, item.source, root, item.createdAt);
      intents.push(intent);
      nodes.push(createSkeletonNodeRecord({
        intentId: intent.intentId,
        pageReceiptHash: null,
        expectedScopeHash: progressiveConnectorScopeHash(item.source),
        node: root,
      }));
    }
    assertEnumerationIntentUniqueness(intents);
    return {
      ...current,
      receipts: [...current.receipts, ...intents],
      skeleton: { ...current.skeleton, nodes },
    };
  });
}

export async function recordScanEnumerationPage(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly source: AuthorizedSourceV1;
  readonly intentId: string;
  readonly requestCursor: string | null;
  readonly page: SkeletonPage;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly pageReceipt: EnumerationPageReceipt }> {
  let pageReceipt: EnumerationPageReceipt | undefined;
  const snapshot = await updateScanStore(options, (current) => {
    if (current.state.phase !== "Discovering") throw new Error("Enumeration page requires Discovering state");
    assertAuthorizedSourceBinding(options.source, current.plan);
    assertDurableSourceBinding(current, options.source);
    const intent = durableIntent(current, options.intentId);
    if (intent === undefined || intent.sourceId !== options.source.sourceId) {
      throw new Error("Enumeration page requires its durable intent");
    }
    const parentRecord = current.skeleton.nodes.find(({ node }) => (
      node.sourceId === intent.sourceId && node.nodeId === intent.targetNodeId
    ));
    if (parentRecord === undefined || parentRecord.node.nodeVersion !== intent.targetNodeVersion) {
      throw new Error("Enumeration page requires its exact durable parent version");
    }
    const parent = parentRecord.node;
    const decisions = durableDecisions(current);
    const priorPages = skeletonPageEvidence(current, intent.intentId);
    pageReceipt = createEnumerationPageReceipt({
      plan: current.plan,
      intent,
      trustedDecisionReceipts: decisions,
      parent,
      page: options.page,
      requestCursor: options.requestCursor,
      expectedScopeHash: progressiveConnectorScopeHash(options.source),
      priorPages,
      eventSequence: current.revision + 1,
    });
    const nodeRecords = options.page.nodes.map((node) => createSkeletonNodeRecord({
      intentId: intent.intentId,
      pageReceiptHash: pageReceipt!.receiptHash,
      expectedScopeHash: progressiveConnectorScopeHash(options.source),
      node,
    }));
    const currentSourceNodes = current.skeleton.nodes.filter(({ node }) => node.sourceId === options.source.sourceId).length;
    const planMaxNodes = current.plan.policy.budget.maxNodes ?? 0;
    if (currentSourceNodes + nodeRecords.length > options.source.budget.maxNodes
      || current.skeleton.nodes.length + nodeRecords.length > planMaxNodes) {
      throw new Error("SCAN_NODE_BUDGET_EXCEEDED");
    }
    const pageRecord = createSkeletonPageRecord({
      intentId: intent.intentId,
      expectedScopeHash: progressiveConnectorScopeHash(options.source),
      receiptHash: pageReceipt.receiptHash,
    });
    const state = pageReceipt.state === "complete"
      ? transitionScanState(current.state, { type: "layer-discovered" })
      : current.state;
    return {
      ...current,
      state,
      receipts: [...current.receipts, pageReceipt],
      skeleton: {
        ...current.skeleton,
        nodes: [...current.skeleton.nodes, ...nodeRecords],
        pages: [...current.skeleton.pages, pageRecord],
      },
    };
  });
  if (pageReceipt === undefined) throw invalid("Enumeration page receipt was not created");
  return { snapshot, pageReceipt };
}

export async function beginScanLayerDecision(options: {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly layout: RuntimeLayout;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly intentId: string;
  readonly scanInput: AgentScanInputContext;
  readonly summary: AgentLayerSummary;
  readonly persistedAt: string;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly summaryReceipt: LayerSummaryReceipt }> {
  assertRuntimeBinding(options.dataDir, options.runtimeDir);
  assertLayoutBinding(options.dataDir, options.runtimeDir, options.layout);
  let summaryReceipt: LayerSummaryReceipt | undefined;
  const snapshot = await updateScanStore(options, async (current) => {
    await assertCanonicalScanPlanPolicy(current.plan, options.layout);
    if (current.state.phase !== "Summarizing" && current.state.phase !== "Deciding") {
      throw new Error("Layer decision preparation requires Summarizing state");
    }
    const intent = durableIntent(current, options.intentId);
    if (intent === undefined) throw new Error("Layer decision requires its durable intent");
    const pages = pagesForIntent(current, intent.intentId);
    const completePage = pages.at(-1);
    if (completePage?.state !== "complete") throw new Error("Layer decision requires a complete page chain");
    const uncommitted = (receiptsBySchema(current.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[])
      .filter((candidate) => pagesForIntent(current, candidate.intentId).at(-1)?.state === "complete"
        && !current.ledger.entries.some((entry) => entry.intentId === candidate.intentId));
    if (uncommitted.length !== 1 || uncommitted[0]!.intentId !== intent.intentId) {
      throw new Error("Layer decision requires the unique completed uncommitted frontier intent");
    }
    const parentNode = current.skeleton.nodes.find(({ node }) => (
      node.sourceId === intent.sourceId && node.nodeId === intent.targetNodeId
    ))?.node;
    if (parentNode === undefined) throw new Error("Layer decision requires its durable parent node");
    const layerNodes = layerNodesForIntent(current, intent.intentId);
    assertCanonicalLayerPolicy(current, options.scanInput, layerNodes, true);
    summaryReceipt = createLayerSummaryReceipt({
      plan: current.plan,
      intent,
      trustedDecisionReceipts: durableDecisions(current),
      trustedReceiptHashes: receiptHashes(current.receipts),
      completePageReceipt: completePage,
      parentNode,
      layerNodes,
      summary: options.summary,
      scanInput: options.scanInput,
      persistedAt: options.persistedAt,
    });
    const pendingLayer = createPendingLayer({
      intentId: intent.intentId,
      scanInput: structuredClone(options.scanInput),
      scanInputHash: sha256Canonical(options.scanInput),
      summaryReceipt,
    });
    if (current.state.phase === "Deciding") {
      await writeScanLayerSummary({
        runtimeDir: options.runtimeDir,
        scanId: options.scanId,
        input: options.scanInput,
        summary: options.summary,
      });
      return sha256Canonical(current.pendingLayer) === sha256Canonical(pendingLayer)
        ? current
        : { ...current, pendingLayer };
    }
    await writeScanLayerSummary({
      runtimeDir: options.runtimeDir,
      scanId: options.scanId,
      input: options.scanInput,
      summary: options.summary,
    });
    return {
      ...current,
      pendingLayer,
      state: transitionScanState(current.state, { type: "layer-summarized" }),
    };
  });
  if (summaryReceipt === undefined) throw invalid("Layer summary receipt was not prepared");
  return { snapshot, summaryReceipt };
}

export type ScanControlEvent =
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly retryPhase: ScanWorkPhase; readonly code: string }
  | { readonly type: "retry" };

export async function reserveScanAgentAttempt(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly inputSetHash: string;
  readonly operationId: string;
  readonly reservedAt: string;
}): Promise<{
  readonly snapshot: ScanStoreSnapshot;
  readonly attempt: AgentAttemptReservationReceipt;
}> {
  let attempt: AgentAttemptReservationReceipt | undefined;
  const snapshot = await updateScanStore(options, (current) => {
    if (current.state.phase !== "Deciding" || current.pendingLayer === null) {
      throw new Error("Agent attempt reservation requires one pending Deciding layer");
    }
    if (current.pendingLayer.scanInputHash !== options.inputSetHash) {
      throw new Error("Agent attempt reservation input does not match the pending layer");
    }
    if (!SCAN_ID.test(options.operationId)) throw new Error("Agent attempt operationId is invalid");
    const sourceId = current.pendingLayer.scanInput.layer.sourceId;
    const source = current.sourceBindings.find((item) => item.sourceId === sourceId);
    if (source === undefined) throw new Error("Agent attempt reservation lost its durable Source");
    const attempts = receiptsBySchema(
      current.receipts,
      "openlifewiki.agent-attempt-reservation/v1",
    ) as AgentAttemptReservationReceipt[];
    const sourceAttempts = attempts.filter((item) => item.sourceId === sourceId);
    const planLimit = current.plan.policy.budget.maxAgentCalls;
    if (planLimit === undefined
      || attempts.length >= planLimit
      || sourceAttempts.length >= source.budget.maxAgentCalls) {
      throw new AdapterError("SCAN_INVALID", "Agent call budget is exhausted");
    }
    const attemptNumber = attempts.length + 1;
    if (attempts.some(({ operationId }) => operationId === options.operationId)) {
      throw new Error("Agent attempt operationId must be unique");
    }
    const payload: Omit<AgentAttemptReservationReceipt, "receiptHash"> = {
      schema: "openlifewiki.agent-attempt-reservation/v1",
      scanId: current.plan.scanId,
      scanPlanHash: current.plan.scanPlanHash,
      skeletonVersion: current.plan.skeletonVersion,
      sourceId,
      operationId: options.operationId,
      inputSetHash: options.inputSetHash,
      selectedAgentConfigHash: current.plan.selectedAgentConfigHash,
      attemptNumber,
      reservedAt: options.reservedAt,
    };
    attempt = { ...payload, receiptHash: sha256Canonical(payload) };
    return { ...current, receipts: [...current.receipts, attempt] };
  });
  if (attempt === undefined) throw invalid("Agent attempt reservation was not persisted");
  return { snapshot, attempt };
}

export async function controlScan(options: {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly event: ScanControlEvent;
}): Promise<ScanStoreSnapshot> {
  assertRuntimeBinding(options.dataDir, options.runtimeDir);
  if (!(["pause", "resume", "cancel", "fail", "retry"] as const).includes(options.event.type)) {
    throw invalid("Scan control event is not allowed by the B2 lifecycle boundary");
  }
  return await updateScanStore(options, async (current) => {
    const state = transitionScanState(current.state, options.event);
    if (["pause", "cancel", "fail"].includes(options.event.type)) {
      const reason = options.event.type === "fail"
        ? "failure"
        : options.event.type === "pause" ? "pause" : "cancel";
      await clearScanScratch({
        runtimeDir: options.runtimeDir,
        scanId: options.scanId,
        reason,
      });
    }
    const boundary = createBodyReadEpochBoundaryReceipt({
      scanId: current.plan.scanId,
      scanPlanHash: current.plan.scanPlanHash,
      skeletonVersion: current.plan.skeletonVersion,
      event: options.event.type,
      fromTransitionSequence: current.state.transitionSequence,
      toTransitionSequence: state.transitionSequence,
      persistedAt: new Date().toISOString(),
    });
    return {
      ...current,
      state,
      pendingLayer: options.event.type === "cancel" ? null : current.pendingLayer,
      receipts: [...current.receipts, boundary],
    };
  });
}

export async function commitScanLayerOutcome(options: {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly layout: RuntimeLayout;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly intent: EnumerationIntent;
  readonly scanInput: AgentScanInputContext;
  readonly agentResult: AgentScanResult;
  readonly agentInvocationReceipt: AgentScanInvocationReceipt;
  readonly agentDecisions: readonly ScanDecision[];
  readonly systemOutcomes: readonly ScanSystemOutcomeReceipt[];
  readonly committedAt: string;
}): Promise<ScanStoreSnapshot> {
  assertRuntimeBinding(options.dataDir, options.runtimeDir);
  assertLayoutBinding(options.dataDir, options.runtimeDir, options.layout);
  const snapshot = await updateScanStore(options, async (current) => {
    await assertCanonicalScanPlanPolicy(current.plan, options.layout);
    if (current.state.phase !== "Deciding") throw new Error("Layer outcome requires Deciding state");
    const durableIntent = current.receipts.find((receipt) => (
      schemaOf(receipt) === "openlifewiki.enumeration-intent/v1"
      && (receipt as EnumerationIntent).intentId === options.intent.intentId
    ));
    if (durableIntent === undefined || sha256Canonical(durableIntent) !== sha256Canonical(options.intent)) {
      throw new Error("Layer outcome requires its exact durable Enumeration Intent");
    }
    if (current.pendingLayer === null
      || current.pendingLayer.intentId !== options.intent.intentId
      || current.pendingLayer.scanInputHash !== sha256Canonical(options.scanInput)
      || sha256Canonical(current.pendingLayer.scanInput) !== sha256Canonical(options.scanInput)) {
      throw new Error("Layer outcome requires its exact durable prepared metadata");
    }
    const attempts = receiptsBySchema(
      current.receipts,
      "openlifewiki.agent-attempt-reservation/v1",
    ) as AgentAttemptReservationReceipt[];
    const currentAttempt = attempts.at(-1);
    if (currentAttempt === undefined
      || currentAttempt.sourceId !== options.scanInput.layer.sourceId
      || currentAttempt.operationId !== options.agentInvocationReceipt.operationId
      || currentAttempt.inputSetHash !== current.pendingLayer.scanInputHash
      || currentAttempt.selectedAgentConfigHash !== current.plan.selectedAgentConfigHash) {
      throw new Error("Layer outcome has no exact durable Agent attempt reservation");
    }
    const summary = current.pendingLayer.summaryReceipt;
    const scratch = await readScanLayerSummary({
      runtimeDir: options.runtimeDir,
      scanId: options.scanId,
      input: options.scanInput,
    });
    if (scratch === undefined || sha256Canonical(scratch) !== summary.summaryHash) {
      throw new Error("Layer outcome requires the exact body-free summary scratch");
    }
    const completePage = pagesForIntent(current, options.intent.intentId).at(-1);
    const parentNode = current.skeleton.nodes.find(({ node }) => (
      node.sourceId === options.intent.sourceId && node.nodeId === options.intent.targetNodeId
    ))?.node;
    if (completePage === undefined || parentNode === undefined) {
      throw new Error("Layer outcome lacks its durable frontier evidence");
    }
    const canonicalSummary = createLayerSummaryReceipt({
      plan: current.plan,
      intent: options.intent,
      trustedDecisionReceipts: durableDecisions(current),
      trustedReceiptHashes: receiptHashes(current.receipts),
      completePageReceipt: completePage,
      parentNode,
      layerNodes: layerNodesForIntent(current, options.intent.intentId),
      summary: scratch,
      scanInput: options.scanInput,
      persistedAt: summary.persistedAt,
    });
    assertCanonicalLayerPolicy(
      current,
      options.scanInput,
      layerNodesForIntent(current, options.intent.intentId),
      false,
    );
    if (sha256Canonical(canonicalSummary) !== sha256Canonical(summary)) {
      throw new Error("Layer outcome pending receipt does not replay from durable frontier evidence");
    }
    const additions: ScanStoreReceipt[] = [
      summary,
      options.agentInvocationReceipt,
      ...options.agentDecisions,
      ...options.systemOutcomes,
    ];
    const trustedReceiptHashes = [
      ...receiptHashes(current.receipts),
      ...receiptHashes(additions),
    ];
    const ledger = appendLayerOutcomeBatch({
      ledger: current.ledger,
      plan: current.plan,
      expectedHeadHash: current.ledger.headHash,
      sequence: current.ledger.entries.length + 1,
      intent: options.intent,
      scanInput: options.scanInput,
      summary,
      agentResult: options.agentResult,
      agentInvocationReceipt: options.agentInvocationReceipt,
      agentDecisions: options.agentDecisions,
      systemOutcomes: options.systemOutcomes,
      trustedReceiptHashes,
      committedAt: options.committedAt,
    });
    const derivedIntents: EnumerationIntent[] = [];
    const derivedSelections: LeafSelectionReceipt[] = [];
    for (const decision of options.agentDecisions) {
      if (decision.decision !== "descend") continue;
      if (decision.targetKind === "container") {
        derivedIntents.push(createEnumerationIntent({
          plan: current.plan,
          trustedDecisionReceiptHashes: options.agentDecisions.map(({ receiptHash }) => receiptHash),
          decisionReceipt: decision,
          intent: {
            schema: "openlifewiki.enumeration-intent/v1",
            intentId: `intent_${decision.receiptHash.slice("sha256:".length, "sha256:".length + 32)}`,
            sourceId: decision.sourceId,
            targetNodeId: decision.nodeId,
            targetNodeVersion: decision.nodeVersion,
            authorizationHash: decision.authorizationHash,
            origin: "container-descend",
            parentLayerNodeId: decision.parentNodeId,
            childSetHash: decision.childSetHash,
            inputSetHash: decision.inputSetHash,
            createdAt: options.committedAt,
          },
        }));
      } else {
        const targetEffect = options.scanInput.resolvedPolicy.targetEffects.find(({ targetNodeId }) => (
          targetNodeId === decision.nodeId
        ));
        if (targetEffect?.indexingDisposition !== "qmd-current") {
          throw new Error("INDEXING_DISPOSITION_REQUIRES_NON_DESCEND");
        }
        derivedSelections.push(createLeafSelectionReceipt({
          plan: current.plan,
          trustedDecisionReceiptHashes: options.agentDecisions.map(({ receiptHash }) => receiptHash),
          decisionReceipt: decision,
          actor: "openlifewiki",
          reason: decision.reason,
          persistedAt: options.committedAt,
        }));
      }
    }
    assertEnumerationIntentUniqueness([
      ...receiptsBySchema(current.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[],
      ...derivedIntents,
    ]);
    let scratchCleanupRequired = false;
    try {
      await clearScanScratch({
        runtimeDir: options.runtimeDir,
        scanId: options.scanId,
        reason: "decision-committed",
      });
    } catch {
      scratchCleanupRequired = true;
    }
    return {
      ...current,
      ledger,
      pendingLayer: null,
      scratchCleanupRequired,
      state: transitionScanState(current.state, { type: "continue-discovery" }),
      receipts: [...current.receipts, ...additions, ...derivedIntents, ...derivedSelections],
    };
  });
  return snapshot;
}

function assertCanonicalLayerPolicy(
  snapshot: ScanStoreSnapshot,
  scanInput: AgentScanInputContext,
  layerNodes: readonly SkeletonNode[],
  reserveCurrentAttempt: boolean,
): void {
  const source = snapshot.sourceBindings.find(({ sourceId }) => sourceId === scanInput.layer.sourceId);
  if (source === undefined) throw new Error("Layer policy requires its exact durable Authorized Source");
  const targets = scanInput.decisionTargets.map((target) => {
    const matches = layerNodes.filter(({ sourceId, nodeId, parentId, nodeVersion }) => (
      sourceId === source.sourceId
      && nodeId === target.nodeId
      && parentId === target.parentId
      && nodeVersion === target.nodeVersion
    ));
    if (matches.length !== 1) throw new Error("Layer policy target does not match one durable Skeleton node");
    return { node: matches[0]! };
  });
  const expected = resolveAgentScanPolicy({
    plan: snapshot.plan,
    source,
    remainingBudget: canonicalRemainingBudget(snapshot, source, reserveCurrentAttempt),
    targets,
  });
  if (scanInput.scanId !== snapshot.plan.scanId
    || scanInput.scanPlanHash !== snapshot.plan.scanPlanHash
    || scanInput.skeletonVersion !== snapshot.plan.skeletonVersion
    || scanInput.skillHash !== snapshot.plan.skillHash
    || scanInput.scanIntent !== snapshot.plan.scanIntent
    || sha256Canonical(scanInput.resolvedPolicy) !== sha256Canonical(expected)) {
    throw new Error("Layer policy input does not match the canonical Plan, Source and Skeleton effects");
  }
}

function canonicalRemainingBudget(
  snapshot: ScanStoreSnapshot,
  source: AuthorizedSourceV1,
  reserveCurrentAttempt: boolean,
): AgentScanInputContext["resolvedPolicy"]["remainingBudget"] {
  const plan = snapshot.plan.policy.budget;
  const observations = receiptsBySchema(
    snapshot.receipts,
    "openlifewiki.body-observation-receipt/v1",
  ) as BodyObservationReceipt[];
  const globalBodyBytes = observations.reduce((sum, item) => sum + item.bytes, 0);
  const sourceBodyBytes = observations.filter(({ sourceId }) => sourceId === source.sourceId)
    .reduce((sum, item) => sum + item.bytes, 0);
  const attempts = receiptsBySchema(
    snapshot.receipts,
    "openlifewiki.agent-attempt-reservation/v1",
  ) as AgentAttemptReservationReceipt[];
  const globalAgentCalls = attempts.length;
  const sourceAgentCalls = attempts.filter(({ sourceId }) => sourceId === source.sourceId).length;
  const remaining = (limit: number | undefined, consumed: number) => (
    limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - consumed)
  );
  return {
    nodes: Math.min(
      remaining(plan.maxNodes, snapshot.skeleton.nodes.length),
      remaining(source.budget.maxNodes, snapshot.skeleton.nodes.filter(({ node }) => node.sourceId === source.sourceId).length),
    ),
    bodyBytes: Math.min(
      remaining(plan.maxBodyBytes, globalBodyBytes),
      remaining(source.budget.maxBodyBytes, sourceBodyBytes),
    ),
    agentCalls: Math.max(0, Math.min(
      remaining(plan.maxAgentCalls, globalAgentCalls),
      remaining(source.budget.maxAgentCalls, sourceAgentCalls),
    ) - (reserveCurrentAttempt ? 1 : 0)),
  };
}

export async function closeScanFrontier(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
}): Promise<ScanStoreSnapshot> {
  return await updateScanStore(options, (current) => {
    if (current.state.phase !== "Discovering" || current.pendingLayer !== null) {
      throw new Error("Frontier close requires idle Discovering state");
    }
    const intents = receiptsBySchema(current.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[];
    const rootSources = intents.filter(({ origin }) => origin === "authorized-root").map(({ sourceId }) => sourceId);
    if (rootSources.length !== current.plan.sourceIds.length
      || new Set(rootSources).size !== rootSources.length
      || current.plan.sourceIds.some((sourceId) => !rootSources.includes(sourceId))) {
      throw new Error("Frontier is missing an authorized Source root");
    }
    for (const intent of intents) {
      if (pagesForIntent(current, intent.intentId).at(-1)?.state !== "complete"
        || !current.ledger.entries.some((entry) => entry.intentId === intent.intentId)) {
        throw new Error("Frontier contains incomplete or uncommitted Enumeration Intents");
      }
    }
    const decisions = durableDecisions(current);
    const selections = receiptsBySchema(current.receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[];
    for (const decision of decisions) {
      if (decision.decision !== "descend") continue;
      if (decision.targetKind === "container") {
        const derived = intents.filter(({ decisionReceiptHash }) => decisionReceiptHash === decision.receiptHash);
        if (derived.length !== 1) throw new Error("Container descend lacks its exact derived Enumeration Intent");
      } else if (current.plan.policy.indexing.rules.length > 0) {
        throw new Error("INDEXING_RULE_UNRESOLVED");
      } else {
        const selected = selections.filter(({ decisionReceiptHash }) => decisionReceiptHash === decision.receiptHash);
        const expected = current.plan.policy.indexing.default === "qmd-current" ? 1 : 0;
        if (selected.length !== expected) throw new Error("Leaf descend selection does not match indexing disposition");
      }
    }
    const outcomes = receiptsBySchema(current.receipts, "openlifewiki.scan-system-outcome/v1") as ScanSystemOutcomeReceipt[];
    if (decisions.some(({ decision }) => decision === "ask-user")
      || outcomes.some(({ outcome }) => ["blocked", "failed", "unknown"].includes(outcome))) {
      throw new Error("Frontier contains unresolved work");
    }
    return {
      ...current,
      state: transitionScanState(current.state, { type: "frontier-discovered" }),
    };
  });
}

export interface ActiveScanBodyLeaseContext {
  readonly lease: ActiveBodyReadLease;
  readonly snapshot: ScanStoreSnapshot;
  readonly reservation: BodyBudgetReservationReceipt;
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly trustedReceiptHashes: readonly string[];
  readonly expectedPhysicalIoAccountingHash: string;
}

export interface ConsumedBodyEvidence {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly bytes: number;
  readonly contentHash: string;
  readonly observationReceiptHash: string;
  readonly commitReceiptHash: string;
}

/** Package-internal atomic body-read path. Deliberately omitted from the package entry point. */
export async function withActiveScanBodyLease(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly open: (context: ActiveScanBodyLeaseContext) => Promise<ApprovedLeafBody>;
  readonly onChunk?: (chunk: Uint8Array) => Promise<void>;
  readonly now?: () => Date;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly evidence: ConsumedBodyEvidence }> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }
    if (current.state.phase !== "ReadingLeaves") {
      throw invalid("Body read requires ReadingLeaves");
    }
    const active = currentActiveBodyBudgetReservations(current);
    if (active.length !== 1) throw invalid("Body read requires one current JIT reservation");
    const reservation = active[0]!;
    if (reservation.sourceId !== options.sourceId
      || reservation.nodeId !== options.nodeId
      || reservation.nodeVersion !== options.nodeVersion) {
      throw invalid("Body read target does not own the current JIT reservation");
    }
    const selectionReceipt = durableLeafSelection(
      current,
      reservation.sourceId,
      reservation.nodeId,
      reservation.nodeVersion,
      reservation.authorizationHash,
    );
    if (selectionReceipt === undefined) throw invalid("Body read has no durable selected leaf");
    const lease = issueActiveBodyReadLease({
      scanId: current.plan.scanId,
      reservationReceiptHash: reservation.receiptHash,
      scanTransitionSequence: current.state.transitionSequence,
    });
    try {
      const body = await options.open({
        lease,
        snapshot: current,
        reservation,
        selectionReceipt,
        trustedReceiptHashes: receiptHashes(current.receipts),
        expectedPhysicalIoAccountingHash: sha256Canonical(current.physicalIo),
      });
      if (body.sourceId !== reservation.sourceId
        || body.nodeId !== reservation.nodeId
        || body.nodeVersion !== reservation.nodeVersion) {
        throw new Error("Approved body stream does not bind the active reservation");
      }
      const digest = createHash("sha256");
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      for await (const chunk of body.stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Approved body stream yielded a non-byte chunk");
        const nextBytes = bytes + chunk.byteLength;
        if (!Number.isSafeInteger(nextBytes) || nextBytes > reservation.reservedBytes) {
          throw new Error("Approved body stream exceeded its active reservation");
        }
        utf8.decode(chunk, { stream: true });
        digest.update(chunk);
        if (options.onChunk !== undefined) await options.onChunk(chunk);
        bytes = nextBytes;
      }
      utf8.decode();
      const contentHash = `sha256:${digest.digest("hex")}`;
      const committedAt = (options.now ?? (() => new Date()))().toISOString();
      const observation = createBodyObservationReceipt({
        plan: current.plan,
        trustedSelectionReceiptHashes: receiptHashes(current.receipts),
        selectionReceipt,
        previousObservationReceipt: null,
        observation: {
          schema: "openlifewiki.body-observation-receipt/v1",
          sourceId: reservation.sourceId,
          nodeId: reservation.nodeId,
          nodeVersion: reservation.nodeVersion,
          contentHash,
          bytes,
          purpose: "initial-read",
          rematerializationAuthorizationHash: null,
          observedAt: committedAt,
        },
      });
      const commit = createBodyReadCommitReceipt({
        scanId: current.plan.scanId,
        scanPlanHash: current.plan.scanPlanHash,
        skeletonVersion: current.plan.skeletonVersion,
        sourceId: reservation.sourceId,
        nodeId: reservation.nodeId,
        nodeVersion: reservation.nodeVersion,
        reservationReceiptHash: reservation.receiptHash,
        observationReceiptHash: observation.receiptHash,
        scanTransitionSequence: current.state.transitionSequence,
        committedAt,
      });
      const proposed = appendTrustedBodyObservation(current, {
        observation,
        selectionReceipt,
        budgetReservation: reservation,
        commit,
      });
      assertUpdate(current, proposed);
      const next = createSnapshot({
        revision: current.revision + 1,
        plan: proposed.plan,
        state: proposed.state,
        sourceBindings: proposed.sourceBindings,
        connectorStatuses: proposed.connectorStatuses,
        scratchCleanupRequired: proposed.scratchCleanupRequired,
        skeleton: proposed.skeleton,
        pendingLayer: proposed.pendingLayer,
        ledger: proposed.ledger,
        receipts: proposed.receipts,
        physicalIo: proposed.physicalIo,
      });
      await persist(path, next);
      return {
        snapshot: next,
        evidence: Object.freeze({
          sourceId: reservation.sourceId,
          nodeId: reservation.nodeId,
          nodeVersion: reservation.nodeVersion,
          bytes,
          contentHash,
          observationReceiptHash: observation.receiptHash,
          commitReceiptHash: commit.receiptHash,
        }),
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Active body read failed", error);
    } finally {
      revokeActiveBodyReadLease(lease);
    }
  });
}

export async function reserveScanBodyBudget(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
  readonly expectedPhysicalIoAccountingHash: string;
  readonly source: AuthorizedSourceV1;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly reservedBytes: number;
  readonly now?: () => Date;
}): Promise<{ readonly snapshot: ScanStoreSnapshot; readonly reservation: BodyBudgetReservationReceipt }> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }
    if (current.state.phase !== "ReadingLeaves") {
      throw invalid("Body budget reservation requires ReadingLeaves");
    }
    const accountingHash = sha256Canonical(current.physicalIo);
    const requestedKey = bodyWorkKey(options.source.sourceId, options.nodeId, options.nodeVersion);
    const active = currentActiveBodyBudgetReservations(current);
    const existing = active.length === 1 && bodyWorkKey(
      active[0]!.sourceId,
      active[0]!.nodeId,
      active[0]!.nodeVersion,
    ) === requestedKey ? active[0] : undefined;
    if (existing !== undefined
      && existing.reservedBytes === options.reservedBytes
      && existing.physicalIoAccountingHash === options.expectedPhysicalIoAccountingHash) {
      assertAuthorizedSourceBinding(options.source, current.plan);
      return { snapshot: current, reservation: existing };
    }
    if (options.expectedPhysicalIoAccountingHash !== accountingHash) {
      throw conflict("Physical I/O accounting changed before budget reservation");
    }
    assertAuthorizedSourceBinding(options.source, current.plan);
    const sourceIndex = current.plan.sourceIds.indexOf(options.source.sourceId);
    const selection = durableLeafSelection(
      current,
      options.source.sourceId,
      options.nodeId,
      options.nodeVersion,
      options.source.authorizationHash,
    );
    if (selection === undefined) {
      throw invalid("Body budget reservation requires an exact durable selected leaf");
    }
    const observations = current.receipts.filter((receipt) => (
      schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1"
    )) as readonly BodyObservationReceipt[];
    if (observations.some((item) => bodyWorkKey(item.sourceId, item.nodeId, item.nodeVersion) === requestedKey)) {
      throw invalid("Selected leaf body was already observed");
    }
    if (active.length > 0) {
      throw invalid("A current JIT body budget reservation already exists");
    }
    const planLimit = current.plan.policy.budget.maxBodyBytes;
    if (planLimit === undefined) throw invalid("Scan Plan has no body budget");
    const limit = Math.min(options.source.budget.maxBodyBytes, planLimit);
    if (!Number.isSafeInteger(limit) || limit < 0) throw invalid("Scan Plan has no valid body budget");
    const sourceConsumed = observations
      .filter(({ sourceId }) => sourceId === options.source.sourceId)
      .reduce((total, item) => total + item.bytes, 0);
    const planConsumed = observations.reduce((total, item) => total + item.bytes, 0);
    const remainingBeforeBytes = Math.min(
      options.source.budget.maxBodyBytes - sourceConsumed,
      planLimit - planConsumed,
    );
    if (!Number.isSafeInteger(options.reservedBytes)
      || options.reservedBytes <= 0
      || options.reservedBytes > remainingBeforeBytes) {
      throw invalid("Body budget reservation exceeds the durable remaining budget");
    }
    const reservation = createBodyBudgetReservationReceipt({
      schema: "openlifewiki.body-budget-reservation/v1",
      scanId: current.plan.scanId,
      scanPlanHash: current.plan.scanPlanHash,
      skeletonVersion: current.plan.skeletonVersion,
      authorizationHash: current.plan.authorizationHashes[sourceIndex]!,
      sourceId: options.source.sourceId,
      nodeId: options.nodeId,
      nodeVersion: options.nodeVersion,
      scanTransitionSequence: current.state.transitionSequence,
      physicalIoAccountingHash: accountingHash,
      remainingBeforeBytes,
      reservedBytes: options.reservedBytes,
      reservedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    const proposed = { ...current, receipts: [...current.receipts, reservation] };
    try {
      assertUpdate(current, proposed);
      const next = createSnapshot({
        revision: current.revision + 1,
        plan: proposed.plan,
        state: proposed.state,
        sourceBindings: proposed.sourceBindings,
        connectorStatuses: proposed.connectorStatuses,
        scratchCleanupRequired: proposed.scratchCleanupRequired,
        skeleton: proposed.skeleton,
        pendingLayer: proposed.pendingLayer,
        ledger: proposed.ledger,
        receipts: proposed.receipts,
        physicalIo: proposed.physicalIo,
      });
      await persist(path, next);
      return { snapshot: next, reservation };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Proposed scan update failed integrity validation", error);
    }
  });
}

async function updateScanStore(options: {
  readonly dataDir: string;
  readonly scanId: string;
  readonly expectedRevision: number;
}, update: (snapshot: ScanStoreSnapshot) => ScanStoreUpdate | Promise<ScanStoreUpdate>): Promise<ScanStoreSnapshot> {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw conflict("Expected scan revision must be a non-negative integer");
  }
  const path = scanStoreStatePath(options.dataDir, options.scanId);
  return await withScanLock(path, async () => {
    const current = await readScanStore({ dataDir: options.dataDir, scanId: options.scanId });
    if (current === undefined) throw conflict("Scan state is missing");
    if (current.revision !== options.expectedRevision) {
      throw conflict(`Scan revision changed: expected ${options.expectedRevision}, received ${current.revision}`);
    }

    let proposed: ScanStoreUpdate;
    try {
      proposed = await update(freeze(structuredClone(current)));
      assertUpdate(current, proposed);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid("Proposed scan update failed integrity validation", error);
    }
    if (sha256Canonical(proposed) === sha256Canonical(current)) return current;
    const next = createSnapshot({
      revision: current.revision + 1,
      plan: proposed.plan,
      state: proposed.state,
      sourceBindings: proposed.sourceBindings,
      connectorStatuses: proposed.connectorStatuses,
      scratchCleanupRequired: proposed.scratchCleanupRequired,
      skeleton: proposed.skeleton,
      pendingLayer: proposed.pendingLayer,
      ledger: proposed.ledger,
      receipts: proposed.receipts,
      physicalIo: proposed.physicalIo,
    });
    await persist(path, next);
    return next;
  });
}

function schemaOf(receipt: ScanStoreReceipt): string | undefined {
  return isRecord(receipt) && typeof receipt.schema === "string" ? receipt.schema : undefined;
}

function receiptsBySchema(receipts: readonly ScanStoreReceipt[], schema: string): ScanStoreReceipt[] {
  return receipts.filter((receipt) => schemaOf(receipt) === schema);
}

function artifactHash(receipt: ScanStoreReceipt): string | undefined {
  if (!isRecord(receipt)) return undefined;
  if (typeof receipt.receiptHash === "string") return receipt.receiptHash;
  return typeof receipt.authorizationHash === "string" ? receipt.authorizationHash : undefined;
}

function receiptHashes(receipts: readonly ScanStoreReceipt[]): string[] {
  return receipts.map((receipt) => {
    const hash = artifactHash(receipt);
    if (hash === undefined) throw new Error("Durable scan artifact has no trusted hash");
    return hash;
  });
}

interface TrustedBodyObservationInput {
  readonly observation: BodyObservationReceipt;
  readonly selectionReceipt: LeafSelectionReceipt;
  readonly budgetReservation: BodyBudgetReservationReceipt;
  readonly commit: BodyReadCommitReceipt;
}

function createBodyReadCommitReceipt(
  input: Omit<BodyReadCommitReceipt, "schema" | "receiptHash">,
): BodyReadCommitReceipt {
  const payload = { schema: "openlifewiki.body-read-commit/v1" as const, ...input };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function createBodyReadEpochBoundaryReceipt(
  input: Omit<BodyReadEpochBoundaryReceipt, "schema" | "receiptHash">,
): BodyReadEpochBoundaryReceipt {
  const payload = { schema: "openlifewiki.body-read-epoch-boundary/v1" as const, ...input };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function appendTrustedBodyObservation(
  current: ScanStoreSnapshot,
  item: TrustedBodyObservationInput,
): ScanStoreSnapshot {
  if (current.state.phase !== "ReadingLeaves") {
    throw new Error("Body observation requires ReadingLeaves");
  }
  assertTrustedBodyObservation(item, current);
  const existingObservations = receiptsBySchema(
    current.receipts,
    "openlifewiki.body-observation-receipt/v1",
  ) as BodyObservationReceipt[];
  assertBodyReadCommit(item.commit, item.observation, item.budgetReservation);
  const additions: ScanStoreReceipt[] = [item.observation, item.commit];
  const physicalIo = recordPhysicalIo({
    accounting: current.physicalIo,
    priorObservations: existingObservations,
    observations: [item.observation],
    rematerializationAuthorizations: [],
    trustedReceiptHashes: [...receiptHashes(current.receipts), item.observation.receiptHash],
  });
  return { ...current, physicalIo, receipts: [...current.receipts, ...additions] };
}

function assertTrustedBodyObservation(
  item: TrustedBodyObservationInput,
  current: ScanStoreSnapshot,
): void {
  const selectionHash = item.selectionReceipt.receiptHash;
  const durableSelection = current.receipts.find((receipt) => artifactHash(receipt) === selectionHash);
  if (durableSelection === undefined || sha256Canonical(durableSelection) !== sha256Canonical(item.selectionReceipt)) {
    throw new Error("Body observation selection is outside the durable trusted receipt set");
  }
  const reservation = item.budgetReservation;
  const durableReservation = current.receipts.find((receipt) => artifactHash(receipt) === reservation.receiptHash);
  const activeReservations = currentActiveBodyBudgetReservations(current);
  const activeReservation = activeReservations.length === 1 ? activeReservations[0] : undefined;
  const accountingHash = sha256Canonical(current.physicalIo);
  if (durableReservation === undefined
    || sha256Canonical(durableReservation) !== sha256Canonical(reservation)
    || activeReservation?.receiptHash !== reservation.receiptHash
    || reservation.sourceId !== item.observation.sourceId
    || reservation.nodeId !== item.observation.nodeId
    || reservation.nodeVersion !== item.observation.nodeVersion
    || reservation.authorizationHash !== item.observation.authorizationHash
    || reservation.physicalIoAccountingHash !== accountingHash
    || item.observation.bytes > reservation.reservedBytes
    || current.receipts.some((receipt) => schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1"
      && (receipt as BodyObservationReceipt).sourceId === reservation.sourceId
      && (receipt as BodyObservationReceipt).nodeId === reservation.nodeId
      && (receipt as BodyObservationReceipt).nodeVersion === reservation.nodeVersion)) {
    throw new Error("Body observation does not bind one current unconsumed budget reservation");
  }
  assertBodyObservationReceipt(item.observation, {
    plan: current.plan,
    trustedSelectionReceiptHashes: receiptHashes(current.receipts),
    selectionReceipt: item.selectionReceipt,
    previousObservationReceipt: null,
  });
}

function assertBodyReadCommit(
  commit: BodyReadCommitReceipt,
  observation: BodyObservationReceipt,
  reservation: BodyBudgetReservationReceipt,
): void {
  const { receiptHash, ...unsigned } = commit;
  if (sha256Canonical(unsigned) !== receiptHash
    || commit.schema !== "openlifewiki.body-read-commit/v1"
    || commit.scanId !== reservation.scanId
    || commit.scanPlanHash !== reservation.scanPlanHash
    || commit.skeletonVersion !== reservation.skeletonVersion
    || commit.sourceId !== reservation.sourceId
    || commit.nodeId !== reservation.nodeId
    || commit.nodeVersion !== reservation.nodeVersion
    || commit.reservationReceiptHash !== reservation.receiptHash
    || commit.observationReceiptHash !== observation.receiptHash
    || commit.scanTransitionSequence !== reservation.scanTransitionSequence
    || !Number.isFinite(Date.parse(commit.committedAt))) {
    throw new Error("Body read commit does not bind its active reservation and observation");
  }
}

function assertAuthorizedSourceBinding(source: AuthorizedSourceV1, plan: ScanPlan): void {
  const { authorizationHash, ...unsigned } = source;
  const index = plan.sourceIds.indexOf(source.sourceId);
  if (sha256Canonical(unsigned) !== authorizationHash
    || index < 0
    || plan.authorizationHashes[index] !== authorizationHash) {
    throw new Error("Authorized Source does not bind the active Scan Plan");
  }
}

function assertDurableSourceBinding(snapshot: ScanStoreSnapshot, source: AuthorizedSourceV1): void {
  const durable = snapshot.sourceBindings.find(({ sourceId }) => sourceId === source.sourceId);
  if (durable === undefined || sha256Canonical(durable) !== sha256Canonical(source)) {
    throw new Error("Authorized Source differs from the durable scan binding");
  }
}

function assertConnectedProbeSet(
  plan: ScanPlan,
  sources: readonly AuthorizedSourceV1[],
  statuses: readonly ConnectorStatus[],
): void {
  if (sources.length !== plan.sourceIds.length || statuses.length !== plan.sourceIds.length) {
    throw new Error("Connected probes must exactly cover every ScanPlan Source");
  }
  if (sources.some((source, index) => source.sourceId !== plan.sourceIds[index]
    || source.authorizationHash !== plan.authorizationHashes[index]
    || source.rootNodeId !== plan.rootNodeIds[index])
    || statuses.some((status, index) => status.sourceId !== plan.sourceIds[index])) {
    throw new Error("Connected probes must follow the exact ScanPlan Source, authorization and root order");
  }
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  if (sourceById.size !== sources.length) throw new Error("Connected probe Source is duplicated");
  for (const sourceId of plan.sourceIds) {
    const source = sourceById.get(sourceId);
    const status = statuses.find((item) => item.sourceId === sourceId);
    if (source === undefined || status === undefined) throw new Error("Connected probe Source is missing");
    assertAuthorizedSourceBinding(source, plan);
    assertConnectorStatusShape(status);
    const fingerprint = status.identity?.fingerprint;
    const provider = source.providerObservation;
    const descriptor = CONNECTOR_DESCRIPTORS.find(({ connectorType }) => connectorType === source.connectorType);
    if (status.connectorType !== source.connectorType
      || status.status !== "connected"
      || status.blocking !== null
      || status.changedItems !== 0
      || status.lastScan !== undefined
      || fingerprint !== source.identityFingerprint
      || sha256Canonical(status.authorizedScope) !== sha256Canonical(source.scope)
      || provider === undefined
      || descriptor === undefined
      || status.providerProject !== descriptor.provider.project
      || provider !== undefined && (
        status.providerName !== provider.providerName
        || status.providerVersion !== provider.providerVersion
        || status.providerContractHash !== (provider.contractHash ?? undefined)
      )) {
      throw new Error("Connected probe identity, provider or scope drifted from Source authorization");
    }
    assertConnectedIdentity(status, source);
  }
  if (new Set(statuses.map(({ sourceId }) => sourceId)).size !== statuses.length) {
    throw new Error("Connected probe status is duplicated");
  }
}

function assertConnectorStatusShape(value: unknown): asserts value is ConnectorStatus {
  if (!isRecord(value) || value.schema !== "openlifewiki.connector-status/v1"
    || !hasOnlyKeys(value, [
      "authorizedScope", "blocking", "changedItems", "connectorType", "identity", "lastProbe",
      "lastScan", "providerContractHash", "providerName", "providerProject", "providerVersion",
      "schema", "sourceId", "status",
    ])
    || !SCAN_ID.test(String(value.sourceId))
    || !["local-folder", "github", "feishu", "codex-history"].includes(String(value.connectorType))
    || typeof value.providerName !== "string" || value.providerName.length === 0
    || !["connected", "auth-required", "missing", "blocked"].includes(String(value.status))
    || typeof value.lastProbe !== "string" || !Number.isFinite(Date.parse(value.lastProbe))
    || !Number.isSafeInteger(value.changedItems) || Number(value.changedItems) < 0
    || !isRecord(value.identity) || Object.values(value.identity).some((item) => typeof item !== "string")
    || !isRecord(value.authorizedScope)
    || !(value.blocking === null || isRecord(value.blocking))) {
    throw new Error("Connector status shape is invalid");
  }
  const identityKeys = CONNECTED_IDENTITY_KEYS[value.connectorType as keyof typeof CONNECTED_IDENTITY_KEYS];
  if (identityKeys === undefined || !identityKeys.some((keys) => hasExactKeys(value.identity as Record<string, unknown>, keys))) {
    throw new Error("Connector status identity is not canonical and redacted");
  }
  const identity = value.identity as Record<string, unknown>;
  if (!SHA256.test(String(identity.fingerprint))) {
    throw new Error("Connector status identity is not canonical and redacted");
  }
  assertSafeConnectorIdentityValues(
    value.connectorType as ConnectorStatus["connectorType"],
    value.identity as Readonly<Record<string, string>>,
  );
}

const CONNECTED_IDENTITY_KEYS = {
  "local-folder": [["account", "fingerprint", "profile"]],
  github: [["account", "fingerprint", "host"]],
  feishu: [["account", "effectiveScope", "fingerprint", "profile", "tenant"]],
  "codex-history": [
    ["account", "fingerprint", "profile"],
    ["account", "fingerprint", "plan", "profile"],
  ],
} as const;

function assertConnectedIdentity(status: ConnectorStatus, source: AuthorizedSourceV1): void {
  const identity = status.identity as Readonly<Record<string, string>>;
  const account = identity.account;
  const accountIsCanonical = source.connectorType === "codex-history"
    ? account === CODEX_PUBLIC_ACCOUNT
    : account !== undefined && looksRedacted(account);
  if (identity.fingerprint !== source.identityFingerprint || !accountIsCanonical) {
    throw new Error("Connected probe identity is not the canonical redacted Source identity");
  }
  if (source.connectorType === "local-folder" && identity.profile !== "local") {
    throw new Error("Local Folder identity profile is invalid");
  }
  if (source.connectorType === "github" && identity.host !== (source.scope as { hostname?: unknown }).hostname) {
    throw new Error("GitHub identity host differs from the approved scope");
  }
  if (source.connectorType === "feishu" && identity.profile !== (source.scope as { profile?: unknown }).profile) {
    throw new Error("Feishu identity profile differs from the approved scope");
  }
  if (source.connectorType === "codex-history"
    && !["ChatGPT login", "Codex login"].includes(identity.profile ?? "")) {
    throw new Error("Codex History identity profile is invalid");
  }
}

function looksRedacted(value: string): boolean {
  const [local] = value.split("@", 1);
  return local === "**" || /^[^*\s]\*{3}[^*\s]$/u.test(local ?? "");
}

function createCanonicalRootIntent(
  plan: ScanPlan,
  source: AuthorizedSourceV1,
  root: SkeletonNode,
  createdAt: string,
): EnumerationIntent {
  return createEnumerationIntent({
    plan,
    trustedDecisionReceiptHashes: [],
    decisionReceipt: null,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1",
      intentId: `intent_root_${sha256Canonical({
        scanId: plan.scanId,
        sourceId: source.sourceId,
      }).slice("sha256:".length, "sha256:".length + 32)}`,
      sourceId: source.sourceId,
      targetNodeId: root.nodeId,
      targetNodeVersion: root.nodeVersion,
      authorizationHash: source.authorizationHash,
      origin: "authorized-root",
      parentLayerNodeId: null,
      childSetHash: null,
      inputSetHash: sha256Canonical({
        scanPlanHash: plan.scanPlanHash,
        skeletonVersion: plan.skeletonVersion,
        sourceId: source.sourceId,
        authorizationHash: source.authorizationHash,
        scopeHash: progressiveConnectorScopeHash(source),
        rootMetadataHash: sha256Canonical(root),
      }),
      createdAt,
    },
  });
}

function createSkeletonNodeRecord(
  input: Omit<ScanSkeletonNodeRecord, "schema" | "recordHash">,
): ScanSkeletonNodeRecord {
  assertSkeletonNode(input.node);
  const payload = { schema: "openlifewiki.scan-skeleton-node/v1" as const, ...input };
  return { ...payload, recordHash: sha256Canonical(payload) };
}

function createSkeletonPageRecord(
  input: Omit<ScanSkeletonPageRecord, "schema" | "recordHash">,
): ScanSkeletonPageRecord {
  const payload = { schema: "openlifewiki.scan-skeleton-page/v1" as const, ...input };
  return { ...payload, recordHash: sha256Canonical(payload) };
}

function createPendingLayer(input: Omit<PendingScanLayer, "schema" | "recordHash">): PendingScanLayer {
  const payload = { schema: "openlifewiki.pending-scan-layer/v1" as const, ...input };
  return { ...payload, recordHash: sha256Canonical(payload) };
}

function durableDecisions(snapshot: ScanStoreSnapshot): ScanDecision[] {
  const hashes = new Set(snapshot.ledger.entries.flatMap(({ agentDecisionReceiptHashes }) => agentDecisionReceiptHashes));
  return (receiptsBySchema(snapshot.receipts, "openlifewiki.scan-decision/v1") as ScanDecision[])
    .filter(({ receiptHash }) => hashes.has(receiptHash));
}

function durableIntent(snapshot: ScanStoreSnapshot, intentId: string): EnumerationIntent | undefined {
  return (receiptsBySchema(snapshot.receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[])
    .find((intent) => intent.intentId === intentId);
}

function pagesForIntent(snapshot: ScanStoreSnapshot, intentId: string): EnumerationPageReceipt[] {
  return (receiptsBySchema(snapshot.receipts, "openlifewiki.enumeration-page-receipt/v1") as EnumerationPageReceipt[])
    .filter((page) => page.intentId === intentId)
    .sort((left, right) => left.pageSequence - right.pageSequence);
}

function skeletonPageEvidence(snapshot: ScanStoreSnapshot, intentId: string): {
  readonly receipt: EnumerationPageReceipt;
  readonly nodes: readonly SkeletonNode[];
}[] {
  return pagesForIntent(snapshot, intentId).map((receipt) => ({
    receipt,
    nodes: snapshot.skeleton.nodes
      .filter((record) => record.pageReceiptHash === receipt.receiptHash)
      .map(({ node }) => node),
  }));
}

function layerNodesForIntent(snapshot: ScanStoreSnapshot, intentId: string): SkeletonNode[] {
  return skeletonPageEvidence(snapshot, intentId).flatMap(({ nodes }) => nodes);
}

function assertConnectorStatuses(value: unknown, plan: ScanPlan): asserts value is readonly ConnectorStatus[] {
  if (!Array.isArray(value)) throw new Error("Connector statuses must be an array");
  value.forEach(assertConnectorStatusShape);
  const ids = value.map(({ sourceId }) => sourceId);
  if (new Set(ids).size !== ids.length || ids.some((sourceId) => !plan.sourceIds.includes(sourceId))
    || ids.some((sourceId, index) => sourceId !== plan.sourceIds[index])
    || value.some(({ status, blocking }) => status !== "connected" || blocking !== null)
    || value.length !== 0 && value.length !== plan.sourceIds.length) {
    throw new Error("Connector statuses do not bind unique ScanPlan Sources");
  }
}

function assertSourceBindings(
  value: unknown,
  plan: ScanPlan,
  statuses: readonly ConnectorStatus[],
): asserts value is readonly AuthorizedSourceV1[] {
  if (!Array.isArray(value) || value.length !== statuses.length
    || value.length !== 0 && value.length !== plan.sourceIds.length) {
    throw new Error("Durable Source bindings must exactly match connected probes");
  }
  const bindings = value as AuthorizedSourceV1[];
  const ids = new Set<string>();
  for (const source of bindings) {
    const index = bindings.indexOf(source);
    assertAuthorizedSourceBinding(source, plan);
    if (ids.has(source.sourceId) || source.sourceId !== plan.sourceIds[index]
      || source.rootNodeId !== plan.rootNodeIds[index]) {
      throw new Error("Durable Source binding is duplicated, reordered or root-mismatched");
    }
    ids.add(source.sourceId);
    const status = statuses.find(({ sourceId }) => sourceId === source.sourceId);
    if (status === undefined) throw new Error("Durable Source binding lacks connected probe evidence");
    assertConnectedProbeSet(
      createSingleSourcePlanView(plan, source),
      [source],
      [status],
    );
  }
}

function createSingleSourcePlanView(plan: ScanPlan, source: AuthorizedSourceV1): ScanPlan {
  const index = plan.sourceIds.indexOf(source.sourceId);
  if (index < 0) throw new Error("Source is outside ScanPlan");
  return {
    ...plan,
    sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash],
    rootNodeIds: [plan.rootNodeIds[index]!],
  };
}

function assertSkeletonStore(
  value: unknown,
  plan: ScanPlan,
  receipts: readonly ScanStoreReceipt[],
  sourceBindings: readonly AuthorizedSourceV1[],
): asserts value is ScanSkeletonStore {
  if (!isRecord(value) || !hasExactKeys(value, ["nodes", "pages", "schema"])
    || value.schema !== "openlifewiki.scan-skeleton/v1"
    || !Array.isArray(value.nodes) || !Array.isArray(value.pages)) {
    throw new Error("Scan Skeleton store shape is invalid");
  }
  const intents = receiptsBySchema(receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[];
  const pages = receiptsBySchema(receipts, "openlifewiki.enumeration-page-receipt/v1") as EnumerationPageReceipt[];
  const nodeKeys = new Set<string>();
  const nodes = value.nodes.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["expectedScopeHash", "intentId", "node", "pageReceiptHash", "recordHash", "schema"])
      || item.schema !== "openlifewiki.scan-skeleton-node/v1") throw new Error("Skeleton node record shape is invalid");
    const { recordHash, ...payload } = item;
    if (!SHA256.test(String(recordHash)) || sha256Canonical(payload) !== recordHash
      || !SHA256.test(String(item.expectedScopeHash))
      || !(item.pageReceiptHash === null || typeof item.pageReceiptHash === "string" && SHA256.test(item.pageReceiptHash))) {
      throw new Error("Skeleton node record hash or binding is invalid");
    }
    assertSkeletonNode(item.node);
    const node = item.node;
    const source = sourceBindings.find(({ sourceId }) => sourceId === node.sourceId);
    if (source === undefined || item.expectedScopeHash !== progressiveConnectorScopeHash(source)) {
      throw new Error("Skeleton node scope does not bind the durable Source");
    }
    const key = `${node.sourceId}\0${node.nodeId}`;
    if (nodeKeys.has(key) || !plan.sourceIds.includes(node.sourceId)) throw new Error("Skeleton logical node is duplicated or outside plan");
    nodeKeys.add(key);
    return item as unknown as ScanSkeletonNodeRecord;
  });
  const pageHashes = new Set<string>();
  const eventSequences = new Set<number>();
  const pageRecords = value.pages.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["expectedScopeHash", "intentId", "receiptHash", "recordHash", "schema"])
      || item.schema !== "openlifewiki.scan-skeleton-page/v1") throw new Error("Skeleton page record shape is invalid");
    const { recordHash, ...payload } = item;
    if (![item.expectedScopeHash, item.receiptHash, recordHash].every((hash) => typeof hash === "string" && SHA256.test(hash))
      || sha256Canonical(payload) !== recordHash || pageHashes.has(String(item.receiptHash))) {
      throw new Error("Skeleton page record hash is invalid or duplicated");
    }
    const receipt = pages.find(({ receiptHash }) => receiptHash === item.receiptHash);
    const source = sourceBindings.find(({ sourceId }) => sourceId === receipt?.sourceId);
    if (receipt === undefined || source === undefined
      || item.expectedScopeHash !== progressiveConnectorScopeHash(source)
      || receipt.requestScopeHash !== item.expectedScopeHash) {
      throw new Error("Skeleton page scope does not bind the durable Source");
    }
    pageHashes.add(String(item.receiptHash));
    return item as unknown as ScanSkeletonPageRecord;
  });
  if (pages.length !== pageRecords.length || pages.some(({ receiptHash }) => !pageHashes.has(receiptHash))) {
    throw new Error("Skeleton page records do not exactly cover durable page receipts");
  }
  for (const page of pages) {
    if (eventSequences.has(page.eventSequence)) throw new Error("Enumeration page eventSequence is duplicated");
    eventSequences.add(page.eventSequence);
  }
  for (const record of nodes) {
    const intent = intents.find(({ intentId }) => intentId === record.intentId);
    if (intent === undefined) throw new Error("Skeleton node has no durable Enumeration Intent");
    if (record.pageReceiptHash === null) {
      if (record.node.sourceId !== intent.sourceId || record.node.nodeId !== intent.targetNodeId
        || record.node.nodeVersion !== intent.targetNodeVersion) {
        throw new Error("Skeleton parent record does not bind its Enumeration Intent");
      }
    } else if (!pageRecords.some((page) => page.receiptHash === record.pageReceiptHash && page.intentId === record.intentId)) {
      throw new Error("Skeleton child record has no exact page attribution");
    }
  }
  if (pageRecords.some((record) => !intents.some(({ intentId }) => intentId === record.intentId))) {
    throw new Error("Skeleton page record has no durable Enumeration Intent");
  }
  for (const intent of intents) {
    const parent = nodes.find(({ node }) => node.sourceId === intent.sourceId && node.nodeId === intent.targetNodeId);
    if (parent === undefined || parent.node.nodeVersion !== intent.targetNodeVersion) {
      throw new Error("Enumeration Intent lacks its exact durable Skeleton parent");
    }
    if (intent.origin === "authorized-root") {
      const source = sourceBindings.find(({ sourceId }) => sourceId === intent.sourceId);
      const expected = source === undefined ? undefined
        : createCanonicalRootIntent(plan, source, parent.node, intent.createdAt);
      if (source === undefined || source.rootNodeId !== parent.node.nodeId || parent.pageReceiptHash !== null
        || expected === undefined || sha256Canonical(intent) !== sha256Canonical(expected)) {
        throw new Error("Authorized-root Enumeration Intent is not canonical for its durable Source and root metadata");
      }
    }
    const records = pageRecords.filter((record) => record.intentId === intent.intentId);
    const evidence: { receipt: EnumerationPageReceipt; nodes: readonly SkeletonNode[] }[] = [];
    for (const record of records) {
      const receipt = pages.find(({ receiptHash }) => receiptHash === record.receiptHash);
      if (receipt === undefined || record.expectedScopeHash !== parent.expectedScopeHash) throw new Error("Skeleton page scope drifted");
      const pageNodes = nodes.filter(({ pageReceiptHash }) => pageReceiptHash === receipt.receiptHash).map(({ node }) => node);
      const providerPage: SkeletonPage = {
        schema: "openlifewiki.skeleton-page/v1", sourceId: receipt.sourceId,
        parentNodeId: parent.node.nodeId, requestScopeHash: record.expectedScopeHash,
        nodes: pageNodes, nextCursor: receipt.nextCursor, pageComplete: receipt.state === "complete",
        observedAt: receipt.observedAt, skeletonVersion: receipt.skeletonVersion,
      };
      assertEnumerationPageReceipt(receipt, {
        plan, intent, trustedDecisionReceipts: durableDecisionReceipts(receipts, plan),
        parent: parent.node, page: providerPage, expectedScopeHash: record.expectedScopeHash,
        priorPages: evidence, requestCursor: evidence.at(-1)?.receipt.nextCursor ?? null,
        eventSequence: receipt.eventSequence,
      });
      evidence.push({ receipt, nodes: pageNodes });
    }
  }
}

function durableDecisionReceipts(receipts: readonly ScanStoreReceipt[], plan: ScanPlan): ScanDecision[] {
  return (receiptsBySchema(receipts, "openlifewiki.scan-decision/v1") as ScanDecision[])
    .filter((decision) => decision.scanPlanHash === plan.scanPlanHash);
}

function assertPendingLayer(
  value: unknown,
  plan: ScanPlan,
  state: ScanState,
  receipts: readonly ScanStoreReceipt[],
  skeleton: ScanSkeletonStore,
): asserts value is PendingScanLayer | null {
  if (value === null) {
    if (state.phase === "Deciding") throw new Error("Deciding state requires durable prepared metadata");
    return;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["intentId", "recordHash", "scanInput", "scanInputHash", "schema", "summaryReceipt"])
    || value.schema !== "openlifewiki.pending-scan-layer/v1") throw new Error("Pending layer shape is invalid");
  const { recordHash, ...payload } = value;
  if (!SHA256.test(String(recordHash)) || sha256Canonical(payload) !== recordHash || !SHA256.test(String(value.scanInputHash))) {
    throw new Error("Pending layer hash is invalid");
  }
  const intent = (receiptsBySchema(receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[])
    .find(({ intentId }) => intentId === value.intentId);
  assertAgentScanInputContext(value.scanInput);
  const scanInput = value.scanInput;
  const summary = value.summaryReceipt;
  const pendingState = state.phase === "Deciding"
    || state.phase === "Paused" && state.resumePhase === "Deciding"
    || state.phase === "Failed" && state.retryPhase === "Deciding";
  const intentPages = (receiptsBySchema(receipts, "openlifewiki.enumeration-page-receipt/v1") as EnumerationPageReceipt[])
    .filter(({ intentId }) => intentId === value.intentId)
    .sort((left, right) => left.pageSequence - right.pageSequence);
  const layerNodes = skeleton.nodes
    .filter(({ intentId, pageReceiptHash }) => intentId === value.intentId && pageReceiptHash !== null)
    .map(({ node }) => node);
  const completeChildren = buildSkeletonTrustedChildren(layerNodes);
  const parentNode = skeleton.nodes.find(({ node }) => (
    node.sourceId === intent?.sourceId && node.nodeId === intent?.targetNodeId
  ))?.node;
  if (!pendingState || intent === undefined || parentNode === undefined || !isRecord(summary)
    || !hasExactKeys(summary, B2_RECEIPT_KEYS.get("openlifewiki.layer-summary-receipt/v1")!)
    || summary.schema !== "openlifewiki.layer-summary-receipt/v1"
    || summary.scanId !== plan.scanId || summary.scanPlanHash !== plan.scanPlanHash
    || summary.skeletonVersion !== plan.skeletonVersion || summary.intentId !== intent.intentId
    || summary.inputSetHash !== value.scanInputHash
    || value.scanInputHash !== sha256Canonical(scanInput)
    || scanInput.layer.sourceId !== intent.sourceId
    || scanInput.layer.parentNodeId !== parentNode.nodeId
    || scanInput.layer.parentNodeVersion !== parentNode.nodeVersion
    || sha256Canonical(scanInput.completeChildren) !== sha256Canonical(completeChildren)
    || scanInput.layer.childSetHash !== intentPages.at(-1)?.childSetHash
    || scanInput.layer.summaryHash !== summary.summaryHash
    || sha256Canonical(Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "receiptHash"))) !== summary.receiptHash
    || intentPages.at(-1)?.state !== "complete"
    || !skeleton.pages.some(({ intentId }) => intentId === value.intentId)) {
    throw new Error("Pending layer does not bind the durable frontier");
  }
}

function assertConnectorStatusAppendOnly(current: readonly ConnectorStatus[], proposed: readonly ConnectorStatus[]): void {
  if (current.length > 0 && sha256Canonical(current) !== sha256Canonical(proposed)) {
    throw new Error("Connected probe status snapshot is immutable");
  }
}

function assertSkeletonAppendOnly(current: ScanSkeletonStore, proposed: ScanSkeletonStore): void {
  for (const [field, prior, next] of [
    ["node", current.nodes, proposed.nodes],
    ["page", current.pages, proposed.pages],
  ] as const) {
    if (next.length < prior.length || prior.some((item, index) => sha256Canonical(item) !== sha256Canonical(next[index]))) {
      throw new Error(`Skeleton ${field} records are append-only`);
    }
  }
}

function assertPendingLayerAdvance(
  current: PendingScanLayer | null,
  proposed: PendingScanLayer | null,
  currentState: ScanState,
  proposedState: ScanState,
): void {
  if (current === null && proposed !== null && !(currentState.phase === "Summarizing" && proposedState.phase === "Deciding")) {
    throw new Error("Pending layer may be prepared only during Summarizing");
  }
  if (current !== null && proposed === null
    && !(currentState.phase === "Deciding"
      && ["Discovering", "Cancelled"].includes(proposedState.phase))) {
    throw new Error("Pending layer may clear only with atomic layer commit");
  }
  if (current !== null && proposed !== null && sha256Canonical(current) !== sha256Canonical(proposed)) {
    throw new Error("Pending layer cannot be rewritten");
  }
}

function assertRuntimeBinding(dataDir: string, runtimeDir: string): void {
  const expected = resolve(dirname(resolve(dataDir)), "runtime");
  if (resolve(runtimeDir) !== expected) {
    throw invalid("Scan scratch runtime must be the runtime sibling of the durable data directory");
  }
}

function assertLayoutBinding(dataDir: string, runtimeDir: string, layout: RuntimeLayout): void {
  if (resolve(layout.dataDir) !== resolve(dataDir) || resolve(layout.runtimeDir) !== resolve(runtimeDir)) {
    throw invalid("Scan decision layout does not match its data and runtime directories");
  }
}

function createSnapshot(input: Omit<ScanStoreSnapshot, "schema" | "snapshotHash">): ScanStoreSnapshot {
  const unsigned = {
    schema: "openlifewiki.scan-store-snapshot/v1" as const,
    revision: input.revision,
    plan: structuredClone(input.plan),
    state: structuredClone(input.state),
    sourceBindings: structuredClone(input.sourceBindings),
    connectorStatuses: structuredClone(input.connectorStatuses),
    scratchCleanupRequired: input.scratchCleanupRequired,
    skeleton: structuredClone(input.skeleton),
    pendingLayer: structuredClone(input.pendingLayer),
    ledger: structuredClone(input.ledger),
    receipts: structuredClone(input.receipts),
    physicalIo: structuredClone(input.physicalIo),
  };
  const snapshot = { ...unsigned, snapshotHash: sha256Canonical(unsigned) };
  assertSnapshot(snapshot);
  return freeze(snapshot);
}

function assertSnapshot(value: unknown): ScanStoreSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) throw new Error("snapshot shape is invalid");
  if (value.schema !== "openlifewiki.scan-store-snapshot/v1"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || typeof value.snapshotHash !== "string"
    || !SHA256.test(value.snapshotHash)) {
    throw new Error("snapshot header is invalid");
  }
  const { snapshotHash, ...unsigned } = value;
  if (sha256Canonical(unsigned) !== snapshotHash) throw new Error("snapshotHash mismatch");
  assertScanPlan(value.plan);
  const plan = value.plan;
  assertState(value.state, plan);
  assertScratchCleanupState(value.scratchCleanupRequired, value.pendingLayer, value.state);
  assertLedger(value.ledger, plan);
  const receipts = assertReceipts(value.receipts, plan, value.ledger, value.state);
  assertConnectorStatuses(value.connectorStatuses, plan);
  assertSourceBindings(value.sourceBindings, plan, value.connectorStatuses);
  assertSkeletonStore(value.skeleton, plan, receipts, value.sourceBindings);
  assertPendingLayer(value.pendingLayer, plan, value.state, receipts, value.skeleton);
  assertPhysicalIo(value.physicalIo, receipts);
  assertLedgerReferences(value.ledger, receipts);
  return value as unknown as ScanStoreSnapshot;
}

function assertUpdate(current: ScanStoreSnapshot, proposed: ScanStoreUpdate): void {
  if (!isRecord(proposed) || !hasExactKeys(proposed, SNAPSHOT_KEYS)
    || proposed.schema !== "openlifewiki.scan-store-snapshot/v1") {
    throw new Error("Proposed scan snapshot shape is invalid");
  }
  assertScanPlan(proposed.plan);
  assertState(proposed.state, proposed.plan);
  assertScratchCleanupState(proposed.scratchCleanupRequired, proposed.pendingLayer, proposed.state);
  assertLedger(proposed.ledger, proposed.plan);
  const receipts = assertReceipts(proposed.receipts, proposed.plan, proposed.ledger, proposed.state);
  assertConnectorStatuses(proposed.connectorStatuses, proposed.plan);
  assertSourceBindings(proposed.sourceBindings, proposed.plan, proposed.connectorStatuses);
  assertSkeletonStore(proposed.skeleton, proposed.plan, receipts, proposed.sourceBindings);
  assertPendingLayer(proposed.pendingLayer, proposed.plan, proposed.state, receipts, proposed.skeleton);
  assertPhysicalIo(proposed.physicalIo, receipts);
  assertLedgerReferences(proposed.ledger, receipts);
  if (sha256Canonical(proposed.plan) !== sha256Canonical(current.plan)) {
    throw new Error("Scan Plan is immutable");
  }
  assertStateAdvance(current.state, proposed.state);
  assertConnectorStatusAppendOnly(current.connectorStatuses, proposed.connectorStatuses);
  if (current.sourceBindings.length > 0
    && sha256Canonical(current.sourceBindings) !== sha256Canonical(proposed.sourceBindings)) {
    throw new Error("Durable Source bindings are immutable");
  }
  assertSkeletonAppendOnly(current.skeleton, proposed.skeleton);
  assertPendingLayerAdvance(current.pendingLayer, proposed.pendingLayer, current.state, proposed.state);
  if (!current.scratchCleanupRequired && proposed.scratchCleanupRequired
    && !(current.state.phase === "Deciding" && proposed.state.phase === "Discovering"
      && current.pendingLayer !== null && proposed.pendingLayer === null)) {
    throw new Error("Scratch cleanup obligation may begin only with an atomic layer commit");
  }
  if (current.scratchCleanupRequired && !proposed.scratchCleanupRequired
    && sha256Canonical(current.state) !== sha256Canonical(proposed.state)) {
    throw new Error("Scratch cleanup recovery cannot mutate scan work state");
  }
  if (current.scratchCleanupRequired && proposed.scratchCleanupRequired
    && sha256Canonical(current) !== sha256Canonical(proposed)) {
    throw new Error("Pending scratch cleanup must settle before scan work can advance");
  }
  assertLedgerAppendOnly(current.ledger, proposed.ledger);
  assertReceiptAppendOnly(current.receipts, proposed.receipts);
  assertPhysicalIoAppendOnly(current.physicalIo, proposed.physicalIo);
  if (proposed.revision !== current.revision || proposed.snapshotHash !== current.snapshotHash) {
    throw new Error("Updater cannot forge revision or snapshotHash");
  }
}

function assertScratchCleanupState(
  value: unknown,
  pendingLayer: unknown,
  state: ScanState,
): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error("Scratch cleanup obligation is invalid");
  if (value && (pendingLayer !== null || state.phase === "Deciding")) {
    throw new Error("Committed scratch cleanup cannot overlap a pending layer");
  }
}

function assertState(value: unknown, plan: ScanPlan): asserts value is ScanState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "completed", "failureCode", "phase", "resumePhase", "retryPhase", "scanId", "schema", "transitionSequence",
  ])) throw new Error("Scan state shape is invalid");
  if (value.schema !== "openlifewiki.scan-state/v1"
    || value.scanId !== plan.scanId
    || !Number.isSafeInteger(value.transitionSequence)
    || Number(value.transitionSequence) < 0
    || typeof value.completed !== "boolean") throw new Error("Scan state binding is invalid");
  const phases = new Set([
    "Draft", "Probing", "Discovering", "Summarizing", "Deciding", "ReadingLeaves",
    "BuildingQMD", "VerifyingQMD", "PublishingQMD", "Paused", "Cancelled", "Failed", "Complete",
  ]);
  const workPhases = new Set([
    "Probing", "Discovering", "Summarizing", "Deciding", "ReadingLeaves",
    "BuildingQMD", "VerifyingQMD", "PublishingQMD",
  ]);
  if (!phases.has(String(value.phase))) throw new Error("Scan phase is invalid");
  if (value.completed !== (value.phase === "Complete")) throw new Error("Scan completion flag is invalid");
  if (!(value.resumePhase === null || workPhases.has(String(value.resumePhase)))
    || !(value.retryPhase === null || workPhases.has(String(value.retryPhase)))
    || !(value.failureCode === null || typeof value.failureCode === "string" && value.failureCode.length > 0)) {
    throw new Error("Scan recovery state is invalid");
  }
  if (value.phase === "Paused") {
    if (value.resumePhase === null || value.retryPhase !== null || value.failureCode !== null) {
      throw new Error("Paused scan recovery state is invalid");
    }
  } else if (value.phase === "Failed") {
    if (value.resumePhase !== null || value.retryPhase === null || value.failureCode === null) {
      throw new Error("Failed scan recovery state is invalid");
    }
  } else if (value.resumePhase !== null || value.retryPhase !== null || value.failureCode !== null) {
    throw new Error("Stable scan phase cannot retain recovery fields");
  }
}

function assertStateAdvance(current: ScanState, proposed: ScanState): void {
  if (sha256Canonical(current) === sha256Canonical(proposed)) return;
  if (proposed.transitionSequence !== current.transitionSequence + 1) {
    throw new Error("Scan state transition sequence must advance exactly once");
  }
  const events: ScanStateEvent[] = [
    { type: "approve-plan" }, { type: "probe-connected" }, { type: "layer-discovered" },
    { type: "layer-summarized" }, { type: "continue-discovery" }, { type: "frontier-discovered" },
    { type: "leaves-read" }, { type: "qmd-built" }, { type: "qmd-verified" }, { type: "qmd-published" },
    { type: "pause" }, { type: "resume" }, { type: "cancel" }, { type: "retry" },
  ];
  if (proposed.phase === "Failed" && proposed.retryPhase !== null && proposed.failureCode !== null) {
    events.push({ type: "fail", retryPhase: proposed.retryPhase, code: proposed.failureCode });
  }
  for (const event of events) {
    try {
      if (sha256Canonical(transitionScanState(current, event)) === sha256Canonical(proposed)) return;
    } catch {
      // Try the remaining legal events.
    }
  }
  throw new Error("Scan state update is not a legal transition");
}

function assertLedger(value: unknown, plan: ScanPlan): asserts value is ScanLedger {
  if (!isRecord(value) || !hasExactKeys(value, [
    "entries", "headHash", "scanId", "scanPlanHash", "schema", "skeletonVersion",
  ])) throw new Error("Scan ledger shape is invalid");
  if (value.schema !== "openlifewiki.scan-ledger/v1"
    || value.scanId !== plan.scanId
    || value.scanPlanHash !== plan.scanPlanHash
    || value.skeletonVersion !== plan.skeletonVersion
    || !Array.isArray(value.entries)) throw new Error("Scan ledger plan binding is invalid");
  let previous: string | null = null;
  const layers = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      "agentDecisionReceiptHashes", "agentInvocationReceiptHash", "agentResultHash", "batchHash",
      "committedAt", "entryHash", "intentId", "parentNodeId", "previousEntryHash", "scanId",
      "scanPlanHash", "schema", "sequence", "skeletonVersion", "sourceId",
      "summaryReceiptHash", "systemOutcomeReceiptHashes",
    ])) throw new Error("Scan ledger entry is invalid");
    const { entryHash, ...unsigned } = entry;
    if (entry.schema !== "openlifewiki.scan-ledger-entry/v1"
      || entry.scanId !== plan.scanId
      || entry.scanPlanHash !== plan.scanPlanHash
      || entry.skeletonVersion !== plan.skeletonVersion
      || entry.sequence !== index + 1
      || entry.previousEntryHash !== previous
      || typeof entryHash !== "string"
      || sha256Canonical(unsigned) !== entryHash) throw new Error("Scan ledger hash chain is invalid");
    const batch = {
      summaryReceiptHash: entry.summaryReceiptHash,
      agentInvocationReceiptHash: entry.agentInvocationReceiptHash,
      agentResultHash: entry.agentResultHash,
      agentDecisionReceiptHashes: entry.agentDecisionReceiptHashes,
      systemOutcomeReceiptHashes: entry.systemOutcomeReceiptHashes,
    };
    if (typeof entry.sourceId !== "string"
      || !plan.sourceIds.includes(entry.sourceId)
      || typeof entry.parentNodeId !== "string"
      || typeof entry.intentId !== "string"
      || typeof entry.summaryReceiptHash !== "string"
      || !SHA256.test(entry.summaryReceiptHash)
      || typeof entry.agentInvocationReceiptHash !== "string"
      || !SHA256.test(entry.agentInvocationReceiptHash)
      || typeof entry.agentResultHash !== "string"
      || !SHA256.test(entry.agentResultHash)
      || !Array.isArray(entry.agentDecisionReceiptHashes)
      || !Array.isArray(entry.systemOutcomeReceiptHashes)
      || [...entry.agentDecisionReceiptHashes, ...entry.systemOutcomeReceiptHashes]
        .some((hash) => typeof hash !== "string" || !SHA256.test(hash))
      || typeof entry.batchHash !== "string"
      || sha256Canonical(batch) !== entry.batchHash
      || typeof entry.committedAt !== "string"
      || !Number.isFinite(Date.parse(entry.committedAt))) {
      throw new Error("Scan ledger batch is invalid");
    }
    const layerKey = `${entry.sourceId}\0${entry.parentNodeId}`;
    if (layers.has(layerKey)) throw new Error("Scan ledger layer is duplicated");
    layers.add(layerKey);
    previous = entryHash;
  });
  if (value.headHash !== previous) throw new Error("Scan ledger headHash is invalid");
}

function assertLedgerAppendOnly(current: ScanLedger, proposed: ScanLedger): void {
  if (proposed.entries.length < current.entries.length) throw new Error("Scan ledger cannot remove entries");
  current.entries.forEach((entry, index) => {
    if (sha256Canonical(proposed.entries[index]) !== sha256Canonical(entry)) {
      throw new Error("Scan ledger cannot rewrite committed entries");
    }
  });
}

function assertReceipts(
  value: unknown,
  plan: ScanPlan,
  ledger: ScanLedger,
  state: ScanState,
): readonly ScanStoreReceipt[] {
  if (!Array.isArray(value)) throw new Error("Scan receipts must be an array");
  const hashes = new Set<string>();
  const receipts = value.map((receipt) => {
    if (!isRecord(receipt)
      || typeof receipt.schema !== "string"
      || !hasExactKeys(receipt, B2_RECEIPT_KEYS.get(receipt.schema) ?? [])) {
      throw new Error("Scan receipt does not match an exact B2 schema");
    }
    assertReceiptSchemaShape(receipt);
    const { receiptHash, ...unsigned } = receipt;
    if (typeof receiptHash !== "string"
      || !SHA256.test(receiptHash)
      || sha256Canonical(unsigned) !== receiptHash) throw new Error("Scan receipt self-hash is invalid");
    const hash = receiptHash;
    if (hashes.has(hash)) throw new Error("Scan receipt is duplicated");
    hashes.add(hash);
    if (receipt.scanId !== plan.scanId
      || receipt.scanPlanHash !== plan.scanPlanHash
      || receipt.skeletonVersion !== plan.skeletonVersion) {
      throw new Error("Scan receipt does not bind the active plan and skeleton");
    }
    if (typeof receipt.sourceId === "string" && !plan.sourceIds.includes(receipt.sourceId)) {
      throw new Error("Scan receipt Source is outside the active plan");
    }
    return receipt;
  });
  assertReceiptRelationships(receipts, plan, ledger, state);
  return receipts;
}

function assertReceiptSchemaShape(receipt: Record<string, unknown>): void {
  const timestamp = (field: string): boolean => typeof receipt[field] === "string" && Number.isFinite(Date.parse(receipt[field]));
  const hash = (field: string): boolean => typeof receipt[field] === "string" && SHA256.test(receipt[field]);
  const text = (field: string): boolean => typeof receipt[field] === "string" && receipt[field].length > 0;
  const identifier = (field: string): boolean => typeof receipt[field] === "string" && SCAN_ID.test(receipt[field]);
  const boundedText = (field: string): boolean => typeof receipt[field] === "string"
    && receipt[field].length > 0 && receipt[field].length <= 8_192;
  switch (receipt.schema) {
    case "openlifewiki.enumeration-intent/v1":
      if (!text("intentId") || !text("targetNodeId") || !text("targetNodeVersion") || !hash("authorizationHash")
        || !hash("inputSetHash") || !timestamp("createdAt")) throw new Error("Enumeration Intent shape is invalid");
      break;
    case "openlifewiki.enumeration-page-receipt/v1":
      if (!text("intentId") || !Number.isSafeInteger(receipt.pageSequence) || Number(receipt.pageSequence) < 1
        || !Number.isSafeInteger(receipt.eventSequence) || Number(receipt.eventSequence) < 1
        || !(receipt.previousPageReceiptHash === null || hash("previousPageReceiptHash"))
        || !Array.isArray(receipt.discoveredNodeIds) || !Array.isArray(receipt.knownUnenumeratedSlotIds)
        || receipt.discoveredNodeIds.some((value) => typeof value !== "string" || !SCAN_ID.test(value))
        || receipt.knownUnenumeratedSlotIds.some((value) => typeof value !== "string" || !SHA256.test(value))
        || !hash("requestScopeHash")
        || !hash("discoveredMetadataHash")
        || !(receipt.nextCursor === null || boundedText("nextCursor"))
        || !["known", "estimated", "unknown"].includes(String(receipt.childCountKind))
        || !["open", "complete", "blocked"].includes(String(receipt.state))
        || !(receipt.childSetHash === null || hash("childSetHash"))
        || !timestamp("observedAt")) throw new Error("Enumeration page receipt shape is invalid");
      break;
    case "openlifewiki.layer-summary-receipt/v1":
      if (!text("intentId") || !hash("summaryHash") || !hash("childSetHash") || !hash("inputSetHash")
        || !timestamp("persistedAt")) throw new Error("Layer Summary receipt shape is invalid");
      break;
    case "openlifewiki.agent-scan-invocation-receipt/v1": {
      const agent = receipt.agent;
      if (!isRecord(agent) || !hasExactKeys(agent, ["driverContractVersion", "id", "mode", "runtime"])
        || Object.values(agent).some((value) => typeof value !== "string" || value.length === 0)
        || !["native-cli", "provider-runtime"].includes(String(agent.mode))
        || !text("sourceId") || !hash("layerHash") || !hash("inputSetHash") || !hash("skillHash")
        || !hash("outputSchemaHash") || !hash("resultHash") || !text("operationId") || !text("runtimeVersion")
        || receipt.outputSchemaId !== "openlifewiki.agent-scan-result/v1" || !timestamp("invokedAt")) {
        throw new Error("Agent invocation receipt shape is invalid");
      }
      break;
    }
    case "openlifewiki.agent-attempt-reservation/v1":
      if (!identifier("operationId") || !hash("inputSetHash") || !hash("selectedAgentConfigHash")
        || !Number.isSafeInteger(receipt.attemptNumber) || Number(receipt.attemptNumber) < 1
        || !timestamp("reservedAt")) {
        throw new Error("Agent attempt reservation shape is invalid");
      }
      break;
    case "openlifewiki.scan-plan-owner-approval/v1":
      if (receipt.approvedBy !== "human:owner" || !hash("ownerIdentityFingerprint")
        || !hash("previewHash") || !hash("approvalHash")
        || !Number.isSafeInteger(receipt.hostConfigRevision) || Number(receipt.hostConfigRevision) < 0
        || !timestamp("approvedAt")) {
        throw new Error("ScanPlan Owner approval shape is invalid");
      }
      break;
    case "openlifewiki.scan-decision/v1": {
      const cost = receipt.estimatedCost;
      const decision = receipt.decision;
      const validOutcomeFields = (decision === "skip" || decision === "descend")
        ? receipt.question === null && receipt.revisitCondition === null
        : decision === "defer"
          ? receipt.question === null && boundedText("revisitCondition")
          : decision === "ask-user"
            ? boundedText("question") && receipt.revisitCondition === null
            : false;
      if (!isRecord(cost) || !hasExactKeys(cost, ["agentCalls", "bodyBytes", "nodes"])
        || Object.values(cost).some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
        || !hash("authorizationHash") || !hash("childSetHash") || !hash("summaryHash") || !hash("inputSetHash")
        || !identifier("sourceId") || !identifier("parentNodeId") || !boundedText("parentNodeVersion")
        || !identifier("nodeId") || !boundedText("nodeVersion") || !boundedText("reason") || !identifier("actor")
        || !["descend", "skip", "defer", "ask-user"].includes(String(decision))
        || !["container", "leaf"].includes(String(receipt.targetKind)) || !validOutcomeFields
        || !timestamp("persistedAt")) throw new Error("Scan decision receipt shape is invalid");
      break;
    }
    case "openlifewiki.scan-system-outcome/v1":
      if (!text("nodeId") || !text("code") || !["blocked", "failed", "unknown"].includes(String(receipt.outcome))
        || !["discovery", "summarization", "selectedScan", "committedIndex"].includes(String(receipt.phase))
        || !timestamp("persistedAt")) throw new Error("System outcome receipt shape is invalid");
      break;
    case "openlifewiki.body-budget-reservation/v1": {
      const { receiptHash: _receiptHash, ...draft } = receipt;
      createBodyBudgetReservationReceipt(draft as Parameters<typeof createBodyBudgetReservationReceipt>[0]);
      break;
    }
    case "openlifewiki.leaf-selection/v1":
      if (!hash("authorizationHash") || !hash("inputSetHash") || !hash("decisionReceiptHash")
        || !text("sourceId") || !text("nodeId") || !text("nodeVersion") || !text("actor") || !text("reason")
        || !timestamp("persistedAt")) throw new Error("Leaf selection receipt shape is invalid");
      break;
    case "openlifewiki.body-observation-receipt/v1":
      if (!hash("authorizationHash") || !hash("inputSetHash") || !hash("selectionReceiptHash") || !hash("contentHash")
        || !Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 0 || !timestamp("observedAt")) {
        throw new Error("Body observation receipt shape is invalid");
      }
      break;
    case "openlifewiki.body-read-commit/v1":
      if (!text("sourceId") || !text("nodeId") || !text("nodeVersion")
        || !hash("reservationReceiptHash") || !hash("observationReceiptHash")
        || !Number.isSafeInteger(receipt.scanTransitionSequence)
        || Number(receipt.scanTransitionSequence) < 0 || !timestamp("committedAt")) {
        throw new Error("Body read commit receipt shape is invalid");
      }
      break;
    case "openlifewiki.body-read-epoch-boundary/v1":
      if (!(["pause", "resume", "cancel", "fail", "retry"] as const).includes(
        receipt.event as ScanControlEvent["type"],
      ) || !Number.isSafeInteger(receipt.fromTransitionSequence)
        || !Number.isSafeInteger(receipt.toTransitionSequence)
        || Number(receipt.fromTransitionSequence) < 0
        || receipt.toTransitionSequence !== Number(receipt.fromTransitionSequence) + 1
        || !timestamp("persistedAt")) {
        throw new Error("Body read epoch boundary receipt shape is invalid");
      }
      break;
    default:
      throw new Error("Scan receipt schema is outside B2");
  }
}

function assertReceiptRelationships(
  receipts: readonly ScanStoreReceipt[],
  plan: ScanPlan,
  ledger: ScanLedger,
  state: ScanState,
): void {
  const durableDecisionHashes = new Set(ledger.entries.flatMap(({ agentDecisionReceiptHashes }) => agentDecisionReceiptHashes));
  const durableSummaryHashes = new Set(ledger.entries.map(({ summaryReceiptHash }) => summaryReceiptHash));
  const durableInvocationHashes = new Set(ledger.entries.map(({ agentInvocationReceiptHash }) => agentInvocationReceiptHash));
  const durableSystemHashes = new Set(ledger.entries.flatMap(({ systemOutcomeReceiptHashes }) => systemOutcomeReceiptHashes));
  const attempts = receiptsBySchema(
    receipts,
    "openlifewiki.agent-attempt-reservation/v1",
  ) as AgentAttemptReservationReceipt[];
  attempts.forEach((attempt, index) => {
    if (attempt.attemptNumber !== index + 1
      || attempt.selectedAgentConfigHash !== plan.selectedAgentConfigHash) {
      throw new Error("Agent attempt reservation sequence or selected Agent binding is invalid");
    }
  });
  const approvals = receiptsBySchema(
    receipts,
    "openlifewiki.scan-plan-owner-approval/v1",
  ) as ScanPlanOwnerApprovalReceipt[];
  if (approvals.length > 1) throw new Error("ScanPlan Owner approval receipt must be unique");
  approvals.forEach((approval) => assertScanPlanOwnerApproval(approval, plan));
  if (state.phase !== "Draft" && approvals.length !== 1) {
    throw new Error("Active scan state requires its exact Owner-approved ScanPlan receipt");
  }
  for (const receipt of receipts) {
    const schema = schemaOf(receipt);
    const hash = artifactHash(receipt);
    if ((schema === "openlifewiki.layer-summary-receipt/v1" && !durableSummaryHashes.has(String(hash)))
      || (schema === "openlifewiki.agent-scan-invocation-receipt/v1" && !durableInvocationHashes.has(String(hash)))
      || (schema === "openlifewiki.scan-decision/v1" && !durableDecisionHashes.has(String(hash)))
      || (schema === "openlifewiki.scan-system-outcome/v1" && !durableSystemHashes.has(String(hash)))) {
      throw new Error("Layer receipt is not committed by the Core ledger");
    }
  }
  const decisions = (receiptsBySchema(receipts, "openlifewiki.scan-decision/v1") as ScanDecision[])
    .filter(({ receiptHash }) => durableDecisionHashes.has(receiptHash));
  const intents = receiptsBySchema(receipts, "openlifewiki.enumeration-intent/v1") as EnumerationIntent[];
  for (const intent of intents) {
    assertEnumerationIntent(intent, { plan, trustedDecisionReceipts: decisions });
  }
  assertEnumerationIntentUniqueness(intents);
  for (const selectionValue of receiptsBySchema(receipts, "openlifewiki.leaf-selection/v1")) {
    const selection = selectionValue as LeafSelectionReceipt;
    const decision = decisions.find(({ receiptHash }) => receiptHash === selection.decisionReceiptHash);
    if (decision === undefined || decision.decision !== "descend" || decision.targetKind !== "leaf"
      || decision.sourceId !== selection.sourceId || decision.nodeId !== selection.nodeId
      || decision.nodeVersion !== selection.nodeVersion || decision.authorizationHash !== selection.authorizationHash
      || decision.inputSetHash !== selection.inputSetHash) throw new Error("Leaf selection lacks its exact durable descend decision");
  }
  const selections = receiptsBySchema(receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[];
  for (const entry of ledger.entries) {
    const matchingIntents = intents.filter(({ intentId }) => intentId === entry.intentId);
    const intent = matchingIntents[0];
    const summary = (receiptsBySchema(receipts, "openlifewiki.layer-summary-receipt/v1") as LayerSummaryReceipt[])
      .find(({ receiptHash }) => receiptHash === entry.summaryReceiptHash);
    const invocation = (receiptsBySchema(receipts, "openlifewiki.agent-scan-invocation-receipt/v1") as AgentScanInvocationReceipt[])
      .find(({ receiptHash }) => receiptHash === entry.agentInvocationReceiptHash);
    if (matchingIntents.length !== 1 || intent === undefined || summary === undefined || invocation === undefined
      || intent.sourceId !== entry.sourceId || intent.targetNodeId !== entry.parentNodeId
      || summary.sourceId !== entry.sourceId || summary.intentId !== entry.intentId
      || invocation.sourceId !== entry.sourceId || invocation.inputSetHash !== summary.inputSetHash
      || invocation.resultHash !== entry.agentResultHash) {
      throw new Error("Scan ledger entry does not bind one exact durable intent, Source, parent, summary and invocation");
    }
    const layerDecisions = decisions.filter(({ receiptHash }) => entry.agentDecisionReceiptHashes.includes(receiptHash));
    const layerSystemOutcomes = (receiptsBySchema(receipts, "openlifewiki.scan-system-outcome/v1") as ScanSystemOutcomeReceipt[])
      .filter(({ receiptHash }) => entry.systemOutcomeReceiptHashes.includes(receiptHash));
    if (layerDecisions.length !== entry.agentDecisionReceiptHashes.length
      || new Set(entry.agentDecisionReceiptHashes).size !== entry.agentDecisionReceiptHashes.length
      || layerSystemOutcomes.length !== entry.systemOutcomeReceiptHashes.length
      || new Set(entry.systemOutcomeReceiptHashes).size !== entry.systemOutcomeReceiptHashes.length
      || layerDecisions.some((decision) => decision.sourceId !== entry.sourceId
        || decision.parentNodeId !== entry.parentNodeId
        || decision.summaryHash !== summary.summaryHash
        || decision.childSetHash !== summary.childSetHash
        || decision.inputSetHash !== summary.inputSetHash)
      || layerSystemOutcomes.some((outcome) => outcome.sourceId !== entry.sourceId)) {
      throw new Error("Scan ledger layer outcomes do not bind the exact committed layer");
    }
    for (const decision of layerDecisions) {
      const derivedIntents = intents.filter(({ decisionReceiptHash }) => decisionReceiptHash === decision.receiptHash);
      const derivedSelections = selections.filter(({ decisionReceiptHash }) => decisionReceiptHash === decision.receiptHash);
      if (decision.decision !== "descend") {
        if (derivedIntents.length > 0 || derivedSelections.length > 0) {
          throw new Error("Non-descend decision cannot own a derived frontier action");
        }
        continue;
      }
      if (decision.targetKind === "container") {
        const expected = createEnumerationIntent({
          plan,
          trustedDecisionReceiptHashes: layerDecisions.map(({ receiptHash }) => receiptHash),
          decisionReceipt: decision,
          intent: {
            schema: "openlifewiki.enumeration-intent/v1",
            intentId: `intent_${decision.receiptHash.slice("sha256:".length, "sha256:".length + 32)}`,
            sourceId: decision.sourceId,
            targetNodeId: decision.nodeId,
            targetNodeVersion: decision.nodeVersion,
            authorizationHash: decision.authorizationHash,
            origin: "container-descend",
            parentLayerNodeId: decision.parentNodeId,
            childSetHash: decision.childSetHash,
            inputSetHash: decision.inputSetHash,
            createdAt: entry.committedAt,
          },
        });
        if (derivedIntents.length !== 1 || sha256Canonical(derivedIntents[0]) !== sha256Canonical(expected)
          || derivedSelections.length !== 0) {
          throw new Error("Container frontier action does not match its canonical committed decision");
        }
      } else {
        const expected = createLeafSelectionReceipt({
          plan,
          trustedDecisionReceiptHashes: layerDecisions.map(({ receiptHash }) => receiptHash),
          decisionReceipt: decision,
          actor: "openlifewiki",
          reason: decision.reason,
          persistedAt: entry.committedAt,
        });
        if (derivedSelections.length !== 1 || sha256Canonical(derivedSelections[0]) !== sha256Canonical(expected)
          || derivedIntents.length !== 0) {
          throw new Error("Leaf selection does not match its canonical committed decision");
        }
      }
    }
  }
  const observations = receiptsBySchema(receipts, "openlifewiki.body-observation-receipt/v1") as BodyObservationReceipt[];
  const reservations = receiptsBySchema(receipts, "openlifewiki.body-budget-reservation/v1") as BodyBudgetReservationReceipt[];
  for (const reservation of reservations) {
    if (!selections.some((selection) => selection.sourceId === reservation.sourceId
      && selection.nodeId === reservation.nodeId && selection.nodeVersion === reservation.nodeVersion
      && selection.authorizationHash === reservation.authorizationHash)) {
      throw new Error("Body budget reservation lacks its exact durable selected leaf");
    }
  }
  replayBodyBudgetReservations(receipts, state.transitionSequence);
  const observedNodeVersions = new Set<string>();
  for (const observation of observations) {
    const selection = selections.find(({ receiptHash }) => receiptHash === observation.selectionReceiptHash);
    const previous = observation.previousObservationReceiptHash === null ? null
      : observations.find(({ receiptHash }) => receiptHash === observation.previousObservationReceiptHash) ?? null;
    const nodeVersionKey = `${observation.sourceId}\0${observation.nodeId}\0${observation.nodeVersion}`;
    if (selection === undefined || observedNodeVersions.has(nodeVersionKey)
      || observation.purpose !== "initial-read") {
      throw new Error("B2 Body observation lacks its exact durable selection or uses an unavailable rematerialization path");
    }
    observedNodeVersions.add(nodeVersionKey);
    assertBodyObservationReceipt(observation, {
      plan,
      trustedSelectionReceiptHashes: selections.map(({ receiptHash }) => receiptHash),
      selectionReceipt: selection,
      previousObservationReceipt: previous,
    });
  }
}

function durableLeafSelection(
  snapshot: ScanStoreSnapshot,
  sourceId: string,
  nodeId: string,
  nodeVersion: string,
  authorizationHash: string,
): LeafSelectionReceipt | undefined {
  return (receiptsBySchema(snapshot.receipts, "openlifewiki.leaf-selection/v1") as LeafSelectionReceipt[])
    .find((selection) => selection.sourceId === sourceId && selection.nodeId === nodeId
      && selection.nodeVersion === nodeVersion && selection.authorizationHash === authorizationHash);
}

function activeBodyBudgetReservations(
  receipts: readonly ScanStoreReceipt[],
  maxTransitionSequence: number,
): BodyBudgetReservationReceipt[] {
  return [...replayBodyBudgetReservations(receipts, maxTransitionSequence).values()];
}

function currentActiveBodyBudgetReservations(snapshot: ScanStoreSnapshot): BodyBudgetReservationReceipt[] {
  if (snapshot.state.phase !== "ReadingLeaves") return [];
  return activeBodyBudgetReservations(snapshot.receipts, snapshot.state.transitionSequence)
    .filter(({ scanTransitionSequence }) => scanTransitionSequence === snapshot.state.transitionSequence);
}

function replayBodyBudgetReservations(
  receipts: readonly ScanStoreReceipt[],
  maxTransitionSequence: number,
): ReadonlyMap<string, BodyBudgetReservationReceipt> {
  const latest = new Map<string, BodyBudgetReservationReceipt>();
  const observedReceiptHashes: string[] = [];
  const counters = {
    initialReadItems: 0,
    initialReadBytes: 0,
    rematerializedItems: 0,
    rematerializedBytes: 0,
  };
  let epochFloor = 0;
  for (const [index, receipt] of receipts.entries()) {
    if (schemaOf(receipt) === "openlifewiki.body-budget-reservation/v1") {
      const reservation = receipt as BodyBudgetReservationReceipt;
      if (reservation.scanTransitionSequence < epochFloor
        || reservation.scanTransitionSequence > maxTransitionSequence) {
        throw new Error("Body budget reservation is outside the durable scan epoch range");
      }
      const key = bodyWorkKey(reservation.sourceId, reservation.nodeId, reservation.nodeVersion);
      const previous = latest.get(key);
      if (previous?.scanTransitionSequence === reservation.scanTransitionSequence) {
        throw new Error("A JIT body budget reservation cannot be replaced in the same scan epoch");
      }
      const currentEpoch = [...latest.values()].filter(
        ({ scanTransitionSequence }) => scanTransitionSequence === reservation.scanTransitionSequence,
      );
      if (currentEpoch.length > 0) {
        throw new Error("Only one JIT body budget reservation may be active per scan epoch");
      }
      latest.set(key, reservation);
    } else if (schemaOf(receipt) === "openlifewiki.body-observation-receipt/v1") {
      const observation = receipt as BodyObservationReceipt;
      const key = bodyWorkKey(observation.sourceId, observation.nodeId, observation.nodeVersion);
      const reservation = latest.get(key);
      const commitValue = receipts[index + 1];
      const commit = schemaOf(commitValue ?? {}) === "openlifewiki.body-read-commit/v1"
        ? commitValue as BodyReadCommitReceipt
        : undefined;
      if (reservation === undefined
        || commit === undefined
        || reservation.sourceId !== observation.sourceId
        || reservation.nodeId !== observation.nodeId
        || reservation.nodeVersion !== observation.nodeVersion
        || reservation.authorizationHash !== observation.authorizationHash
        || reservation.physicalIoAccountingHash !== sha256Canonical({
          schema: "openlifewiki.scan-physical-io/v1",
          observedReceiptHashes,
          counters,
        })
        || observation.bytes > reservation.reservedBytes) {
        throw new Error("Body observation does not consume the latest active JIT reservation");
      }
      assertBodyReadCommit(commit, observation, reservation);
      latest.delete(key);
      observedReceiptHashes.push(observation.receiptHash);
      if (observation.purpose === "initial-read") {
        counters.initialReadItems += 1;
        counters.initialReadBytes += observation.bytes;
      } else {
        counters.rematerializedItems += 1;
        counters.rematerializedBytes += observation.bytes;
      }
    } else if (schemaOf(receipt) === "openlifewiki.body-read-commit/v1") {
      if (schemaOf(receipts[index - 1] ?? {}) !== "openlifewiki.body-observation-receipt/v1") {
        throw new Error("Body read commit must immediately follow its observation");
      }
    } else if (schemaOf(receipt) === "openlifewiki.body-read-epoch-boundary/v1") {
      const boundary = receipt as BodyReadEpochBoundaryReceipt;
      if (boundary.fromTransitionSequence < epochFloor
        || boundary.fromTransitionSequence > maxTransitionSequence
        || boundary.toTransitionSequence > maxTransitionSequence) {
        throw new Error("Body read epoch boundary is outside the durable monotonic state range");
      }
      epochFloor = boundary.toTransitionSequence;
      latest.clear();
    }
  }
  return latest;
}

function bodyWorkKey(sourceId: string, nodeId: string, nodeVersion: string): string {
  return `${sourceId}\0${nodeId}\0${nodeVersion}`;
}

function assertEnumerationIntentUniqueness(intents: readonly EnumerationIntent[]): void {
  const intentIds = new Set<string>();
  const rootSources = new Set<string>();
  const targetVersions = new Set<string>();
  const decisionReceiptHashes = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.intentId)) throw new Error("Enumeration Intent ID is duplicated");
    intentIds.add(intent.intentId);
    if (intent.origin === "authorized-root") {
      if (rootSources.has(intent.sourceId)) {
        throw new Error("Each Source can have only one authorized-root Enumeration Intent");
      }
      rootSources.add(intent.sourceId);
    }
    const targetVersion = `${intent.sourceId}\0${intent.targetNodeId}\0${intent.targetNodeVersion}`;
    if (targetVersions.has(targetVersion)) {
      throw new Error("Enumeration Intent target and version must be unique per Source");
    }
    targetVersions.add(targetVersion);
    if (intent.decisionReceiptHash !== null) {
      if (decisionReceiptHashes.has(intent.decisionReceiptHash)) {
        throw new Error("Each descend decision can create only one Enumeration Intent");
      }
      decisionReceiptHashes.add(intent.decisionReceiptHash);
    }
  }
}

function assertReceiptAppendOnly(
  current: readonly ScanStoreReceipt[],
  proposed: readonly ScanStoreReceipt[],
): void {
  if (proposed.length < current.length) throw new Error("Durable scan receipts cannot be removed");
  current.forEach((receipt, index) => {
    if (sha256Canonical(proposed[index]) !== sha256Canonical(receipt)) {
      throw new Error("Durable scan receipts cannot be rewritten or reordered");
    }
  });
}

function assertPhysicalIo(value: unknown, receipts: readonly ScanStoreReceipt[]): void {
  if (!isRecord(value) || !hasExactKeys(value, ["counters", "observedReceiptHashes", "schema"])
    || value.schema !== "openlifewiki.scan-physical-io/v1"
    || !Array.isArray(value.observedReceiptHashes)
    || !isRecord(value.counters)
    || !hasExactKeys(value.counters, [
      "initialReadBytes", "initialReadItems", "rematerializedBytes", "rematerializedItems",
    ])) throw new Error("Physical I/O accounting shape is invalid");
  const observations = new Map<string, BodyObservationReceipt>();
  const observationOrder: string[] = [];
  for (const receipt of receipts) {
    const record = receipt as Record<string, unknown>;
    if (record.schema === "openlifewiki.body-observation-receipt/v1") {
      const hash = String(record.receiptHash);
      observations.set(hash, record as unknown as BodyObservationReceipt);
      observationOrder.push(hash);
    }
  }
  if (sha256Canonical(value.observedReceiptHashes) !== sha256Canonical(observationOrder)) {
    throw new Error("Physical I/O accounting must cover the exact durable body observation set in order");
  }
  const seen = new Set<string>();
  const expected = {
    initialReadItems: 0,
    initialReadBytes: 0,
    rematerializedItems: 0,
    rematerializedBytes: 0,
  };
  for (const hash of value.observedReceiptHashes) {
    if (typeof hash !== "string" || seen.has(hash)) throw new Error("Physical I/O receipt is invalid or duplicated");
    seen.add(hash);
    const observation = observations.get(hash);
    if (observation === undefined || !Number.isSafeInteger(observation.bytes) || observation.bytes < 0) {
      throw new Error("Physical I/O accounting references no valid observation");
    }
    if (observation.purpose === "initial-read") {
      expected.initialReadItems += 1;
      expected.initialReadBytes += observation.bytes;
    } else if (observation.purpose === "qmd-rematerialization") {
      expected.rematerializedItems += 1;
      expected.rematerializedBytes += observation.bytes;
    } else throw new Error("Body observation purpose is invalid");
  }
  if (sha256Canonical(value.counters) !== sha256Canonical(expected)) {
    throw new Error("Physical I/O counters are not derived from observed receipts");
  }
}

function assertPhysicalIoAppendOnly(
  current: PhysicalIoAccounting,
  proposed: PhysicalIoAccounting,
): void {
  if (proposed.observedReceiptHashes.length < current.observedReceiptHashes.length) {
    throw new Error("Physical I/O observations cannot be removed");
  }
  current.observedReceiptHashes.forEach((hash, index) => {
    if (proposed.observedReceiptHashes[index] !== hash) {
      throw new Error("Physical I/O observations cannot be rewritten or reordered");
    }
  });
  for (const key of [
    "initialReadItems", "initialReadBytes", "rematerializedItems", "rematerializedBytes",
  ] as const) {
    if (proposed.counters[key] < current.counters[key]) {
      throw new Error("Physical I/O counters cannot decrease");
    }
  }
}

function assertLedgerReferences(ledger: ScanLedger, receipts: readonly ScanStoreReceipt[]): void {
  const hashes = new Set(receiptHashes(receipts));
  for (const entry of ledger.entries) {
    const referenced = [
      entry.summaryReceiptHash,
      entry.agentInvocationReceiptHash,
      ...entry.agentDecisionReceiptHashes,
      ...entry.systemOutcomeReceiptHashes,
    ];
    if (referenced.some((hash) => !hashes.has(hash))) {
      throw new Error("Scan ledger references a receipt outside the durable receipt set");
    }
  }
}

async function persist(path: string, snapshot: ScanStoreSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeJsonAtomic(path, snapshot);
}

async function withScanLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let token: string | undefined;
  let inode: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(candidate, { mode: 0o700 });
      try {
        const details = await stat(candidate);
        token = randomUUID();
        inode = details.ino;
        await writeJsonAtomic(join(candidate, "owner.json"), {
          pid: process.pid,
          token,
          inode,
          createdAt: new Date().toISOString(),
        });
        if (await directoryEntryExists(lockPath)) {
          throw Object.assign(new Error("Scan lock already exists"), { code: "EEXIST" });
        }
        await rename(candidate, lockPath);
      } catch (error) {
        await rm(candidate, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      token = undefined;
      inode = undefined;
      await rm(candidate, { recursive: true, force: true });
      const observed = await readLockIdentity(lockPath);
      if (observed !== undefined && !processIsAlive(observed.pid) && await takeOverStaleLock(lockPath, observed)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (token === undefined || inode === undefined) throw conflict("Scan state is locked by another writer");
  try {
    return await operation();
  } finally {
    try {
      const current = await stat(lockPath);
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
      if (current.ino === inode && owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch {
      // A replaced or already-released lock is not ours to remove.
    }
  }
}

interface ScanLockIdentity {
  readonly pid: number;
  readonly token: string;
  readonly inode: number;
}

async function readLockIdentity(lockPath: string): Promise<ScanLockIdentity | undefined> {
  try {
    const details = await stat(lockPath);
    try {
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        pid?: unknown;
        token?: unknown;
        inode?: unknown;
      };
      if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== "string" || owner.token.length === 0 || owner.inode !== details.ino) {
        return undefined;
      }
      return {
        pid: owner.pid,
        token: owner.token,
        inode: details.ino,
      };
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      return undefined;
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function takeOverStaleLock(
  lockPath: string,
  observed: ScanLockIdentity,
): Promise<boolean> {
  const current = await readLockIdentity(lockPath);
  if (!sameLock(current, observed)) return false;
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const moved = await readLockIdentity(quarantine);
  if (!sameLock(moved, observed)) {
    try {
      await rename(quarantine, lockPath);
    } catch {
      // A different writer already owns the lock path.
    }
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

function sameLock(
  left: ScanLockIdentity | undefined,
  right: ScanLockIdentity,
): boolean {
  return left !== undefined && left.inode === right.inode && left.token === right.token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertScanId(scanId: string): void {
  if (!SCAN_ID.test(scanId)) throw invalid("scanId is invalid");
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function directoryEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function conflict(message: string): AdapterError {
  return new AdapterError("SCAN_CONFLICT", message);
}

function invalid(message: string, cause?: unknown): AdapterError {
  return new AdapterError("SCAN_INVALID", message, cause === undefined ? undefined : { cause });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
