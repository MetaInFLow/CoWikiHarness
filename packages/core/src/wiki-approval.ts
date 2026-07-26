import type {
  ActiveQmdGenerationEvidence,
  ConnectedWikiSourceEvidence,
  ConnectorType,
  OwnerApprovedScanEvidence,
  WikiApproval,
  WikiEvidenceManifest,
  WikiEvidenceLineage,
  WikiProposal,
  WikiSourceRequirement,
  WikiVaultManifest,
} from "@openlifewiki/protocol";
import { CONNECTOR_TYPES } from "@openlifewiki/protocol";

import { sha256Canonical } from "./hashing.js";

export interface WikiPublicationGateInput {
  readonly proposal: WikiProposal;
  readonly approval: WikiApproval;
  readonly ownerApprovedScan: OwnerApprovedScanEvidence;
  /** Loaded from the active QMD pointer at publication time. */
  readonly currentActiveQmdGeneration: ActiveQmdGenerationEvidence;
  readonly evidenceManifest: WikiEvidenceManifest;
  readonly evidenceLineage: WikiEvidenceLineage;
  readonly vaultManifest: WikiVaultManifest;
  readonly expectedOwnerId: string;
  readonly trustedApprovalReceiptHashes: readonly string[];
  readonly trustedLineageReceiptHashes: readonly string[];
  readonly recomputedProposalHash: string;
  readonly currentWikiHash: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function assertHash(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a canonical sha256 hash`);
}

function assertTrusted(hash: string, trusted: ReadonlySet<string>, label: string): void {
  assertHash(hash, label);
  if (!trusted.has(hash)) throw new Error(`${label} is absent from the trusted ledger`);
}

function assertCanonicalReceipt(
  value: Readonly<Record<string, unknown>> & { readonly receiptHash: string },
  label: string,
): void {
  const { receiptHash, ...payload } = value;
  if (sha256Canonical(payload) !== receiptHash) {
    throw new Error(`${label} ${receiptHash} failed integrity verification`);
  }
}

function assertCanonicalLineage(value: WikiEvidenceLineage): void {
  const { lineageHash, ...payload } = value;
  if (sha256Canonical(payload) !== lineageHash) {
    throw new Error(`Evidence lineage ${lineageHash} failed integrity verification`);
  }
}

function assertCanonicalEvidenceManifest(value: WikiEvidenceManifest): void {
  const { receiptHash, evidenceManifestHash, ...payload } = value;
  if (sha256Canonical(payload) !== evidenceManifestHash) {
    throw new Error(`Evidence Manifest ${evidenceManifestHash} failed payload integrity verification`);
  }
  if (sha256Canonical({ ...payload, evidenceManifestHash }) !== receiptHash) {
    throw new Error(`Evidence Manifest receipt ${receiptHash} failed integrity verification`);
  }
}

function assertCanonicalProposal(value: WikiProposal): void {
  const { proposalHash, ...payload } = value;
  if (sha256Canonical(payload) !== proposalHash) {
    throw new Error(`Wiki proposal ${proposalHash} failed integrity verification`);
  }
}

function assertCanonicalVault(value: WikiVaultManifest): void {
  const { vaultManifestHash, ...payload } = value;
  if (sha256Canonical(payload) !== vaultManifestHash) {
    throw new Error(`Wiki Vault manifest ${vaultManifestHash} failed integrity verification`);
  }
}

function uniqueSet(values: readonly string[], label: string, allowEmpty = false): Set<string> {
  if (!allowEmpty && values.length === 0) throw new Error(`${label} cannot be empty`);
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`${label} contains duplicate members`);
  return result;
}

function assertExactSet(actual: ReadonlySet<string>, expected: ReadonlySet<string>, label: string): void {
  const missing = [...expected].filter((member) => !actual.has(member));
  const extra = [...actual].filter((member) => !expected.has(member));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} must exactly equal the Owner-required set; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`,
    );
  }
}

function requiredSourceMap(
  required: readonly WikiSourceRequirement[],
): ReadonlyMap<string, WikiSourceRequirement> {
  uniqueSet(required.map(({ sourceId }) => sourceId), "Owner-required Source set");
  for (const source of required) {
    if (source.sourceId.length === 0) throw new Error("Owner-required Source id cannot be empty");
    if (!(CONNECTOR_TYPES as readonly string[]).includes(source.connectorType)) {
      throw new Error(`Owner-required Connector type ${String(source.connectorType)} is unsupported`);
    }
  }
  return new Map(required.map((source) => [source.sourceId, source]));
}

function connectorSetFromRequirements(
  required: readonly WikiSourceRequirement[],
): Set<ConnectorType> {
  return new Set(required.map(({ connectorType }) => connectorType));
}

function assertSourceBindings(
  values: readonly { readonly sourceId: string; readonly connectorType: ConnectorType }[],
  required: ReadonlyMap<string, WikiSourceRequirement>,
  label: string,
): void {
  const sourceIds = uniqueSet(values.map(({ sourceId }) => sourceId), `${label} Source set`);
  assertExactSet(sourceIds, new Set(required.keys()), `${label} Source set`);
  for (const value of values) {
    if (required.get(value.sourceId)?.connectorType !== value.connectorType) {
      throw new Error(`${label} Connector binding differs for Source ${value.sourceId}`);
    }
  }
}

function assertConnectedBindings(
  values: readonly ConnectedWikiSourceEvidence[],
  required: ReadonlyMap<string, WikiSourceRequirement>,
): void {
  assertSourceBindings(values, required, "Connected");
  for (const source of values) {
    const requirement = required.get(source.sourceId)!;
    if (source.status !== "connected") {
      throw new Error(`Connected Source ${source.sourceId} has status ${String(source.status)}`);
    }
    if (source.authorizationHash !== requirement.authorizationHash) {
      throw new Error(`Connected Source ${source.sourceId} authorizationHash mismatch`);
    }
    if (source.identityFingerprint.length === 0) {
      throw new Error(`Connected Source ${source.sourceId} identity fingerprint is missing`);
    }
    assertHash(source.identityFingerprint, `Identity fingerprint for Source ${source.sourceId}`);
  }
}

function assertDeclaredSets(
  sourceIds: readonly string[],
  connectorTypes: readonly ConnectorType[],
  required: ReadonlyMap<string, WikiSourceRequirement>,
  requiredConnectors: ReadonlySet<ConnectorType>,
  label: string,
): void {
  assertExactSet(
    uniqueSet(sourceIds, `${label} Source set`),
    new Set(required.keys()),
    `${label} Source set`,
  );
  assertExactSet(
    uniqueSet(connectorTypes, `${label} Connector set`),
    requiredConnectors,
    `${label} Connector set`,
  );
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function assertOwnerApprovedScan(
  evidence: OwnerApprovedScanEvidence,
  expectedOwnerId: string,
  trusted: ReadonlySet<string>,
): ReadonlyMap<string, WikiSourceRequirement> {
  if (evidence.schema !== "openlifewiki.owner-approved-scan-evidence/v1") {
    throw new Error("Owner-approved Scan evidence schema mismatch");
  }
  assertCanonicalReceipt(evidence as unknown as Readonly<Record<string, unknown>> & {
    readonly receiptHash: string;
  }, "Owner-approved Scan evidence");
  assertTrusted(evidence.receiptHash, trusted, "Owner-approved Scan evidence receipt");
  assertTrusted(evidence.ownerApprovalReceiptHash, trusted, "Owner Scan approval receipt");
  if (evidence.owner.role !== "owner" || evidence.owner.id !== expectedOwnerId) {
    throw new Error("Owner-approved Scan evidence does not match the expected Owner");
  }
  if (evidence.approvedAt.length === 0) throw new Error("Owner-approved Scan timestamp is missing");
  assertHash(evidence.scanPlanHash, "Owner-approved scanPlanHash");
  const required = requiredSourceMap(evidence.requiredSources);
  for (const source of evidence.requiredSources) {
    assertHash(source.authorizationHash, `Authorization for Source ${source.sourceId}`);
  }
  assertConnectedBindings(evidence.connectedSources, required);
  for (const source of evidence.connectedSources) {
    assertTrusted(
      source.connectorStatusReceiptHash,
      trusted,
      `Connector status receipt for Source ${source.sourceId}`,
    );
  }
  return required;
}

function assertCurrentGeneration(
  generation: ActiveQmdGenerationEvidence,
  ownerScan: OwnerApprovedScanEvidence,
  required: ReadonlyMap<string, WikiSourceRequirement>,
  trusted: ReadonlySet<string>,
): void {
  if (generation.schema !== "openlifewiki.active-qmd-generation-evidence/v1") {
    throw new Error("Active QMD generation evidence schema mismatch");
  }
  assertCanonicalReceipt(generation as unknown as Readonly<Record<string, unknown>> & {
    readonly receiptHash: string;
  }, "Active QMD generation evidence");
  assertTrusted(generation.receiptHash, trusted, "Active QMD generation receipt");
  assertEqual(generation.ownerApprovedScanReceiptHash, ownerScan.receiptHash, "QMD Owner Scan receipt");
  assertEqual(generation.scanPlanHash, ownerScan.scanPlanHash, "QMD scanPlanHash");
  assertHash(generation.selectedLeafManifestHash, "QMD selectedLeafManifestHash");
  assertHash(generation.manifestHash, "QMD manifestHash");
  if (generation.generationId.length === 0) throw new Error("Active QMD generationId is missing");
  if (generation.publishedAt.length === 0) throw new Error("Active QMD publication timestamp is missing");
  assertSourceBindings(generation.committedSources, required, "QMD committed");
  const committedReceiptHashes = generation.committedSources.flatMap((source) => {
    if (source.evidenceReceiptHashes.length === 0) {
      throw new Error(`Active QMD Source ${source.sourceId} has no committed evidence receipts`);
    }
    uniqueSet(
      source.evidenceReceiptHashes,
      `Active QMD Source ${source.sourceId} committed receipt set`,
    );
    return source.evidenceReceiptHashes;
  });
  uniqueSet(committedReceiptHashes, "Active QMD committed evidence receipt set");
  for (const receiptHash of committedReceiptHashes) {
    assertTrusted(receiptHash, trusted, "Active QMD committed evidence receipt");
  }
}

function assertEvidenceManifest(
  manifest: WikiEvidenceManifest,
  generation: ActiveQmdGenerationEvidence,
  ownerScan: OwnerApprovedScanEvidence,
  required: ReadonlyMap<string, WikiSourceRequirement>,
  trusted: ReadonlySet<string>,
): void {
  if (manifest.schema !== "openlifewiki.wiki-evidence-manifest/v1") {
    throw new Error("Evidence Manifest schema mismatch");
  }
  assertCanonicalEvidenceManifest(manifest);
  assertTrusted(manifest.receiptHash, trusted, "Evidence Manifest receipt");
  assertSourceBindings(manifest.sources, required, "Evidence Manifest");
  const committedBySource = new Map(generation.committedSources.map((source) => [
    source.sourceId,
    new Set(source.evidenceReceiptHashes),
  ]));
  const evidenceReceiptHashes = manifest.sources.flatMap(({ evidenceReceiptHashes }) => {
    if (evidenceReceiptHashes.length === 0) {
      throw new Error("Evidence Manifest Source has no evidence receipts");
    }
    uniqueSet(evidenceReceiptHashes, "Evidence Manifest Source receipt set");
    return evidenceReceiptHashes;
  });
  uniqueSet(evidenceReceiptHashes, "Evidence Manifest receipt set");
  for (const receiptHash of evidenceReceiptHashes) {
    assertTrusted(receiptHash, trusted, "Evidence Manifest item receipt");
  }
  for (const source of manifest.sources) {
    assertExactSet(
      new Set(source.evidenceReceiptHashes),
      committedBySource.get(source.sourceId) ?? new Set(),
      `Evidence Manifest Source ${source.sourceId} frozen committed receipt set`,
    );
  }
  assertEqual(manifest.scanPlanHash, ownerScan.scanPlanHash, "Evidence Manifest scanPlanHash");
  assertEqual(
    manifest.selectedLeafManifestHash,
    generation.selectedLeafManifestHash,
    "Evidence Manifest selectedLeafManifestHash",
  );
  assertEqual(
    manifest.activeQmdGenerationId,
    generation.generationId,
    "Evidence Manifest QMD generationId",
  );
  assertEqual(
    manifest.activeQmdManifestHash,
    generation.manifestHash,
    "Evidence Manifest QMD manifestHash",
  );
  assertEqual(
    manifest.activeQmdGenerationReceiptHash,
    generation.receiptHash,
    "Evidence Manifest active QMD generation receipt",
  );
  if (manifest.generatedAt.length === 0) throw new Error("Evidence Manifest timestamp is missing");
}

function assertLineage(
  lineage: WikiEvidenceLineage,
  ownerScan: OwnerApprovedScanEvidence,
  generation: ActiveQmdGenerationEvidence,
  manifest: WikiEvidenceManifest,
  required: ReadonlyMap<string, WikiSourceRequirement>,
  requiredConnectors: ReadonlySet<ConnectorType>,
  trusted: ReadonlySet<string>,
): void {
  if (lineage.schema !== "openlifewiki.wiki-evidence-lineage/v1") {
    throw new Error("Evidence lineage schema mismatch");
  }
  assertCanonicalLineage(lineage);
  assertTrusted(lineage.lineageHash, trusted, "Evidence lineage hash");
  assertDeclaredSets(
    lineage.sourceIds,
    lineage.connectorTypes,
    required,
    requiredConnectors,
    "Evidence lineage",
  );
  assertEqual(lineage.ownerApprovedScanReceiptHash, ownerScan.receiptHash, "Lineage Owner Scan receipt");
  assertEqual(lineage.scanPlanHash, ownerScan.scanPlanHash, "Lineage scanPlanHash");
  assertEqual(
    lineage.selectedLeafManifestHash,
    generation.selectedLeafManifestHash,
    "Lineage selectedLeafManifestHash",
  );
  assertEqual(lineage.activeQmdGenerationId, generation.generationId, "Lineage QMD generationId");
  assertEqual(lineage.activeQmdManifestHash, generation.manifestHash, "Lineage QMD manifestHash");
  assertEqual(
    lineage.activeQmdGenerationReceiptHash,
    generation.receiptHash,
    "Lineage active QMD generation receipt",
  );
  assertEqual(
    lineage.evidenceManifestHash,
    manifest.evidenceManifestHash,
    "Lineage evidenceManifestHash",
  );
  assertEqual(
    lineage.evidenceManifestReceiptHash,
    manifest.receiptHash,
    "Lineage Evidence Manifest receipt",
  );
}

function assertProposalLineage(
  proposal: WikiProposal,
  ownerScan: OwnerApprovedScanEvidence,
  generation: ActiveQmdGenerationEvidence,
  manifest: WikiEvidenceManifest,
  lineage: WikiEvidenceLineage,
  required: ReadonlyMap<string, WikiSourceRequirement>,
  requiredConnectors: ReadonlySet<ConnectorType>,
): void {
  if (proposal.schema !== "openlifewiki.wiki-proposal/v1") {
    throw new Error("Wiki proposal schema mismatch");
  }
  if (
    proposal.compiler.project !== "atomicstrata/llm-wiki-compiler"
    || proposal.compiler.version !== "1.1.0"
  ) {
    throw new Error("Wiki proposal compiler contract mismatch");
  }
  assertCanonicalProposal(proposal);
  assertDeclaredSets(
    proposal.sourceIds,
    proposal.connectorTypes,
    required,
    requiredConnectors,
    "Proposal",
  );
  assertEqual(proposal.scanPlanHash, ownerScan.scanPlanHash, "Proposal scanPlanHash");
  assertEqual(
    proposal.selectedLeafManifestHash,
    generation.selectedLeafManifestHash,
    "Proposal selectedLeafManifestHash",
  );
  assertEqual(proposal.activeQmdGenerationId, generation.generationId, "Proposal QMD generationId");
  assertEqual(proposal.activeQmdManifestHash, generation.manifestHash, "Proposal QMD manifestHash");
  assertEqual(
    proposal.activeQmdGenerationReceiptHash,
    generation.receiptHash,
    "Proposal active QMD generation receipt",
  );
  assertEqual(proposal.evidenceManifestHash, manifest.evidenceManifestHash, "Proposal evidenceManifestHash");
  assertEqual(
    proposal.evidenceManifestReceiptHash,
    manifest.receiptHash,
    "Proposal Evidence Manifest receipt",
  );
  assertEqual(proposal.evidenceLineageHash, lineage.lineageHash, "Proposal evidence lineage hash");
}

function assertVaultLineage(
  vault: WikiVaultManifest,
  proposal: WikiProposal,
  required: ReadonlyMap<string, WikiSourceRequirement>,
  requiredConnectors: ReadonlySet<ConnectorType>,
): void {
  if (vault.schema !== "openlifewiki.wiki-vault-manifest/v1") {
    throw new Error("Wiki Vault manifest schema mismatch");
  }
  assertCanonicalVault(vault);
  assertDeclaredSets(
    vault.sourceIds,
    vault.connectorTypes,
    required,
    requiredConnectors,
    "Vault",
  );
  assertEqual(vault.proposalId, proposal.proposalId, "Vault proposalId");
  assertEqual(vault.proposalHash, proposal.proposalHash, "Vault proposalHash");
  assertEqual(vault.scanPlanHash, proposal.scanPlanHash, "Vault scanPlanHash");
  assertEqual(
    vault.selectedLeafManifestHash,
    proposal.selectedLeafManifestHash,
    "Vault selectedLeafManifestHash",
  );
  assertEqual(vault.activeQmdGenerationId, proposal.activeQmdGenerationId, "Vault QMD generationId");
  assertEqual(vault.activeQmdManifestHash, proposal.activeQmdManifestHash, "Vault QMD manifestHash");
  assertEqual(
    vault.activeQmdGenerationReceiptHash,
    proposal.activeQmdGenerationReceiptHash,
    "Vault active QMD generation receipt",
  );
  assertEqual(vault.evidenceManifestHash, proposal.evidenceManifestHash, "Vault evidenceManifestHash");
  assertEqual(
    vault.evidenceManifestReceiptHash,
    proposal.evidenceManifestReceiptHash,
    "Vault Evidence Manifest receipt",
  );
  assertEqual(vault.evidenceLineageHash, proposal.evidenceLineageHash, "Vault evidence lineage hash");
  if (vault.generatedAt.length === 0) throw new Error("Wiki Vault manifest timestamp is missing");
}

export function assertWikiPublicationAllowed(
  input: WikiPublicationGateInput,
): { readonly allowed: true } {
  const { approval, proposal } = input;
  const trustedLineage = new Set(input.trustedLineageReceiptHashes);
  const required = assertOwnerApprovedScan(
    input.ownerApprovedScan,
    input.expectedOwnerId,
    trustedLineage,
  );
  const requiredConnectors = connectorSetFromRequirements(input.ownerApprovedScan.requiredSources);
  assertCurrentGeneration(
    input.currentActiveQmdGeneration,
    input.ownerApprovedScan,
    required,
    trustedLineage,
  );
  assertEvidenceManifest(
    input.evidenceManifest,
    input.currentActiveQmdGeneration,
    input.ownerApprovedScan,
    required,
    trustedLineage,
  );
  assertLineage(
    input.evidenceLineage,
    input.ownerApprovedScan,
    input.currentActiveQmdGeneration,
    input.evidenceManifest,
    required,
    requiredConnectors,
    trustedLineage,
  );
  assertProposalLineage(
    proposal,
    input.ownerApprovedScan,
    input.currentActiveQmdGeneration,
    input.evidenceManifest,
    input.evidenceLineage,
    required,
    requiredConnectors,
  );
  assertVaultLineage(input.vaultManifest, proposal, required, requiredConnectors);

  if (approval.schema !== "openlifewiki.wiki-approval/v1") {
    throw new Error("Wiki approval schema mismatch");
  }
  if (approval.actor.role !== "owner") {
    throw new Error("Wiki publication requires an Owner approval receipt");
  }
  if (approval.actor.id !== input.expectedOwnerId) {
    throw new Error("Wiki approval receipt does not match the expected Owner");
  }
  assertCanonicalReceipt(approval as unknown as Readonly<Record<string, unknown>> & {
    readonly receiptHash: string;
  }, "Wiki approval receipt");
  assertTrusted(
    approval.receiptHash,
    new Set(input.trustedApprovalReceiptHashes),
    "Wiki approval receipt",
  );
  if (approval.proposalId !== proposal.proposalId) throw new Error("proposalId mismatch");
  if (
    approval.proposalHash !== proposal.proposalHash
    || input.recomputedProposalHash !== proposal.proposalHash
  ) {
    throw new Error("proposalHash mismatch");
  }
  if (
    approval.baseWikiHash !== proposal.baseWikiHash
    || input.currentWikiHash !== proposal.baseWikiHash
  ) {
    throw new Error("baseWikiHash compare-and-swap mismatch");
  }
  if (approval.approvedAt.length === 0) {
    throw new Error("Wiki approval receipt is incomplete");
  }

  return { allowed: true };
}
