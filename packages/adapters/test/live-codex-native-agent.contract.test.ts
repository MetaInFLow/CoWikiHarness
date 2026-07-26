import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { sha256Canonical } from "@openlifewiki/protocol";

import { CodexNativeAgentDriver } from "../src/index.js";

const runLive = process.env.OPENLIFEWIKI_LIVE_AGENT_TEST === "1";

it.runIf(runLive)("returns a metadata-only, schema-valid Codex decision", async () => {
  const skill = await readFile(
    new URL("../../../skills/openlifewiki-progressive-scan/SKILL.md", import.meta.url),
    "utf8",
  );
  const hash = sha256Canonical(skill);
  const target = { nodeId: "node_product", parentId: "node_root", nodeVersion: "v1", kind: "container" as const };
  const input = {
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

  const result = await new CodexNativeAgentDriver({ timeoutMs: 120_000 })
    .decideScan({ operationId: "op_live_01", scanInput: input });

  expect(result).toMatchObject({ schema: "openlifewiki.agent-scan-result/v1", status: "decision-ready" });
}, 130_000);
