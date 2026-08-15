import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  sha256Canonical,
  type AgentScanInputContext,
  type SkeletonNode,
} from "@openlifewiki/protocol";

import {
  cleanupOrphanScanScratch,
  readScanLayerSummary,
  writeScanLayerSummary,
  type AgentLayerSummary,
} from "../src/index.js";
import { clearScanScratch } from "../src/scan-scratch.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("disposable scan Layer Summary scratch", () => {
  it("writes and reads only the current validated summary with owner-only permissions", async () => {
    const runtimeDir = await temporaryRuntimeDir();
    const { input, summary } = fixture();

    await writeScanLayerSummary({ runtimeDir, scanId: input.scanId, input, summary });

    expect(await readScanLayerSummary({ runtimeDir, scanId: input.scanId, input })).toEqual(summary);
    expect((await stat(join(runtimeDir, "scans", input.scanId))).mode & 0o777).toBe(0o700);
    expect((await stat(join(runtimeDir, "scans", input.scanId, "layer-summary.json"))).mode & 0o777).toBe(0o600);
  });

  it.each(["decision-committed", "pause", "cancel", "failure"] as const)(
    "deletes summary scratch on %s",
    async (reason) => {
      const runtimeDir = await temporaryRuntimeDir();
      const { input, summary } = fixture();
      await writeScanLayerSummary({ runtimeDir, scanId: input.scanId, input, summary });

      await clearScanScratch({ runtimeDir, scanId: input.scanId, reason });

      expect(await readScanLayerSummary({ runtimeDir, scanId: input.scanId, input })).toBeUndefined();
    },
  );

  it("rejects invalid or body-bearing summaries, traversal IDs, and removes startup orphans", async () => {
    const runtimeDir = await temporaryRuntimeDir();
    const { input, summary } = fixture();
    const invalid = {
      ...summary,
      metadataSamples: [{
        schema: "openlifewiki.metadata-sample/v1",
        nodeId: "child",
        inputSetHash: HASH_A,
        fields: { rawContent: "private source" },
      }],
    } as AgentLayerSummary;
    const invalidInput = {
      ...input,
      layer: { ...input.layer, summaryHash: sha256Canonical(invalid) },
    };
    await expect(writeScanLayerSummary({
      runtimeDir, scanId: input.scanId, input: invalidInput, summary: invalid,
    }))
      .rejects.toMatchObject({ code: "SCAN_SCRATCH_INVALID" });
    await expect(writeScanLayerSummary({ runtimeDir, scanId: "../escape", input, summary }))
      .rejects.toMatchObject({ code: "SCAN_SCRATCH_INVALID" });

    await mkdir(join(runtimeDir, "scans", "orphan"), { recursive: true });
    await writeFile(join(runtimeDir, "scans", "orphan", "layer-summary.json"), "private");
    expect(await cleanupOrphanScanScratch({ runtimeDir })).toEqual({ removed: 1 });
    await expect(stat(join(runtimeDir, "scans", "orphan"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function fixture(): { readonly input: AgentScanInputContext; readonly summary: AgentLayerSummary } {
  const target = { nodeId: "child", parentId: "root", nodeVersion: "v1", kind: "leaf" as const };
  const child = skeleton(target.nodeId, target.parentId, target.nodeVersion, "file");
  const completeChildren = [{ target, metadataHash: sha256Canonical(child) }];
  const common = {
    scanId: "scan_01",
    scanPlanHash: HASH_A,
    skeletonVersion: HASH_B,
    layer: {
      sourceId: "source_local",
      parentNodeId: "root",
      parentNodeVersion: "root-v1",
      summaryHash: HASH_A,
      childSetHash: sha256Canonical(completeChildren),
      decisionTargetSetHash: sha256Canonical([target]),
      coverage: { directChildrenEnumerated: 1, pageComplete: true, openCursor: false, unknownChildCount: false },
      systemOutcomes: [],
    },
    completeChildren,
    decisionTargets: [target],
    scanIntent: "Index current product documents.",
    resolvedPolicy: {
      resolutionHash: HASH_A, hostBindingHash: HASH_B, wikiBindingHash: HASH_A,
      priorityReferenceHashes: [], include: ["/**"], includeSets: [["/**"]], exclude: [],
      remainingBudget: { nodes: 10, bodyBytes: 1000, agentCalls: 2 },
      indexing: { default: "qmd-current" as const, rules: [] },
      targetEffects: [{
        targetNodeId: "child", eligible: true as const, effectiveSensitivity: "normal" as const,
        ownerApprovalRequired: false, indexingDisposition: "qmd-current" as const,
        priorityRelation: "none" as const, matchedPriorityReferenceHashes: [], matchedNarrowingRuleHashes: [],
      }],
    },
    skillHash: HASH_A,
  } satisfies AgentScanInputContext;
  const summary: AgentLayerSummary = {
    schema: "openlifewiki.layer-summary/v1",
    overview: {
      title: "Product documents",
      description: "Metadata-only summary of the current layer.",
      providerDescription: "Local Folder metadata",
    },
    parent: skeleton("root", null, "root-v1", "directory"),
    children: [{ target, metadataHash: sha256Canonical(child), skeleton: child }],
    metadataSamples: [{
      schema: "openlifewiki.metadata-sample/v1",
      nodeId: "child",
      inputSetHash: HASH_A,
      fields: { mimeType: "text/markdown", label: "roadmap" },
    }],
    coverage: common.layer.coverage,
    policy: {
      scanIntent: common.scanIntent,
      resolvedPolicy: common.resolvedPolicy,
    },
  };
  return {
    summary,
    input: { ...common, layer: { ...common.layer, summaryHash: sha256Canonical(summary) } },
  };
}

function skeleton(
  nodeId: string,
  parentId: string | null,
  nodeVersion: string,
  kind: "directory" | "file",
): SkeletonNode {
  return {
    schema: "openlifewiki.skeleton-node/v1",
    sourceId: "source_local",
    nodeId,
    parentId,
    kind,
    title: nodeId,
    locator: `file:///approved/${nodeId}`,
    childCount: { value: kind === "directory" ? 1 : 0, kind: "known" },
    modifiedRange: null,
    permission: "readable",
    scanability: "metadata-only",
    page: { cursor: null, hasMore: false },
    sizeEstimate: { bytes: 10, kind: "estimated" },
    nodeVersion,
  };
}

async function temporaryRuntimeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-scan-scratch-test-"));
  roots.push(root);
  return join(root, "runtime");
}
