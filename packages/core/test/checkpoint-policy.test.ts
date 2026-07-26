import { describe, expect, it } from "vitest";

import {
  assertBodyObservationReceipt,
  createBodyObservationReceipt,
  createCurrentLeafVersionReceipt,
  createScanPlan,
  createTemporaryQmdGenerationFailureReceipt,
  createTemporaryQmdGenerationDeletionReceipt,
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
      selectionReceiptHash: selected.receiptHash,
      bodyObservationReceiptHash: observed.receiptHash,
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
      phase: "body-processed" as const,
      indexingDisposition: "qmd-current" as const,
      selectionReceiptHash: selected.receiptHash,
      bodyObservationReceiptHash: observed.receiptHash,
      qmdGenerationId: null,
    };

    const trustedReceiptHashes = [checkpoint.receiptHash, selected.receiptHash, observed.receiptHash];
    expect(isCheckpointReusable({
      checkpoint, selection: selected, observation: observed, expected, trustedReceiptHashes,
    })).toBe(true);
    expect(isCheckpointReusable({
      checkpoint,
      selection: selected,
      observation: observed,
      expected: { ...expected, contentHash: sha256Canonical("changed") },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      selection: selected,
      observation: observed,
      expected: { ...expected, scanPlanHash: sha256Canonical("new-plan") },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      selection: selected,
      observation: observed,
      expected: { ...expected, nodeId: "sibling" },
      trustedReceiptHashes,
    })).toBe(false);

    const { receiptHash: _checkpointHash, ...checkpointPayload } = checkpoint;
    const forged = receipt({ ...checkpointPayload, phase: "discovered" as const });
    expect(isCheckpointReusable({
      checkpoint: forged,
      selection: null,
      observation: null,
      expected: {
        ...expected,
        phase: "discovered",
        contentHash: null,
        selectionReceiptHash: null,
        bodyObservationReceiptHash: null,
      },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      selection: selected,
      observation: observed,
      expected: { ...expected, indexingDisposition: "metadata-only" },
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      selection: null,
      observation: observed,
      expected,
      trustedReceiptHashes,
    })).toBe(false);
    expect(isCheckpointReusable({
      checkpoint,
      selection: selected,
      observation: observed,
      expected: { ...expected, selectionReceiptHash: sha256Canonical("other-selection") },
      trustedReceiptHashes,
    })).toBe(false);

    const qmdCheckpoint = receipt({
      ...checkpointPayload,
      phase: "qmd-committed" as const,
      qmdGenerationId: "generation-1",
    });
    const qmdExpected = {
      ...expected,
      phase: "qmd-committed" as const,
      qmdGenerationId: "generation-1",
    };
    const qmdTrusted = [...trustedReceiptHashes, qmdCheckpoint.receiptHash];
    expect(isCheckpointReusable({
      checkpoint: qmdCheckpoint,
      selection: selected,
      observation: observed,
      expected: qmdExpected,
      trustedReceiptHashes: qmdTrusted,
    })).toBe(true);
    expect(isCheckpointReusable({
      checkpoint: qmdCheckpoint,
      selection: selected,
      observation: observed,
      expected: { ...qmdExpected, qmdGenerationId: "generation-2" },
      trustedReceiptHashes: qmdTrusted,
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
    const currentVersion = createCurrentLeafVersionReceipt({
      plan: scanPlan,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
      selectionReceipt: selected,
      priorBodyObservationReceipt: observed,
      observedNodeVersion: selected.nodeVersion,
      observedAt: "2026-07-27T10:03:00Z",
    });
    const failure = createTemporaryQmdGenerationFailureReceipt({
      plan: scanPlan,
      generationId: "temporary-generation-1",
      phase: "build",
      failedAt: "2026-07-27T10:03:30Z",
    });
    const deletion = createTemporaryQmdGenerationDeletionReceipt({
      plan: scanPlan,
      failureReceipt: failure,
      trustedReceiptHashes: [failure.receiptHash],
      deletedAt: "2026-07-27T10:04:00Z",
    });
    expect(() => createTemporaryQmdGenerationDeletionReceipt({
      plan: scanPlan,
      failureReceipt: failure,
      trustedReceiptHashes: [],
      deletedAt: "2026-07-27T10:04:00Z",
    })).toThrow(/trusted/i);
    const recoveryTrusted = [
      selected.receiptHash,
      observed.receiptHash,
      currentVersion.receiptHash,
      failure.receiptHash,
      deletion.receiptHash,
    ];
    const authorization = authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted,
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
    expect(() => recordPhysicalIo({
      accounting: createPhysicalIoAccounting(),
      priorObservations: [],
      observations: [observed, rematerialized],
      rematerializationAuthorizations: [],
      trustedReceiptHashes: [observed.receiptHash, rematerialized.receiptHash],
    })).toThrow(/authorization/i);
    expect(() => recordPhysicalIo({
      accounting: createPhysicalIoAccounting(),
      priorObservations: [],
      observations: [observed, rematerialized],
      rematerializationAuthorizations: [authorization],
      trustedReceiptHashes: [observed.receiptHash, rematerialized.receiptHash],
    })).toThrow(/trusted/i);
    const accounting = recordPhysicalIo({
      accounting: createPhysicalIoAccounting(),
      priorObservations: [],
      observations: [observed, rematerialized],
      rematerializationAuthorizations: [authorization],
      trustedReceiptHashes: [
        observed.receiptHash,
        rematerialized.receiptHash,
        authorization.authorizationHash,
      ],
    });
    expect(accounting.counters).toEqual({
      initialReadItems: 1,
      initialReadBytes: 128,
      rematerializedItems: 1,
      rematerializedBytes: 128,
    });
    expect(() => recordPhysicalIo({
      accounting: {
        ...createPhysicalIoAccounting(),
        counters: {
          initialReadItems: 99,
          initialReadBytes: 99,
          rematerializedItems: 0,
          rematerializedBytes: 0,
        },
      },
      priorObservations: [],
      observations: [observed],
      rematerializationAuthorizations: [],
      trustedReceiptHashes: [observed.receiptHash],
    })).toThrow(/counter|accounting/i);
    expect(() => recordPhysicalIo({
      accounting,
      priorObservations: [observed],
      observations: [],
      rematerializationAuthorizations: [authorization],
      trustedReceiptHashes: [
        observed.receiptHash,
        rematerialized.receiptHash,
        authorization.authorizationHash,
      ],
    })).toThrow(/exact|entry|accounting/i);

    const changedVersion = createCurrentLeafVersionReceipt({
      plan: scanPlan,
      trustedReceiptHashes: [selected.receiptHash, observed.receiptHash],
      selectionReceipt: selected,
      priorBodyObservationReceipt: observed,
      observedNodeVersion: "leaf-v2",
      observedAt: "2026-07-27T10:03:00Z",
    });
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [changedVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: [...recoveryTrusted, changedVersion.receiptHash],
    })).toThrow(/version/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [],
      currentVersionReceipts: [],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted,
    })).toThrow(/observation|complete/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted.filter((hash) => hash !== deletion.receiptHash),
    })).toThrow(/deleted|trusted/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted.filter((hash) => hash !== failure.receiptHash),
    })).toThrow(/failure|trusted/i);
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted.filter((hash) => hash !== currentVersion.receiptHash),
    })).toThrow(/current leaf version|trusted/i);

    const { receiptHash: _observationHash, ...observationPayload } = observed;
    const forgedObservation = receipt({
      ...observationPayload,
      observedAt: "2026-07-27T10:02:00Z",
    });
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [forgedObservation],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: failure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: recoveryTrusted,
    })).toThrow(/trusted/i);
    expect(() => recordPhysicalIo({
      accounting: createPhysicalIoAccounting(),
      priorObservations: [],
      observations: [observed],
      rematerializationAuthorizations: [],
      trustedReceiptHashes: [],
    })).toThrow(/trusted/i);

    const laterFailure = createTemporaryQmdGenerationFailureReceipt({
      plan: scanPlan,
      generationId: "temporary-generation-2",
      phase: "build",
      failedAt: "2026-07-27T10:06:00Z",
    });
    expect(() => authorizeQmdRematerialization({
      plan: scanPlan,
      selections: [selected],
      bodyObservations: [observed],
      currentVersionReceipts: [currentVersion],
      temporaryGenerationFailureReceipt: laterFailure,
      temporaryGenerationDeletionReceipt: deletion,
      trustedReceiptHashes: [...recoveryTrusted, laterFailure.receiptHash],
    })).toThrow(/failure|generation|deletion/i);
  });
});
