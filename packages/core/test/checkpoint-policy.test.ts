import { describe, expect, it } from "vitest";

import {
  assertBodyObservationReceipt,
  createBodyObservationReceipt,
  createScanPlan,
  sha256Canonical,
  type BodyObservationReceipt,
  type LeafSelectionReceipt,
  type ScanCheckpoint,
  type ScanPlan,
} from "@openlifewiki/protocol";

import {
  authorizeQmdRematerialization,
  createPhysicalIoAccounting,
  deriveBranchInvalidation,
  isCheckpointReusable,
  recordPhysicalIo,
} from "../src/index.js";

const AT = "2026-07-27T10:00:00Z";
const AUTH = sha256Canonical("authorization");
const SKELETON = sha256Canonical("skeleton");
const INPUT = sha256Canonical("input");
const CONTENT = sha256Canonical("body-content");

function receipt<T extends object>(payload: T): T & { readonly receiptHash: string } {
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function plan(): ScanPlan {
  return createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-1",
    sourceIds: ["source-local"],
    authorizationHashes: [AUTH],
    rootNodeIds: ["root"],
    skeletonVersion: SKELETON,
    agentProfileId: "agent-codex",
    skillHash: sha256Canonical("skill"),
    scanIntent: "Build reusable current knowledge.",
    priorityDocumentRefs: [],
    policy: {
      include: ["/**"], exclude: [], sensitivity: "normal", budget: {},
      indexing: { default: "qmd-current", rules: [] },
    },
  });
}

function selection(scanPlan: ScanPlan, nodeId = "leaf"): LeafSelectionReceipt {
  return receipt({
    schema: "openlifewiki.leaf-selection/v1" as const,
    scanId: scanPlan.scanId,
    sourceId: "source-local",
    nodeId,
    nodeVersion: `${nodeId}-v1`,
    scanPlanHash: scanPlan.scanPlanHash,
    skeletonVersion: scanPlan.skeletonVersion,
    authorizationHash: AUTH,
    inputSetHash: INPUT,
    decisionReceiptHash: sha256Canonical({ decision: nodeId }),
    actor: "control-plane",
    reason: "Selected by a trusted decision",
    persistedAt: AT,
  });
}

function observation(scanPlan: ScanPlan, selected: LeafSelectionReceipt): BodyObservationReceipt {
  return createBodyObservationReceipt({
    plan: scanPlan,
    trustedSelectionReceiptHashes: [selected.receiptHash],
    selectionReceipt: selected,
    previousObservationReceipt: null,
    observation: {
      schema: "openlifewiki.body-observation-receipt/v1",
      sourceId: selected.sourceId,
      nodeId: selected.nodeId,
      nodeVersion: selected.nodeVersion,
      contentHash: CONTENT,
      bytes: 128,
      purpose: "initial-read",
      rematerializationAuthorizationHash: null,
      observedAt: AT,
    },
  });
}

describe("checkpoint reuse and recovery policy", () => {
  it("reuses a checkpoint only on exact plan, skeleton, authorization, input, version and content hash", () => {
    const scanPlan = plan();
    const selected = selection(scanPlan);
    const observed = observation(scanPlan, selected);
    expect(() => assertBodyObservationReceipt(observed, {
      plan: scanPlan,
      trustedSelectionReceiptHashes: [selected.receiptHash],
      selectionReceipt: selected,
      previousObservationReceipt: null,
    })).not.toThrow();
    expect(() => assertBodyObservationReceipt({ ...observed, bytes: 129 }, {
      plan: scanPlan,
      trustedSelectionReceiptHashes: [selected.receiptHash],
      selectionReceipt: selected,
      previousObservationReceipt: null,
    })).toThrow(/receiptHash/i);
    const checkpoint: ScanCheckpoint = receipt({
      schema: "openlifewiki.scan-checkpoint/v1" as const,
      scanId: scanPlan.scanId,
      scanPlanHash: scanPlan.scanPlanHash,
      skeletonVersion: scanPlan.skeletonVersion,
      sourceId: selected.sourceId,
      authorizationHash: AUTH,
      nodeId: selected.nodeId,
      nodeVersion: selected.nodeVersion,
      phase: "body-processed" as const,
      indexingDisposition: "qmd-current" as const,
      inputSetHash: INPUT,
    });
    const expected = {
      scanId: scanPlan.scanId,
      sourceId: selected.sourceId,
      nodeId: selected.nodeId,
      scanPlanHash: scanPlan.scanPlanHash,
      skeletonVersion: scanPlan.skeletonVersion,
      authorizationHash: AUTH,
      inputSetHash: INPUT,
      nodeVersion: selected.nodeVersion,
      contentHash: CONTENT,
    };

    const trustedReceiptHashes = [checkpoint.receiptHash, observed.receiptHash];
    expect(isCheckpointReusable({
      checkpoint, observation: observed, expected, trustedReceiptHashes,
    })).toBe(true);
    expect(isCheckpointReusable({
      checkpoint,
      observation: observed,
      expected: { ...expected, contentHash: sha256Canonical("changed") },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      observation: observed,
      expected: { ...expected, scanPlanHash: sha256Canonical("new-plan") },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      observation: observed,
      expected: { ...expected, nodeId: "sibling" },
      trustedReceiptHashes,
    })).toBe(false);

    const { receiptHash: _checkpointHash, ...checkpointPayload } = checkpoint;
    const forged = receipt({ ...checkpointPayload, phase: "discovered" as const });
    expect(isCheckpointReusable({
      checkpoint: forged,
      observation: null,
      expected: { ...expected, contentHash: null },
      trustedReceiptHashes,
    })).toBe(false);
  });

  it("invalidates only the changed branch, its ancestors and descendants", () => {
    const invalidated = deriveBranchInvalidation({
      nodes: [
        { sourceId: "source-local", nodeId: "root", parentNodeId: null },
        { sourceId: "source-local", nodeId: "a", parentNodeId: "root" },
        { sourceId: "source-local", nodeId: "a-leaf", parentNodeId: "a" },
        { sourceId: "source-local", nodeId: "b", parentNodeId: "root" },
        { sourceId: "source-local", nodeId: "b-leaf", parentNodeId: "b" },
      ],
      changed: [{ sourceId: "source-local", nodeId: "a" }],
    });
    expect(invalidated).toEqual([
      { sourceId: "source-local", nodeId: "a" },
      { sourceId: "source-local", nodeId: "a-leaf" },
      { sourceId: "source-local", nodeId: "root" },
    ]);
    expect(invalidated).not.toContainEqual({ sourceId: "source-local", nodeId: "b" });
  });

  it("allows QMD rematerialization only after complete exact current observations and deleted failure", () => {
    const scanPlan = plan();
    const selected = selection(scanPlan);
    const observed = observation(scanPlan, selected);
    const authorization = authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentLeaves: [{
        sourceId: selected.sourceId,
        nodeId: selected.nodeId,
        nodeVersion: selected.nodeVersion,
        contentHash: CONTENT,
        bytes: 128,
      }],
      failedTemporaryGenerationDeleted: true,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
    });
    expect(authorization).toMatchObject({ allowed: true, logicalCompletionsAdded: 0 });

    const rematerialized = createBodyObservationReceipt({
      plan: scanPlan,
      trustedSelectionReceiptHashes: [selected.receiptHash],
      selectionReceipt: selected,
      previousObservationReceipt: observed,
      observation: {
        schema: "openlifewiki.body-observation-receipt/v1",
        sourceId: selected.sourceId,
        nodeId: selected.nodeId,
        nodeVersion: selected.nodeVersion,
        contentHash: CONTENT,
        bytes: 128,
        purpose: "qmd-rematerialization",
        rematerializationAuthorizationHash: authorization.authorizationHash,
        observedAt: "2026-07-27T10:05:00Z",
      },
    });
    expect(() => recordPhysicalIo(
      createPhysicalIoAccounting(),
      [observed, rematerialized],
      [],
    )).toThrow(/authorization/i);
    const accounting = recordPhysicalIo(
      createPhysicalIoAccounting(),
      [observed, rematerialized],
      [authorization],
    );
    expect(accounting.counters).toEqual({
      initialReadItems: 1,
      initialReadBytes: 128,
      rematerializedItems: 1,
      rematerializedBytes: 128,
    });

    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentLeaves: [{
        sourceId: selected.sourceId,
        nodeId: selected.nodeId,
        nodeVersion: "leaf-v2",
        contentHash: CONTENT,
        bytes: 128,
      }],
      failedTemporaryGenerationDeleted: true,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
    })).toThrow(/version/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [],
      currentLeaves: [],
      failedTemporaryGenerationDeleted: true,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
    })).toThrow(/observation|complete/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentLeaves: [{
        sourceId: selected.sourceId,
        nodeId: selected.nodeId,
        nodeVersion: selected.nodeVersion,
        contentHash: CONTENT,
        bytes: 128,
      }],
      failedTemporaryGenerationDeleted: false,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
    })).toThrow(/deleted/i);

    const { receiptHash: _observationHash, ...observationPayload } = observed;
    const forgedObservation = receipt({
      ...observationPayload,
      observedAt: "2026-07-27T10:02:00Z",
    });
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [forgedObservation],
      currentLeaves: [{
        sourceId: selected.sourceId,
        nodeId: selected.nodeId,
        nodeVersion: selected.nodeVersion,
        contentHash: CONTENT,
        bytes: 128,
      }],
      failedTemporaryGenerationDeleted: true,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
    })).toThrow(/trusted/i);
  });
});
