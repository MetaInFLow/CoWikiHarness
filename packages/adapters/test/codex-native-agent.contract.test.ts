import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAgentScanInputSetHash,
  sha256Canonical,
  type AgentScanInputContext,
} from "@openlifewiki/protocol";

import { AgentService, CodexNativeAgentDriver, type CommandRunner } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SKILL = "# Canonical Skill\nMetadata decisions only.\n";

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
        return { stdout: JSON.stringify(scanResult(input)), stderr: "" };
      },
    };

    try {
      const result = await new AgentService(new CodexNativeAgentDriver({ runner, skillPath, scratchRoot: root }))
        .decideScan({ operationId: "op_01", scanInput: input });

      expect(result).toMatchObject({ schema: "openlifewiki.agent-scan-result/v1", status: "decision-ready" });
      expect(calls).toHaveLength(2);
      const invocation = calls[1]!;
      expect(invocation).toMatchObject({ command: "codex", options: { cwd: expect.stringContaining("openlifewiki-codex-"), timeoutMs: 60_000 } });
      expect(invocation.args).toEqual(expect.arrayContaining([
        "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", "-",
      ]));
      expect(invocation.args.join(" ")).not.toContain(SKILL);
      expect(invocation.args.join(" ")).not.toContain(input.scanIntent);
      const payload = JSON.parse(invocation.options!.stdin!) as { skill: { content: string }; scanInput: AgentScanInputContext };
      expect(payload.skill.content).toBe(SKILL);
      expect(payload.scanInput).toEqual(input);
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
    expect(result).toMatchObject({ schema: "openlifewiki.agent-failure/v1", code, status: "failed" });
  });

  it("rejects wrong target and hash-bound output without a fallback", async () => {
    const input = scanInput(sha256Canonical(SKILL));
    const wrongTarget = scanResult(input);
    wrongTarget.childOutcomes[0]!.target = { ...wrongTarget.childOutcomes[0]!.target, nodeId: "node_extra" };
    const result = await invoke(JSON.stringify(wrongTarget), input);
    expect(result).toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
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
        throw error;
      },
    };
    try {
      const result = await new CodexNativeAgentDriver({ runner, skillPath, scratchRoot: root })
        .decideScan({ operationId: "op_01", scanInput: scanInput(sha256Canonical(SKILL)) });
      expect(result).toMatchObject({ schema: "openlifewiki.agent-failure/v1", code });
      expect(JSON.stringify(result)).not.toContain("exit status 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an input whose declared Skill hash is not canonical", async () => {
    const input = scanInput(HASH_A);
    const result = await invoke(JSON.stringify(scanResult(input)), input);
    expect(result).toMatchObject({ code: "AGENT_CONTRACT_UNSUPPORTED" });
  });
});

async function invoke(stdout: string, input = scanInput(sha256Canonical(SKILL))) {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-agent-test-"));
  const skillPath = join(root, "SKILL.md");
  await writeFile(skillPath, SKILL);
  const runner: CommandRunner = {
    async run(_command, args) {
      if (args[0] === "--version") return { stdout: "codex 1.0.0", stderr: "" };
      return { stdout, stderr: "" };
    },
  };
  try {
    return await new CodexNativeAgentDriver({ runner, skillPath, scratchRoot: root })
      .decideScan({ operationId: "op_01", scanInput: input });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scanInput(skillHash: string): AgentScanInputContext {
  const targets = [
    { nodeId: "node_product", parentId: "node_root", nodeVersion: "v1", kind: "container" as const },
    { nodeId: "node_archive", parentId: "node_root", nodeVersion: "v2", kind: "leaf" as const },
  ];
  return {
    scanId: "scan_01",
    scanPlanHash: HASH_A,
    skeletonVersion: HASH_B,
    layer: {
      sourceId: "src_01",
      parentNodeId: "node_root",
      parentNodeVersion: "root-v1",
      summaryHash: HASH_A,
      childSetHash: sha256Canonical(targets.map((target) => ({ target, metadataHash: HASH_A }))),
      decisionTargetSetHash: sha256Canonical(targets),
      coverage: { directChildrenEnumerated: 2, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren: targets.map((target) => ({ target, metadataHash: HASH_A })),
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
