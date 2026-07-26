import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  getAgentIoSchemaHash,
  sha256Canonical,
  type AgentScanInputContext,
  type SkeletonNode,
} from "@openlifewiki/protocol";

import {
  AgentService,
  CodexNativeAgentDriver,
  isValidAgentLayerSummary,
  type AgentLayerSummary,
  type CodexNativeFileSystem,
  type CommandRunner,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SKILL = "# Canonical Skill\nMetadata decisions only.\n";

const CODEX_EXEC_HELP = [
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--sandbox",
  "--skip-git-repo-check",
  "--output-schema",
  "--disable",
].join("\n");

describe("Codex native Agent driver", () => {
  it("passes Skill and metadata only through stdin and returns a bound decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-agent-test-"));
    const skillPath = join(root, "SKILL.md");
    await writeFile(skillPath, SKILL);
    const input = scanInput(sha256Canonical(SKILL));
    const calls: Array<{ command: string; args: readonly string[]; options?: Parameters<CommandRunner["run"]>[2] }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        if (args[0] === "--version") return { stdout: "codex 1.0.0\n", stderr: "" };
        if (args[0] === "exec" && args[1] === "--help") {
          return { stdout: CODEX_EXEC_HELP, stderr: "" };
        }
        return { stdout: JSON.stringify(scanResult(input)), stderr: "" };
      },
    };

    try {
      const result = await new AgentService(new CodexNativeAgentDriver({ runner, skillPath, scratchRoot: root }))
        .decideScan({ operationId: "op_01", scanInput: input, layerSummary: layerSummary(input) });

      expect(result.decision).toMatchObject({ schema: "openlifewiki.agent-scan-result/v1", status: "decision-ready" });
      expect(result.invocation).toEqual({
        schema: "openlifewiki.agent-invocation/v1",
        binary: { command: "codex", version: "1.0.0" },
        agent: { id: "agent_codex_native", runtime: "codex", mode: "native-cli", driverContractVersion: "v1" },
        inputSetHash: buildAgentScanInputSetHash(input),
        skillHash: sha256Canonical(SKILL),
        outputSchema: {
          id: "openlifewiki.agent-scan-result/v1",
          hash: getAgentIoSchemaHash("openlifewiki.agent-scan-result/v1"),
        },
      });
      expect(calls).toHaveLength(3);
      expect(calls[1]?.args).toEqual(["exec", "--help"]);
      const invocation = calls[2]!;
      expect(invocation).toMatchObject({ command: "codex", options: { cwd: expect.stringContaining("openlifewiki-codex-"), timeoutMs: 60_000 } });
      expect(invocation.args).toEqual([
        "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only",
        "--skip-git-repo-check", "--output-schema", expect.stringMatching(/agent-scan-result\.schema\.json$/u),
        "--disable", "apps", "--disable", "browser_use", "--disable", "browser_use_external",
        "--disable", "browser_use_full_cdp_access", "--disable", "code_mode", "--disable", "code_mode_host",
        "--disable", "computer_use", "--disable", "hooks", "--disable", "in_app_browser",
        "--disable", "multi_agent", "--disable", "shell_tool", "--disable", "unified_exec", "-",
      ]);
      expect(invocation.args.join(" ")).not.toContain(SKILL);
      expect(invocation.args.join(" ")).not.toContain(input.scanIntent);
      const payload = JSON.parse(invocation.options!.stdin!) as {
        skill: { content: string };
        scanInput: AgentScanInputContext;
        layerSummary: AgentLayerSummary;
        expectedBindings: { inputSetHash: string };
      };
      expect(payload.skill.content).toBe(SKILL);
      expect(payload.scanInput).toEqual(input);
      expect(payload.layerSummary).toEqual(layerSummary(input));
      expect(payload.layerSummary.overview).toEqual({
        title: "Product documentation layer",
        description: "Metadata-only overview for the current direct-child decision.",
        providerDescription: "Local Folder public filesystem metadata.",
      });
      expect(payload.layerSummary.children[0]?.skeleton).toMatchObject({
        schema: "openlifewiki.skeleton-node/v1",
        locator: "file:///approved/product",
        childCount: { value: 3, kind: "known" },
        modifiedRange: { from: "2026-07-25T00:00:00Z", to: "2026-07-26T00:00:00Z" },
        permission: "readable",
        scanability: "metadata-only",
        page: { cursor: null, hasMore: false },
        sizeEstimate: { bytes: 128, kind: "estimated" },
      });
      expect(payload.layerSummary.metadataSamples).toEqual([
        expect.objectContaining({
          schema: "openlifewiki.metadata-sample/v1",
          nodeId: "node_product",
          fields: { mimeType: "inode/directory", publicLabel: "product" },
        }),
      ]);
      expect(payload.expectedBindings.inputSetHash).toBe(buildAgentScanInputSetHash(input));
      expect(Object.keys(invocation.options!.env!).sort()).toEqual(expect.arrayContaining(["HOME", "PATH"]));
      expect(Object.keys(invocation.options!.env!).every((name) => [
        "CODEX_HOME", "HOME", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "PATH", "SSL_CERT_DIR",
        "SSL_CERT_FILE", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
      ].includes(name))).toBe(true);
      expect(invocation.options!.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(invocation.options!.env).not.toHaveProperty("HTTPS_PROXY");
      expect(JSON.stringify(calls)).not.toContain("OPENAI_API_KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed JSON", "not json", "AGENT_OUTPUT_INVALID"],
    ["refusal", "I cannot comply with that request", "AGENT_REFUSAL"],
  ])("returns explicit failure for %s without repairing output", async (_label, stdout, code) => {
    const result = await invoke(stdout);
    expect(result.decision).toMatchObject({ schema: "openlifewiki.agent-failure/v1", code, status: "failed" });
  });

  it("rejects wrong target and hash-bound output without a fallback", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    const wrongTarget = scanResult(input);
    wrongTarget.childOutcomes[0]!.target = { ...wrongTarget.childOutcomes[0]!.target, nodeId: "node_extra" };
    const result = await invoke(JSON.stringify(wrongTarget), input);
    expect(result.decision).toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
  });

  it.each([
    [Object.assign(new Error("spawn codex"), { code: "ENOENT" }), "AGENT_MISSING"],
    [Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), "AGENT_TIMEOUT"],
    [new Error("login required"), "AGENT_AUTH_REQUIRED"],
    [new Error("exit status 1"), "AGENT_EXIT_NONZERO"],
  ])("maps process failure to %s without exposing diagnostics", async (error, code) => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-agent-test-"));
    const skillPath = join(root, "SKILL.md");
    await writeFile(skillPath, SKILL);
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return { stdout: "codex 1.0.0", stderr: "" };
        if (args[0] === "exec" && args[1] === "--help") return { stdout: CODEX_EXEC_HELP, stderr: "" };
        throw error;
      },
    };
    try {
      const result = await new CodexNativeAgentDriver({ runner, skillPath, scratchRoot: root })
        .decideScan({
          operationId: "op_01",
          scanInput: scanInput(sha256Canonical(SKILL)),
          layerSummary: layerSummary(scanInput(sha256Canonical(SKILL))),
        });
      expect(result.decision).toMatchObject({ schema: "openlifewiki.agent-failure/v1", code });
      expect(JSON.stringify(result.decision)).not.toContain("exit status 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an input whose declared Skill hash is not canonical", async () => {
    const input = scanInput(HASH_A);
    const result = await invoke(JSON.stringify(scanResult(input)), input);
    expect(result.decision).toMatchObject({ code: "AGENT_CONTRACT_UNSUPPORTED" });
  });

  it("reports empty output as invalid without exposing process diagnostics", async () => {
    const result = await invoke("");
    expect(result.decision).toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
  });

  it("accepts a complete legal layer larger than the former transport limit", () => {
    const { input, summary } = largeLayerFixture(1_000);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeGreaterThan(256 * 1024);
    expect(isValidAgentLayerSummary(summary, input)).toBe(true);
  });

  it("reports an invalid trusted scan input as a structured failure", async () => {
    const input = { ...scanInput(sha256Canonical(SKILL)), scanId: "" } as AgentScanInputContext;
    await expect(drive({ input, summary: layerSummary(scanInput(sha256Canonical(SKILL))) })).resolves.toMatchObject({
      decision: {
        schema: "openlifewiki.agent-failure/v1",
        code: "AGENT_HOST_CONFIG_INVALID",
        phase: "validate-host-config",
      },
    });
  });

  it("reports a missing scratch root without rejecting", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    const result = await drive({ input, scratchRoot: (root) => join(root, "missing", "scratch") });
    expect(result.decision).toMatchObject({ code: "AGENT_SPAWN_FAILED", phase: "spawn" });
  });

  it("reports output-schema write failure without misclassifying the Codex binary", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    const result = await drive({ input, fileSystem: fileSystemWith({
      async writeFile() { throw Object.assign(new Error("schema denied"), { code: "EACCES" }); },
    }) });
    expect(result.decision).toMatchObject({ code: "AGENT_TOOL_ERROR", phase: "tool-call" });
    expect(JSON.stringify(result)).not.toContain("schema denied");
  });

  it("reports missing structured-output capability as a contract failure", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    let invoked = false;
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return { stdout: "codex 1.0.0", stderr: "" };
        if (args[0] === "exec" && args[1] === "--help") {
          return { stdout: CODEX_EXEC_HELP.replace("--output-schema", ""), stderr: "" };
        }
        invoked = true;
        return { stdout: JSON.stringify(scanResult(input)), stderr: "" };
      },
    };
    const result = await drive({ input, runner });
    expect(result.decision).toMatchObject({ code: "AGENT_CONTRACT_UNSUPPORTED", phase: "probe-runtime" });
    expect(invoked).toBe(false);
  });

  it("normalizes cleanup failure and preserves an earlier structured invocation failure", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    let invokeFails = false;
    const fileSystem = fileSystemWith({ async rm() { throw new Error("cleanup raw details"); } });
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return { stdout: "codex 1.0.0", stderr: "" };
        if (args[0] === "exec" && args[1] === "--help") return { stdout: CODEX_EXEC_HELP, stderr: "" };
        if (invokeFails) throw new Error("exit status 1");
        return { stdout: JSON.stringify(scanResult(input)), stderr: "" };
      },
    };
    const successCleanup = await drive({ input, runner, fileSystem });
    expect(successCleanup.decision).toMatchObject({ code: "AGENT_TOOL_ERROR", phase: "normalize-output" });
    invokeFails = true;
    const failedCleanup = await drive({ input, runner, fileSystem });
    expect(failedCleanup.decision).toMatchObject({ code: "AGENT_EXIT_NONZERO", phase: "invoke" });
    expect(JSON.stringify(failedCleanup)).not.toContain("cleanup raw details");
  });

  it.each([
    ["nested body-like field", (summary: AgentLayerSummary) => ({
      ...summary,
      metadataSamples: [{
        ...summary.metadataSamples[0]!,
        fields: { safe: { nested: { body: "must never enter an Agent summary" } } },
      }],
    })],
    ["oversized metadata", (summary: AgentLayerSummary) => ({
      ...summary,
      overview: { ...summary.overview, providerDescription: "x".repeat(4_097) },
    })],
    ["wrong target", (summary: AgentLayerSummary) => ({
      ...summary,
      children: [{ ...summary.children[0]!, target: { ...summary.children[0]!.target, nodeId: "node_wrong" } }],
    })],
    ["wrong hash", (summary: AgentLayerSummary) => ({ ...summary, policy: { ...summary.policy, scanIntent: "changed" } })],
  ])("fails closed for a %s Layer Summary", async (label, mutate) => {
    const input = scanInput(sha256Canonical(SKILL));
    const summary = mutate(layerSummary(input)) as AgentLayerSummary;
    const reboundInput = label === "wrong hash" ? input : withSummaryHash(input, summary);
    const result = await invoke(JSON.stringify(scanResult(reboundInput)), reboundInput, summary);
    expect(result.decision).toMatchObject({ code: "AGENT_HOST_CONFIG_INVALID" });
  });
});

async function invoke(
  stdout: string,
  input = scanInput(sha256Canonical(SKILL)),
  summary: AgentLayerSummary = layerSummary(input),
) {
  return await drive({ stdout, input, summary });
}

async function drive(options: {
  readonly stdout?: string;
  readonly input: AgentScanInputContext;
  readonly summary?: AgentLayerSummary;
  readonly runner?: CommandRunner;
  readonly fileSystem?: CodexNativeFileSystem;
  readonly scratchRoot?: (root: string) => string;
}) {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-agent-test-"));
  const skillPath = join(root, "SKILL.md");
  await writeFile(skillPath, SKILL);
  try {
    const runner = options.runner ?? successfulRunner(options.input, options.stdout);
    return await new CodexNativeAgentDriver({
      runner,
      skillPath,
      scratchRoot: options.scratchRoot?.(root) ?? root,
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    }).decideScan({
      operationId: "op_01",
      scanInput: options.input,
      layerSummary: options.summary ?? layerSummary(options.input),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scanInput(skillHash: string): AgentScanInputContext {
  const targets = [
    { nodeId: "node_product", parentId: "node_root", nodeVersion: "v1", kind: "container" as const },
    { nodeId: "node_archive", parentId: "node_root", nodeVersion: "v2", kind: "leaf" as const },
  ];
  const common = {
    scanId: "scan_01",
    scanPlanHash: HASH_A,
    skeletonVersion: HASH_B,
    layer: {
      sourceId: "src_01",
      parentNodeId: "node_root",
      parentNodeVersion: "root-v1",
      summaryHash: HASH_A,
      childSetHash: sha256Canonical(targets.map((target) => ({
        target,
        metadataHash: sha256Canonical(skeletonNode(target)),
      }))),
      decisionTargetSetHash: sha256Canonical(targets),
      coverage: { directChildrenEnumerated: 2, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren: targets.map((target) => ({ target, metadataHash: sha256Canonical(skeletonNode(target)) })),
    decisionTargets: targets,
    remainingBudget: { nodes: 10, bodyBytes: 0, agentCalls: 2 },
    sensitivityByTarget: targets.map((target) => ({
      targetNodeId: target.nodeId, effective: "normal" as const, ownerApprovalRequired: false,
    })),
    scanIntent: "Index current product documentation.",
    indexing: { default: "metadata-only", rules: [] },
    skillHash,
    wikiHash: HASH_A,
    hostPolicyHash: HASH_B,
  } as AgentScanInputContext;
  return {
    ...common,
    layer: { ...common.layer, summaryHash: sha256Canonical(layerSummary(common)) },
  };
}

function largeLayerFixture(count: number): {
  readonly input: AgentScanInputContext;
  readonly summary: AgentLayerSummary;
} {
  const skillHash = sha256Canonical(SKILL);
  const targets = Array.from({ length: count }, (_, index) => ({
    nodeId: `node_${index}`,
    parentId: "node_root",
    nodeVersion: `v${index}`,
    kind: "leaf" as const,
  }));
  const completeChildren = targets.map((target) => ({
    target,
    metadataHash: sha256Canonical(skeletonNode(target)),
  }));
  const common: AgentScanInputContext = {
    ...scanInput(skillHash),
    layer: {
      ...scanInput(skillHash).layer,
      summaryHash: HASH_A,
      childSetHash: sha256Canonical(completeChildren),
      decisionTargetSetHash: sha256Canonical(targets),
      coverage: { directChildrenEnumerated: count, pageComplete: true, openCursor: false, unknownChildCount: false },
    },
    completeChildren,
    decisionTargets: targets,
    remainingBudget: { nodes: count, bodyBytes: 0, agentCalls: count },
    sensitivityByTarget: targets.map(({ nodeId }) => ({
      targetNodeId: nodeId,
      effective: "normal" as const,
      ownerApprovalRequired: false,
    })),
  };
  const summary: AgentLayerSummary = {
    ...layerSummary(common),
    parent: { ...parentSkeletonNode(common), childCount: { value: count, kind: "known" } },
    children: completeChildren.map(({ target, metadataHash }) => ({
      target,
      metadataHash,
      skeleton: skeletonNode(target),
    })),
    metadataSamples: [],
    coverage: common.layer.coverage,
  };
  return {
    summary,
    input: { ...common, layer: { ...common.layer, summaryHash: sha256Canonical(summary) } },
  };
}

function layerSummary(input: AgentScanInputContext): AgentLayerSummary {
  return {
    schema: "openlifewiki.layer-summary/v1",
    overview: {
      title: "Product documentation layer",
      description: "Metadata-only overview for the current direct-child decision.",
      providerDescription: "Local Folder public filesystem metadata.",
    },
    parent: parentSkeletonNode(input),
    children: input.completeChildren.map(({ target, metadataHash }) => ({
      target,
      metadataHash,
      skeleton: skeletonNode(target),
    })),
    metadataSamples: [{
      schema: "openlifewiki.metadata-sample/v1",
      nodeId: "node_product",
      inputSetHash: HASH_A,
      fields: { mimeType: "inode/directory", publicLabel: "product" },
    }],
    coverage: input.layer.coverage,
    policy: {
      scanIntent: input.scanIntent,
      indexing: input.indexing,
      remainingBudget: input.remainingBudget,
    },
  };
}

function withSummaryHash(input: AgentScanInputContext, summary: AgentLayerSummary): AgentScanInputContext {
  return { ...input, layer: { ...input.layer, summaryHash: sha256Canonical(summary) } };
}

function parentSkeletonNode(input: AgentScanInputContext): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: input.layer.sourceId,
    nodeId: input.layer.parentNodeId,
    parentId: null,
    kind: "directory",
    title: "Product documentation",
    locator: "file:///approved",
    childCount: { value: 2, kind: "known" },
    modifiedRange: { from: "2026-07-25T00:00:00Z", to: "2026-07-26T00:00:00Z" },
    permission: "readable",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 256, kind: "estimated" },
    nodeVersion: input.layer.parentNodeVersion,
  };
}

function skeletonNode(target: AgentScanInputContext["decisionTargets"][number]): SkeletonNode {
  const product = target.nodeId === "node_product";
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: "src_01",
    nodeId: target.nodeId,
    parentId: target.parentId,
    kind: product ? "directory" : "file",
    title: product ? "Product roadmap" : "Archived material",
    locator: product ? "file:///approved/product" : "file:///approved/archive.md",
    childCount: { value: product ? 3 : 0, kind: "known" },
    modifiedRange: { from: "2026-07-25T00:00:00Z", to: "2026-07-26T00:00:00Z" },
    permission: "readable",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: product ? 128 : 64, kind: "estimated" },
    nodeVersion: target.nodeVersion,
  };
}

function successfulRunner(input: AgentScanInputContext, stdout?: string): CommandRunner {
  return {
    async run(_command, args) {
      if (args[0] === "--version") return { stdout: "codex 1.0.0", stderr: "" };
      if (args[0] === "exec" && args[1] === "--help") return { stdout: CODEX_EXEC_HELP, stderr: "" };
      return { stdout: stdout ?? JSON.stringify(scanResult(input)), stderr: "" };
    },
  };
}

function fileSystemWith(overrides: Partial<CodexNativeFileSystem>): CodexNativeFileSystem {
  return {
    readFile: async (path) => await readFile(path, "utf8"),
    mkdtemp,
    writeFile: async (path, data, options) => { await writeFile(path, data, options); },
    rm: async (path, options) => { await rm(path, options); },
    ...overrides,
  };
}

function scanResult(input: AgentScanInputContext) {
  const inputSetHash = buildAgentScanInputSetHash(input);
  return {
    schema: "openlifewiki.agent-scan-result/v1" as const,
    operationId: "op_01",
    scanId: input.scanId,
    scanPlanHash: input.scanPlanHash,
    skeletonVersion: input.skeletonVersion,
    skillHash: input.skillHash,
    inputSetHash,
    agent: { id: "agent_codex_native", runtime: "codex" as const, mode: "native-cli" as const, driverContractVersion: "v1" },
    layer: input.layer,
    childOutcomes: input.decisionTargets.map((target) => ({
      target,
      outcome: "skip" as const,
      reason: "Metadata is outside the current scan intent.",
      estimatedCost: { nodes: 0, bodyBytes: 0, agentCalls: 0 },
      revisitCondition: null,
      question: null,
    })),
    status: "decision-ready" as const,
  };
}
