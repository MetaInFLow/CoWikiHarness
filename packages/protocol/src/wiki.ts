import type { ConnectorType } from "./connector.js";

export interface WikiSourceRequirement {
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly authorizationHash: string;
}

export interface ConnectedWikiSourceEvidence extends WikiSourceRequirement {
  readonly identityFingerprint: string;
  readonly status: "connected";
  readonly connectorStatusReceiptHash: string;
}

export interface CommittedWikiSourceEvidence {
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  /** Frozen receipts committed for this Source in this active generation. */
  readonly evidenceReceiptHashes: readonly string[];
}

/** Owner approval fixes the required Source set for one scan. */
export interface OwnerApprovedScanEvidence {
  readonly schema: "openlifewiki.owner-approved-scan-evidence/v1";
  readonly scanPlanHash: string;
  readonly requiredSources: readonly WikiSourceRequirement[];
  readonly connectedSources: readonly ConnectedWikiSourceEvidence[];
  readonly owner: {
    readonly id: string;
    readonly role: "owner";
  };
  readonly ownerApprovalReceiptHash: string;
  readonly approvedAt: string;
  readonly receiptHash: string;
}

/** Current active QMD evidence, supplied by the active-pointer boundary. */
export interface ActiveQmdGenerationEvidence {
  readonly schema: "openlifewiki.active-qmd-generation-evidence/v1";
  readonly scanPlanHash: string;
  readonly ownerApprovedScanReceiptHash: string;
  readonly selectedLeafManifestHash: string;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly committedSources: readonly CommittedWikiSourceEvidence[];
  readonly publishedAt: string;
  readonly receiptHash: string;
}

export interface WikiEvidenceSource {
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly evidenceReceiptHashes: readonly string[];
}

/** Canonical Evidence payload and its trusted persistence receipt. */
export interface WikiEvidenceManifest {
  readonly schema: "openlifewiki.wiki-evidence-manifest/v1";
  readonly scanPlanHash: string;
  readonly selectedLeafManifestHash: string;
  readonly activeQmdGenerationId: string;
  readonly activeQmdManifestHash: string;
  readonly activeQmdGenerationReceiptHash: string;
  readonly sources: readonly WikiEvidenceSource[];
  readonly generatedAt: string;
  readonly evidenceManifestHash: string;
  readonly receiptHash: string;
}

/** Immutable bridge from approved scan evidence to Wiki proposal semantics. */
export interface WikiEvidenceLineage {
  readonly schema: "openlifewiki.wiki-evidence-lineage/v1";
  readonly scanPlanHash: string;
  readonly ownerApprovedScanReceiptHash: string;
  readonly selectedLeafManifestHash: string;
  readonly activeQmdGenerationId: string;
  readonly activeQmdManifestHash: string;
  readonly activeQmdGenerationReceiptHash: string;
  readonly evidenceManifestHash: string;
  readonly evidenceManifestReceiptHash: string;
  readonly sourceIds: readonly string[];
  readonly connectorTypes: readonly ConnectorType[];
  readonly lineageHash: string;
}

export interface WikiProposal {
  readonly schema: "openlifewiki.wiki-proposal/v1";
  readonly proposalId: string;
  readonly baseWikiHash: string;
  readonly scanPlanHash: string;
  readonly selectedLeafManifestHash: string;
  readonly activeQmdGenerationId: string;
  readonly activeQmdManifestHash: string;
  readonly activeQmdGenerationReceiptHash: string;
  readonly evidenceManifestHash: string;
  readonly evidenceManifestReceiptHash: string;
  readonly evidenceLineageHash: string;
  readonly sourceIds: readonly string[];
  readonly connectorTypes: readonly ConnectorType[];
  readonly compiler: {
    readonly project: "atomicstrata/llm-wiki-compiler";
    readonly version: "1.1.0";
    readonly receiptHash: string;
  };
  readonly taxonomy: {
    readonly folders: readonly unknown[];
    readonly tags: readonly unknown[];
    readonly aliases: readonly unknown[];
  };
  readonly directoryDiff: readonly unknown[];
  readonly fileDiff: readonly unknown[];
  readonly tagDiff: readonly unknown[];
  readonly linkChanges: readonly unknown[];
  readonly quality: {
    readonly citation: Readonly<Record<string, unknown>>;
    readonly freshness: Readonly<Record<string, unknown>>;
    readonly links: Readonly<Record<string, unknown>>;
    readonly lint: Readonly<Record<string, unknown>>;
    readonly eval: Readonly<Record<string, unknown>>;
    readonly knownGaps: readonly unknown[];
  };
  readonly proposalHash: string;
}

export interface WikiVaultManifest {
  readonly schema: "openlifewiki.wiki-vault-manifest/v1";
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly scanPlanHash: string;
  readonly selectedLeafManifestHash: string;
  readonly activeQmdGenerationId: string;
  readonly activeQmdManifestHash: string;
  readonly activeQmdGenerationReceiptHash: string;
  readonly evidenceManifestHash: string;
  readonly evidenceManifestReceiptHash: string;
  readonly evidenceLineageHash: string;
  readonly sourceIds: readonly string[];
  readonly connectorTypes: readonly ConnectorType[];
  readonly generatedAt: string;
  readonly vaultManifestHash: string;
}

export interface WikiApproval {
  readonly schema: "openlifewiki.wiki-approval/v1";
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly baseWikiHash: string;
  readonly actor: {
    readonly id: string;
    readonly role: "owner";
  };
  readonly approvedAt: string;
  readonly receiptHash: string;
}
