import { z } from "zod";

import {
  AGENT_IO_SCHEMA_IDS,
  AGENT_IO_SCHEMA_BUILDERS,
  AGENT_IO_SEMANTIC_RULES,
  AGENT_IO_SEMANTIC_RULES_VERSION,
  AGENT_FAILURE_PRESENTATION,
  agentBaseWikiPageSchema,
  agentCitationSchema,
  agentConnectorActionSchema,
  agentScanBudgetSchema,
  agentScanCoverageSchema,
  agentScanNodeSchema,
  agentScanSensitivitySchema,
  agentWikiSourceSchema,
  agentWikiDirectChildFolders,
  agentWikiParentFolder,
  agentWikiSameStringSet,
  buildAgentFailureSchema,
  buildAgentIoAgentSchema,
  buildAgentQueryResultSchema,
  buildAgentScanResultSchema,
  buildAgentWikiSemanticsSchema,
  validateAgentFailureSemantics,
  validateAgentIoAgentSemantics,
  validateAgentQuerySemantics,
  validateAgentScanSemantics,
  validateAgentWikiSemantics,
  type AgentFailure,
  type AgentIoAgent,
  type AgentIoEnvelope,
  type AgentIoSchemaId,
  type AgentQueryResult,
  type AgentScanResult,
  type AgentWikiSemantics,
} from "./agent-io.js";
import { sha256Canonical } from "./hashing.js";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

const scanExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-scan-result/v1"),
  agent: buildAgentIoAgentSchema(),
  inputSetHash: hash,
  skillHash: hash,
  scanPlanHash: hash,
  skeletonVersion: hash,
  operationId: safeIdentifier,
  scanId: safeIdentifier,
  node: agentScanNodeSchema,
  coverage: agentScanCoverageSchema,
  budget: agentScanBudgetSchema,
  sensitivity: agentScanSensitivitySchema,
  allowedNextConnectorActions: z.array(agentConnectorActionSchema).max(2),
});
const queryExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-query-result/v1"),
  agent: buildAgentIoAgentSchema(),
  inputSetHash: hash,
  skillHash: hash,
  queryId: safeIdentifier,
  activeGeneration: z.strictObject({
    generationId: safeIdentifier,
    manifestHash: hash,
  }),
  allowedCitations: z.array(agentCitationSchema),
});
const wikiExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-wiki-semantics/v1"),
  agent: buildAgentIoAgentSchema(),
  inputSetHash: hash,
  skillHash: hash,
  proposalId: safeIdentifier,
  baseWikiHash: hash,
  evidenceManifestHash: hash,
  allowedEvidence: z.array(agentWikiSourceSchema),
  baseWikiPages: z.array(agentBaseWikiPageSchema),
});
const failureExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-failure/v1"),
  agent: buildAgentIoAgentSchema(),
  inputSetHash: hash,
  skillHash: hash,
  operationId: safeIdentifier,
});

const agentIoExpectedBindingsSchema = z.discriminatedUnion("schema", [
  scanExpectedBindingsSchema,
  queryExpectedBindingsSchema,
  wikiExpectedBindingsSchema,
  failureExpectedBindingsSchema,
]);

export const AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES = Object.freeze([
  ["openlifewiki.agent-scan-result/v1", scanExpectedBindingsSchema],
  ["openlifewiki.agent-query-result/v1", queryExpectedBindingsSchema],
  ["openlifewiki.agent-wiki-semantics/v1", wikiExpectedBindingsSchema],
  ["openlifewiki.agent-failure/v1", failureExpectedBindingsSchema],
].map(([schemaId, schema]) => ({
  schemaId: schemaId as AgentIoSchemaId,
  sha256: sha256Canonical(z.toJSONSchema(schema as z.ZodType, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  })),
})).sort((left, right) => {
  if (left.schemaId < right.schemaId) return -1;
  if (left.schemaId > right.schemaId) return 1;
  return 0;
}));

export type AgentScanExpectedBindings = z.infer<typeof scanExpectedBindingsSchema>;
export type AgentQueryExpectedBindings = z.infer<typeof queryExpectedBindingsSchema>;
export type AgentWikiExpectedBindings = z.infer<typeof wikiExpectedBindingsSchema>;
export type AgentFailureExpectedBindings = z.infer<typeof failureExpectedBindingsSchema>;
export type AgentIoExpectedBindings = z.infer<typeof agentIoExpectedBindingsSchema>;

export interface AgentIoJsonSchema extends Readonly<Record<string, unknown>> {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly $id: AgentIoSchemaId;
}

const SCHEMA_FILES = {
  "openlifewiki.agent-scan-result/v1": "agent-scan-result.v1.schema.json",
  "openlifewiki.agent-query-result/v1": "agent-query-result.v1.schema.json",
  "openlifewiki.agent-wiki-semantics/v1": "agent-wiki-semantics.v1.schema.json",
  "openlifewiki.agent-failure/v1": "agent-failure.v1.schema.json",
} as const satisfies Record<AgentIoSchemaId, string>;

export function assertAgentIoEqual(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new Error(`Agent I/O binding mismatch: ${path}`);
}

export function assertAgentIoDeepEqual(actual: unknown, expected: unknown, path: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Agent I/O binding mismatch: ${path}`);
  }
}

export function assertAgentIoAgent(actual: AgentIoAgent, expected: AgentIoAgent): void {
  assertAgentIoEqual(actual.id, expected.id, "agent.id");
  assertAgentIoEqual(actual.runtime, expected.runtime, "agent.runtime");
  assertAgentIoEqual(actual.mode, expected.mode, "agent.mode");
  assertAgentIoEqual(
    actual.driverContractVersion,
    expected.driverContractVersion,
    "agent.driverContractVersion",
  );
}

export function assertAgentIoCommonBindings(
  value: AgentIoEnvelope,
  expected: AgentIoExpectedBindings,
): void {
  assertAgentIoEqual(value.schema, expected.schema, "schema");
  assertAgentIoAgent(value.agent, expected.agent);
  assertAgentIoEqual(value.inputSetHash, expected.inputSetHash, "inputSetHash");
  assertAgentIoEqual(value.skillHash, expected.skillHash, "skillHash");
}

export function assertAgentScanBindings(
  value: AgentScanResult,
  expected: AgentScanExpectedBindings,
): void {
  assertAgentIoCommonBindings(value, expected);
  assertAgentIoEqual(value.operationId, expected.operationId, "operationId");
  assertAgentIoEqual(value.scanId, expected.scanId, "scanId");
  assertAgentIoEqual(value.scanPlanHash, expected.scanPlanHash, "scanPlanHash");
  assertAgentIoEqual(value.skeletonVersion, expected.skeletonVersion, "skeletonVersion");
  assertAgentIoDeepEqual(value.node, expected.node, "node");
  assertAgentIoDeepEqual(value.coverage, expected.coverage, "coverage");
  assertAgentIoDeepEqual(value.budget, expected.budget, "budget");
  assertAgentIoDeepEqual(value.sensitivity, expected.sensitivity, "sensitivity");
  assertAgentIoDeepEqual(
    value.nextConnectorActions,
    expected.allowedNextConnectorActions,
    "allowedNextConnectorActions",
  );
}

export function assertAgentQueryBindings(
  value: AgentQueryResult,
  expected: AgentQueryExpectedBindings,
): void {
  assertAgentIoCommonBindings(value, expected);
  assertAgentIoEqual(value.queryId, expected.queryId, "queryId");
  assertAgentIoEqual(
    value.activeGeneration.generationId,
    expected.activeGeneration.generationId,
    "activeGeneration.generationId",
  );
  assertAgentIoEqual(
    value.activeGeneration.manifestHash,
    expected.activeGeneration.manifestHash,
    "activeGeneration.manifestHash",
  );
  const allowedById = new Map(expected.allowedCitations.map((citation) => [
    citation.citationId,
    citation,
  ]));
  if (allowedById.size !== expected.allowedCitations.length) {
    throw new Error("Agent I/O trusted context is ambiguous: allowedCitations");
  }
  value.citations.forEach((citation) => {
    const allowed = allowedById.get(citation.citationId);
    if (allowed === undefined || JSON.stringify(citation) !== JSON.stringify(allowed)) {
      throw new Error("Agent I/O binding mismatch: allowedCitations");
    }
  });
}

export function assertAgentWikiBindings(
  value: AgentWikiSemantics,
  expected: AgentWikiExpectedBindings,
): void {
  assertAgentIoCommonBindings(value, expected);
  assertAgentIoEqual(value.proposalId, expected.proposalId, "proposalId");
  assertAgentIoEqual(value.baseWikiHash, expected.baseWikiHash, "baseWikiHash");
  assertAgentIoEqual(
    value.evidenceManifestHash,
    expected.evidenceManifestHash,
    "evidenceManifestHash",
  );
  const evidenceById = new Map(expected.allowedEvidence.map((entry) => [entry.id, entry]));
  if (evidenceById.size !== expected.allowedEvidence.length) {
    throw new Error("Agent I/O trusted context is ambiguous: allowedEvidence");
  }
  value.concepts.flatMap(({ sources }) => sources).forEach((source) => {
    const allowed = evidenceById.get(source.id);
    if (allowed === undefined || JSON.stringify(source) !== JSON.stringify(allowed)) {
      throw new Error("Agent I/O binding mismatch: allowedEvidence");
    }
  });
  const basePageById = new Map(expected.baseWikiPages.map((page) => [page.page_uid, page]));
  if (basePageById.size !== expected.baseWikiPages.length) {
    throw new Error("Agent I/O trusted context is ambiguous: baseWikiPages");
  }
  value.concepts.flatMap(({ links }) => links).forEach(({ target }) => {
    if (target.kind !== "base-wiki") return;
    const allowed = basePageById.get(target.page_uid);
    if (allowed === undefined || allowed.path !== target.path) {
      throw new Error("Agent I/O binding mismatch: baseWikiPages");
    }
  });
}

export function assertAgentFailureBindings(
  value: AgentFailure,
  expected: AgentFailureExpectedBindings,
): void {
  assertAgentIoCommonBindings(value, expected);
  assertAgentIoEqual(value.operationId, expected.operationId, "operationId");
}

export function parseAgentScanResult(
  input: unknown,
  expected: AgentScanExpectedBindings,
): AgentScanResult {
  const checkedExpected = scanExpectedBindingsSchema.parse(expected);
  const value = buildAgentScanResultSchema().parse(input);
  assertAgentScanBindings(value, checkedExpected);
  return value;
}

export function parseAgentQueryResult(
  input: unknown,
  expected: AgentQueryExpectedBindings,
): AgentQueryResult {
  const checkedExpected = queryExpectedBindingsSchema.parse(expected);
  const value = buildAgentQueryResultSchema().parse(input);
  assertAgentQueryBindings(value, checkedExpected);
  return value;
}

export function parseAgentWikiSemantics(
  input: unknown,
  expected: AgentWikiExpectedBindings,
): AgentWikiSemantics {
  const checkedExpected = wikiExpectedBindingsSchema.parse(expected);
  const value = buildAgentWikiSemanticsSchema().parse(input);
  assertAgentWikiBindings(value, checkedExpected);
  return value;
}

export function parseAgentFailure(
  input: unknown,
  expected: AgentFailureExpectedBindings,
): AgentFailure {
  const checkedExpected = failureExpectedBindingsSchema.parse(expected);
  const value = buildAgentFailureSchema().parse(input);
  assertAgentFailureBindings(value, checkedExpected);
  return value;
}

export function parseAgentIoEnvelope(
  input: unknown,
  expected: AgentIoExpectedBindings,
): AgentIoEnvelope {
  const checkedExpected = agentIoExpectedBindingsSchema.parse(expected);
  if (typeof input !== "object" || input === null || !("schema" in input)) {
    throw new Error("Agent I/O envelope requires a recognized schema ID");
  }
  const schemaId = (input as { readonly schema?: unknown }).schema;
  if (schemaId !== checkedExpected.schema) {
    throw new Error("Agent I/O binding mismatch: schema");
  }
  switch (checkedExpected.schema) {
    case "openlifewiki.agent-scan-result/v1":
      return parseAgentScanResult(input, checkedExpected);
    case "openlifewiki.agent-query-result/v1":
      return parseAgentQueryResult(input, checkedExpected);
    case "openlifewiki.agent-wiki-semantics/v1":
      return parseAgentWikiSemantics(input, checkedExpected);
    case "openlifewiki.agent-failure/v1":
      return parseAgentFailure(input, checkedExpected);
  }
}

export function canonicalizeAgentIoExecutableSource(validator: CallableFunction): string {
  return Function.prototype.toString.call(validator)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\(0,\s*__vite_ssr_import_\d+__\.([A-Za-z_$][A-Za-z0-9_$]*)\)/g, "$1")
    .replace(/\b__vite_ssr_import_\d+__\./g, "")
    .replace(/\bvoid 0\b|\bvoid0\b/g, "undefined")
    .replace(/\\u0000/g, "\\0")
    .replace(/\s+/g, "")
    .replace(/;/g, "")
    .replace(/,([\]})])/g, "$1");
}

export const AGENT_IO_EXECUTABLE_VALIDATORS = Object.freeze({
  agentWikiDirectChildFolders,
  agentWikiParentFolder,
  agentWikiSameStringSet,
  assertAgentFailureBindings,
  assertAgentIoAgent,
  assertAgentIoCommonBindings,
  assertAgentIoDeepEqual,
  assertAgentIoEqual,
  assertAgentQueryBindings,
  assertAgentScanBindings,
  assertAgentWikiBindings,
  buildAgentFailureSchema,
  buildAgentIoAgentSchema,
  buildAgentQueryResultSchema,
  buildAgentScanResultSchema,
  buildAgentWikiSemanticsSchema,
  getAgentIoJsonSchema,
  parseAgentFailure,
  parseAgentIoEnvelope,
  parseAgentQueryResult,
  parseAgentScanResult,
  parseAgentWikiSemantics,
  validateAgentFailureSemantics,
  validateAgentIoAgentSemantics,
  validateAgentQuerySemantics,
  validateAgentScanSemantics,
  validateAgentWikiSemantics,
} satisfies Record<string, CallableFunction>);

export const AGENT_IO_EXECUTABLE_VALIDATOR_SOURCES = Object.freeze(
  Object.entries(AGENT_IO_EXECUTABLE_VALIDATORS)
    .map(([name, validator]) => ({
      name,
      source: canonicalizeAgentIoExecutableSource(validator),
    }))
    .sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    }),
);

export function getAgentIoJsonSchema(schemaId: AgentIoSchemaId): AgentIoJsonSchema {
  const jsonSchema = z.toJSONSchema(AGENT_IO_SCHEMA_BUILDERS[schemaId](), {
    target: "draft-2020-12",
    unrepresentable: "throw",
  });
  return { ...jsonSchema, $id: schemaId } as AgentIoJsonSchema;
}

export function getAgentIoSchemaHash(schemaId: AgentIoSchemaId): string {
  return sha256Canonical(getAgentIoJsonSchema(schemaId));
}

export const AGENT_IO_SEMANTIC_RULES_HASH = sha256Canonical({
  version: AGENT_IO_SEMANTIC_RULES_VERSION,
  rules: AGENT_IO_SEMANTIC_RULES,
  executables: AGENT_IO_EXECUTABLE_VALIDATOR_SOURCES,
  data: {
    failurePresentation: AGENT_FAILURE_PRESENTATION,
    expectedBindingSchemaHashes: AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
  },
});

const manifestPayload = {
  schema: "openlifewiki.agent-io-schema-manifest/v1",
  generator: {
    package: "@openlifewiki/protocol",
    packageVersion: "0.1.0-dev.1",
    generatorVersion: "5",
    source: "zod",
    sourceVersion: "4.4.3",
    target: "draft-2020-12",
  },
  semanticRules: {
    version: AGENT_IO_SEMANTIC_RULES_VERSION,
    rules: AGENT_IO_SEMANTIC_RULES,
    executables: AGENT_IO_EXECUTABLE_VALIDATOR_SOURCES,
    data: {
      failurePresentation: AGENT_FAILURE_PRESENTATION,
      expectedBindingSchemaHashes: AGENT_IO_EXPECTED_BINDING_SCHEMA_HASHES,
    },
    sha256: AGENT_IO_SEMANTIC_RULES_HASH,
  },
  schemas: AGENT_IO_SCHEMA_IDS
    .map((schemaId) => ({
      schemaId,
      file: SCHEMA_FILES[schemaId],
      sha256: getAgentIoSchemaHash(schemaId),
    }))
    .sort((left, right) => {
      if (left.schemaId < right.schemaId) return -1;
      if (left.schemaId > right.schemaId) return 1;
      return 0;
    }),
} as const;

export const AGENT_IO_SCHEMA_MANIFEST = Object.freeze({
  ...manifestPayload,
  manifestHash: sha256Canonical(manifestPayload),
});

export function getAgentIoSchemaManifest(): typeof AGENT_IO_SCHEMA_MANIFEST {
  return AGENT_IO_SCHEMA_MANIFEST;
}

export function getAgentIoSchemaManifestHash(): string {
  return AGENT_IO_SCHEMA_MANIFEST.manifestHash;
}
