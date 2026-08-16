import { z } from "zod";

export const KNOWLEDGE_LOCATION_KINDS = [
  "managed-markdown",
  "feishu",
  "github",
  "person-local",
] as const;
export const KNOWLEDGE_LOCATION_ROLES = [
  "canonical",
  "original",
  "managed-copy",
  "reference",
] as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const safeLocator = z.string().min(1).max(4_096).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") {
      context.addIssue({ code: "custom", message: "locator cannot contain credentials" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "locator must be an absolute URI" });
  }
});
const boundedMarkdown = z.string().superRefine((value, context) => {
  if (new TextEncoder().encode(value).byteLength > 1_048_576) {
    context.addIssue({ code: "custom", message: "Markdown exceeds 1 MiB of UTF-8" });
  }
});
const safeMetadata = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (containsForbiddenMetadataKey(value)) {
    context.addIssue({ code: "custom", message: "metadata contains credential material" });
  }
});

function containsForbiddenMetadataKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenMetadataKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => (
    /api[_-]?key|token|credential|password|secret/i.test(key)
    || containsForbiddenMetadataKey(child)
  ));
}

export const knowledgeItemSchema = z.strictObject({
  schema: z.literal("openlifewiki.knowledge-item/v1"),
  itemId: id,
  orgId: id,
  ownerPrincipalId: id,
  title: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(200)).max(50),
  status: z.enum(["draft", "stable", "deprecated"]),
  currentVersionId: id.nullable(),
  revision: z.int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const knowledgeLocationInputSchema = z.strictObject({
  kind: z.enum(KNOWLEDGE_LOCATION_KINDS),
  role: z.enum(KNOWLEDGE_LOCATION_ROLES),
  locator: safeLocator,
  connectorInstanceId: id.nullable(),
  ownerPrincipalId: id,
  metadata: safeMetadata,
});

export const knowledgeLocationSchema = knowledgeLocationInputSchema.extend({
  schema: z.literal("openlifewiki.knowledge-location/v1"),
  locationId: id,
  itemId: id,
  observedProviderVersion: z.string().min(1).max(500).nullable(),
  availability: z.enum(["available", "offline", "unknown", "revoked"]),
  revision: z.int().nonnegative(),
  lastVerifiedAt: timestamp.nullable(),
});

export const knowledgeVersionSchema = z.strictObject({
  schema: z.literal("openlifewiki.knowledge-version/v1"),
  versionId: id,
  itemId: id,
  locationId: id,
  ordinal: z.int().positive(),
  bodyHash: hash,
  bodyMarkdown: boundedMarkdown.nullable(),
  providerVersion: z.string().min(1).max(500).nullable(),
  provenance: z.record(z.string(), z.unknown()),
  createdByPrincipalId: id,
  createdAt: timestamp,
});

export const managedMarkdownInputSchema = z.strictObject({
  title: z.string().min(1).max(500),
  bodyMarkdown: boundedMarkdown,
  aliases: z.array(z.string().min(1).max(200)).max(50).default([]),
  tags: z.array(z.string().min(1).max(100)).max(100).default([]),
});

export const knowledgeCitationSchema = z.strictObject({
  citationId: id,
  itemId: id,
  locationId: id,
  versionId: id,
  locator: safeLocator,
  title: z.string().min(1).max(500),
  bodyHash: hash,
});

export const knowledgeSearchCandidateSchema = z.strictObject({
  itemId: id,
  locationId: id,
  versionId: id.nullable(),
  title: z.string().min(1).max(500),
  locator: safeLocator,
  tags: z.array(z.string().min(1).max(100)),
  snippet: z.string().max(2_000).nullable(),
  freshness: z.enum(["current", "stale", "unknown"]),
  availability: z.enum(["available", "offline", "unknown", "revoked"]),
});

export const knowledgeEvidenceSchema = z.strictObject({
  citation: knowledgeCitationSchema,
  bodyMarkdown: boundedMarkdown,
  providerVersion: z.string().min(1).max(500).nullable(),
});

export const knowledgeQueryResultSchema = z.strictObject({
  schema: z.literal("openlifewiki.knowledge-query-result/v1"),
  taskId: id,
  evidenceMode: z.enum(["grounded", "partial", "conflicting", "no-evidence"]),
  answer: z.string().max(32_000),
  citations: z.array(knowledgeCitationSchema),
  gaps: z.array(z.strictObject({
    code: id,
    description: z.string().min(1).max(2_000),
  })),
});

export const knowledgeRegistrationResultSchema = z.strictObject({
  schema: z.literal("openlifewiki.knowledge-registration-result/v1"),
  taskId: id,
  item: knowledgeItemSchema,
  locations: z.array(knowledgeLocationSchema),
});

export const managedKnowledgeResultSchema = z.strictObject({
  schema: z.literal("openlifewiki.managed-knowledge-result/v1"),
  taskId: id,
  item: knowledgeItemSchema,
  location: knowledgeLocationSchema,
  version: knowledgeVersionSchema,
});

export const storePreviewSchema = z.strictObject({
  schema: z.literal("openlifewiki.store-preview/v1"),
  taskId: id,
  itemId: id,
  expectedRevision: z.int().nonnegative(),
  oldBodyHash: hash,
  newBodyHash: hash,
  oldTitle: z.string().min(1).max(500),
  newTitle: z.string().min(1).max(500),
  previewHash: hash,
});

export const knowledgeAgentResultSchema = z.union([
  knowledgeQueryResultSchema,
  knowledgeRegistrationResultSchema,
  managedKnowledgeResultSchema,
  storePreviewSchema,
]);

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeLocation = z.infer<typeof knowledgeLocationSchema>;
export type KnowledgeVersion = z.infer<typeof knowledgeVersionSchema>;
export type KnowledgeLocationInput = z.infer<typeof knowledgeLocationInputSchema>;
export type KnowledgeQueryResult = z.infer<typeof knowledgeQueryResultSchema>;
export type KnowledgeSearchCandidate = z.infer<typeof knowledgeSearchCandidateSchema>;
export type KnowledgeEvidence = z.infer<typeof knowledgeEvidenceSchema>;
export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;
export type KnowledgeRegistrationResult = z.infer<typeof knowledgeRegistrationResultSchema>;
export type ManagedKnowledgeResult = z.infer<typeof managedKnowledgeResultSchema>;
export type StorePreview = z.infer<typeof storePreviewSchema>;
export type KnowledgeAgentResult = z.infer<typeof knowledgeAgentResultSchema>;
