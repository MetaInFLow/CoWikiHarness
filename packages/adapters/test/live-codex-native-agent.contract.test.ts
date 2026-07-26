import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { sha256Canonical } from "@openlifewiki/protocol";

import {
  CodexNativeAgentDriver,
  type AgentLayerSummary,
} from "../src/index.js";

const runLive = process.env.OPENLIFEWIKI_LIVE_AGENT_TEST === "1";

it.runIf(runLive)("returns a metadata-only, schema-valid Codex decision", async () => {
  const skill = await readFile(
    new URL("../../../skills/openlifewiki-progressive-scan/SKILL.md", import.meta.url),
    "utf8",
  );
  const hash = sha256Canonical(skill);
  const target = { nodeId: "node_product", parentId: "node_root", nodeVersion: "v1", kind: "container" as const };
  const common = {
    scanId: "scan_live_01",
    scanPlanHash: `sha256:${"a".repeat(64)}`,
    skeletonVersion: `sha256:${"b".repeat(64)}`,
    layer: {
      sourceId: "src_live_01",
      parentNodeId: "node_root",
      parentNodeVersion: "root-v1",
      summaryHash: `sha256:${"c".repeat(64)}`,
      childSetHash: sha256Canonical([{ target, metadataHash: `sha256:${"d".repeat(64)}` }]),
      decisionTargetSetHash: sha256Canonical([target]),
      coverage: { directChildrenEnumerated: 1, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren: [{ target, metadataHash: `sha256:${"d".repeat(64)}` }],
    decisionTargets: [target],
    remainingBudget: { nodes: 1, bodyBytes: 0, agentCalls: 1 },
    sensitivityByTarget: [{ targetNodeId: target.nodeId, effective: "normal" as const, ownerApprovalRequired: false }],
    scanIntent: "Assess only the supplied metadata for relevance.",
    indexing: { default: "metadata-only" as const, rules: [] },
    skillHash: hash,
    wikiHash: `sha256:${"e".repeat(64)}`,
    hostPolicyHash: `sha256:${"f".repeat(64)}`,
  };
  const summary = layerSummary(common);
  const input = { ...common, layer: { ...common.layer, summaryHash: sha256Canonical(summary) } };

  const result = await new CodexNativeAgentDriver({ timeoutMs: 120_000 })
    .decideScan({ operationId: "op_live_01", scanInput: input, layerSummary: layerSummary(input) });

  expect(result.decision).toMatchObject({ schema: "openlifewiki.agent-scan-result/v1", status: "decision-ready" });
  expect(result.invocation).toMatchObject({
    binary: { command: "codex", version: expect.any(String) },
    outputSchema: { id: "openlifewiki.agent-scan-result/v1", hash: expect.stringMatching(/^sha256:/u) },
  });
}, 130_000);

function layerSummary(input: {
  readonly scanId: string;
  readonly layer: {
    readonly sourceId: string;
    readonly parentNodeId: string;
    readonly parentNodeVersion: string;
    readonly coverage: { readonly directChildrenEnumerated: number; readonly pageComplete: boolean; readonly openCursor: boolean; readonly unknownChildCount: boolean };
  };
  readonly completeChildren: readonly { readonly target: { readonly nodeId: string; readonly parentId: string; readonly nodeVersion: string; readonly kind: "container" | "leaf" }; readonly metadataHash: string }[];
  readonly scanIntent: string;
  readonly indexing: { readonly default: "qmd-current" | "metadata-only" | "excluded"; readonly rules: { readonly match: string; readonly disposition: "qmd-current" | "metadata-only" | "excluded" }[] };
  readonly remainingBudget: { readonly nodes: number; readonly bodyBytes: number; readonly agentCalls: number };
}): AgentLayerSummary {
  return {
    schema: "openlifewiki.layer-summary/v1",
    parent: {
      sourceId: input.layer.sourceId,
      nodeId: input.layer.parentNodeId,
      nodeVersion: input.layer.parentNodeVersion,
      title: "Synthetic product knowledge root",
      description: "Metadata-only fixture for an explainable layer decision.",
      updatedAt: "2026-07-26T00:00:00Z",
      sizeBytes: 0,
    },
    children: input.completeChildren.map(({ target, metadataHash }) => ({
      target,
      metadataHash,
      title: "Product roadmap",
      description: "Published roadmap metadata; body is unavailable to the Agent.",
      updatedAt: "2026-07-26T00:00:00Z",
      sizeBytes: 0,
    })),
    coverage: input.layer.coverage,
    policy: {
      scanIntent: input.scanIntent,
      indexing: input.indexing,
      remainingBudget: input.remainingBudget,
    },
  };
}
