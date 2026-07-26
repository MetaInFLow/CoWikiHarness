import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_IO_SCHEMA_IDS,
  AGENT_IO_SCHEMA_MANIFEST,
  canonicalJson,
  getAgentIoJsonSchema,
  getAgentIoSchemaHash,
  parseAgentFailure,
  parseAgentIoEnvelope,
  parseAgentQueryResult,
  parseAgentScanResult,
  parseAgentWikiSemantics,
  type AgentFailure,
  type AgentQueryResult,
  type AgentScanResult,
  type AgentWikiSemantics,
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
      material: true,
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
    agent,
    folders: [{
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
        target_page_uid: "page_02",
        path: "../Governance/authorization.md",
        text: "Authorization",
      }],
      status: "draft",
      stale_after: "2026-10-26",
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
    agent,
    code: "OUTPUT_INVALID",
    phase: "validate-output",
    message: "The Agent result did not match the required output contract.",
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

  it("parses each valid envelope only through its named strict schema", () => {
    expect(parseAgentScanResult(validScanResult())).toEqual(validScanResult());
    expect(parseAgentQueryResult(validQueryResult())).toEqual(validQueryResult());
    expect(parseAgentWikiSemantics(validWikiSemantics())).toEqual(validWikiSemantics());
    expect(parseAgentFailure(validFailure())).toEqual(validFailure());

    expect(() => parseAgentQueryResult(validScanResult())).toThrow();
    expect(() => parseAgentWikiSemantics(validQueryResult())).toThrow();
    expect(() => parseAgentFailure(validWikiSemantics())).toThrow();
    expect(() => parseAgentScanResult(validFailure())).toThrow();
  });

  it("dispatches a recognized envelope and rejects unknown or mismatched schema IDs", () => {
    expect(parseAgentIoEnvelope(validScanResult())).toEqual(validScanResult());
    expect(() => parseAgentIoEnvelope({ ...validScanResult(), schema: "agent-scan-result/v1" }))
      .toThrow();
    expect(() => parseAgentIoEnvelope({ ...validScanResult(), schema: "openlifewiki.unknown/v1" }))
      .toThrow();
  });

  it("rejects missing, unknown and credential-like fields at every strict boundary", () => {
    const { reason: _reason, ...missingReason } = validScanResult();
    expect(() => parseAgentScanResult(missingReason)).toThrow();
    expect(() => parseAgentScanResult({ ...validScanResult(), prompt: "hidden" })).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      agent: { ...agent, token: "credential-value" },
    })).toThrow();
    expect(() => parseAgentFailure({ ...validFailure(), apiKey: "credential-value" })).toThrow();
    expect(() => parseAgentFailure({
      ...validFailure(),
      message: "token=credential-value",
    })).toThrow();
  });

  it("rejects stale expected hash bindings", () => {
    expect(() => parseAgentScanResult(validScanResult(), { inputSetHash: HASH_E })).toThrow();
    expect(() => parseAgentQueryResult(validQueryResult(), { activeGenerationId: "qmdgen_old" }))
      .toThrow();
    expect(() => parseAgentWikiSemantics(validWikiSemantics(), { baseWikiHash: HASH_D }))
      .toThrow();
    expect(() => parseAgentFailure(validFailure(), { inputSetHash: HASH_D })).toThrow();
  });

  it("allows only legal Connector action combinations for each scan decision", () => {
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      decision: "skip",
      nextConnectorActions: validScanResult().nextConnectorActions,
    })).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      nextConnectorActions: [{
        action: "readApprovedLeafBody",
        node: "node_01",
        expectedVersion: "provider-version",
        descendReceipt: HASH_E,
      }],
    })).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      nextConnectorActions: [
        { action: "getVersion", node: "node_01" },
        {
          action: "readApprovedLeafBody",
          node: "node_01",
          expectedVersion: "provider-version",
          descendReceipt: HASH_E,
        },
      ],
    })).not.toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      decision: "defer",
      nextConnectorActions: [],
      revisitCondition: null,
    })).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      decision: "defer",
      nextConnectorActions: [{
        action: "listChildrenMetadata",
        parent: "different-node",
        limit: 100,
        cursor: null,
      }],
      revisitCondition: "Resume when the declared resource window opens.",
    })).toThrow();
    expect(() => parseAgentScanResult({
      ...validScanResult(),
      decision: "ask-user",
      nextConnectorActions: [],
      question: null,
    })).toThrow();
  });

  it("requires every material factual claim to resolve at least one current citation", () => {
    const query = validQueryResult();
    expect(() => parseAgentQueryResult({
      ...query,
      claims: [{ ...query.claims[0], citationIds: [] }],
    })).toThrow();
    expect(() => parseAgentQueryResult({
      ...query,
      claims: [{ ...query.claims[0], citationIds: ["missing"] }],
    })).toThrow();
  });

  it("keeps Wiki semantics free of compiler, provider and approval authority", () => {
    expect(() => parseAgentWikiSemantics({
      ...validWikiSemantics(),
      compiler: { provider: "hidden" },
    })).toThrow();
    expect(() => parseAgentWikiSemantics({
      ...validWikiSemantics(),
      approval: { approvedBy: "agent" },
    })).toThrow();
  });

  it("accepts the complete failure taxonomy and rejects an unknown code", () => {
    const requiredCodes = [
      "NOT_INSTALLED",
      "UNSUPPORTED_VERSION",
      "CONTRACT_UNSUPPORTED",
      "AUTH_REQUIRED",
      "HOST_CONFIG_INVALID",
      "SPAWN_FAILED",
      "TIMEOUT",
      "CANCELLED",
      "PROVIDER_ERROR",
      "TOOL_ERROR",
      "OUTPUT_INVALID",
      "EXIT_NONZERO",
      "AMBIGUOUS_REMOTE_STATE",
    ] as const;

    for (const code of requiredCodes) {
      expect(() => parseAgentFailure({
        ...validFailure(),
        code,
        ambiguousRemoteState: code === "AMBIGUOUS_REMOTE_STATE",
      })).not.toThrow();
    }
    expect(() => parseAgentFailure({ ...validFailure(), code: "UNKNOWN" })).toThrow();
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
      .toEqual(AGENT_IO_SCHEMA_IDS);
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
