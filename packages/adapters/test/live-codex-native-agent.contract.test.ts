import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import {
  sha256Canonical,
  type AgentScanInputContext,
  type SkeletonNode,
} from "@openlifewiki/protocol";

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
  const child = childSkeletonNode(target, "src_live_01");
  const completeChild = { target, metadataHash: sha256Canonical(child) };
  const common: AgentScanInputContext = {
    scanId: "scan_live_01",
    scanPlanHash: `sha256:${"a".repeat(64)}`,
    skeletonVersion: `sha256:${"b".repeat(64)}`,
    layer: {
      sourceId: "src_live_01",
      parentNodeId: "node_root",
      parentNodeVersion: "root-v1",
      summaryHash: `sha256:${"c".repeat(64)}`,
      childSetHash: sha256Canonical([completeChild]),
      decisionTargetSetHash: sha256Canonical([target]),
      coverage: { directChildrenEnumerated: 1, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren: [completeChild],
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

function layerSummary(input: AgentScanInputContext): AgentLayerSummary {
  return {
    schema: "openlifewiki.layer-summary/v1",
    overview: {
      title: "Synthetic product knowledge root",
      description: "Metadata-only fixture for an explainable layer decision.",
      providerDescription: "Local Folder public filesystem metadata.",
    },
    parent: parentSkeletonNode(input),
    children: input.completeChildren.map(({ target, metadataHash }) => ({
      target,
      metadataHash,
      skeleton: childSkeletonNode(target, input.layer.sourceId),
    })),
    metadataSamples: [{
      schema: "openlifewiki.metadata-sample/v1",
      nodeId: "node_product",
      inputSetHash: `sha256:${"d".repeat(64)}`,
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

function parentSkeletonNode(input: AgentScanInputContext): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: input.layer.sourceId,
    nodeId: input.layer.parentNodeId,
    parentId: null,
    kind: "directory",
    title: "Synthetic product knowledge root",
    locator: "file:///approved",
    childCount: { value: 1, kind: "known" },
    modifiedRange: { from: "2026-07-25T00:00:00Z", to: "2026-07-26T00:00:00Z" },
    permission: "readable",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 128, kind: "estimated" },
    nodeVersion: input.layer.parentNodeVersion,
  };
}

function childSkeletonNode(
  target: AgentScanInputContext["decisionTargets"][number],
  sourceId: string,
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId,
    nodeId: target.nodeId,
    parentId: target.parentId,
    kind: "directory",
    title: "Product roadmap",
    locator: "file:///approved/product",
    childCount: { value: 3, kind: "known" },
    modifiedRange: { from: "2026-07-25T00:00:00Z", to: "2026-07-26T00:00:00Z" },
    permission: "readable",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 128, kind: "estimated" },
    nodeVersion: target.nodeVersion,
  };
}
