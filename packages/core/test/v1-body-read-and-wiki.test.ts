import { describe, expect, it } from "vitest";

import {
  createScanPlan,
  createScanPlanPolicyMaterial,
  type ActiveQmdGenerationEvidence,
  type AuthorizedSourceV1,
  type LeafSelectionReceipt,
  type OwnerApprovedScanEvidence,
  type ScanDecision,
  type ScanPlan,
  type SkeletonNode,
  type WikiApproval,
  type WikiEvidenceManifest,
  type WikiEvidenceLineage,
  type WikiProposal,
  type WikiVaultManifest,
} from "@openlifewiki/protocol";

import {
  assertBodyReadAllowed,
  assertWikiPublicationAllowed,
  listMcpTools,
  sha256Canonical,
} from "../src/index.js";

const bodyAuthorizationHash = sha256Canonical("body-authorization");
const bodySkeletonVersion = sha256Canonical("body-skeleton");
const bodySkillHash = sha256Canonical("body-skill");

const authorization: AuthorizedSourceV1 = {
  schema: "openlifewiki.authorized-source/v1",
  sourceId: "source-1",
  connectorType: "local-folder",
  rootNodeId: "root",
  identityFingerprint: "identity-1",
  approval: {
    schema: "openlifewiki.source-owner-approval/v1",
    action: "authorize",
    approvedBy: "human:owner",
    approvedAt: "2026-07-26T10:00:00Z",
    ownerIdentityFingerprint: "owner-1",
    previewHash: "preview-1",
    configHash: "config-1",
    configRevision: 0,
    previousAuthorizationHash: null,
    approvalHash: "approval-1",
  },
  scope: { root: "/approved" },
  include: ["**/*.md"],
  exclude: [],
  sensitivity: { default: "normal", rules: [] },
  budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
  approvedBy: "human:owner",
  approvedAt: "2026-07-26T10:00:00Z",
  authorizationHash: bodyAuthorizationHash,
};

const plan: ScanPlan = createScanPlan({
  schema: "openlifewiki.scan-plan/v1",
  scanId: "scan-1",
  sourceIds: ["source-1"],
  authorizationHashes: [bodyAuthorizationHash],
  rootNodeIds: ["root"],
  skeletonVersion: bodySkeletonVersion,
  agentProfileId: "agent-codex",
  hostConfigRevision: 0,
  selectedAgentConfigHash: bodySkillHash,
  skillHash: bodySkillHash,
  scanIntent: "Build the current reusable knowledge Wiki.",
  ...createScanPlanPolicyMaterial({ ownerPolicy: {
    schema: "openlifewiki.scan-narrowing-policy/v1",
    include: ["/**"],
    exclude: [],
    sensitivity: { default: "normal", rules: [] },
    budget: {},
    indexing: { default: "qmd-current", rules: [] },
  } }),
});

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
  scanPlanHash: plan.scanPlanHash,
  skeletonVersion: plan.skeletonVersion,
  authorizationHash: bodyAuthorizationHash,
  sourceId: "source-1",
  parentNodeId: "root",
  parentNodeVersion: "root-v1",
  childSetHash: "children-1",
  nodeId: "leaf",
  nodeVersion: "leaf-v1",
  targetKind: "leaf",
  summaryHash: "summary-1",
  inputSetHash: "leaf-input-1",
  decision: "descend",
  reason: "Selected within scope and budget",
  revisitCondition: null,
  question: null,
  actor: "agent:codex/native",
  estimatedCost: { nodes: 1, bodyBytes: 10, agentCalls: 1 },
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
  scanPlanHash: plan.scanPlanHash,
  skeletonVersion: plan.skeletonVersion,
  authorizationHash: bodyAuthorizationHash,
  inputSetHash: "leaf-input-1",
  decisionReceiptHash: decisionReceipt().receiptHash,
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
      authorizationHash: bodyAuthorizationHash,
      scanPlanHash: plan.scanPlanHash,
      skeletonVersion: plan.skeletonVersion,
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

  it("rejects a tampered ScanPlan before evaluating body receipts", () => {
    expect(() => assertBodyReadAllowed(bodyGate({
      plan: { ...plan, scanIntent: "A replayed objective with the old hash." },
    }))).toThrow(/scanPlanHash/i);
  });

  it("pairs authorization and root with the request Source index", () => {
    const { scanPlanHash: _planHash, ...planPayload } = plan;
    const mismatchedPlan = createScanPlan({
      ...planPayload,
      sourceIds: ["source-other", "source-1"],
      authorizationHashes: [bodyAuthorizationHash, sha256Canonical("wrong-source-1-auth")],
      rootNodeIds: ["other-root", "root"],
    });
    expect(() => assertBodyReadAllowed(bodyGate({ plan: mismatchedPlan }))).toThrow(
      /authorizationHash mismatch/i,
    );
  });

  it("allows an authorized root that is itself a leaf with a target-bound root decision", () => {
    const rootLeaf: SkeletonNode = {
      ...leafNode,
      nodeId: "root",
      parentId: null,
      locator: "openlifewiki://feishu/document/root",
      nodeVersion: "root-v1",
    };
    const rootDecision = decisionReceipt({
      parentNodeId: "root",
      parentNodeVersion: "root-v1",
      nodeId: "root",
      nodeVersion: "root-v1",
      targetKind: "leaf",
    });
    const rootSelection = leafSelectionReceipt({
      nodeId: "root",
      nodeVersion: "root-v1",
      decisionReceiptHash: rootDecision.receiptHash,
    });
    expect(assertBodyReadAllowed(bodyGate({
      request: { ...bodyGate().request, nodeId: "root", nodeVersion: "root-v1" },
      path: [rootLeaf],
      decisionReceipts: [rootDecision],
      leafSelectionReceipts: [rootSelection],
      trustedReceiptHashes: [rootDecision.receiptHash, rootSelection.receiptHash],
    }))).toEqual({ allowed: true });
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

  it("rejects a descend receipt that targets an unrelated ancestor instead of the requested leaf", () => {
    const unrelated = decisionReceipt({
      parentNodeId: "root",
      parentNodeVersion: "root-v1",
      nodeId: "root",
      nodeVersion: "root-v1",
      targetKind: "container",
    });
    const selection = leafSelectionReceipt({ decisionReceiptHash: unrelated.receiptHash });

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [unrelated],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [unrelated.receiptHash, selection.receiptHash],
    }))).toThrow(/descend/i);
  });

  it("requires a persisted child descend decision for every path edge", () => {
    const folderNode: SkeletonNode = {
      ...rootNode,
      nodeId: "folder",
      parentId: "root",
      title: "Folder",
      locator: "file:///approved/folder",
      nodeVersion: "folder-v1",
    };
    const nestedLeaf: SkeletonNode = {
      ...leafNode,
      parentId: "folder",
      locator: "file:///approved/folder/leaf.md",
    };
    const folderDecision = decisionReceipt({
      nodeId: "folder",
      nodeVersion: "folder-v1",
      targetKind: "container",
      inputSetHash: "folder-input-1",
    });
    const leafDecision = decisionReceipt({
      parentNodeId: "folder",
      parentNodeVersion: "folder-v1",
    });
    const selection = leafSelectionReceipt({ decisionReceiptHash: leafDecision.receiptHash });
    const nestedGate = bodyGate({
      path: [rootNode, folderNode, nestedLeaf],
      decisionReceipts: [folderDecision, leafDecision],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [
        folderDecision.receiptHash,
        leafDecision.receiptHash,
        selection.receiptHash,
      ],
    });

    expect(assertBodyReadAllowed(nestedGate)).toEqual({ allowed: true });
    expect(() => assertBodyReadAllowed({
      ...nestedGate,
      decisionReceipts: [leafDecision],
    })).toThrow(/folder/i);
  });

  it("rejects a truncated path that omits the ancestor decision boundary", () => {
    expect(() => assertBodyReadAllowed(bodyGate({ path: [leafNode] }))).toThrow(/root|descend/i);
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

  it.each([
    ["source", { sourceId: "source-2" }],
    ["version", { nodeVersion: "leaf-v2" }],
    ["plan", { scanPlanHash: "plan-2" }],
    ["skeleton", { skeletonVersion: "skeleton-2" }],
    ["authorization", { authorizationHash: "auth-2" }],
  ])("rejects a leaf selection with a different %s binding", (_label, overrides) => {
    const leafDecision = decisionReceipt();
    const selection = leafSelectionReceipt(overrides);

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [leafDecision],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [leafDecision.receiptHash, selection.receiptHash],
    }))).toThrow(/leaf selection/i);
  });

  it("rejects a leaf selection bound to another decision receipt", () => {
    const leafDecision = decisionReceipt();
    const selection = leafSelectionReceipt({ decisionReceiptHash: "sha256:other-decision" });

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [leafDecision],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [leafDecision.receiptHash, selection.receiptHash],
    }))).toThrow(/decision receipt/i);
  });

  it("rejects a leaf selection whose input binding differs from the leaf decision", () => {
    const leafDecision = decisionReceipt();
    const selection = leafSelectionReceipt({ inputSetHash: "other-input" });

    expect(() => assertBodyReadAllowed(bodyGate({
      decisionReceipts: [leafDecision],
      leafSelectionReceipts: [selection],
      trustedReceiptHashes: [leafDecision.receiptHash, selection.receiptHash],
    }))).toThrow(/input/i);
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

const wikiScanPlanHash = sha256Canonical("wiki-scan-plan");
const wikiAuthorizationHash = sha256Canonical("wiki-authorization");
const connectorStatusReceiptHash = sha256Canonical("wiki-connector-status");
const ownerApprovalReceiptHash = sha256Canonical("wiki-owner-scan-approval");
const ownerScanPayload: Omit<OwnerApprovedScanEvidence, "receiptHash"> = {
  schema: "openlifewiki.owner-approved-scan-evidence/v1",
  scanPlanHash: wikiScanPlanHash,
  requiredSources: [{
    sourceId: "source-1",
    connectorType: "local-folder",
    authorizationHash: wikiAuthorizationHash,
  }],
  connectedSources: [{
    sourceId: "source-1",
    connectorType: "local-folder",
    authorizationHash: wikiAuthorizationHash,
    identityFingerprint: sha256Canonical("wiki-identity"),
    status: "connected",
    connectorStatusReceiptHash,
  }],
  owner: { id: "owner-1", role: "owner" },
  ownerApprovalReceiptHash,
  approvedAt: "2026-07-26T10:00:00Z",
};
const ownerApprovedScan: OwnerApprovedScanEvidence = {
  ...ownerScanPayload,
  receiptHash: sha256Canonical(ownerScanPayload),
};
const selectedLeafManifestHash = sha256Canonical("wiki-selected-leaves");
const wikiSourceEvidenceReceiptHash = sha256Canonical("wiki-source-evidence-receipt");
const activeGenerationPayload: Omit<ActiveQmdGenerationEvidence, "receiptHash"> = {
  schema: "openlifewiki.active-qmd-generation-evidence/v1",
  scanPlanHash: wikiScanPlanHash,
  ownerApprovedScanReceiptHash: ownerApprovedScan.receiptHash,
  selectedLeafManifestHash,
  generationId: "wiki-generation-1",
  manifestHash: sha256Canonical("wiki-qmd-manifest"),
  committedSources: [{
    sourceId: "source-1",
    connectorType: "local-folder",
    evidenceReceiptHashes: [wikiSourceEvidenceReceiptHash],
  }],
  publishedAt: "2026-07-26T10:01:00Z",
};
const currentActiveQmdGeneration: ActiveQmdGenerationEvidence = {
  ...activeGenerationPayload,
  receiptHash: sha256Canonical(activeGenerationPayload),
};
const evidenceManifestCore = {
  schema: "openlifewiki.wiki-evidence-manifest/v1" as const,
  scanPlanHash: wikiScanPlanHash,
  selectedLeafManifestHash,
  activeQmdGenerationId: currentActiveQmdGeneration.generationId,
  activeQmdManifestHash: currentActiveQmdGeneration.manifestHash,
  activeQmdGenerationReceiptHash: currentActiveQmdGeneration.receiptHash,
  sources: [{
    sourceId: "source-1",
    connectorType: "local-folder" as const,
    evidenceReceiptHashes: [wikiSourceEvidenceReceiptHash],
  }],
  generatedAt: "2026-07-26T10:01:10Z",
};
const evidenceManifestHash = sha256Canonical(evidenceManifestCore);
const evidenceManifestPayload = { ...evidenceManifestCore, evidenceManifestHash };
const evidenceManifest: WikiEvidenceManifest = {
  ...evidenceManifestPayload,
  receiptHash: sha256Canonical(evidenceManifestPayload),
};
const lineagePayload: Omit<WikiEvidenceLineage, "lineageHash"> = {
  schema: "openlifewiki.wiki-evidence-lineage/v1",
  scanPlanHash: wikiScanPlanHash,
  ownerApprovedScanReceiptHash: ownerApprovedScan.receiptHash,
  selectedLeafManifestHash,
  activeQmdGenerationId: currentActiveQmdGeneration.generationId,
  activeQmdManifestHash: currentActiveQmdGeneration.manifestHash,
  activeQmdGenerationReceiptHash: currentActiveQmdGeneration.receiptHash,
  evidenceManifestHash,
  evidenceManifestReceiptHash: evidenceManifest.receiptHash,
  sourceIds: ["source-1"],
  connectorTypes: ["local-folder"],
};
const evidenceLineage: WikiEvidenceLineage = {
  ...lineagePayload,
  lineageHash: sha256Canonical(lineagePayload),
};
const proposalPayload: Omit<WikiProposal, "proposalHash"> = {
  schema: "openlifewiki.wiki-proposal/v1",
  proposalId: "proposal-1",
  baseWikiHash: sha256Canonical("wiki-base"),
  scanPlanHash: wikiScanPlanHash,
  selectedLeafManifestHash,
  activeQmdGenerationId: currentActiveQmdGeneration.generationId,
  activeQmdManifestHash: currentActiveQmdGeneration.manifestHash,
  activeQmdGenerationReceiptHash: currentActiveQmdGeneration.receiptHash,
  evidenceManifestHash,
  evidenceManifestReceiptHash: evidenceManifest.receiptHash,
  evidenceLineageHash: evidenceLineage.lineageHash,
  sourceIds: ["source-1"],
  connectorTypes: ["local-folder"],
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
};
const proposal: WikiProposal = {
  ...proposalPayload,
  proposalHash: sha256Canonical(proposalPayload),
};
const vaultPayload: Omit<WikiVaultManifest, "vaultManifestHash"> = {
  schema: "openlifewiki.wiki-vault-manifest/v1",
  proposalId: proposal.proposalId,
  proposalHash: proposal.proposalHash,
  scanPlanHash: proposal.scanPlanHash,
  selectedLeafManifestHash: proposal.selectedLeafManifestHash,
  activeQmdGenerationId: proposal.activeQmdGenerationId,
  activeQmdManifestHash: proposal.activeQmdManifestHash,
  activeQmdGenerationReceiptHash: proposal.activeQmdGenerationReceiptHash,
  evidenceManifestHash: proposal.evidenceManifestHash,
  evidenceManifestReceiptHash: proposal.evidenceManifestReceiptHash,
  evidenceLineageHash: proposal.evidenceLineageHash,
  sourceIds: proposal.sourceIds,
  connectorTypes: proposal.connectorTypes,
  generatedAt: "2026-07-26T10:01:30Z",
};
const vaultManifest: WikiVaultManifest = {
  ...vaultPayload,
  vaultManifestHash: sha256Canonical(vaultPayload),
};

const approvalPayload: Omit<WikiApproval, "receiptHash"> = {
  schema: "openlifewiki.wiki-approval/v1",
  proposalId: "proposal-1",
  proposalHash: proposal.proposalHash,
  baseWikiHash: proposal.baseWikiHash,
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
    ownerApprovedScan,
    currentActiveQmdGeneration,
    evidenceManifest,
    evidenceLineage,
    vaultManifest,
    expectedOwnerId: "owner-1",
    trustedApprovalReceiptHashes: [approval.receiptHash],
    trustedLineageReceiptHashes: [
      ownerApprovalReceiptHash,
      ownerApprovedScan.receiptHash,
      connectorStatusReceiptHash,
      currentActiveQmdGeneration.receiptHash,
      wikiSourceEvidenceReceiptHash,
      evidenceManifest.receiptHash,
      evidenceLineage.lineageHash,
    ],
    recomputedProposalHash: proposal.proposalHash,
    currentWikiHash: proposal.baseWikiHash,
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
