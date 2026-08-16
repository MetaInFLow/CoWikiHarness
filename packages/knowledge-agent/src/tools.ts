import { tool } from "@openai/agents";
import type {
  AccessContext,
  KnowledgeEvidence,
  KnowledgeLocation,
  KnowledgeRegistrationResult,
  KnowledgeSearchCandidate,
  ManagedKnowledgeResult,
  StorePreview,
} from "@openlifewiki/protocol";
import {
  knowledgeLocationInputSchema,
  managedMarkdownInputSchema,
} from "@openlifewiki/protocol";
import { z } from "zod";

import type { KnowledgeAgentContext } from "./context.js";
import { KnowledgeOperationError } from "./operations.js";

export interface KnowledgeReadOperations {
  query(context: AccessContext, input: {
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeSearchCandidate[]>;
  get(context: AccessContext, input: {
    readonly itemId: string;
    readonly locationId: string;
    readonly versionId: string | null;
  }): Promise<KnowledgeEvidence>;
}

export interface KnowledgeToolOperations extends KnowledgeReadOperations {
  register(context: AccessContext, input: {
    readonly schema: "openlifewiki.operation/v1";
    readonly kind: "knowledge.register";
    readonly itemId: string | null;
    readonly expectedRevision: number | null;
    readonly title: string;
    readonly aliases: readonly string[];
    readonly tags: readonly string[];
    readonly locations: readonly z.infer<typeof knowledgeLocationInputSchema>[];
  }): Promise<KnowledgeRegistrationResult>;
  storeManaged(context: AccessContext, input: {
    readonly schema: "openlifewiki.operation/v1";
    readonly kind: "knowledge.store";
    readonly itemId: null;
    readonly expectedRevision: null;
    readonly content: z.infer<typeof managedMarkdownInputSchema>;
  }): Promise<ManagedKnowledgeResult>;
  previewManagedReplacement(context: AccessContext, input: {
    readonly schema: "openlifewiki.operation/v1";
    readonly kind: "knowledge.store.preview-replace";
    readonly itemId: string;
    readonly expectedRevision: number;
    readonly content: z.infer<typeof managedMarkdownInputSchema>;
  }): Promise<StorePreview>;
  applyManagedReplacement(context: AccessContext, input: {
    readonly schema: "openlifewiki.operation/v1";
    readonly kind: "knowledge.store.apply-replace";
    readonly itemId: string;
    readonly expectedRevision: number;
    readonly previewHash: string;
    readonly content: z.infer<typeof managedMarkdownInputSchema>;
  }): Promise<ManagedKnowledgeResult>;
  share(context: AccessContext, input: {
    readonly schema: "openlifewiki.operation/v1";
    readonly kind: "knowledge.share";
    readonly itemId: string;
    readonly targetPrincipalId: string;
    readonly capabilities: readonly ("knowledge.query" | "knowledge.store" | "knowledge.organize")[];
  }): Promise<KnowledgeRegistrationResult>;
  listLocations(context: AccessContext, input: { readonly itemId: string }): Promise<readonly KnowledgeLocation[]>;
}

export interface KnowledgeNotFoundToolResult {
  readonly status: "no-evidence";
  readonly code: "KNOWLEDGE_NOT_FOUND";
  readonly citation: null;
}

const searchParameters = z.strictObject({
  query: z.string().min(1).max(8_000),
  limit: z.int().min(1).max(50),
});

const getParameters = z.strictObject({
  itemId: z.string().min(1).max(256),
  locationId: z.string().min(1).max(256),
  versionId: z.string().min(1).max(256).nullable(),
});

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const registerLocationParameters = z.strictObject({
  kind: z.enum(["managed-markdown", "feishu", "github", "person-local"]),
  role: z.enum(["canonical", "original", "managed-copy", "reference"]),
  locator: z.string().min(1).max(4_096),
  connectorInstanceId: id.nullable(),
  ownerPrincipalId: id,
  metadataJson: z.string().max(32_768),
});
const registerParameters = z.strictObject({
  itemId: id.nullable(),
  expectedRevision: z.int().nonnegative().nullable(),
  title: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(200)).max(50),
  tags: z.array(z.string().min(1).max(100)).max(100),
  locations: z.array(registerLocationParameters).min(1).max(20),
});
const storeDraftParameters = z.strictObject({
  content: managedMarkdownInputSchema,
});
const previewReplaceParameters = z.strictObject({
  itemId: id,
  expectedRevision: z.int().nonnegative(),
  content: managedMarkdownInputSchema,
});
const replaceParameters = z.strictObject({
  itemId: id,
  expectedRevision: z.int().nonnegative(),
  previewHash: hash,
  content: managedMarkdownInputSchema,
});
const listLocationsParameters = z.strictObject({ itemId: id });
const shareParameters = z.strictObject({
  itemId: id,
  targetPrincipalId: id,
  capabilities: z.array(z.enum([
    "knowledge.query",
    "knowledge.store",
    "knowledge.organize",
  ])).min(1),
});

export function createKnowledgeReadTools(operations: KnowledgeReadOperations) {
  const knowledgeSearchTool = tool<typeof searchParameters, KnowledgeAgentContext>({
    name: "knowledge_search",
    description: "Search only knowledge authorized for the represented user. Returns candidate metadata, never hidden rows.",
    parameters: searchParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.query(runContext.context.access, input);
    },
  });

  const knowledgeGetTool = tool<typeof getParameters, KnowledgeAgentContext>({
    name: "knowledge_get",
    description: "Retrieve one exact authorized item location and version for grounded citation. A null versionId selects the current version at that location. Missing knowledge returns an explicit no-evidence marker.",
    parameters: getParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      try {
        const evidence = await operations.get(runContext.context.access, input);
        runContext.context.retrievedCitations.push(evidence.citation);
        return evidence;
      } catch (error) {
        if (isKnowledgeNotFound(error)) {
          return {
            status: "no-evidence",
            code: "KNOWLEDGE_NOT_FOUND",
            citation: null,
          } satisfies KnowledgeNotFoundToolResult;
        }
        throw error;
      }
    },
  });

  return [knowledgeSearchTool, knowledgeGetTool] as const;
}

export function createKnowledgeTools(operations: KnowledgeToolOperations) {
  const readTools = createKnowledgeReadTools(operations);
  const registerTool = tool<typeof registerParameters, KnowledgeAgentContext>({
    name: "knowledge_register",
    description: "Register one or more authorized knowledge locations without copying external bodies.",
    parameters: registerParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.register(runContext.context.access, {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.register",
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        title: input.title,
        aliases: input.aliases,
        tags: input.tags,
        locations: input.locations.map(({ metadataJson, ...location }) => ({
          ...location,
          metadata: parseToolMetadata(metadataJson),
        })),
      });
    },
  });
  const storeDraftTool = tool<typeof storeDraftParameters, KnowledgeAgentContext>({
    name: "knowledge_store_draft",
    description: "Create a new private managed Markdown draft.",
    parameters: storeDraftParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.storeManaged(runContext.context.access, {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.store",
        itemId: null,
        expectedRevision: null,
        content: input.content,
      });
    },
  });
  const previewReplaceTool = tool<typeof previewReplaceParameters, KnowledgeAgentContext>({
    name: "knowledge_store_preview_replace",
    description: "Create the canonical preview and preview hash for one managed Markdown replacement without writing it.",
    parameters: previewReplaceParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.previewManagedReplacement(runContext.context.access, {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.store.preview-replace",
        ...input,
      });
    },
  });
  const replaceTool = tool<typeof replaceParameters, KnowledgeAgentContext>({
    name: "knowledge_store_replace",
    description: "Apply one exact managed Markdown replacement using its approved preview hash and revision.",
    parameters: replaceParameters,
    errorFunction: null,
    needsApproval: true,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.applyManagedReplacement(runContext.context.access, {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.store.apply-replace",
        ...input,
      });
    },
  });
  const listLocationsTool = tool<typeof listLocationsParameters, KnowledgeAgentContext>({
    name: "knowledge_list_locations",
    description: "List only the locations authorized for one knowledge item.",
    parameters: listLocationsParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.listLocations(runContext.context.access, input);
    },
  });
  const shareTool = tool<typeof shareParameters, KnowledgeAgentContext>({
    name: "knowledge_share",
    description: "Share one item with an active principal using explicit query, store, or organize capabilities.",
    parameters: shareParameters,
    errorFunction: null,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.share(runContext.context.access, {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.share",
        ...input,
      });
    },
  });

  return [
    ...readTools,
    registerTool,
    storeDraftTool,
    previewReplaceTool,
    replaceTool,
    listLocationsTool,
    shareTool,
  ] as const;
}

function parseToolMetadata(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KnowledgeOperationError("INVALID_OPERATION");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KnowledgeOperationError("INVALID_OPERATION");
  }
  return parsed as Record<string, unknown>;
}

function isKnowledgeNotFound(error: unknown): error is KnowledgeOperationError {
  return error instanceof KnowledgeOperationError
    && error.code === "KNOWLEDGE_NOT_FOUND";
}
