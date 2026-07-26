import { z } from "zod";

import {
  AGENT_IO_SCHEMA_IDS,
  AGENT_IO_SEMANTIC_RULES,
  AGENT_IO_SEMANTIC_RULES_VERSION,
  agentFailureSchema,
  agentIoAgentSchema,
  agentIoSchemas,
  agentQueryResultSchema,
  agentScanResultSchema,
  agentWikiSemanticsSchema,
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

const scanExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-scan-result/v1"),
  agent: agentIoAgentSchema,
  inputSetHash: hash,
  skillHash: hash,
  scanPlanHash: hash,
  skeletonVersion: hash,
});
const queryExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-query-result/v1"),
  agent: agentIoAgentSchema,
  inputSetHash: hash,
  skillHash: hash,
  activeGeneration: z.strictObject({
    generationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
    manifestHash: hash,
  }),
});
const wikiExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-wiki-semantics/v1"),
  agent: agentIoAgentSchema,
  inputSetHash: hash,
  skillHash: hash,
  baseWikiHash: hash,
  evidenceManifestHash: hash,
});
const failureExpectedBindingsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-failure/v1"),
  agent: agentIoAgentSchema,
  inputSetHash: hash,
  skillHash: hash,
});

const agentIoExpectedBindingsSchema = z.discriminatedUnion("schema", [
  scanExpectedBindingsSchema,
  queryExpectedBindingsSchema,
  wikiExpectedBindingsSchema,
  failureExpectedBindingsSchema,
]);

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

function assertEqual(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new Error(`Agent I/O binding mismatch: ${path}`);
}

function assertAgent(actual: AgentIoAgent, expected: AgentIoAgent): void {
  assertEqual(actual.id, expected.id, "agent.id");
  assertEqual(actual.runtime, expected.runtime, "agent.runtime");
  assertEqual(actual.mode, expected.mode, "agent.mode");
  assertEqual(
    actual.driverContractVersion,
    expected.driverContractVersion,
    "agent.driverContractVersion",
  );
}

function assertCommonBindings(
  value: AgentIoEnvelope,
  expected: AgentIoExpectedBindings,
): void {
  assertEqual(value.schema, expected.schema, "schema");
  assertAgent(value.agent, expected.agent);
  assertEqual(value.inputSetHash, expected.inputSetHash, "inputSetHash");
  assertEqual(value.skillHash, expected.skillHash, "skillHash");
}

export function parseAgentScanResult(
  input: unknown,
  expected: AgentScanExpectedBindings,
): AgentScanResult {
  const checkedExpected = scanExpectedBindingsSchema.parse(expected);
  const value = agentScanResultSchema.parse(input);
  assertCommonBindings(value, checkedExpected);
  assertEqual(value.scanPlanHash, checkedExpected.scanPlanHash, "scanPlanHash");
  assertEqual(value.skeletonVersion, checkedExpected.skeletonVersion, "skeletonVersion");
  return value;
}

export function parseAgentQueryResult(
  input: unknown,
  expected: AgentQueryExpectedBindings,
): AgentQueryResult {
  const checkedExpected = queryExpectedBindingsSchema.parse(expected);
  const value = agentQueryResultSchema.parse(input);
  assertCommonBindings(value, checkedExpected);
  assertEqual(
    value.activeGeneration.generationId,
    checkedExpected.activeGeneration.generationId,
    "activeGeneration.generationId",
  );
  assertEqual(
    value.activeGeneration.manifestHash,
    checkedExpected.activeGeneration.manifestHash,
    "activeGeneration.manifestHash",
  );
  return value;
}

export function parseAgentWikiSemantics(
  input: unknown,
  expected: AgentWikiExpectedBindings,
): AgentWikiSemantics {
  const checkedExpected = wikiExpectedBindingsSchema.parse(expected);
  const value = agentWikiSemanticsSchema.parse(input);
  assertCommonBindings(value, checkedExpected);
  assertEqual(value.baseWikiHash, checkedExpected.baseWikiHash, "baseWikiHash");
  assertEqual(
    value.evidenceManifestHash,
    checkedExpected.evidenceManifestHash,
    "evidenceManifestHash",
  );
  return value;
}

export function parseAgentFailure(
  input: unknown,
  expected: AgentFailureExpectedBindings,
): AgentFailure {
  const checkedExpected = failureExpectedBindingsSchema.parse(expected);
  const value = agentFailureSchema.parse(input);
  assertCommonBindings(value, checkedExpected);
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

export function getAgentIoJsonSchema(schemaId: AgentIoSchemaId): AgentIoJsonSchema {
  const jsonSchema = z.toJSONSchema(agentIoSchemas[schemaId], {
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
});

const manifestPayload = {
  schema: "openlifewiki.agent-io-schema-manifest/v1",
  generator: {
    package: "@openlifewiki/protocol",
    packageVersion: "0.1.0-dev.1",
    generatorVersion: "2",
    source: "zod",
    sourceVersion: "4.4.3",
    target: "draft-2020-12",
  },
  semanticRules: {
    version: AGENT_IO_SEMANTIC_RULES_VERSION,
    rules: AGENT_IO_SEMANTIC_RULES,
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
