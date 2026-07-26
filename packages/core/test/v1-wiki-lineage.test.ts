import { describe, expect, it } from "vitest";

import type {
  ActiveQmdGenerationEvidence,
  ConnectorType,
  OwnerApprovedScanEvidence,
  WikiApproval,
  WikiEvidenceManifest,
  WikiEvidenceLineage,
  WikiProposal,
  WikiVaultManifest,
} from "@openlifewiki/protocol";

import { assertWikiPublicationAllowed, sha256Canonical } from "../src/index.js";

const CONNECTOR_TYPES = [
  "local-folder",
  "github",
  "feishu",
  "codex-history",
] as const satisfies readonly ConnectorType[];

function hash(value: string): string {
  return sha256Canonical(value);
}

function canonicalReceipt<T extends Readonly<Record<string, unknown>>>(payload: T) {
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function canonicalLineage<T extends Readonly<Record<string, unknown>>>(payload: T) {
  return { ...payload, lineageHash: sha256Canonical(payload) };
}

function canonicalVault<T extends Readonly<Record<string, unknown>>>(payload: T) {
  return { ...payload, vaultManifestHash: sha256Canonical(payload) };
}

interface LineageFixture {
  readonly gate: Parameters<typeof assertWikiPublicationAllowed>[0];
  readonly ownerScan: OwnerApprovedScanEvidence;
  readonly activeGeneration: ActiveQmdGenerationEvidence;
  readonly evidenceManifest: WikiEvidenceManifest;
  readonly lineage: WikiEvidenceLineage;
  readonly proposal: WikiProposal;
  readonly vault: WikiVaultManifest;
}

function lineageFixture(
  connectorTypes: readonly ConnectorType[] = CONNECTOR_TYPES,
): LineageFixture {
  const connectorSet = [...new Set(connectorTypes)];
  const requiredSources = connectorTypes.map((connectorType, index) => ({
    sourceId: `source-${index + 1}`,
    connectorType,
    authorizationHash: hash(`authorization-${index + 1}`),
  }));
  const connectedSources = requiredSources.map((source, index) => ({
    ...source,
    identityFingerprint: hash(`identity-${index + 1}`),
    status: "connected" as const,
    connectorStatusReceiptHash: hash(`connector-status-${index + 1}`),
  }));
  const scanPlanHash = hash("owner-approved-scan-plan");
  const ownerApprovalReceiptHash = hash("owner-scan-approval");
  const ownerScan = canonicalReceipt({
    schema: "openlifewiki.owner-approved-scan-evidence/v1" as const,
    scanPlanHash,
    requiredSources,
    connectedSources,
    owner: { id: "owner-1", role: "owner" as const },
    ownerApprovalReceiptHash,
    approvedAt: "2026-07-26T10:00:00Z",
  });

  const selectedLeafManifestHash = hash("selected-leaf-manifest");
  const committedSources = requiredSources.map(({ sourceId, connectorType }, index) => ({
    sourceId,
    connectorType,
    evidenceReceiptHashes: [hash(`selected-leaf-evidence-${index + 1}`)],
  }));
  const activeGeneration = canonicalReceipt({
    schema: "openlifewiki.active-qmd-generation-evidence/v1" as const,
    scanPlanHash,
    ownerApprovedScanReceiptHash: ownerScan.receiptHash,
    selectedLeafManifestHash,
    generationId: "qmd-generation-1",
    manifestHash: hash("qmd-manifest-1"),
    committedSources,
    publishedAt: "2026-07-26T10:10:00Z",
  });

  const evidenceSources = committedSources;
  const evidenceManifestPayload = {
    schema: "openlifewiki.wiki-evidence-manifest/v1" as const,
    scanPlanHash,
    selectedLeafManifestHash,
    activeQmdGenerationId: activeGeneration.generationId,
    activeQmdManifestHash: activeGeneration.manifestHash,
    activeQmdGenerationReceiptHash: activeGeneration.receiptHash,
    sources: evidenceSources,
    generatedAt: "2026-07-26T10:11:00Z",
  };
  const evidenceManifestHash = sha256Canonical(evidenceManifestPayload);
  const evidenceManifestReceiptPayload = {
    ...evidenceManifestPayload,
    evidenceManifestHash,
  };
  const evidenceManifest: WikiEvidenceManifest = {
    ...evidenceManifestReceiptPayload,
    receiptHash: sha256Canonical(evidenceManifestReceiptPayload),
  };
  const lineage = canonicalLineage({
    schema: "openlifewiki.wiki-evidence-lineage/v1" as const,
    scanPlanHash,
    ownerApprovedScanReceiptHash: ownerScan.receiptHash,
    selectedLeafManifestHash,
    activeQmdGenerationId: activeGeneration.generationId,
    activeQmdManifestHash: activeGeneration.manifestHash,
    activeQmdGenerationReceiptHash: activeGeneration.receiptHash,
    evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
    sourceIds: requiredSources.map(({ sourceId }) => sourceId),
    connectorTypes: connectorSet,
  });

  const proposalPayload = {
    schema: "openlifewiki.wiki-proposal/v1" as const,
    proposalId: "proposal-1",
    baseWikiHash: hash("wiki-before-publication"),
    scanPlanHash,
    selectedLeafManifestHash,
    activeQmdGenerationId: activeGeneration.generationId,
    activeQmdManifestHash: activeGeneration.manifestHash,
    activeQmdGenerationReceiptHash: activeGeneration.receiptHash,
    evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
    evidenceLineageHash: lineage.lineageHash,
    sourceIds: requiredSources.map(({ sourceId }) => sourceId),
    connectorTypes: connectorSet,
    compiler: {
      project: "atomicstrata/llm-wiki-compiler" as const,
      version: "1.1.0" as const,
      receiptHash: hash("compiler-receipt"),
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

  const vault = canonicalVault({
    schema: "openlifewiki.wiki-vault-manifest/v1" as const,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
    scanPlanHash,
    selectedLeafManifestHash,
    activeQmdGenerationId: activeGeneration.generationId,
    activeQmdManifestHash: activeGeneration.manifestHash,
    activeQmdGenerationReceiptHash: activeGeneration.receiptHash,
    evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
    evidenceLineageHash: lineage.lineageHash,
    sourceIds: requiredSources.map(({ sourceId }) => sourceId),
    connectorTypes: connectorSet,
    generatedAt: "2026-07-26T10:20:00Z",
  });

  const approvalPayload = {
    schema: "openlifewiki.wiki-approval/v1" as const,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
    baseWikiHash: proposal.baseWikiHash,
    actor: { id: "owner-1", role: "owner" as const },
    approvedAt: "2026-07-26T10:21:00Z",
  };
  const approval: WikiApproval = canonicalReceipt(approvalPayload);

  const trustedLineageReceiptHashes = [
    ownerApprovalReceiptHash,
    ownerScan.receiptHash,
    activeGeneration.receiptHash,
    evidenceManifest.receiptHash,
    lineage.lineageHash,
    ...connectedSources.map(({ connectorStatusReceiptHash }) => connectorStatusReceiptHash),
    ...evidenceSources.flatMap(({ evidenceReceiptHashes }) => evidenceReceiptHashes),
  ];
  const gate = {
    proposal,
    approval,
    ownerApprovedScan: ownerScan,
    currentActiveQmdGeneration: activeGeneration,
    evidenceManifest,
    evidenceLineage: lineage,
    vaultManifest: vault,
    expectedOwnerId: "owner-1",
    trustedApprovalReceiptHashes: [approval.receiptHash],
    trustedLineageReceiptHashes,
    recomputedProposalHash: proposal.proposalHash,
    currentWikiHash: proposal.baseWikiHash,
  } satisfies Parameters<typeof assertWikiPublicationAllowed>[0];

  return { gate, ownerScan, activeGeneration, evidenceManifest, lineage, proposal, vault };
}

function withReceipt<T extends { readonly receiptHash: string }>(
  value: T,
  changes: Omit<Partial<T>, "receiptHash">,
): T {
  const { receiptHash: _oldHash, ...payload } = { ...value, ...changes };
  return { ...payload, receiptHash: sha256Canonical(payload) } as unknown as T;
}

function withLineage(
  value: WikiEvidenceLineage,
  changes: Omit<Partial<WikiEvidenceLineage>, "lineageHash">,
): WikiEvidenceLineage {
  const { lineageHash: _oldHash, ...payload } = { ...value, ...changes };
  return { ...payload, lineageHash: sha256Canonical(payload) };
}

function withEvidenceManifest(
  value: WikiEvidenceManifest,
  changes: Omit<Partial<WikiEvidenceManifest>, "evidenceManifestHash" | "receiptHash">,
): WikiEvidenceManifest {
  const {
    evidenceManifestHash: _oldManifestHash,
    receiptHash: _oldReceiptHash,
    ...oldPayload
  } = value;
  const payload = { ...oldPayload, ...changes };
  const evidenceManifestHash = sha256Canonical(payload);
  const receiptPayload = { ...payload, evidenceManifestHash };
  return { ...receiptPayload, receiptHash: sha256Canonical(receiptPayload) };
}

function withVault(
  value: WikiVaultManifest,
  changes: Omit<Partial<WikiVaultManifest>, "vaultManifestHash">,
): WikiVaultManifest {
  const { vaultManifestHash: _oldHash, ...payload } = { ...value, ...changes };
  return { ...payload, vaultManifestHash: sha256Canonical(payload) };
}

function withEvidenceChain(
  fixture: LineageFixture,
  evidenceManifest: WikiEvidenceManifest,
): Parameters<typeof assertWikiPublicationAllowed>[0] {
  const lineage = withLineage(fixture.lineage, {
    evidenceManifestHash: evidenceManifest.evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
  });
  const {
    proposalHash: _oldProposalHash,
    ...oldProposalPayload
  } = fixture.proposal;
  const proposalPayload = {
    ...oldProposalPayload,
    evidenceManifestHash: evidenceManifest.evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
    evidenceLineageHash: lineage.lineageHash,
  };
  const proposal: WikiProposal = {
    ...proposalPayload,
    proposalHash: sha256Canonical(proposalPayload),
  };
  const vault = withVault(fixture.vault, {
    proposalHash: proposal.proposalHash,
    evidenceManifestHash: evidenceManifest.evidenceManifestHash,
    evidenceManifestReceiptHash: evidenceManifest.receiptHash,
    evidenceLineageHash: lineage.lineageHash,
  });
  const approval = withReceipt(fixture.gate.approval, {
    proposalHash: proposal.proposalHash,
  });
  return {
    ...fixture.gate,
    evidenceManifest,
    evidenceLineage: lineage,
    proposal,
    vaultManifest: vault,
    approval,
    recomputedProposalHash: proposal.proposalHash,
    trustedApprovalReceiptHashes: [approval.receiptHash],
    trustedLineageReceiptHashes: [
      ...fixture.gate.trustedLineageReceiptHashes,
      evidenceManifest.receiptHash,
      lineage.lineageHash,
      ...evidenceManifest.sources.flatMap(({ evidenceReceiptHashes }) => evidenceReceiptHashes),
    ],
  };
}

describe("Wiki live-to-Vault lineage gate", () => {
  it("accepts the AV02 four-Connector chain when every exact set and hash resolves", () => {
    expect(assertWikiPublicationAllowed(lineageFixture().gate)).toEqual({ allowed: true });
  });

  it("accepts an ordinary Owner-approved subset without a global four-Connector requirement", () => {
    const fixture = lineageFixture(["local-folder", "github"]);
    expect(assertWikiPublicationAllowed(fixture.gate)).toEqual({ allowed: true });
  });

  it("rejects a required Connector that is not connected", () => {
    const fixture = lineageFixture();
    const ownerScan = withReceipt(fixture.ownerScan, {
      connectedSources: fixture.ownerScan.connectedSources.slice(0, -1),
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      ownerApprovedScan: ownerScan,
      trustedLineageReceiptHashes: [
        ...fixture.gate.trustedLineageReceiptHashes,
        ownerScan.receiptHash,
      ],
    })).toThrow(/connected.*required|exact.*connected/i);
  });

  it("rejects a missing committed Source even when the Connector type set still matches", () => {
    const fixture = lineageFixture(["local-folder", "local-folder", "github"]);
    const activeGeneration = withReceipt(fixture.activeGeneration, {
      committedSources: fixture.activeGeneration.committedSources.slice(1),
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      currentActiveQmdGeneration: activeGeneration,
      trustedLineageReceiptHashes: [
        ...fixture.gate.trustedLineageReceiptHashes,
        activeGeneration.receiptHash,
      ],
    })).toThrow(/committed.*required|source.*exact/i);
  });

  it("rejects evidence from a QMD generation that is no longer active", () => {
    const fixture = lineageFixture();
    const replacement = withReceipt(fixture.activeGeneration, {
      generationId: "qmd-generation-2",
      manifestHash: hash("qmd-manifest-2"),
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      currentActiveQmdGeneration: replacement,
      trustedLineageReceiptHashes: [
        ...fixture.gate.trustedLineageReceiptHashes,
        replacement.receiptHash,
      ],
    })).toThrow(/generation|manifest|lineage/i);
  });

  it("rejects a canonical Evidence Manifest that omits one required Source", () => {
    const fixture = lineageFixture(["local-folder", "local-folder", "github"]);
    const evidenceManifest = withEvidenceManifest(fixture.evidenceManifest, {
      sources: fixture.evidenceManifest.sources.slice(1),
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      evidenceManifest,
      trustedLineageReceiptHashes: [
        ...fixture.gate.trustedLineageReceiptHashes,
        evidenceManifest.receiptHash,
      ],
    })).toThrow(/evidence manifest.*source.*required|source.*exact/i);
  });

  it("rejects a tampered Evidence Manifest payload", () => {
    const fixture = lineageFixture();
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      evidenceManifest: {
        ...fixture.evidenceManifest,
        generatedAt: "2026-07-26T10:11:01Z",
      },
    })).toThrow(/evidence manifest.*integrity/i);
  });

  it("rejects an authentic Evidence Manifest receipt absent from the trusted ledger", () => {
    const fixture = lineageFixture();
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      trustedLineageReceiptHashes: fixture.gate.trustedLineageReceiptHashes.filter(
        (receiptHash) => receiptHash !== fixture.evidenceManifest.receiptHash,
      ),
    })).toThrow(/evidence manifest.*trusted|trusted ledger/i);
  });

  it("rejects a trusted evidence receipt assigned to the wrong Source", () => {
    const fixture = lineageFixture(["local-folder", "github"]);
    const evidenceManifest = withEvidenceManifest(fixture.evidenceManifest, {
      sources: fixture.evidenceManifest.sources.map((source, index, sources) => ({
        ...source,
        evidenceReceiptHashes: sources[index === 0 ? 1 : 0]!.evidenceReceiptHashes,
      })),
    });
    expect(() => assertWikiPublicationAllowed(
      withEvidenceChain(fixture, evidenceManifest),
    )).toThrow(/active.*source|committed.*receipt|frozen.*set/i);
  });

  it("rejects a trusted receipt from a stale QMD generation", () => {
    const fixture = lineageFixture();
    const staleReceiptHash = hash("stale-generation-evidence");
    const evidenceManifest = withEvidenceManifest(fixture.evidenceManifest, {
      sources: fixture.evidenceManifest.sources.map((source, index) => index === 0
        ? { ...source, evidenceReceiptHashes: [staleReceiptHash] }
        : source),
    });
    expect(() => assertWikiPublicationAllowed(
      withEvidenceChain(fixture, evidenceManifest),
    )).toThrow(/active.*generation|committed.*receipt|frozen.*set/i);
  });

  it("rejects a proposal that drops a required Source", () => {
    const fixture = lineageFixture();
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      proposal: {
        ...fixture.proposal,
        sourceIds: fixture.proposal.sourceIds.slice(0, -1),
      },
    })).toThrow(/proposal.*required|source.*exact|proposalHash|integrity/i);
  });

  it("rejects canonical proposal and approval objects with the wrong V1 schema", () => {
    const fixture = lineageFixture();
    const { proposalHash: _proposalHash, ...proposalPayload } = fixture.proposal;
    const wrongProposalPayload = {
      ...proposalPayload,
      schema: "openlifewiki.wiki-proposal/v2",
    };
    const wrongProposal = {
      ...wrongProposalPayload,
      proposalHash: sha256Canonical(wrongProposalPayload),
    } as unknown as WikiProposal;
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      proposal: wrongProposal,
      recomputedProposalHash: wrongProposal.proposalHash,
    })).toThrow(/proposal schema/i);

    const { receiptHash: _approvalHash, ...approvalPayload } = fixture.gate.approval;
    const wrongApprovalPayload = {
      ...approvalPayload,
      schema: "openlifewiki.wiki-approval/v2",
    };
    const wrongApproval = {
      ...wrongApprovalPayload,
      receiptHash: sha256Canonical(wrongApprovalPayload),
    } as unknown as WikiApproval;
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      approval: wrongApproval,
      trustedApprovalReceiptHashes: [wrongApproval.receiptHash],
    })).toThrow(/approval schema/i);
  });

  it("rejects a canonical proposal from a different compiler contract", () => {
    const fixture = lineageFixture();
    const { proposalHash: _proposalHash, ...proposalPayload } = fixture.proposal;
    const wrongCompilerPayload = {
      ...proposalPayload,
      compiler: { ...proposalPayload.compiler, version: "1.2.0" },
    };
    const proposal = {
      ...wrongCompilerPayload,
      proposalHash: sha256Canonical(wrongCompilerPayload),
    } as unknown as WikiProposal;
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      proposal,
      recomputedProposalHash: proposal.proposalHash,
    })).toThrow(/compiler contract/i);
  });

  it("rejects a Vault that adds a non-approved Source", () => {
    const fixture = lineageFixture();
    const vault = withVault(fixture.vault, {
      sourceIds: [...fixture.vault.sourceIds, "source-unapproved"],
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      vaultManifest: vault,
    })).toThrow(/vault.*required|source.*exact/i);
  });

  it("rejects a lineage hash that the proposal did not bind", () => {
    const fixture = lineageFixture();
    const lineage = withLineage(fixture.lineage, {
      evidenceManifestHash: hash("substituted-evidence"),
    });
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      evidenceLineage: lineage,
      trustedLineageReceiptHashes: [
        ...fixture.gate.trustedLineageReceiptHashes,
        lineage.lineageHash,
      ],
    })).toThrow(/lineage|evidence/i);
  });

  it("rejects an authentic chain receipt absent from the trusted ledger", () => {
    const fixture = lineageFixture();
    expect(() => assertWikiPublicationAllowed({
      ...fixture.gate,
      trustedLineageReceiptHashes: fixture.gate.trustedLineageReceiptHashes.filter(
        (receiptHash) => receiptHash !== fixture.activeGeneration.receiptHash,
      ),
    })).toThrow(/trusted/i);
  });
});
