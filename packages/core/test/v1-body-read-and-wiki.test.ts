import { describe, expect, it } from "vitest";

import type {
  AuthorizedSourceV1,
  LeafSelectionReceipt,
  ScanDecision,
  ScanPlan,
  SkeletonNode,
  WikiApproval,
  WikiProposal,
} from "@openlifewiki/protocol";

import {
  assertBodyReadAllowed,
  assertWikiPublicationAllowed,
  listMcpTools,
  sha256Canonical,
} from "../src/index.js";

const authorization: AuthorizedSourceV1 = {
  schema: "openlifewiki.authorized-source/v1",
  sourceId: "source-1",
  connectorType: "local-folder",
  rootNodeId: "root",
  identityFingerprint: "identity-1",
  scope: { root: "/approved" },
  include: ["**/*.md"],
  exclude: [],
  sensitivity: { default: "normal", rules: [] },
  budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
  approvedBy: "human:owner",
  approvedAt: "2026-07-26T10:00:00Z",
  authorizationHash: "auth-1",
};

const plan: ScanPlan = {
  schema: "openlifewiki.scan-plan/v1",
  scanId: "scan-1",
  sourceIds: ["source-1"],
  authorizationHashes: ["auth-1"],
  skeletonVersion: "skeleton-1",
  agentProfileId: "agent-codex",
  skillHash: "skill-1",
  priorityDocumentRefs: [],
  policy: { include: ["/**"], exclude: [], sensitivity: "normal", budget: {} },
  scanPlanHash: "plan-1",
};

const rootNode: SkeletonNode = {
  schema: "openlifewiki.skeleton-node/v1",
  sourceId: "source-1",
  nodeId: "root",
  parentId: null,
  kind: "directory",
  title: "Root",
  locator: "file:///approved",
  childCount: { value: 1, kind: "known" },
  modifiedRange: null,
  permission: "readable",
  scanability: "metadata-only",
  page: { cursor: null, hasMore: false },
  sizeEstimate: { bytes: 10, kind: "known" },
  nodeVersion: "root-v1",
};

const leafNode: SkeletonNode = {
  ...rootNode,
  nodeId: "leaf",
  parentId: "root",
  kind: "file",
  title: "Leaf",
  locator: "file:///approved/leaf.md",
  childCount: { value: 0, kind: "known" },
  scanability: "metadata-and-body",
  nodeVersion: "leaf-v1",
};

const descendReceiptPayload: Omit<ScanDecision, "receiptHash"> = {
  schema: "openlifewiki.scan-decision/v1",
  scanId: "scan-1",
  scanPlanHash: "plan-1",
  skeletonVersion: "skeleton-1",
  authorizationHash: "auth-1",
  nodeId: "root",
  nodeVersion: "root-v1",
  summaryHash: "summary-1",
  inputSetHash: "input-1",
  decision: "descend",
  reason: "Selected within scope and budget",
  actor: "agent:codex/native",
  coverage: { directChildrenEnumerated: 1, pageComplete: true },
  estimatedCost: { bodyBytes: 10, agentCalls: 1 },
  persistedAt: "2026-07-26T10:01:00Z",
};

function decisionReceipt(
  overrides: Partial<Omit<ScanDecision, "receiptHash">> = {},
): ScanDecision {
  const payload = { ...descendReceiptPayload, ...overrides };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

const leafSelectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
  schema: "openlifewiki.leaf-selection/v1",
  scanId: "scan-1",
  sourceId: "source-1",
  nodeId: "leaf",
  nodeVersion: "leaf-v1",
  scanPlanHash: "plan-1",
  skeletonVersion: "skeleton-1",
  authorizationHash: "auth-1",
  inputSetHash: "leaf-input-1",
  actor: "agent:codex/native",
  reason: "Selected within the approved body budget",
  persistedAt: "2026-07-26T10:01:30Z",
};

function leafSelectionReceipt(
  overrides: Partial<Omit<LeafSelectionReceipt, "receiptHash">> = {},
): LeafSelectionReceipt {
  const payload = { ...leafSelectionPayload, ...overrides };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function bodyGate(overrides: Record<string, unknown> = {}) {
  const receipt = decisionReceipt();
  const selection = leafSelectionReceipt();
  return {
    request: {
      sourceId: "source-1",
      nodeId: "leaf",
      authorizationHash: "auth-1",
      scanPlanHash: "plan-1",
      skeletonVersion: "skeleton-1",
      nodeVersion: "leaf-v1",
    },
    authorization,
    plan,
    path: [rootNode, leafNode],
    decisionReceipts: [receipt],
    leafSelectionReceipts: [selection],
    trustedReceiptHashes: [receipt.receiptHash, selection.receiptHash],
    metadataSamples: [],
    ...overrides,
  };
}

describe("body read gate", () => {
  it("allows an exact, version-bound body read with a persisted descend path", () => {
    expect(assertBodyReadAllowed(bodyGate())).toEqual({ allowed: true });
  });

  it.each([
    ["authorizationHash", "wrong-auth"],
    ["scanPlanHash", "wrong-plan"],
    ["skeletonVersion", "wrong-skeleton"],
    ["nodeVersion", "leaf-v2"],
  ])("rejects a mismatched %s", (field, value) => {
    expect(() => assertBodyReadAllowed(bodyGate({
      request: { ...bodyGate().request, [field]: value },
    }))).toThrow(/mismatch/i);
  });

  it("rejects a path without a persisted descend decision", () => {
    expect(() => assertBodyReadAllowed(bodyGate({ decisionReceipts: [] }))).toThrow(/descend/i);
  });

  it("rejects a truncated path that omits the ancestor decision boundary", () => {
    expect(() => assertBodyReadAllowed(bodyGate({ path: [leafNode] }))).toThrow(/descend/i);
  });

  it("anchors the path to the authorized root node", () => {
    expect(() => assertBodyReadAllowed(bodyGate({
      authorization: { ...authorization, rootNodeId: "different-root" },
    }))).toThrow(/root/i);
    expect(() => assertBodyReadAllowed(bodyGate({
      path: [{ ...rootNode, parentId: "outside" }, leafNode],
    }))).toThrow(/root/i);
  });

  it("rejects a path whose ancestor belongs to another Source", () => {
    expect(() => assertBodyReadAllowed(bodyGate({
      path: [{ ...rootNode, sourceId: "source-2" }, leafNode],
    }))).toThrow(/source/i);
  });

  it.each(["root", "leaf"])("rejects unreadable %s nodes", (position) => {
    expect(() => assertBodyReadAllowed(bodyGate({
      path: position === "root"
        ? [{ ...rootNode, permission: "denied" }, leafNode]
        : [rootNode, { ...leafNode, permission: "denied" }],
    }))).toThrow(/permission/i);
  });

  it("rejects a metadata-only target", () => {
    expect(() => assertBodyReadAllowed(bodyGate({
      path: [rootNode, { ...leafNode, scanability: "metadata-only" }],
    }))).toThrow(/body/i);
  });

  it("rejects a valid receipt hash that is absent from the trusted ledger", () => {
    const receipt = decisionReceipt();
    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [receipt],
      trustedReceiptHashes: ["sha256:unrelated"],
    }))).toThrow(/trusted/i);
  });

  it("rejects a trusted skip receipt whose decision was changed to descend", () => {
    const trustedSkipReceipt = decisionReceipt({ decision: "skip" });
    const tamperedReceipt: ScanDecision = {
      ...trustedSkipReceipt,
      decision: "descend",
    };

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [tamperedReceipt],
      trustedReceiptHashes: [trustedSkipReceipt.receiptHash],
    }))).toThrow(/integrity/i);
  });

  it("rejects a body read without a target leaf selection receipt", () => {
    expect(() => assertBodyReadAllowed(bodyGate({ leafSelectionReceipts: [] }))).toThrow(
      /leaf selection/i,
    );
  });

  it("rejects a selection receipt for another leaf", () => {
    const ancestor = decisionReceipt();
    const wrongLeaf = leafSelectionReceipt({ nodeId: "other-leaf" });

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [ancestor],
      leafSelectionReceipts: [wrongLeaf],
      trustedReceiptHashes: [ancestor.receiptHash, wrongLeaf.receiptHash],
    }))).toThrow(/leaf selection/i);
  });

  it("rejects a tampered target leaf selection receipt", () => {
    const ancestor = decisionReceipt();
    const selection = leafSelectionReceipt();
    const tamperedSelection: LeafSelectionReceipt = {
      ...selection,
      reason: "Tampered after persistence",
    };

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [ancestor],
      leafSelectionReceipts: [tamperedSelection],
      trustedReceiptHashes: [ancestor.receiptHash, selection.receiptHash],
    }))).toThrow(/integrity/i);
  });

  it("rejects an authentic leaf selection receipt absent from the trusted ledger", () => {
    const ancestor = decisionReceipt();
    const selection = leafSelectionReceipt();

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [ancestor],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [ancestor.receiptHash],
    }))).toThrow(/trusted/i);
  });

  it("rejects a receipt when no persisted ledger hash was loaded", () => {
    expect(() => assertBodyReadAllowed(bodyGate({ trustedReceiptHashes: [] }))).toThrow(/trusted/i);
  });

  it("does not treat metadata sampling as body authorization", () => {
    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [],
      metadataSamples: [{
        schema: "openlifewiki.metadata-sample/v1",
        nodeId: "root",
        inputSetHash: "input-1",
        fields: { title: "Root" },
      }],
    }))).toThrow(/descend/i);
  });
});

const proposal: WikiProposal = {
  schema: "openlifewiki.wiki-proposal/v1",
  proposalId: "proposal-1",
  baseWikiHash: "wiki-1",
  evidenceManifestHash: "evidence-1",
  compiler: {
    project: "atomicstrata/llm-wiki-compiler",
    version: "1.1.0",
    receiptHash: "compiler-1",
  },
  taxonomy: { folders: [], tags: [], aliases: [] },
  directoryDiff: [],
  fileDiff: [],
  tagDiff: [],
  linkChanges: [],
  quality: { citation: {}, freshness: {}, links: {}, lint: {}, eval: {}, knownGaps: [] },
  proposalHash: "proposal-hash-1",
};

const approvalPayload: Omit<WikiApproval, "receiptHash"> = {
  schema: "openlifewiki.wiki-approval/v1",
  proposalId: "proposal-1",
  proposalHash: "proposal-hash-1",
  baseWikiHash: "wiki-1",
  actor: { id: "owner-1", role: "owner" },
  approvedAt: "2026-07-26T10:02:00Z",
};

function approvalReceipt(
  overrides: Partial<Omit<WikiApproval, "receiptHash">> = {},
): WikiApproval {
  const payload = { ...approvalPayload, ...overrides };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function publicationGate(overrides: Record<string, unknown> = {}) {
  const approval = approvalReceipt();
  return {
    proposal,
    approval,
    expectedOwnerId: "owner-1",
    trustedApprovalReceiptHashes: [approval.receiptHash],
    recomputedProposalHash: "proposal-hash-1",
    currentWikiHash: "wiki-1",
    ...overrides,
  };
}

describe("Wiki approval gate", () => {
  it("allows an Owner receipt only when proposal and base hashes still match", () => {
    expect(assertWikiPublicationAllowed(publicationGate())).toEqual({ allowed: true });
  });

  it.each(["visitor", "admin"])("rejects a %s publication receipt", (role) => {
    expect(() => assertWikiPublicationAllowed(publicationGate({
      approval: {
        ...approvalReceipt(),
        actor: { id: `${role}-1`, role },
      } as unknown as WikiApproval,
    }))).toThrow(/owner/i);
  });

  it.each([
    ["reviewed proposal", { approval: { ...approvalReceipt(), proposalHash: "other" } }],
    ["recomputed proposal", { recomputedProposalHash: "other" }],
    ["base Wiki approval", { approval: { ...approvalReceipt(), baseWikiHash: "other" } }],
    ["current Wiki CAS", { currentWikiHash: "other" }],
  ])("rejects a mismatch in %s", (_label, overrides) => {
    expect(() => assertWikiPublicationAllowed(publicationGate(overrides))).toThrow(
      /integrity|mismatch/i,
    );
  });

  it("rejects an Owner role string for the wrong expected identity", () => {
    expect(() => assertWikiPublicationAllowed(publicationGate({
      approval: approvalReceipt({ actor: { id: "attacker", role: "owner" } }),
    }))).toThrow(/owner/i);
  });

  it("rejects an approval receipt with a changed hash", () => {
    expect(() => assertWikiPublicationAllowed(publicationGate({
      approval: { ...approvalReceipt(), receiptHash: "sha256:forged" },
    }))).toThrow(/integrity/i);
  });

  it("rejects an authentic approval receipt absent from the trusted ledger", () => {
    const approval = approvalReceipt();
    expect(() => assertWikiPublicationAllowed(publicationGate({
      approval,
      trustedApprovalReceiptHashes: [],
    }))).toThrow(/trusted/i);
  });

  it("does not let Admin tool access bypass exact approval", () => {
    const tools = listMcpTools({ id: "admin-session", role: "admin" });
    expect(tools).toContain("wiki-proposal.approve");
    expect(() => assertWikiPublicationAllowed(publicationGate({
      approval: {
        ...approvalReceipt(),
        actor: { id: "admin-1", role: "admin" },
      } as unknown as WikiApproval,
    }))).toThrow(/owner/i);
  });
});
