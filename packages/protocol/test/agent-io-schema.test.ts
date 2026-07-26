import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as protocolApi from "../src/index.js";
import {
  AGENT_IO_SCHEMA_IDS,
  AGENT_IO_SCHEMA_MANIFEST,
  AGENT_IO_EXECUTABLE_VALIDATORS,
  AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
  AGENT_IO_SEMANTIC_RULES,
  AGENT_IO_SEMANTIC_RULES_HASH,
  AGENT_IO_SEMANTIC_RULES_VERSION,
  AGENT_FAILURE_PRESENTATION,
  canonicalizeAgentIoExecutableSource,
  canonicalJson,
  getAgentIoJsonSchema,
  getAgentIoSchemaHash,
  parseAgentFailure,
  parseAgentIoEnvelope,
  parseAgentQueryResult,
  parseAgentScanResult,
  parseAgentWikiSemantics,
  sha256Canonical,
  type AgentFailure,
  type AgentFailureExpectedBindings,
  type AgentQueryResult,
  type AgentQueryExpectedBindings,
  type AgentScanResult,
  type AgentScanExpectedBindings,
  type AgentWikiSemantics,
  type AgentWikiExpectedBindings,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const HASH_E = `sha256:${"e".repeat(64)}`;

const agent = {
  id: "agent_codex_native",
  runtime: "codex",
  mode: "native-cli",
  driverContractVersion: "v1",
} as const;

function scanBindings(value = validScanResult()): AgentScanExpectedBindings {
  return {
    schema: value.schema,
    agent: value.agent,
    inputSetHash: value.inputSetHash,
    skillHash: value.skillHash,
    scanPlanHash: value.scanPlanHash,
    skeletonVersion: value.skeletonVersion,
    operationId: value.operationId,
    scanId: value.scanId,
    node: value.node,
    coverage: value.coverage,
    budget: value.budget,
    sensitivity: value.sensitivity,
    allowedNextConnectorActions: value.nextConnectorActions,
  };
}

function queryBindings(value = validQueryResult()): AgentQueryExpectedBindings {
  return {
    schema: value.schema,
    agent: value.agent,
    inputSetHash: value.inputSetHash,
    skillHash: value.skillHash,
    activeGeneration: value.activeGeneration,
    queryId: value.queryId,
    allowedCitations: value.citations,
  };
}

function wikiBindings(value = validWikiSemantics()): AgentWikiExpectedBindings {
  return {
    schema: value.schema,
    agent: value.agent,
    inputSetHash: value.inputSetHash,
    skillHash: value.skillHash,
    baseWikiHash: value.baseWikiHash,
    evidenceManifestHash: value.evidenceManifestHash,
    proposalId: value.proposalId,
    allowedEvidence: value.concepts.flatMap(({ sources }) => sources),
    baseWikiPages: [{
      page_uid: "page_02",
      path: "Governance/authorization.md",
    }],
  };
}

function failureBindings(value = validFailure()): AgentFailureExpectedBindings {
  return {
    schema: value.schema,
    agent: value.agent,
    inputSetHash: value.inputSetHash,
    skillHash: value.skillHash,
    operationId: value.operationId,
  };
}

function validScanResult(): AgentScanResult {
  return {
    schema: "openlifewiki.agent-scan-result/v1",
    operationId: "op_01",
    scanId: "scan_01",
    scanPlanHash: HASH_A,
    skeletonVersion: HASH_B,
    skillHash: HASH_C,
    inputSetHash: HASH_D,
    agent,
    node: {
      sourceId: "src_01",
      nodeId: "node_01",
      nodeVersion: "provider-version",
      summaryHash: HASH_E,
    },
    decision: "descend",
    reason: "The approved node metadata matches the current scan objective and budget.",
    coverage: {
      directChildrenEnumerated: 12,
      pageComplete: true,
      openCursor: false,
      unknownChildCount: false,
    },
    budget: {
      remainingNodes: 9_000,
      remainingBodyBytes: 2_000_000_000,
      remainingAgentCalls: 450,
      estimatedNextNodes: 12,
      estimatedNextBodyBytes: 0,
      estimatedNextAgentCalls: 1,
    },
    sensitivity: {
      effective: "normal",
      ownerApprovalRequired: false,
    },
    nextConnectorActions: [{
      action: "listChildrenMetadata",
      parent: "node_01",
      limit: 100,
      cursor: null,
    }],
    revisitCondition: null,
    question: null,
    status: "decision-ready",
  };
}

function validQueryResult(): AgentQueryResult {
  return {
    schema: "openlifewiki.agent-query-result/v1",
    queryId: "query_01",
    inputSetHash: HASH_A,
    skillHash: HASH_C,
    activeGeneration: {
      generationId: "qmdgen_01",
      manifestHash: HASH_B,
    },
    agent,
    evidenceMode: "grounded",
    answer: "The approved design uses a metadata-only skeleton before selected body reads.",
    claims: [{
      claimId: "claim_01",
      type: "fact",
      text: "Initial discovery enumerates metadata before selected body reads.",
      citationIds: ["citation_01"],
    }],
    citations: [{
      citationId: "citation_01",
      locator: "openlifewiki://source/src_01/node_01",
      sourceId: "src_01",
      nodeId: "node_01",
      nodeVersion: "provider-version",
    }],
    gaps: [],
    rawExposure: {
      status: "not-requested",
      citationIds: [],
    },
    status: "answer-ready",
  };
}

function validWikiSemantics(): AgentWikiSemantics {
  return {
    schema: "openlifewiki.agent-wiki-semantics/v1",
    proposalId: "proposal_01",
    baseWikiHash: HASH_A,
    evidenceManifestHash: HASH_B,
    inputSetHash: HASH_C,
    skillHash: HASH_D,
    agent,
    folders: [{
      path: ".",
      title: "Wiki",
      description: "Root navigation for the proposed Wiki.",
    }, {
      path: "Knowledge Management",
      title: "Knowledge Management",
      description: "Concepts about governed knowledge operations.",
    }],
    tags: [{
      name: "domain/knowledge-management",
      description: "Knowledge-management concepts.",
    }],
    aliases: [{ alias: "Progressive Scan", page_uid: "page_01" }],
    concepts: [{
      page_uid: "page_01",
      type: "Concept",
      title: "Progressive scanning",
      description: "Permission-bound discovery of Source hierarchy.",
      path: "Knowledge Management/progressive-scanning.md",
      body: "# Progressive scanning\n\nDiscover authorized metadata before selecting evidence.",
      sources: [{
        id: "source_node_01",
        resource: "openlifewiki://source/src_01/node_01",
        title: "Authorized design note",
        sourceId: "src_01",
        nodeId: "node_01",
        nodeVersion: "provider-version",
      }],
      tags: ["domain/knowledge-management"],
      aliases: ["Progressive Scan"],
      links: [{
        text: "Authorization",
        target: {
          kind: "base-wiki",
          page_uid: "page_02",
          path: "Governance/authorization.md",
          baseWikiHash: HASH_A,
        },
      }],
      status: "draft",
      stale_after: "2026-10-26",
    }],
    indexes: [{
      folderPath: ".",
      path: "index.md",
      title: "Wiki",
      description: "Root navigation for the proposed Wiki.",
      conceptPageUids: [],
      childFolderPaths: ["Knowledge Management"],
    }, {
      folderPath: "Knowledge Management",
      path: "Knowledge Management/index.md",
      title: "Knowledge Management",
      description: "Concepts about governed knowledge operations.",
      conceptPageUids: ["page_01"],
      childFolderPaths: [],
    }],
    freshness: [{
      page_uid: "page_01",
      status: "current",
      stale_after: "2026-10-26",
      reason: "All declared provenance is current for the proposal evidence manifest.",
      sourceIds: ["src_01"],
    }],
    moves: [{
      page_uid: "page_01",
      from: "Inbox/progressive-scanning.md",
      to: "Knowledge Management/progressive-scanning.md",
      reason: "The concept belongs in its approved primary folder.",
    }],
    knownGaps: [{
      code: "EVIDENCE_COVERAGE_PARTIAL",
      description: "One deferred Source branch remains outside current evidence.",
      sourceIds: ["src_02"],
    }],
    status: "proposal-ready",
  };
}

function validFailure(): AgentFailure {
  return {
    schema: "openlifewiki.agent-failure/v1",
    operationId: "op_01",
    inputSetHash: HASH_A,
    skillHash: HASH_C,
    agent,
    code: "AGENT_OUTPUT_INVALID",
    phase: "validate-output",
    messageKey: "agent.output-invalid",
    remediation: {
      action: "review-output-contract",
      target: "operation",
    },
    retryable: false,
    ambiguousRemoteState: false,
    status: "failed",
  };
}

describe("canonical Agent I/O runtime contracts", () => {
  it("exports inferred TypeScript types for all four envelopes", () => {
    expectTypeOf<AgentScanResult>().toBeObject();
    expectTypeOf<AgentQueryResult>().toBeObject();
    expectTypeOf<AgentWikiSemantics>().toBeObject();
    expectTypeOf<AgentFailure>().toBeObject();
  });

  it("exposes fresh schema builders without initialized canonical schema instances", () => {
    const api = protocolApi as Record<string, unknown>;
    for (const legacySchemaExport of [
      "agentIoAgentSchema",
      "agentScanResultSchema",
      "agentQueryResultSchema",
      "agentWikiSemanticsSchema",
      "agentFailureSchema",
      "agentIoSchemas",
    ]) {
      expect(api[legacySchemaExport]).toBeUndefined();
    }

    expect(typeof api.AGENT_IO_SCHEMA_BUILDERS).toBe("object");
    const builders = api.AGENT_IO_SCHEMA_BUILDERS as Record<string, () => unknown>;
    const hashedBuilders = AGENT_IO_EXECUTABLE_VALIDATORS as Record<string, CallableFunction>;
    const builderNamesBySchemaId = {
      "openlifewiki.agent-scan-result/v1": "buildAgentScanResultSchema",
      "openlifewiki.agent-query-result/v1": "buildAgentQueryResultSchema",
      "openlifewiki.agent-wiki-semantics/v1": "buildAgentWikiSemanticsSchema",
      "openlifewiki.agent-failure/v1": "buildAgentFailureSchema",
    } as const;
    expect(Object.isFrozen(builders)).toBe(true);
    for (const schemaId of AGENT_IO_SCHEMA_IDS) {
      const builder = builders[schemaId];
      expect(typeof builder).toBe("function");
      if (builder === undefined) throw new Error(`Missing schema builder: ${schemaId}`);
      expect(builder).toBe(hashedBuilders[builderNamesBySchemaId[schemaId]]);
      expect(builder()).not.toBe(builder());
    }
  });

  it("parses each valid envelope only through its named strict schema", () => {
    expect(parseAgentScanResult(validScanResult(), scanBindings())).toEqual(validScanResult());
    expect(parseAgentQueryResult(validQueryResult(), queryBindings())).toEqual(validQueryResult());
    expect(parseAgentWikiSemantics(validWikiSemantics(), wikiBindings()))
      .toEqual(validWikiSemantics());
    expect(parseAgentFailure(validFailure(), failureBindings())).toEqual(validFailure());

    expect(() => parseAgentQueryResult(validScanResult(), queryBindings())).toThrow();
    expect(() => parseAgentWikiSemantics(validQueryResult(), wikiBindings())).toThrow();
    expect(() => parseAgentFailure(validWikiSemantics(), failureBindings())).toThrow();
    expect(() => parseAgentScanResult(validFailure(), scanBindings())).toThrow();
  });

  it("requires complete schema-specific bindings and exact selected Agent identity", () => {
    const parseWithoutBindings = parseAgentScanResult as unknown as (input: unknown) => unknown;
    expect(() => parseWithoutBindings(validScanResult())).toThrow();
    expect(() => parseAgentScanResult(validScanResult(), {
      ...scanBindings(),
      agent: { ...agent, driverContractVersion: "v2" },
    })).toThrow(/driverContractVersion/);
    expect(() => parseAgentQueryResult(validQueryResult(), {
      ...queryBindings(),
      agent: { ...agent, id: "different-agent" },
    })).toThrow(/agent\.id/);
    expect(() => parseAgentFailure(validFailure(), {
      ...failureBindings(),
      skillHash: HASH_D,
    })).toThrow(/skillHash/);
  });

  it("dispatches only when the envelope and discriminated binding schemas match", () => {
    expect(parseAgentIoEnvelope(validScanResult(), scanBindings())).toEqual(validScanResult());
    expect(() => parseAgentIoEnvelope(validScanResult(), queryBindings())).toThrow(/schema/);
    expect(() => parseAgentIoEnvelope(
      { ...validScanResult(), schema: "agent-scan-result/v1" },
      scanBindings(),
    )).toThrow();
    expect(() => parseAgentIoEnvelope(
      { ...validScanResult(), schema: "openlifewiki.unknown/v1" },
      scanBindings(),
    )).toThrow();
  });

  it("rejects missing, unknown and credential-like fields at every strict boundary", () => {
    const { reason: _reason, ...missingReason } = validScanResult();
    expect(() => parseAgentScanResult(missingReason, scanBindings())).toThrow();
    expect(() => parseAgentScanResult(
      { ...validScanResult(), prompt: "hidden" },
      scanBindings(),
    )).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      agent: { ...agent, token: "credential-value" },
    }, scanBindings())).toThrow();
    expect(() => parseAgentFailure(
      { ...validFailure(), apiKey: "credential-value" },
      failureBindings(),
    )).toThrow();
    expect(() => parseAgentFailure({
      ...validFailure(),
      message: "Bearer credential-value",
    }, failureBindings())).toThrow();
    expect(() => parseAgentFailure({
      ...validFailure(),
      providerOutput: "Authorization: Bearer credential-value",
    }, failureBindings())).toThrow();
    expect(() => parseAgentFailure({
      ...validFailure(),
      remediation: {
        action: "visit-url",
        target: "https://user:password@example.test/repair",
      },
    }, failureBindings())).toThrow();
  });

  it("rejects every stale schema-specific hash and generation binding", () => {
    expect(() => parseAgentScanResult(validScanResult(), {
      ...scanBindings(),
      inputSetHash: HASH_E,
    })).toThrow(/inputSetHash/);
    expect(() => parseAgentScanResult(validScanResult(), {
      ...scanBindings(),
      scanPlanHash: HASH_E,
    })).toThrow(/scanPlanHash/);
    expect(() => parseAgentQueryResult(validQueryResult(), {
      ...queryBindings(),
      activeGeneration: { ...validQueryResult().activeGeneration, manifestHash: HASH_E },
    })).toThrow(/activeGeneration\.manifestHash/);
    expect(() => parseAgentQueryResult(validQueryResult(), {
      ...queryBindings(),
      activeGeneration: { ...validQueryResult().activeGeneration, generationId: "qmdgen_old" },
    })).toThrow(/activeGeneration\.generationId/);
    expect(() => parseAgentWikiSemantics(validWikiSemantics(), {
      ...wikiBindings(),
      baseWikiHash: HASH_E,
    })).toThrow(/baseWikiHash/);
    expect(() => parseAgentWikiSemantics(validWikiSemantics(), {
      ...wikiBindings(),
      evidenceManifestHash: HASH_E,
    })).toThrow(/evidenceManifestHash/);
  });

  it("verifies every scan decision field against the trusted scan context", () => {
    const scan = validScanResult();
    const expected = scanBindings(scan);
    const mutations = [
      { ...scan, operationId: "op_replayed" },
      { ...scan, scanId: "scan_replayed" },
      { ...scan, node: { ...scan.node, nodeVersion: "invented-version" } },
      {
        ...scan,
        coverage: {
          ...scan.coverage,
          directChildrenEnumerated: scan.coverage.directChildrenEnumerated + 1,
        },
      },
      { ...scan, budget: { ...scan.budget, remainingNodes: scan.budget.remainingNodes + 1 } },
      { ...scan, sensitivity: { effective: "sensitive", ownerApprovalRequired: false } },
      {
        ...scan,
        nextConnectorActions: [{
          action: "listChildrenMetadata",
          parent: scan.node.nodeId,
          limit: 99,
          cursor: null,
        }],
      },
    ];
    for (const mutation of mutations) {
      expect(() => parseAgentScanResult(mutation, expected)).toThrow(/binding mismatch/);
    }

    const selectedLeaf = {
      ...scan,
      nextConnectorActions: [
        { action: "getVersion", node: scan.node.nodeId },
        {
          action: "readApprovedLeafBody",
          node: scan.node.nodeId,
          expectedVersion: scan.node.nodeVersion,
          descendReceipt: HASH_D,
          leafSelectionReceipt: HASH_E,
        },
      ],
    };
    const selectedLeafBindings = scanBindings(selectedLeaf as AgentScanResult);
    for (const receiptField of ["descendReceipt", "leafSelectionReceipt"] as const) {
      expect(() => parseAgentScanResult({
        ...selectedLeaf,
        nextConnectorActions: [selectedLeaf.nextConnectorActions[0], {
          ...selectedLeaf.nextConnectorActions[1],
          [receiptField]: HASH_A,
        }],
      }, selectedLeafBindings)).toThrow(/allowedNextConnectorActions/);
    }
  });

  it("rejects replayed envelope identities", () => {
    expect(() => parseAgentQueryResult(
      { ...validQueryResult(), queryId: "query_replayed" },
      queryBindings(),
    )).toThrow(/queryId/);
    expect(() => parseAgentWikiSemantics(
      { ...validWikiSemantics(), proposalId: "proposal_replayed" },
      wikiBindings(),
    )).toThrow(/proposalId/);
    expect(() => parseAgentFailure(
      { ...validFailure(), operationId: "op_replayed" },
      failureBindings(),
    )).toThrow(/operationId/);
  });

  it("accepts only citations from the bound current retrieval context", () => {
    const query = validQueryResult();
    const expected = queryBindings(query);
    const citation = query.citations[0];
    for (const mutation of [
      { ...citation, locator: "openlifewiki://source/src_01/different-node" },
      { ...citation, sourceId: "src_02" },
      { ...citation, nodeId: "node_02" },
      { ...citation, nodeVersion: "invented-version" },
    ]) {
      expect(() => parseAgentQueryResult({ ...query, citations: [mutation] }, expected))
        .toThrow(/allowedCitations/);
    }
  });

  it("accepts only Wiki provenance and base links from frozen trusted manifests", () => {
    const wiki = validWikiSemantics();
    const expected = wikiBindings(wiki);
    const concept = wiki.concepts[0]!;
    const source = concept.sources[0]!;
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{
        ...concept,
        sources: [{ ...source, nodeVersion: "invented-version" }],
      }],
    }, expected)).toThrow(/allowedEvidence/);
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{
        ...concept,
        links: [{
          text: "Authorization",
          target: {
            kind: "base-wiki",
            page_uid: "page_02",
            path: "Governance/invented.md",
            baseWikiHash: wiki.baseWikiHash,
          },
        }],
      }],
    }, expected)).toThrow(/baseWikiPages/);
  });

  it("allows descend only for the exact child-list or selected leaf read sequence", () => {
    for (const action of [
      { action: "probe" },
      { action: "listRootsMetadata", limit: 100, cursor: null },
    ]) {
      expect(() => parseAgentScanResult({
        ...validScanResult(),
        nextConnectorActions: [action],
      }, scanBindings())).toThrow();
    }

    expect(() => parseAgentScanResult({
      ...validScanResult(),
      nextConnectorActions: [{
        action: "readApprovedLeafBody",
        node: "node_01",
        expectedVersion: "provider-version",
        descendReceipt: HASH_D,
        leafSelectionReceipt: HASH_E,
      }],
    }, scanBindings())).toThrow();

    const selectedLeaf = {
      ...validScanResult(),
      nextConnectorActions: [
        { action: "getVersion", node: "node_01" },
        {
          action: "readApprovedLeafBody",
          node: "node_01",
          expectedVersion: "provider-version",
          descendReceipt: HASH_D,
          leafSelectionReceipt: HASH_E,
        },
      ],
    };
    expect(() => parseAgentScanResult(
      selectedLeaf,
      scanBindings(selectedLeaf as AgentScanResult),
    )).not.toThrow();
    expect(() => parseAgentScanResult({
      ...selectedLeaf,
      nextConnectorActions: selectedLeaf.nextConnectorActions.map((action) => (
        action.action === "readApprovedLeafBody"
          ? { ...action, leafSelectionReceipt: undefined }
          : action
      )),
    }, scanBindings())).toThrow();
  });

  it("fails closed on sensitivity, cost and incomplete coverage", () => {
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      sensitivity: { effective: "sensitive", ownerApprovalRequired: true },
    }, scanBindings())).toThrow();

    for (const budget of [
      { ...validScanResult().budget, estimatedNextNodes: null },
      { ...validScanResult().budget, estimatedNextNodes: 9_001 },
      { ...validScanResult().budget, estimatedNextBodyBytes: 2_000_000_001 },
      { ...validScanResult().budget, estimatedNextAgentCalls: 451 },
    ]) {
      expect(() => parseAgentScanResult({ ...validScanResult(), budget }, scanBindings()))
        .toThrow();
    }

    for (const coverage of [
      { ...validScanResult().coverage, pageComplete: false },
      { ...validScanResult().coverage, openCursor: true },
      { ...validScanResult().coverage, unknownChildCount: true },
    ]) {
      expect(() => parseAgentScanResult({ ...validScanResult(), coverage }, scanBindings()))
        .toThrow();
      expect(() => parseAgentScanResult({
        ...validScanResult(),
        decision: "skip",
        coverage,
        nextConnectorActions: [],
      }, scanBindings())).toThrow();
    }
  });

  it("keeps defer and ask-user explicit without Connector access", () => {
    const deferred = {
      ...validScanResult(),
      decision: "defer",
      nextConnectorActions: [],
      revisitCondition: "Resume after the approved budget window resets.",
    } as const;
    expect(() => parseAgentScanResult(
      deferred,
      scanBindings(deferred as unknown as AgentScanResult),
    )).not.toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      decision: "defer",
      nextConnectorActions: [{ action: "getVersion", node: "node_01" }],
      revisitCondition: "Resume after the approved budget window resets.",
    }, scanBindings())).toThrow();
    const askUser = {
      ...validScanResult(),
      decision: "ask-user",
      nextConnectorActions: [],
      question: "Approve the named sensitive node or keep it deferred?",
    } as const;
    expect(() => parseAgentScanResult(
      askUser,
      scanBindings(askUser as unknown as AgentScanResult),
    )).not.toThrow();
  });

  it("requires every factual claim to resolve at least one current citation", () => {
    const query = validQueryResult();
    expect(() => parseAgentQueryResult({
      ...query,
      claims: [{ ...query.claims[0], citationIds: [] }],
    }, queryBindings())).toThrow();
    expect(() => parseAgentQueryResult({
      ...query,
      claims: [{ ...query.claims[0], citationIds: ["missing"] }],
    }, queryBindings())).toThrow();
    expect(() => parseAgentQueryResult({
      ...query,
      claims: [{ ...query.claims[0], citationIds: [], material: false }],
    }, queryBindings())).toThrow();
  });

  it("enforces meaningful evidence structures for every query mode", () => {
    const query = validQueryResult();
    const coverageGap = {
      code: "EVIDENCE_COVERAGE_PARTIAL",
      kind: "coverage",
      description: "One authorized branch remains deferred.",
      sourceIds: ["src_02"],
    } as const;
    const conflictGap = {
      code: "EVIDENCE_CONFLICT",
      kind: "conflict",
      description: "Current sources disagree about the selected policy.",
      sourceIds: ["src_01", "src_02"],
    } as const;
    const secondCitation = {
      citationId: "citation_02",
      locator: "openlifewiki://source/src_02/node_02",
      sourceId: "src_02",
      nodeId: "node_02",
      nodeVersion: "provider-version-2",
    };

    expect(() => parseAgentQueryResult({
      ...query,
      evidenceMode: "partial-evidence",
      gaps: [coverageGap],
    }, queryBindings())).not.toThrow();
    expect(() => parseAgentQueryResult({
      ...query,
      evidenceMode: "partial-evidence",
      gaps: [],
    }, queryBindings())).toThrow();

    const conflicting = {
      ...query,
      evidenceMode: "conflicting-evidence",
      claims: [{ ...query.claims[0], citationIds: ["citation_01", "citation_02"] }],
      citations: [...query.citations, secondCitation],
      gaps: [conflictGap],
    } as const;
    expect(() => parseAgentQueryResult(
      conflicting,
      queryBindings(conflicting as unknown as AgentQueryResult),
    )).not.toThrow();
    expect(() => parseAgentQueryResult({
      ...query,
      evidenceMode: "conflicting-evidence",
      gaps: [conflictGap],
    }, queryBindings())).toThrow();

    const noEvidence = {
      ...query,
      evidenceMode: "no-evidence",
      answer: "No current authorized evidence resolves this question.",
      claims: [{
        claimId: "gap_01",
        type: "gap",
        text: "The relevant branch is not in the current generation.",
        citationIds: [],
      }],
      citations: [],
      gaps: [coverageGap],
    };
    expect(() => parseAgentQueryResult(
      noEvidence,
      queryBindings(noEvidence as unknown as AgentQueryResult),
    )).not.toThrow();
    expect(() => parseAgentQueryResult({
      ...noEvidence,
      claims: query.claims,
    }, queryBindings())).toThrow();
    expect(() => parseAgentQueryResult({
      ...noEvidence,
      gaps: [],
    }, queryBindings())).toThrow();

    expect(() => parseAgentQueryResult({
      ...query,
      answer: "",
      claims: [],
      citations: [],
    }, queryBindings())).toThrow();
  });

  it("keeps Wiki semantics free of compiler, provider and approval authority", () => {
    expect(() => parseAgentWikiSemantics({
      ...validWikiSemantics(),
      compiler: { provider: "hidden" },
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...validWikiSemantics(),
      approval: { approvedBy: "agent" },
    }, wikiBindings())).toThrow();
  });

  it("requires relationally complete Wiki indexes, freshness and provenance", () => {
    const wiki = validWikiSemantics();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{ ...wiki.concepts[0], sources: [] }],
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{ ...wiki.concepts[0], tags: ["domain/undeclared"] }],
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      indexes: [{ ...wiki.indexes[0], conceptPageUids: [] }],
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      freshness: [{ ...wiki.freshness[0], sourceIds: ["src_missing"] }],
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{
        ...wiki.concepts[0],
        links: [{
          text: "Missing proposal target",
          target: {
            kind: "proposed",
            page_uid: "page_missing",
            path: "Missing/concept.md",
          },
        }],
      }],
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      concepts: [{
        ...wiki.concepts[0],
        links: [{
          text: "Stale base target",
          target: {
            kind: "base-wiki",
            page_uid: "page_02",
            path: "Governance/authorization.md",
            baseWikiHash: HASH_E,
          },
        }],
      }],
    }, wikiBindings())).toThrow();
  });

  it("requires the root folder and exact root index semantics", () => {
    const wiki = validWikiSemantics();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      folders: wiki.folders.filter(({ path }) => path !== "."),
      indexes: wiki.indexes.filter(({ folderPath }) => folderPath !== "."),
    }, wikiBindings())).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...wiki,
      indexes: wiki.indexes.map((index) => index.folderPath === "."
        ? { ...index, childFolderPaths: [] }
        : index),
    }, wikiBindings())).toThrow();
  });

  it("accepts one all-AGENT failure taxonomy and rejects every old alias", () => {
    const requiredCodes = [
      "AGENT_MISSING",
      "AGENT_UNSUPPORTED_VERSION",
      "AGENT_CONTRACT_UNSUPPORTED",
      "AGENT_AUTH_REQUIRED",
      "AGENT_HOST_CONFIG_INVALID",
      "AGENT_SPAWN_FAILED",
      "AGENT_TIMEOUT",
      "AGENT_CANCELLED",
      "AGENT_PROVIDER_FAILED",
      "AGENT_TOOL_ERROR",
      "AGENT_OUTPUT_INVALID",
      "AGENT_EXIT_NONZERO",
      "AGENT_AMBIGUOUS_REMOTE_STATE",
      "AGENT_REFUSAL",
    ] as const;

    for (const code of requiredCodes) {
      const presentation = AGENT_FAILURE_PRESENTATION[code];
      expect(() => parseAgentFailure({
        ...validFailure(),
        code,
        messageKey: presentation.messageKey,
        remediation: presentation.remediation,
        ambiguousRemoteState: code === "AGENT_AMBIGUOUS_REMOTE_STATE",
      }, failureBindings())).not.toThrow();
    }
    for (const code of ["OUTPUT_INVALID", "NOT_INSTALLED", "PROVIDER_ERROR", "UNKNOWN"]) {
      expect(() => parseAgentFailure({ ...validFailure(), code }, failureBindings())).toThrow();
    }
    expect(() => parseAgentFailure({
      ...validFailure(),
      messageKey: "agent.provider-failed",
    }, failureBindings())).toThrow();
    expect(() => parseAgentFailure({
      ...validFailure(),
      remediation: AGENT_FAILURE_PRESENTATION.AGENT_TIMEOUT.remediation,
    }, failureBindings())).toThrow();
  });
});

describe("generated Agent I/O JSON Schema artifacts", () => {
  const schemaDirectory = new URL("../schemas/", import.meta.url);

  it("publishes exactly four full schema IDs", () => {
    expect(AGENT_IO_SCHEMA_IDS).toEqual([
      "openlifewiki.agent-scan-result/v1",
      "openlifewiki.agent-query-result/v1",
      "openlifewiki.agent-wiki-semantics/v1",
      "openlifewiki.agent-failure/v1",
    ]);
    expect(AGENT_IO_SCHEMA_MANIFEST.schemas.map(({ schemaId }) => schemaId))
      .toEqual([...AGENT_IO_SCHEMA_IDS].sort());
  });

  it("binds sorted runtime semantic rules into the release manifest hash", () => {
    const executableSources = Object.entries(AGENT_IO_EXECUTABLE_VALIDATORS)
      .map(([name, validator]) => ({
        name,
        source: canonicalizeAgentIoExecutableSource(validator),
      }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    expect(AGENT_IO_SEMANTIC_RULES).toEqual([...AGENT_IO_SEMANTIC_RULES].sort());
    expect(AGENT_IO_SEMANTIC_RULES_HASH).toBe(sha256Canonical({
      version: AGENT_IO_SEMANTIC_RULES_VERSION,
      rules: AGENT_IO_SEMANTIC_RULES,
      executables: executableSources,
      data: {
        failurePresentation: AGENT_FAILURE_PRESENTATION,
        expectedBindingSchemaHashes: AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
      },
    }));
    expect(AGENT_IO_SCHEMA_MANIFEST.semanticRules).toEqual({
      version: AGENT_IO_SEMANTIC_RULES_VERSION,
      rules: AGENT_IO_SEMANTIC_RULES,
      executables: executableSources,
      data: {
        failurePresentation: AGENT_FAILURE_PRESENTATION,
        expectedBindingSchemaHashes: AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
      },
      sha256: AGENT_IO_SEMANTIC_RULES_HASH,
    });
    expect(AGENT_IO_SCHEMA_MANIFEST.manifestHash).toBe(sha256Canonical({
      schema: AGENT_IO_SCHEMA_MANIFEST.schema,
      generator: AGENT_IO_SCHEMA_MANIFEST.generator,
      semanticRules: AGENT_IO_SCHEMA_MANIFEST.semanticRules,
      schemas: AGENT_IO_SCHEMA_MANIFEST.schemas,
    }));
  });

  it("binds schema wiring and parser entrypoints into executable integrity", () => {
    const requiredExecutableNames = [
      "buildAgentFailureSchema",
      "buildAgentIoAgentSchema",
      "buildAgentQueryResultSchema",
      "buildAgentScanResultSchema",
      "buildAgentWikiSemanticsSchema",
      "getAgentIoJsonSchema",
      "parseAgentFailure",
      "parseAgentIoEnvelope",
      "parseAgentQueryResult",
      "parseAgentScanResult",
      "parseAgentWikiSemantics",
    ];
    const executableSources = Object.entries(AGENT_IO_EXECUTABLE_VALIDATORS)
      .map(([name, validator]) => ({
        name,
        source: canonicalizeAgentIoExecutableSource(validator),
      }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const executableNames = new Set(executableSources.map(({ name }) => name));
    for (const name of requiredExecutableNames) expect(executableNames.has(name)).toBe(true);
    const executableSourceByName = new Map(
      executableSources.map(({ name, source }) => [name, source]),
    );
    const schemaWiring = [
      ["buildAgentFailureSchema", "validateAgentFailureSemantics"],
      ["buildAgentIoAgentSchema", "validateAgentIoAgentSemantics"],
      ["buildAgentQueryResultSchema", "validateAgentQuerySemantics"],
      ["buildAgentScanResultSchema", "validateAgentScanSemantics"],
      ["buildAgentWikiSemanticsSchema", "validateAgentWikiSemantics"],
    ] as const;
    for (const [builder, validator] of schemaWiring) {
      expect(executableSourceByName.get(builder)).toContain(`.superRefine(${validator})`);
    }
    const parserBindings = [
      ["parseAgentFailure", "buildAgentFailureSchema", "assertAgentFailureBindings"],
      ["parseAgentQueryResult", "buildAgentQueryResultSchema", "assertAgentQueryBindings"],
      ["parseAgentScanResult", "buildAgentScanResultSchema", "assertAgentScanBindings"],
      ["parseAgentWikiSemantics", "buildAgentWikiSemanticsSchema", "assertAgentWikiBindings"],
    ] as const;
    for (const [parser, builder, assertion] of parserBindings) {
      expect(executableSourceByName.get(parser)).toContain(`${builder}().parse(input)`);
      expect(executableSourceByName.get(parser)).toContain(`${assertion}(value,checkedExpected)`);
    }
    expect(executableSourceByName.get("parseAgentIoEnvelope"))
      .toContain("returnparseAgentScanResult(input,checkedExpected)");
    expect(executableSourceByName.get("getAgentIoJsonSchema"))
      .toContain("AGENT_IO_SCHEMA_BUILDERS[schemaId]()");

    const digest = (executables: typeof executableSources): string => sha256Canonical({
      version: AGENT_IO_SEMANTIC_RULES_VERSION,
      rules: AGENT_IO_SEMANTIC_RULES,
      executables,
      data: {
        failurePresentation: AGENT_FAILURE_PRESENTATION,
        expectedBindingSchemaHashes: AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
      },
    });
    const withoutScanWiring = executableSources.filter(
      ({ name }) => name !== "buildAgentScanResultSchema",
    );
    expect(digest(withoutScanWiring)).not.toBe(AGENT_IO_SEMANTIC_RULES_HASH);

    function bypassedParseAgentScanResult(input: unknown): unknown {
      return input;
    }
    const bypassedScanEntrypoint = executableSources.map((entry) => entry.name === "parseAgentScanResult"
      ? { ...entry, source: canonicalizeAgentIoExecutableSource(bypassedParseAgentScanResult) }
      : entry);
    expect(digest(bypassedScanEntrypoint)).not.toBe(AGENT_IO_SEMANTIC_RULES_HASH);
  });

  it("checks in exactly the four named JSON Schema artifacts", async () => {
    const schemaFiles = (await readdir(schemaDirectory))
      .filter((file) => file.endsWith(".schema.json"))
      .sort();
    const schemaIds = await Promise.all(schemaFiles.map(async (file) => {
      const artifact = JSON.parse(await readFile(new URL(file, schemaDirectory), "utf8"));
      return artifact.$id;
    }));

    expect(schemaFiles).toHaveLength(4);
    expect(schemaIds.sort()).toEqual([...AGENT_IO_SCHEMA_IDS].sort());
  });

  it("derives checked-in artifacts and manifest hashes from the runtime schemas", async () => {
    for (const entry of AGENT_IO_SCHEMA_MANIFEST.schemas) {
      const checkedInBytes = await readFile(new URL(entry.file, schemaDirectory), "utf8");
      const runtimeSchema = getAgentIoJsonSchema(entry.schemaId);
      expect(checkedInBytes).toBe(canonicalJson(runtimeSchema));
      expect(JSON.parse(checkedInBytes)).toEqual(runtimeSchema);
      expect(`sha256:${createHash("sha256").update(checkedInBytes).digest("hex")}`)
        .toBe(entry.sha256);
      expect(entry.sha256).toBe(getAgentIoSchemaHash(entry.schemaId));
    }

    const checkedInManifest = JSON.parse(
      await readFile(new URL("manifest.json", schemaDirectory), "utf8"),
    );
    expect(checkedInManifest).toEqual(AGENT_IO_SCHEMA_MANIFEST);
  });

  it("keeps schemas strict and free of secret, token and BaseURL defaults", () => {
    const serialized = JSON.stringify(
      AGENT_IO_SCHEMA_IDS.map((schemaId) => getAgentIoJsonSchema(schemaId)),
    );
    expect(serialized).not.toMatch(/"default"/i);
    expect(serialized).not.toMatch(/secret|token|baseurl|api[_-]?key/i);
    expect(serialized).toContain('"additionalProperties":false');
  });
});
