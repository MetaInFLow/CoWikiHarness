import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  createScanPlanPolicyMaterial,
  createScanPlan,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanResult,
  type AuthorizedSourceV1,
  type RuntimeLayout,
} from "@openlifewiki/protocol";

import {
  AgentService,
  approveScanPlan,
  createLocalScanService,
  createScanStore,
  currentOwnerIdentityFingerprint,
  localFolderConnector,
  readScanStore,
  writeConfig,
  type AgentDriver,
  type AgentScanInvocation,
  type AgentScanRequest,
  type ProgressiveConnectorProvider,
} from "../src/index.js";
import { authorizePriorityDocumentReference } from "../src/priority-reference.js";

const AT = "2026-07-27T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("local progressive ScanService", () => {
  it("walks metadata skeleton layers, binds Skill and priority policy, and reads zero bodies", async () => {
    const fixture = await scanFixture();
    let inspection = await fixture.service.inspect(fixture.plan.scanId);

    const phases: string[] = [];
    for (let step = 0; step < 12 && inspection.snapshot.state.phase !== "ReadingLeaves"; step += 1) {
      inspection = await fixture.service.advance({
        scanId: fixture.plan.scanId,
        expectedRevision: inspection.snapshot.revision,
      });
      phases.push(inspection.snapshot.state.phase);
    }

    expect(inspection.snapshot.state.phase).toBe("ReadingLeaves");
    expect(phases.filter((phase) => phase === "Summarizing")).toHaveLength(2);
    expect(phases.filter((phase) => phase === "Deciding")).toHaveLength(2);
    expect(fixture.providerCounters.rootLists).toBe(1);
    expect(fixture.providerCounters.childLists).toBe(2);
    expect(fixture.providerCounters.bodyReads).toBe(0);
    expect(fixture.agent.calls).toHaveLength(2);
    expect(fixture.agent.calls.every(({ scanInput }) => (
      scanInput.skillHash === fixture.plan.skillHash
      && scanInput.resolvedPolicy.hostBindingHash === fixture.plan.policyBindings.host.bindingHash
      && scanInput.resolvedPolicy.wikiBindingHash === fixture.plan.policyBindings.wiki.bindingHash
    ))).toBe(true);
    expect(fixture.agent.calls[0]!.scanInput.resolvedPolicy.targetEffects)
      .toEqual(expect.arrayContaining([expect.objectContaining({ priorityRelation: "ancestor" })]));
    expect(fixture.agent.calls[0]!.layerSummary.overview.description).not.toContain("[object Object]");
    expect(fixture.agent.calls.every(({ layerSummary }) => layerSummary.metadataSamples.length === 0)).toBe(true);
    expect(inspection.workspace.decisions.map(({ decision }) => decision)).toEqual([
      "skip", "descend", "descend",
    ]);
    expect(inspection.workspace.selections).toHaveLength(1);
    expect(inspection.progress).toMatchObject({
      discovery: { complete: true },
      summarization: { completed: 2, total: 2, percent: 100 },
      selectedScan: { completed: 0, total: 1, percent: 0 },
    });
  });

  it("changes target effects and scripted outcomes when approved priority policy changes over identical metadata", async () => {
    const fixture = await scanFixture();
    let withPriority = await fixture.service.inspect(fixture.plan.scanId);
    while (fixture.agent.calls.length === 0) {
      withPriority = await fixture.service.advance({
        scanId: fixture.plan.scanId,
        expectedRevision: withPriority.snapshot.revision,
      });
    }

    const withoutPriorityMaterial = createScanPlanPolicyMaterial({ ownerPolicy: fixture.plan.ownerPolicy });
    const withoutPriorityPlan = createScanPlan({
      schema: "openlifewiki.scan-plan/v1",
      scanId: "scan_local_without_priority",
      sourceIds: fixture.plan.sourceIds,
      authorizationHashes: fixture.plan.authorizationHashes,
      rootNodeIds: fixture.plan.rootNodeIds,
      skeletonVersion: fixture.plan.skeletonVersion,
      agentProfileId: fixture.plan.agentProfileId,
      hostConfigRevision: fixture.plan.hostConfigRevision,
      selectedAgentConfigHash: fixture.plan.selectedAgentConfigHash,
      skillHash: fixture.plan.skillHash,
      scanIntent: fixture.plan.scanIntent,
      ...withoutPriorityMaterial,
    });
    await createScanStore({ dataDir: fixture.layout.dataDir, plan: withoutPriorityPlan });
    await approveScanPlan({
      dataDir: fixture.layout.dataDir,
      layout: fixture.layout,
      scanId: withoutPriorityPlan.scanId,
      expectedRevision: 0,
    });
    const withoutPriorityAgent = new ScriptedAgent(false);
    const withoutPriorityService = createLocalScanService({
      configPath: fixture.layout.configFile,
      layout: fixture.layout,
      provider: fixture.provider,
      agentService: new AgentService(withoutPriorityAgent),
      now: () => new Date(AT),
      pageSize: 50,
    });
    let withoutPriority = await withoutPriorityService.inspect(withoutPriorityPlan.scanId);
    while (withoutPriorityAgent.calls.length === 0) {
      withoutPriority = await withoutPriorityService.advance({
        scanId: withoutPriorityPlan.scanId,
        expectedRevision: withoutPriority.snapshot.revision,
      });
    }

    const withCall = fixture.agent.calls[0]!;
    const withoutCall = withoutPriorityAgent.calls[0]!;
    expect(withCall.layerSummary.children).toEqual(withoutCall.layerSummary.children);
    expect(withCall.scanInput.resolvedPolicy.targetEffects.map(({ priorityRelation }) => priorityRelation))
      .not.toEqual(withoutCall.scanInput.resolvedPolicy.targetEffects.map(({ priorityRelation }) => priorityRelation));
    expect(buildAgentScanInputSetHash(withCall.scanInput)).not.toBe(buildAgentScanInputSetHash(withoutCall.scanInput));
    expect(fixture.agent.outcomes[0]!.map(({ outcome }) => outcome)).toContain("descend");
    expect(withoutPriorityAgent.outcomes[0]!.map(({ outcome }) => outcome)).toEqual(["skip", "skip"]);
    expect(fixture.providerCounters.bodyReads).toBe(0);
  });

  it("stops at ask-user and does not close or read a sensitive branch", async () => {
    const fixture = await scanFixture({ sensitiveFolder: true });
    let inspection = await fixture.service.inspect(fixture.plan.scanId);
    for (let step = 0; step < 8 && inspection.condition !== "waiting-owner"; step += 1) {
      inspection = await fixture.service.advance({
        scanId: fixture.plan.scanId,
        expectedRevision: inspection.snapshot.revision,
      });
    }
    expect(inspection.condition).toBe("waiting-owner");
    expect(inspection.snapshot.state.phase).toBe("Discovering");
    expect(inspection.workspace.decisions.some(({ decision }) => decision === "ask-user")).toBe(true);
    expect(fixture.providerCounters.bodyReads).toBe(0);
    const same = await fixture.service.advance({
      scanId: fixture.plan.scanId,
      expectedRevision: inspection.snapshot.revision,
    });
    expect(same.snapshot.revision).toBe(inspection.snapshot.revision);
    expect(same.condition).toBe("waiting-owner");
  });

  it("fails Deciding durably on invalid Agent output with no fallback", async () => {
    const fixture = await scanFixture({ agentFailure: true });
    let inspection = await fixture.service.inspect(fixture.plan.scanId);
    while (inspection.snapshot.state.phase !== "Deciding") {
      inspection = await fixture.service.advance({
        scanId: fixture.plan.scanId,
        expectedRevision: inspection.snapshot.revision,
      });
    }
    inspection = await fixture.service.advance({
      scanId: fixture.plan.scanId,
      expectedRevision: inspection.snapshot.revision,
    });
    expect(inspection).toMatchObject({
      condition: "failed",
      snapshot: { state: { phase: "Failed", retryPhase: "Deciding", failureCode: "AGENT_OUTPUT_INVALID" } },
    });
    expect(fixture.agent.calls).toHaveLength(1);
    expect(inspection.workspace.decisions).toEqual([]);
    expect(fixture.providerCounters.bodyReads).toBe(0);
  });

  it("uses revision CAS and rejects Host config drift before provider or Agent work", async () => {
    const fixture = await scanFixture();
    const first = await fixture.service.advance({ scanId: fixture.plan.scanId, expectedRevision: 1 });
    await expect(fixture.service.advance({ scanId: fixture.plan.scanId, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "SCAN_CONFLICT" });
    expect(first.snapshot.revision).toBe(2);

    const changed = { ...fixture.config, revision: 1 };
    await writeFile(fixture.layout.configFile, JSON.stringify(changed));
    await expect(fixture.service.advance({
      scanId: fixture.plan.scanId,
      expectedRevision: first.snapshot.revision,
    })).rejects.toThrow(/config revision changed/i);
    expect(fixture.providerCounters.rootLists).toBe(0);
  });

  it("recovers prepared scratch without invoking the Agent twice", async () => {
    const fixture = await scanFixture();
    let inspection = await fixture.service.inspect(fixture.plan.scanId);
    while (inspection.snapshot.state.phase !== "Deciding") {
      inspection = await fixture.service.advance({
        scanId: fixture.plan.scanId,
        expectedRevision: inspection.snapshot.revision,
      });
    }
    await rm(join(fixture.layout.runtimeDir, "scans", fixture.plan.scanId), { recursive: true, force: true });
    const recovered = await fixture.service.recover({
      scanId: fixture.plan.scanId,
      expectedRevision: inspection.snapshot.revision,
    });
    expect(recovered.snapshot.state.phase).toBe("Deciding");
    expect(fixture.agent.calls).toHaveLength(0);
    const committed = await fixture.service.advance({
      scanId: fixture.plan.scanId,
      expectedRevision: recovered.snapshot.revision,
    });
    expect(committed.workspace.decisions.length).toBeGreaterThan(0);
    expect(fixture.agent.calls).toHaveLength(1);
  });
});

interface ScanFixtureOptions {
  readonly sensitiveFolder?: boolean;
  readonly agentFailure?: boolean;
}

async function scanFixture(options: ScanFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-local-service-test-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, "product"), { recursive: true });
  await writeFile(join(sourceRoot, "product", "roadmap.md"), "private roadmap body");
  await writeFile(join(sourceRoot, "archive.md"), "private archive body");
  const layout = testLayout(root);
  const source = await authorizedLocalSource(sourceRoot, options.sensitiveFolder ?? false);
  const hostConfig = {
    schema: "openlifewiki.host-config/v1" as const,
    selectedAgentId: "agent_codex_native",
    agents: [{ id: "agent_codex_native", runtime: "codex" as const, mode: "native-cli" as const }],
  };
  const config = {
    schema: "openlifewiki.config/v2" as const,
    revision: 0,
    sources: [source],
    scanPolicy: null,
    hostConfig,
    compatibility: { p0Sources: [], agentBindings: [] },
  };
  await writeConfig(layout.configFile, config);
  const skill = await readFile(
    new URL("../../../skills/openlifewiki-progressive-scan/SKILL.md", import.meta.url),
    "utf8",
  );
  const ownerPolicy = {
    schema: "openlifewiki.scan-narrowing-policy/v1" as const,
    include: ["/**"],
    exclude: [] as string[],
    sensitivity: {
      default: "normal" as const,
      rules: options.sensitiveFolder ? [{ match: "/product", level: "sensitive" as const }] : [],
    },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    indexing: { default: "qmd-current" as const, rules: [] },
  };
  const approvedRoot = source.scope.root;
  if (typeof approvedRoot !== "string") throw new Error("Local fixture root is invalid");
  const priorityDocumentRefs = [authorizePriorityDocumentReference({
    source,
    locator: pathToFileURL(join(approvedRoot, "product", "roadmap.md")).href,
  })];
  const policyMaterial = createScanPlanPolicyMaterial({ ownerPolicy, priorityDocumentRefs });
  const selectedAgent = hostConfig.agents[0]!;
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan_local_service",
    sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash],
    rootNodeIds: [source.rootNodeId],
    skeletonVersion: sha256Canonical("local skeleton v1"),
    agentProfileId: "agent_codex_native",
    hostConfigRevision: 0,
    selectedAgentConfigHash: sha256Canonical(selectedAgent),
    skillHash: sha256Canonical(skill),
    scanIntent: "Build a reusable product knowledge Wiki.",
    ...policyMaterial,
  });
  await createScanStore({ dataDir: layout.dataDir, plan });
  await approveScanPlan({ dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0 });
  const providerCounters = { probes: 0, rootLists: 0, childLists: 0, bodyReads: 0 };
  const provider: ProgressiveConnectorProvider = {
    connectorType: "local-folder",
    probe: async (input) => {
      providerCounters.probes += 1;
      return await localFolderConnector.probe(input);
    },
    listRootsMetadata: async (input) => {
      providerCounters.rootLists += 1;
      return await localFolderConnector.listRootsMetadata(input);
    },
    listChildrenMetadata: async (input) => {
      providerCounters.childLists += 1;
      return await localFolderConnector.listChildrenMetadata(input);
    },
    getVersion: async (input) => await localFolderConnector.getVersion(input),
    readApprovedLeafBody: async (input) => {
      providerCounters.bodyReads += 1;
      return await localFolderConnector.readApprovedLeafBody(input);
    },
  };
  const agent = new ScriptedAgent(options.agentFailure ?? false);
  const service = createLocalScanService({
    configPath: layout.configFile,
    layout,
    provider,
    agentService: new AgentService(agent),
    now: () => new Date(AT),
    pageSize: 50,
  });
  return { root, layout, source, plan, config, provider, providerCounters, agent, service };
}

class ScriptedAgent implements AgentDriver {
  readonly calls: AgentScanRequest[] = [];
  readonly outcomes: AgentScanResult["childOutcomes"][] = [];

  constructor(private readonly fail: boolean) {}

  async decideScan(request: AgentScanRequest): Promise<AgentScanInvocation> {
    this.calls.push(structuredClone(request));
    const inputSetHash = buildAgentScanInputSetHash(request.scanInput);
    const invocation = {
      schema: "openlifewiki.agent-invocation/v1" as const,
      binary: { command: "scripted-codex", version: "1.0.0" },
      agent: {
        id: "agent_codex_native",
        runtime: "codex" as const,
        mode: "native-cli" as const,
        driverContractVersion: "v1",
      },
      inputSetHash,
      skillHash: request.scanInput.skillHash,
      outputSchema: {
        id: "openlifewiki.agent-scan-result/v1" as const,
        hash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
      },
    };
    if (this.fail) {
      return {
        invocation,
        decision: {
          schema: "openlifewiki.agent-failure/v1",
          operationId: request.operationId,
          code: "AGENT_OUTPUT_INVALID",
          phase: "validate-output",
          messageKey: "agent.output-invalid",
          remediation: { action: "review-output-contract", target: "operation" },
          retryable: true,
          ambiguousRemoteState: false,
          inputSetHash,
          skillHash: request.scanInput.skillHash,
          agent: invocation.agent,
          status: "failed",
        },
      };
    }
    const childOutcomes = request.scanInput.decisionTargets.map((target) => {
      const effect = request.scanInput.resolvedPolicy.targetEffects.find(({ targetNodeId }) => targetNodeId === target.nodeId)!;
      const child = request.layerSummary.children.find(({ target: item }) => item.nodeId === target.nodeId)!;
      const ask = effect.ownerApprovalRequired;
      const descend = !ask && effect.priorityRelation !== "none";
      const outcome = ask ? "ask-user" as const : descend ? "descend" as const : "skip" as const;
      return {
        target,
        outcome,
        reason: ask ? "The approved sensitivity policy requires Owner input."
          : descend ? "Metadata and priority policy match the scan intent." : "Metadata is outside the current priority.",
        estimatedCost: outcome === "skip" || outcome === "ask-user"
          ? { nodes: 0, bodyBytes: 0, agentCalls: 0 }
          : target.kind === "container"
            ? { nodes: 1, bodyBytes: 0, agentCalls: 1 }
            : { nodes: 1, bodyBytes: child.skeleton.sizeEstimate.bytes ?? 0, agentCalls: 0 },
        revisitCondition: null,
        question: outcome === "ask-user" ? "Allow scanning this sensitive branch?" : null,
      };
    });
    const decision: AgentScanResult = {
      schema: "openlifewiki.agent-scan-result/v1",
      operationId: request.operationId,
      scanId: request.scanInput.scanId,
      scanPlanHash: request.scanInput.scanPlanHash,
      skeletonVersion: request.scanInput.skeletonVersion,
      skillHash: request.scanInput.skillHash,
      inputSetHash,
      agent: invocation.agent,
      layer: request.scanInput.layer,
      childOutcomes,
      status: "decision-ready",
    };
    this.outcomes.push(childOutcomes);
    return { invocation, decision };
  }
}

async function authorizedLocalSource(root: string, sensitiveFolder: boolean): Promise<AuthorizedSourceV1> {
  const actual = await realpath(root);
  const details = await stat(actual);
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: AT,
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    previewHash: sha256Canonical("preview"),
    configHash: sha256Canonical("config"),
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source_local",
    connectorType: "local-folder" as const,
    rootNodeId: "local_root",
    identityFingerprint: sha256Canonical({
      provider: "filesystem", actual, device: String(details.dev), inode: String(details.ino),
    }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    providerObservation: {
      providerName: "filesystem-adapter",
      providerVersion: "0.1.0-dev.1",
      contractHash: null,
    },
    scope: { schema: "openlifewiki.scope/local-folder/v1" as const, root: actual, symlinkPolicy: "deny" as const },
    include: ["**/*.md"],
    exclude: [] as string[],
    sensitivity: {
      default: "normal" as const,
      rules: sensitiveFolder ? [{ match: `${new URL(`file://${join(actual, "product")}`).href}*`, level: "sensitive" as const }] : [],
    },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 10 },
    approvedBy: "human:owner" as const,
    approvedAt: AT,
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function testLayout(root: string): RuntimeLayout {
  const runtimeRoot = join(root, "runtime-root");
  const workspaceRoot = join(root, "workspace");
  return {
    root: runtimeRoot,
    workspaceRoot,
    configFile: join(runtimeRoot, "config.json"),
    stateFile: join(runtimeRoot, "state.json"),
    componentsDir: join(runtimeRoot, "components"),
    dataDir: join(runtimeRoot, "data"),
    runtimeDir: join(runtimeRoot, "runtime"),
    logsDir: join(runtimeRoot, "logs"),
    sourcesDir: join(workspaceRoot, "sources"),
    wikiDir: join(workspaceRoot, "wiki"),
    qmdConfigDir: join(runtimeRoot, "data", "qmd", "config"),
    qmdCacheDir: join(runtimeRoot, "data", "qmd", "cache"),
    qmdInstallDir: join(runtimeRoot, "components", "qmd"),
    qmdExecutable: join(runtimeRoot, "components", "qmd", "qmd"),
  };
}
