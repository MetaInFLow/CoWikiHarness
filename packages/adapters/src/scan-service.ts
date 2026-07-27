import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentScanInputSetHash,
  buildSkeletonTrustedChildren,
  createAgentScanInvocationReceipt,
  createScanSystemOutcomeReceipt,
  createPolicyResolutionHash,
  getAgentIoSchemaHash,
  sha256Canonical,
  type ActiveQmdManifestReceipt,
  type AgentScanInputContext,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type BodyObservationReceipt,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type LayerSummaryReceipt,
  type LeafSelectionReceipt,
  type RuntimeLayout,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanSystemOutcomeReceipt,
  type SkeletonNode,
  type PriorityDocumentReferenceV1,
} from "@openlifewiki/protocol";
import {
  calculateScanProgress,
  deriveScanProgress,
  resolveAgentScanPolicy,
  resolveScanPolicy,
  type CalculatedScanProgress,
} from "@openlifewiki/core";

import { AgentService } from "./agent-service.js";
import { CodexNativeAgentDriver } from "./agents/codex-native.js";
import type { AgentLayerSummary } from "./agents/agent-driver.js";
import { readConfigSnapshot } from "./config-store.js";
import {
  localFolderConnector,
  progressiveConnectorScopeHash,
  type ProgressiveConnectorProvider,
} from "./connectors/index.js";
import { AdapterError } from "./errors.js";
import { authorizePriorityDocumentReference } from "./priority-reference.js";
import { readScanLayerSummary } from "./scan-scratch.js";
import { bindHostScanPolicy, loadWikiScanPolicy } from "./scan-policy-loader.js";
import {
  beginScanLayerDecision,
  closeScanFrontier,
  commitScanLayerOutcome,
  controlScan,
  readScanStore,
  recoverScanScratchCleanup,
  recordScanEnumerationPage,
  recordScanProbeConnected,
  recordScanSourceRoots,
  type ScanControlEvent,
  type ScanStoreReceipt,
  type ScanStoreSnapshot,
  type ScanWorkspaceView,
} from "./scan-store.js";

const CANONICAL_PROGRESSIVE_SCAN_SKILL = new URL(
  "../../../skills/openlifewiki-progressive-scan/SKILL.md",
  import.meta.url,
);

export interface LocalScanServiceOptions {
  readonly configPath: string;
  readonly layout: RuntimeLayout;
  readonly provider?: ProgressiveConnectorProvider;
  readonly agentService?: Pick<AgentService, "decideScan">;
  readonly now?: () => Date;
  readonly pageSize?: number;
}

export type ScanServiceCondition =
  | "ready"
  | "waiting-owner"
  | "paused"
  | "failed"
  | "cancelled";

export interface ScanServiceInspection {
  readonly condition: ScanServiceCondition;
  readonly snapshot: ScanStoreSnapshot;
  readonly workspace: ScanWorkspaceView;
  readonly progress: CalculatedScanProgress | null;
}

export interface ScanAdvanceInput {
  readonly scanId: string;
  readonly expectedRevision: number;
}

export interface ScanControlInput extends ScanAdvanceInput {
  readonly event: ScanControlEvent;
}

/**
 * Orchestrates one durable metadata-first Local Folder scan boundary at a time.
 * Sources and Agent selection are always reloaded from the Host config.
 */
export class LocalScanService {
  private readonly provider: ProgressiveConnectorProvider;
  private readonly agentService: Pick<AgentService, "decideScan">;
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(private readonly options: LocalScanServiceOptions) {
    this.provider = options.provider ?? localFolderConnector;
    this.agentService = options.agentService ?? new AgentService(new CodexNativeAgentDriver({
      scratchRoot: options.layout.runtimeDir,
    }));
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? 100;
    if (resolve(options.configPath) !== resolve(options.layout.configFile)) {
      throw invalid("Scan config path must be the Host config truth");
    }
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1) {
      throw invalid("Scan page size must be a positive integer");
    }
  }

  async inspect(scanId: string): Promise<ScanServiceInspection> {
    const snapshot = await this.requireSnapshot(scanId);
    await this.requireBindings(snapshot);
    return await this.inspection(snapshot);
  }

  async advance(input: ScanAdvanceInput): Promise<ScanServiceInspection> {
    const snapshot = await this.requireExpected(input);
    const sources = await this.requireBindings(snapshot);
    if (snapshot.scratchCleanupRequired) {
      const recovered = await recoverScanScratchCleanup({
        dataDir: this.options.layout.dataDir,
        scanId: input.scanId,
      });
      if (recovered === undefined) throw invalid("Scan state disappeared during scratch cleanup");
      return await this.inspection(recovered);
    }

    if (snapshot.state.phase === "Probing") {
      const statuses = await Promise.all(sources.map(async (source) => {
        this.assertProvider(source);
        return await this.provider.probe({ ...binding(source, snapshot), now: this.now });
      }));
      const next = await recordScanProbeConnected({
        dataDir: this.options.layout.dataDir,
        scanId: input.scanId,
        expectedRevision: input.expectedRevision,
        sources,
        statuses,
      });
      return await this.inspection(next);
    }

    if (snapshot.state.phase === "Discovering") {
      const next = await this.advanceDiscovery(snapshot, sources, input.expectedRevision);
      return await this.inspection(next);
    }

    if (snapshot.state.phase === "Summarizing") {
      const prepared = this.prepareLayer(snapshot, sources);
      const next = await beginScanLayerDecision({
        dataDir: this.options.layout.dataDir,
        runtimeDir: this.options.layout.runtimeDir,
        scanId: input.scanId,
        expectedRevision: input.expectedRevision,
        intentId: prepared.intent.intentId,
        scanInput: prepared.scanInput,
        summary: prepared.summary,
        persistedAt: this.now().toISOString(),
      });
      return await this.inspection(next.snapshot);
    }

    if (snapshot.state.phase === "Deciding") {
      const prepared = this.prepareLayer(snapshot, sources);
      const scratch = await readScanLayerSummary({
        runtimeDir: this.options.layout.runtimeDir,
        scanId: input.scanId,
        input: prepared.scanInput,
      });
      if (scratch === undefined) {
        const recovered = await beginScanLayerDecision({
          dataDir: this.options.layout.dataDir,
          runtimeDir: this.options.layout.runtimeDir,
          scanId: input.scanId,
          expectedRevision: input.expectedRevision,
          intentId: prepared.intent.intentId,
          scanInput: prepared.scanInput,
          summary: prepared.summary,
          persistedAt: prepared.persistedAt,
        });
        return await this.inspection(recovered.snapshot);
      }
      return await this.decide(snapshot, prepared);
    }

    return await this.inspection(snapshot);
  }

  async control(input: ScanControlInput): Promise<ScanServiceInspection> {
    const snapshot = await this.requireExpected(input);
    await this.requireBindings(snapshot);
    const next = await controlScan({
      dataDir: this.options.layout.dataDir,
      runtimeDir: this.options.layout.runtimeDir,
      scanId: input.scanId,
      expectedRevision: input.expectedRevision,
      event: input.event,
    });
    return await this.inspection(next);
  }

  async recover(input: ScanAdvanceInput): Promise<ScanServiceInspection> {
    const snapshot = await this.requireExpected(input);
    const sources = await this.requireBindings(snapshot);
    if (snapshot.scratchCleanupRequired) {
      const recovered = await recoverScanScratchCleanup({
        dataDir: this.options.layout.dataDir,
        scanId: input.scanId,
      });
      if (recovered === undefined) throw invalid("Scan state disappeared during scratch cleanup");
      return await this.inspection(recovered);
    }
    if (snapshot.state.phase !== "Deciding") return await this.inspection(snapshot);
    const prepared = this.prepareLayer(snapshot, sources);
    const scratch = await readScanLayerSummary({
      runtimeDir: this.options.layout.runtimeDir,
      scanId: input.scanId,
      input: prepared.scanInput,
    });
    if (scratch !== undefined) return await this.inspection(snapshot);
    const recovered = await beginScanLayerDecision({
      dataDir: this.options.layout.dataDir,
      runtimeDir: this.options.layout.runtimeDir,
      scanId: input.scanId,
      expectedRevision: input.expectedRevision,
      intentId: prepared.intent.intentId,
      scanInput: prepared.scanInput,
      summary: prepared.summary,
      persistedAt: prepared.persistedAt,
    });
    return await this.inspection(recovered.snapshot);
  }

  private async advanceDiscovery(
    snapshot: ScanStoreSnapshot,
    sources: readonly AuthorizedSourceV1[],
    expectedRevision: number,
  ): Promise<ScanStoreSnapshot> {
    if (snapshot.skeleton.nodes.length === 0) {
      const roots = await Promise.all(sources.map(async (source) => {
        this.assertProvider(source);
        const page = await this.provider.listRootsMetadata({
          ...binding(source, snapshot),
          limit: this.pageSize,
          cursor: null,
          now: this.now,
        });
        return { source, page, createdAt: this.now().toISOString() };
      }));
      return await recordScanSourceRoots({
        dataDir: this.options.layout.dataDir,
        scanId: snapshot.plan.scanId,
        expectedRevision,
        roots,
      });
    }

    const intents = receipts<EnumerationIntent>(snapshot, "openlifewiki.enumeration-intent/v1");
    const pages = receipts<EnumerationPageReceipt>(snapshot, "openlifewiki.enumeration-page-receipt/v1");
    const intent = intents.find((candidate) => pagesForIntent(pages, candidate).at(-1)?.state !== "complete");
    if (intent === undefined) {
      if (receipts<ScanDecision>(snapshot, "openlifewiki.scan-decision/v1")
        .some(({ decision }) => decision === "ask-user")) return snapshot;
      if (intents.some((candidate) => !snapshot.ledger.entries.some(({ intentId }) => intentId === candidate.intentId))) {
        throw invalid("Discovering frontier contains a completed uncommitted layer");
      }
      return await closeScanFrontier({
        dataDir: this.options.layout.dataDir,
        scanId: snapshot.plan.scanId,
        expectedRevision,
      });
    }

    const source = sources.find(({ sourceId }) => sourceId === intent.sourceId);
    const parent = snapshot.skeleton.nodes.find(({ node }) => (
      node.sourceId === intent.sourceId && node.nodeId === intent.targetNodeId
    ))?.node;
    if (source === undefined || parent === undefined) throw invalid("Enumeration intent lost its Source or parent");
    this.assertProvider(source);
    const priorPages = pagesForIntent(pages, intent);
    const previousPageReceipt = priorPages.at(-1) ?? null;
    const requestCursor = previousPageReceipt?.nextCursor ?? null;
    const page = await this.provider.listChildrenMetadata({
      ...binding(source, snapshot),
      parent,
      intent,
      limit: this.pageSize,
      cursor: requestCursor,
      now: this.now,
      trustedDecisionReceipts: receipts<ScanDecision>(snapshot, "openlifewiki.scan-decision/v1"),
      trustedReceiptHashes: receiptHashes(snapshot.receipts),
      previousPageReceipt,
    });
    return (await recordScanEnumerationPage({
      dataDir: this.options.layout.dataDir,
      scanId: snapshot.plan.scanId,
      expectedRevision,
      source,
      intentId: intent.intentId,
      requestCursor,
      page,
    })).snapshot;
  }

  private prepareLayer(
    snapshot: ScanStoreSnapshot,
    sources: readonly AuthorizedSourceV1[],
  ): PreparedLayer {
    const intents = receipts<EnumerationIntent>(snapshot, "openlifewiki.enumeration-intent/v1");
    const pages = receipts<EnumerationPageReceipt>(snapshot, "openlifewiki.enumeration-page-receipt/v1");
    const uncommitted = intents.filter((intent) => (
      pagesForIntent(pages, intent).at(-1)?.state === "complete"
      && !snapshot.ledger.entries.some(({ intentId }) => intentId === intent.intentId)
    ));
    if (uncommitted.length !== 1) throw invalid("Scan layer is not the unique completed frontier layer");
    const intent = uncommitted[0]!;
    const source = sources.find(({ sourceId }) => sourceId === intent.sourceId);
    const parent = snapshot.skeleton.nodes.find(({ node }) => (
      node.sourceId === intent.sourceId && node.nodeId === intent.targetNodeId
    ))?.node;
    const children = snapshot.skeleton.nodes
      .filter((record) => record.intentId === intent.intentId && record.pageReceiptHash !== null)
      .map(({ node }) => node);
    if (source === undefined || parent === undefined) throw invalid("Scan layer lost its Source or parent");
    const completeChildren = buildSkeletonTrustedChildren(children);
    const blockedIds = new Set(children.filter(({ permission }) => (
      permission === "denied" || permission === "unknown"
    )).map(({ nodeId }) => nodeId));
    const decisionTargets = completeChildren
      .filter(({ target }) => !blockedIds.has(target.nodeId))
      .map(({ target }) => target);
    const systemOutcomes = children.filter(({ nodeId }) => blockedIds.has(nodeId)).map(({ nodeId, permission }) => ({
      targetNodeId: nodeId,
      outcome: "blocked" as const,
      code: permission === "denied" ? "PERMISSION_DENIED" : "PERMISSION_UNKNOWN",
    }));
    const remainingBudget = remainingBudgetFor(snapshot, source);
    const coverage = {
      directChildrenEnumerated: completeChildren.length,
      pageComplete: true,
      openCursor: false,
      unknownChildCount: false,
    } as const;
    const priority = snapshot.plan.priorityDocumentRefs.length === 0
      ? "No priority documents are declared."
      : `${snapshot.plan.priorityDocumentRefs.length} authorized priority document reference(s) are bound in resolved policy.`;
    const resolvedPolicy = resolveAgentScanPolicy({
      policy: snapshot.plan.policy,
      policyResolutionHash: snapshot.plan.policyResolutionHash,
      hostBindingHash: snapshot.plan.policyBindings.host.bindingHash,
      wikiBindingHash: snapshot.plan.policyBindings.wiki.bindingHash,
      priorityReferenceHashes: snapshot.plan.priorityDocumentRefs.map(({ referenceHash }) => referenceHash),
      remainingBudget,
      targets: decisionTargets.map((target) => {
        const node = children.find(({ nodeId }) => nodeId === target.nodeId)!;
        const matching = priorityMatches(snapshot.plan.priorityDocumentRefs, source.sourceId, node.locator);
        return {
          targetNodeId: target.nodeId,
          policyPath: policyPath(source, node),
          priorityRelation: matching.relation,
          matchedPriorityReferenceHashes: matching.hashes,
          ownerApprovedSensitive: false,
        };
      }),
    });
    const summary: AgentLayerSummary = {
      schema: "openlifewiki.layer-summary/v1",
      overview: {
        title: parent.title,
        description: `${children.length} direct metadata-only children are ready for decision. ${priority}`,
        providerDescription: source.providerObservation === undefined
          ? null
          : `${source.providerObservation.providerName} ${source.providerObservation.providerVersion ?? "unknown-version"}`,
      },
      parent,
      children: completeChildren.map((child) => ({
        ...child,
        skeleton: children.find(({ nodeId }) => nodeId === child.target.nodeId)!,
      })),
      metadataSamples: [],
      coverage,
      policy: {
        scanIntent: snapshot.plan.scanIntent,
        resolvedPolicy,
      },
    };
    const layer = {
      sourceId: source.sourceId,
      parentNodeId: parent.nodeId,
      parentNodeVersion: parent.nodeVersion,
      summaryHash: sha256Canonical(summary),
      childSetHash: sha256Canonical(completeChildren),
      decisionTargetSetHash: sha256Canonical(decisionTargets),
      coverage,
      systemOutcomes,
    };
    const scanInput: AgentScanInputContext = {
      scanId: snapshot.plan.scanId,
      scanPlanHash: snapshot.plan.scanPlanHash,
      skeletonVersion: snapshot.plan.skeletonVersion,
      layer,
      completeChildren,
      decisionTargets,
      scanIntent: snapshot.plan.scanIntent,
      resolvedPolicy,
      skillHash: snapshot.plan.skillHash,
    };
    const persistedAt = snapshot.pendingLayer?.summaryReceipt.persistedAt ?? this.now().toISOString();
    return { intent, source, parent, children, summary, scanInput, persistedAt };
  }

  private async decide(snapshot: ScanStoreSnapshot, prepared: PreparedLayer): Promise<ScanServiceInspection> {
    const operationId = `scan_${sha256Canonical({
      scanId: snapshot.plan.scanId,
      intentId: prepared.intent.intentId,
      inputSetHash: buildAgentScanInputSetHash(prepared.scanInput),
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    const invoked = await this.agentService.decideScan({
      operationId,
      scanInput: prepared.scanInput,
      layerSummary: prepared.summary,
    });
    if (invoked.decision.schema === "openlifewiki.agent-failure/v1") {
      return await this.failDecision(snapshot, invoked.decision.code);
    }
    const result = invoked.decision as AgentScanResult;
    const expectedInputSetHash = buildAgentScanInputSetHash(prepared.scanInput);
    if (invoked.invocation.inputSetHash !== expectedInputSetHash
      || invoked.invocation.skillHash !== snapshot.plan.skillHash
      || sha256Canonical(invoked.invocation.agent) !== sha256Canonical(result.agent)
      || invoked.invocation.agent.id !== snapshot.plan.agentProfileId
      || invoked.invocation.outputSchema.id !== "openlifewiki.agent-scan-result/v1"
      || invoked.invocation.outputSchema.hash !== getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1")
      || invoked.invocation.binary.version === null) {
      return await this.failDecision(snapshot, "AGENT_OUTPUT_INVALID");
    }
    const committedAt = this.now().toISOString();
    const pending = snapshot.pendingLayer;
    if (pending === null) throw invalid("Agent decision has no prepared durable layer");
    const summaryReceipt = pending.summaryReceipt;
    const invocationReceipt = createAgentScanInvocationReceipt({
      plan: snapshot.plan,
      scanInput: prepared.scanInput,
      result,
      runtimeVersion: invoked.invocation.binary.version ?? "unknown",
      outputSchemaHash: invoked.invocation.outputSchema.hash,
      invokedAt: committedAt,
    });
    const decisions = result.childOutcomes.map((outcome): ScanDecision => {
      const payload: Omit<ScanDecision, "receiptHash"> = {
        schema: "openlifewiki.scan-decision/v1",
        scanId: snapshot.plan.scanId,
        scanPlanHash: snapshot.plan.scanPlanHash,
        skeletonVersion: snapshot.plan.skeletonVersion,
        authorizationHash: prepared.source.authorizationHash,
        sourceId: prepared.source.sourceId,
        parentNodeId: prepared.parent.nodeId,
        parentNodeVersion: prepared.parent.nodeVersion,
        childSetHash: prepared.scanInput.layer.childSetHash,
        nodeId: outcome.target.nodeId,
        nodeVersion: outcome.target.nodeVersion,
        targetKind: outcome.target.kind,
        summaryHash: prepared.scanInput.layer.summaryHash,
        inputSetHash: result.inputSetHash,
        decision: outcome.outcome,
        reason: outcome.reason,
        revisitCondition: outcome.revisitCondition,
        question: outcome.question,
        actor: result.agent.id,
        estimatedCost: outcome.estimatedCost,
        persistedAt: committedAt,
      };
      return { ...payload, receiptHash: sha256Canonical(payload) };
    });
    const trustedReceiptHashes = [...receiptHashes(snapshot.receipts), summaryReceipt.receiptHash];
    const systemOutcomes = prepared.scanInput.layer.systemOutcomes.map((outcome): ScanSystemOutcomeReceipt => {
      const target = prepared.children.find(({ nodeId }) => nodeId === outcome.targetNodeId);
      if (target === undefined) throw invalid("System outcome lost its trusted target");
      return createScanSystemOutcomeReceipt({
        plan: snapshot.plan,
        scanInput: prepared.scanInput,
        summaryReceipt,
        trustedReceiptHashes,
        target,
        outcome: "blocked",
        code: outcome.code,
        persistedAt: committedAt,
      });
    });
    const next = await commitScanLayerOutcome({
      dataDir: this.options.layout.dataDir,
      runtimeDir: this.options.layout.runtimeDir,
      scanId: snapshot.plan.scanId,
      expectedRevision: snapshot.revision,
      intent: prepared.intent,
      scanInput: prepared.scanInput,
      agentResult: result,
      agentInvocationReceipt: invocationReceipt,
      agentDecisions: decisions,
      systemOutcomes,
      committedAt,
    });
    return await this.inspection(next);
  }

  private async failDecision(
    snapshot: ScanStoreSnapshot,
    code: string,
  ): Promise<ScanServiceInspection> {
    const failed = await controlScan({
      dataDir: this.options.layout.dataDir,
      runtimeDir: this.options.layout.runtimeDir,
      scanId: snapshot.plan.scanId,
      expectedRevision: snapshot.revision,
      event: { type: "fail", retryPhase: "Deciding", code },
    });
    return await this.inspection(failed);
  }

  private async requireExpected(input: ScanAdvanceInput): Promise<ScanStoreSnapshot> {
    const snapshot = await this.requireSnapshot(input.scanId);
    if (snapshot.revision !== input.expectedRevision) {
      throw new AdapterError("SCAN_CONFLICT", `Scan revision changed: expected ${input.expectedRevision}, received ${snapshot.revision}`);
    }
    return snapshot;
  }

  private async requireSnapshot(scanId: string): Promise<ScanStoreSnapshot> {
    const snapshot = await readScanStore({ dataDir: this.options.layout.dataDir, scanId });
    if (snapshot === undefined) throw invalid("Scan state does not exist");
    return snapshot;
  }

  private async requireBindings(snapshot: ScanStoreSnapshot): Promise<readonly AuthorizedSourceV1[]> {
    const configSnapshot = await readConfigSnapshot(this.options.configPath);
    if (configSnapshot === undefined || configSnapshot.config.schema !== "openlifewiki.config/v2") {
      throw invalid("Scan requires Host config/v2");
    }
    const config = configSnapshot.config;
    if (config.revision !== snapshot.plan.hostConfigRevision) {
      throw invalid("Host config revision changed after ScanPlan approval");
    }
    if (config.hostConfig === null || config.hostConfig.selectedAgentId !== snapshot.plan.agentProfileId) {
      throw invalid("Selected Agent or Host policy changed after ScanPlan approval");
    }
    const selected = config.hostConfig.agents.filter(({ id }) => id === snapshot.plan.agentProfileId);
    if (selected.length !== 1 || sha256Canonical(selected[0]) !== snapshot.plan.selectedAgentConfigHash) {
      throw invalid("Selected Agent config changed after ScanPlan approval");
    }
    const sources = snapshot.plan.sourceIds.map((sourceId, index) => {
      const matches = config.sources.filter((source) => source.sourceId === sourceId);
      const source = matches[0];
      if (matches.length !== 1 || source === undefined
        || source.authorizationHash !== snapshot.plan.authorizationHashes[index]
        || source.rootNodeId !== snapshot.plan.rootNodeIds[index]) {
        throw invalid("Source authorization changed after ScanPlan approval");
      }
      return source;
    });
    const host = bindHostScanPolicy(config.scanPolicy);
    const wiki = await loadWikiScanPolicy({ wikiDir: this.options.layout.wikiDir });
    if (sha256Canonical(host.binding) !== sha256Canonical(snapshot.plan.policyBindings.host)
      || sha256Canonical(wiki.binding) !== sha256Canonical(snapshot.plan.policyBindings.wiki)) {
      throw invalid("Host or WIKI.md policy binding changed after ScanPlan approval");
    }
    const policy = resolveScanPolicy({
      ownerPolicy: snapshot.plan.ownerPolicy,
      hostPolicy: host.policy,
      wikiPolicy: wiki.policy,
    });
    const resolutionHash = createPolicyResolutionHash({
      ownerPolicy: snapshot.plan.ownerPolicy,
      policyBindings: snapshot.plan.policyBindings,
      priorityDocumentRefs: snapshot.plan.priorityDocumentRefs,
      policy,
    });
    if (sha256Canonical(policy) !== sha256Canonical(snapshot.plan.policy)
      || resolutionHash !== snapshot.plan.policyResolutionHash) {
      throw invalid("Resolved scan policy changed after ScanPlan approval");
    }
    for (const reference of snapshot.plan.priorityDocumentRefs) {
      const source = sources.find(({ sourceId }) => sourceId === reference.sourceId);
      if (source === undefined || sha256Canonical(authorizePriorityDocumentReference({
        source,
        locator: reference.normalizedLocator,
      })) !== sha256Canonical(reference)) {
        throw invalid("Priority document reference changed after ScanPlan approval");
      }
    }
    const skill = await readFile(CANONICAL_PROGRESSIVE_SCAN_SKILL, "utf8");
    if (sha256Canonical(skill) !== snapshot.plan.skillHash) {
      throw invalid("Canonical Skill changed after ScanPlan approval");
    }
    return sources;
  }

  private assertProvider(source: AuthorizedSourceV1): void {
    if (source.connectorType !== this.provider.connectorType) {
      throw invalid(`Local ScanService cannot use ${source.connectorType}`);
    }
  }

  private async inspection(snapshot: ScanStoreSnapshot): Promise<ScanServiceInspection> {
    return {
      condition: conditionFor(snapshot),
      snapshot,
      workspace: workspaceFor(snapshot),
      progress: progressFor(snapshot),
    };
  }
}

export function createLocalScanService(options: LocalScanServiceOptions): LocalScanService {
  return new LocalScanService(options);
}

interface PreparedLayer {
  readonly intent: EnumerationIntent;
  readonly source: AuthorizedSourceV1;
  readonly parent: SkeletonNode;
  readonly children: readonly SkeletonNode[];
  readonly summary: AgentLayerSummary;
  readonly scanInput: AgentScanInputContext;
  readonly persistedAt: string;
}

function binding(source: AuthorizedSourceV1, snapshot: ScanStoreSnapshot) {
  return {
    source,
    plan: snapshot.plan,
    sourceId: source.sourceId,
    authorizationHash: source.authorizationHash,
    rootNodeId: source.rootNodeId,
    scopeHash: progressiveConnectorScopeHash(source),
  } as const;
}

function receipts<T>(snapshot: ScanStoreSnapshot, schema: string): readonly T[] {
  return snapshot.receipts.filter((receipt) => (
    typeof receipt === "object" && receipt !== null && "schema" in receipt && receipt.schema === schema
  )) as unknown as readonly T[];
}

function receiptHashes(values: readonly ScanStoreReceipt[]): readonly string[] {
  return values.flatMap((receipt) => (
    typeof receipt === "object" && receipt !== null && "receiptHash" in receipt
      && typeof receipt.receiptHash === "string" ? [receipt.receiptHash] : []
  ));
}

function pagesForIntent(
  pages: readonly EnumerationPageReceipt[],
  intent: EnumerationIntent,
): readonly EnumerationPageReceipt[] {
  return pages.filter((page) => page.sourceId === intent.sourceId && page.intentId === intent.intentId)
    .sort((left, right) => left.pageSequence - right.pageSequence);
}

function remainingBudgetFor(snapshot: ScanStoreSnapshot, source: AuthorizedSourceV1) {
  const plan = snapshot.plan.policy.budget;
  const globalNodes = snapshot.skeleton.nodes.length;
  const sourceNodes = snapshot.skeleton.nodes.filter(({ node }) => node.sourceId === source.sourceId).length;
  const globalCalls = snapshot.ledger.entries.length;
  const sourceCalls = snapshot.ledger.entries.filter(({ sourceId }) => sourceId === source.sourceId).length;
  const globalBodyBytes = snapshot.physicalIo.counters.initialReadBytes
    + snapshot.physicalIo.counters.rematerializedBytes;
  const sourceBodyBytes = receipts<BodyObservationReceipt>(snapshot, "openlifewiki.body-observation-receipt/v1")
    .filter(({ sourceId }) => sourceId === source.sourceId)
    .reduce((sum, { bytes }) => sum + bytes, 0);
  return {
    nodes: Math.min(
      remaining(plan.maxNodes, globalNodes),
      remaining(source.budget.maxNodes, sourceNodes),
    ),
    bodyBytes: Math.min(
      remaining(plan.maxBodyBytes, globalBodyBytes),
      remaining(source.budget.maxBodyBytes, sourceBodyBytes),
    ),
    agentCalls: Math.min(
      remaining(plan.maxAgentCalls, globalCalls),
      remaining(source.budget.maxAgentCalls, sourceCalls),
    ),
  };
}

function remaining(limit: number | undefined, consumed: number): number {
  return limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - consumed);
}

function policyPath(source: AuthorizedSourceV1, node: SkeletonNode): string {
  if (source.connectorType !== "local-folder") return node.locator;
  const root = source.scope.root;
  if (typeof root !== "string") throw invalid("Local Source root is invalid");
  const fromRoot = relative(resolve(root), resolve(fileURLToPath(node.locator)));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw invalid("Local Skeleton node is outside the approved policy root");
  }
  return `/${fromRoot.split(sep).filter(Boolean).join("/")}` || "/";
}

function priorityMatches(
  references: readonly PriorityDocumentReferenceV1[],
  sourceId: string,
  targetLocator: string,
): { readonly relation: "none" | "exact" | "ancestor"; readonly hashes: readonly string[] } {
  const sourceReferences = references.filter((reference) => reference.sourceId === sourceId);
  const exact = sourceReferences.filter(({ normalizedLocator }) => normalizedLocator === targetLocator);
  if (exact.length > 0) {
    return { relation: "exact", hashes: exact.map(({ referenceHash }) => referenceHash) };
  }
  const ancestors = sourceReferences.filter((reference) => (
    reference.relationMode === "hierarchical" && locatorIsBelow(reference.normalizedLocator, targetLocator)
  ));
  return ancestors.length === 0
    ? { relation: "none", hashes: [] }
    : { relation: "ancestor", hashes: ancestors.map(({ referenceHash }) => referenceHash) };
}

function locatorIsBelow(candidate: string, ancestor: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const ancestorUrl = new URL(ancestor);
    if (candidateUrl.protocol !== ancestorUrl.protocol || candidateUrl.host !== ancestorUrl.host) return false;
    if (candidateUrl.protocol === "file:") {
      const relativePath = relative(fileURLToPath(ancestorUrl), fileURLToPath(candidateUrl));
      return relativePath !== "" && relativePath !== ".."
        && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep);
    }
    return candidate.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
  } catch {
    return false;
  }
}

function conditionFor(snapshot: ScanStoreSnapshot): ScanServiceCondition {
  if (snapshot.state.phase === "Paused") return "paused";
  if (snapshot.state.phase === "Failed") return "failed";
  if (snapshot.state.phase === "Cancelled") return "cancelled";
  if (receipts<ScanDecision>(snapshot, "openlifewiki.scan-decision/v1")
    .some(({ decision }) => decision === "ask-user")) return "waiting-owner";
  return "ready";
}

function workspaceFor(snapshot: ScanStoreSnapshot): ScanWorkspaceView {
  return {
    revision: snapshot.revision,
    state: structuredClone(snapshot.state),
    connectorStatuses: structuredClone(snapshot.connectorStatuses),
    nodes: snapshot.skeleton.nodes.map(({ node }) => structuredClone(node)),
    pages: structuredClone(receipts<EnumerationPageReceipt>(snapshot, "openlifewiki.enumeration-page-receipt/v1")),
    intents: structuredClone(receipts<EnumerationIntent>(snapshot, "openlifewiki.enumeration-intent/v1")),
    summaries: structuredClone(receipts<LayerSummaryReceipt>(snapshot, "openlifewiki.layer-summary-receipt/v1")),
    decisions: structuredClone(receipts<ScanDecision>(snapshot, "openlifewiki.scan-decision/v1")),
    selections: structuredClone(receipts<LeafSelectionReceipt>(snapshot, "openlifewiki.leaf-selection/v1")),
    checkpoints: structuredClone(receipts<ScanStoreReceipt>(snapshot, "openlifewiki.scan-checkpoint/v1")),
    manifests: structuredClone(receipts<ScanStoreReceipt>(snapshot, "openlifewiki.active-qmd-manifest/v1")),
  };
}

function progressFor(snapshot: ScanStoreSnapshot): CalculatedScanProgress | null {
  const enumerationIntents = receipts<EnumerationIntent>(snapshot, "openlifewiki.enumeration-intent/v1");
  if (enumerationIntents.length === 0) return null;
  const manifests = receipts<ActiveQmdManifestReceipt>(snapshot, "openlifewiki.active-qmd-manifest/v1");
  return calculateScanProgress(deriveScanProgress({
    plan: snapshot.plan,
    trustedReceiptHashes: receiptHashes(snapshot.receipts),
    enumerationIntents,
    enumerationPages: receipts<EnumerationPageReceipt>(snapshot, "openlifewiki.enumeration-page-receipt/v1"),
    layerSummaries: receipts<LayerSummaryReceipt>(snapshot, "openlifewiki.layer-summary-receipt/v1"),
    decisions: receipts<ScanDecision>(snapshot, "openlifewiki.scan-decision/v1"),
    leafSelections: receipts<LeafSelectionReceipt>(snapshot, "openlifewiki.leaf-selection/v1"),
    checkpoints: receipts<ScanCheckpoint>(snapshot, "openlifewiki.scan-checkpoint/v1"),
    systemOutcomes: receipts<ScanSystemOutcomeReceipt>(snapshot, "openlifewiki.scan-system-outcome/v1"),
    activeQmdManifest: manifests.at(-1) ?? null,
  }));
}

function invalid(message: string): AdapterError {
  return new AdapterError("SCAN_INVALID", message);
}
