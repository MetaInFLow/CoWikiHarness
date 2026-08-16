import { z } from "zod";

import { knowledgeLocationInputSchema, managedMarkdownInputSchema } from "./knowledge.js";

export const KNOWLEDGE_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "DELEGATION_DENIED",
  "SOURCE_AUTHORIZATION_REQUIRED",
  "LOCAL_SOURCE_OFFLINE",
  "REVISION_CONFLICT",
  "APPROVAL_REQUIRED",
  "BODY_TOO_LARGE",
  "CONNECTOR_UNAVAILABLE",
  "AGENT_RUN_FAILED",
  "TASK_INTERRUPTED",
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_CONFLICT",
  "INVALID_OPERATION",
] as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const knowledgeOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.query"),
    query: z.string().min(1).max(8_000),
    limit: z.int().min(1).max(50).default(10),
    allowPartial: z.boolean().default(true),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.register"),
    itemId: id.nullable(),
    expectedRevision: z.int().nonnegative().nullable(),
    title: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(200)).max(50),
    tags: z.array(z.string().min(1).max(100)).max(100),
    locations: z.array(knowledgeLocationInputSchema).min(1).max(20),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.store"),
    itemId: z.null(),
    expectedRevision: z.null(),
    content: managedMarkdownInputSchema,
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.store.preview-replace"),
    itemId: id,
    expectedRevision: z.int().nonnegative(),
    content: managedMarkdownInputSchema,
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.store.apply-replace"),
    itemId: id,
    expectedRevision: z.int().nonnegative(),
    previewHash: hash,
    content: managedMarkdownInputSchema,
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.share"),
    itemId: id,
    targetPrincipalId: id,
    capabilities: z.array(z.enum([
      "knowledge.query",
      "knowledge.store",
      "knowledge.organize",
    ])).min(1),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.collection.create"),
    expectedRegistryRevision: z.int().nonnegative(),
    parentCollectionId: id.nullable(),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.collection.move"),
    collectionId: id,
    expectedRevision: z.int().nonnegative(),
    parentCollectionId: id.nullable(),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.place"),
    itemId: id,
    collectionId: id,
    expectedPlacementRevision: z.int().nonnegative().nullable(),
  }),
  z.strictObject({
    schema: z.literal("openlifewiki.operation/v1"),
    kind: z.literal("knowledge.organize"),
    mode: z.enum(["bootstrap", "refactor"]),
    itemIds: z.array(id).min(1).max(500),
    instruction: z.string().min(1).max(8_000),
  }),
]);

export const knowledgeFailureSchema = z.strictObject({
  schema: z.literal("openlifewiki.knowledge-failure/v1"),
  taskId: id,
  code: z.enum(KNOWLEDGE_ERROR_CODES),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export type KnowledgeOperation = z.infer<typeof knowledgeOperationSchema>;
export type KnowledgeFailure = z.infer<typeof knowledgeFailureSchema>;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];
