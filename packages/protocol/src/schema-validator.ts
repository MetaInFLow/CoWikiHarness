import { z } from "zod";

import {
  AGENT_IO_SCHEMA_IDS,
  agentFailureSchema,
  agentIoSchemas,
  agentQueryResultSchema,
  agentScanResultSchema,
  agentWikiSemanticsSchema,
  type AgentFailure,
  type AgentIoEnvelope,
  type AgentIoSchemaId,
  type AgentQueryResult,
  type AgentScanResult,
  type AgentWikiSemantics,
} from "./agent-io.js";
import { sha256Canonical } from "./hashing.js";

export interface AgentIoExpectedBindings {
  readonly inputSetHash?: string;
  readonly scanPlanHash?: string;
  readonly skeletonVersion?: string;
  readonly skillHash?: string;
  readonly activeGenerationId?: string;
  readonly baseWikiHash?: string;
  readonly evidenceManifestHash?: string;
}

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

function assertBindings(
  value: AgentIoEnvelope,
  expected: AgentIoExpectedBindings,
): void {
  const actual = {
    inputSetHash: value.inputSetHash,
    scanPlanHash: value.schema === "openlifewiki.agent-scan-result/v1"
      ? value.scanPlanHash
      : undefined,
    skeletonVersion: value.schema === "openlifewiki.agent-scan-result/v1"
      ? value.skeletonVersion
      : undefined,
    skillHash: value.schema === "openlifewiki.agent-scan-result/v1" ? value.skillHash : undefined,
    activeGenerationId: value.schema === "openlifewiki.agent-query-result/v1"
      ? value.activeGeneration.generationId
      : undefined,
    baseWikiHash: value.schema === "openlifewiki.agent-wiki-semantics/v1"
      ? value.baseWikiHash
      : undefined,
    evidenceManifestHash: value.schema === "openlifewiki.agent-wiki-semantics/v1"
      ? value.evidenceManifestHash
      : undefined,
  } as const;

  for (const key of Object.keys(expected) as (keyof AgentIoExpectedBindings)[]) {
    if (expected[key] !== actual[key]) {
      throw new Error(`Agent I/O binding mismatch: ${key}`);
    }
  }
}

function parseWithBindings<T extends AgentIoEnvelope>(
  schema: z.ZodType<T>,
  input: unknown,
  expected: AgentIoExpectedBindings,
): T {
  const value = schema.parse(input);
  assertBindings(value, expected);
  return value;
}

export function parseAgentScanResult(
  input: unknown,
  expected: AgentIoExpectedBindings = {},
): AgentScanResult {
  return parseWithBindings(agentScanResultSchema, input, expected);
}

export function parseAgentQueryResult(
  input: unknown,
  expected: AgentIoExpectedBindings = {},
): AgentQueryResult {
  return parseWithBindings(agentQueryResultSchema, input, expected);
}

export function parseAgentWikiSemantics(
  input: unknown,
  expected: AgentIoExpectedBindings = {},
): AgentWikiSemantics {
  return parseWithBindings(agentWikiSemanticsSchema, input, expected);
}

export function parseAgentFailure(
  input: unknown,
  expected: AgentIoExpectedBindings = {},
): AgentFailure {
  return parseWithBindings(agentFailureSchema, input, expected);
}

export function parseAgentIoEnvelope(
  input: unknown,
  expected: AgentIoExpectedBindings = {},
): AgentIoEnvelope {
  if (typeof input !== "object" || input === null || !("schema" in input)) {
    throw new Error("Agent I/O envelope requires a recognized schema ID");
  }
  const schemaId = (input as { readonly schema?: unknown }).schema;
  if (typeof schemaId !== "string" || !AGENT_IO_SCHEMA_IDS.includes(schemaId as AgentIoSchemaId)) {
    throw new Error("Agent I/O envelope requires a recognized schema ID");
  }
  switch (schemaId) {
    case "openlifewiki.agent-scan-result/v1":
      return parseAgentScanResult(input, expected);
    case "openlifewiki.agent-query-result/v1":
      return parseAgentQueryResult(input, expected);
    case "openlifewiki.agent-wiki-semantics/v1":
      return parseAgentWikiSemantics(input, expected);
    case "openlifewiki.agent-failure/v1":
      return parseAgentFailure(input, expected);
    default:
      throw new Error("Agent I/O envelope requires a recognized schema ID");
  }
}

export function getAgentIoJsonSchema(schemaId: AgentIoSchemaId): AgentIoJsonSchema {
  const jsonSchema = z.toJSONSchema(agentIoSchemas[schemaId], {
    target: "draft-2020-12",
    unrepresentable: "throw",
  });
  return {
    ...jsonSchema,
    $id: schemaId,
  } as AgentIoJsonSchema;
}

export function getAgentIoSchemaHash(schemaId: AgentIoSchemaId): string {
  return sha256Canonical(getAgentIoJsonSchema(schemaId));
}

const manifestPayload = {
  schema: "openlifewiki.agent-io-schema-manifest/v1",
  generator: {
    package: "@openlifewiki/protocol",
    packageVersion: "0.1.0-dev.1",
    generatorVersion: "1",
    source: "zod",
    sourceVersion: "4.4.3",
    target: "draft-2020-12",
  },
  schemas: AGENT_IO_SCHEMA_IDS.map((schemaId) => ({
    schemaId,
    file: SCHEMA_FILES[schemaId],
    sha256: getAgentIoSchemaHash(schemaId),
  })),
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
