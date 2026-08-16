import {
  AdapterError,
  PostgresKnowledgeStore,
} from "@openlifewiki/adapters";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeLocationSchema,
  knowledgeOperationSchema,
  knowledgeRegistrationResultSchema,
  managedKnowledgeResultSchema,
  managedMarkdownInputSchema,
  storePreviewSchema,
  type AccessContext,
  type KnowledgeCapability,
  type KnowledgeErrorCode,
  type KnowledgeEvidence,
  type KnowledgeLocation,
  type KnowledgeOperation,
  type KnowledgeRegistrationResult,
  type KnowledgeSearchCandidate,
  type ManagedKnowledgeResult,
  type StorePreview,
} from "@openlifewiki/protocol";
import { z } from "zod";

export class KnowledgeOperationError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(operationErrorMessage(code));
    this.name = "KnowledgeOperationError";
  }
}

export class KnowledgeOperations {
  constructor(private readonly store: PostgresKnowledgeStore) {}

  async query(context: AccessContext, input: {
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeSearchCandidate[]> {
    return await this.run(() => this.store.searchAuthorized({ context, ...input }));
  }

  async get(context: AccessContext, input: {
    readonly itemId: string;
    readonly locationId: string;
    readonly versionId: string | null;
  }): Promise<KnowledgeEvidence> {
    return await this.run(async () => {
      const value = await this.store.getAuthorized({ context, ...input });
      if (value === null) throw new KnowledgeOperationError("KNOWLEDGE_NOT_FOUND");
      return value;
    });
  }

  async register(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.register" }>,
  ): Promise<KnowledgeRegistrationResult> {
    return await this.run(async () => {
      const operation = parseOperation(input, "knowledge.register");
      const result = await this.store.registerLocations({
        context,
        itemId: operation.itemId,
        expectedRevision: operation.expectedRevision,
        title: operation.title,
        aliases: operation.aliases,
        tags: operation.tags,
        locations: operation.locations,
      });
      return knowledgeRegistrationResultSchema.parse({
        schema: "openlifewiki.knowledge-registration-result/v1",
        taskId: context.taskId,
        ...result,
      });
    });
  }

  async storeManaged(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.store" }>,
  ): Promise<ManagedKnowledgeResult> {
    return await this.run(async () => {
      if (hasOversizedBody(input.content)) {
        await this.store.createManagedKnowledge({ context, content: input.content });
        throw new KnowledgeOperationError("BODY_TOO_LARGE");
      }
      const content = parseManagedContent(input.content);
      const operation = parseOperation({ ...input, content }, "knowledge.store");
      const result = await this.store.createManagedKnowledge({ context, content: operation.content });
      return managedKnowledgeResultSchema.parse({
        schema: "openlifewiki.managed-knowledge-result/v1",
        taskId: context.taskId,
        ...result,
      });
    });
  }

  async previewManagedReplacement(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.store.preview-replace" }>,
  ): Promise<StorePreview> {
    return await this.run(async () => {
      if (hasOversizedBody(input.content)) {
        await this.store.previewManagedKnowledge({
          context,
          itemId: input.itemId,
          expectedRevision: input.expectedRevision,
          content: input.content,
        });
        throw new KnowledgeOperationError("BODY_TOO_LARGE");
      }
      const content = parseManagedContent(input.content);
      const operation = parseOperation({ ...input, content }, "knowledge.store.preview-replace");
      return storePreviewSchema.parse(await this.store.previewManagedKnowledge({
        context,
        itemId: operation.itemId,
        expectedRevision: operation.expectedRevision,
        content: operation.content,
      }));
    });
  }

  async applyManagedReplacement(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.store.apply-replace" }>,
    approvalTaskId?: string,
  ): Promise<ManagedKnowledgeResult> {
    return await this.run(async () => {
      if (hasOversizedBody(input.content)) {
        await this.store.replaceManagedKnowledge({
          context,
          ...(approvalTaskId === undefined ? {} : { approvalTaskId }),
          itemId: input.itemId,
          expectedRevision: input.expectedRevision,
          previewHash: input.previewHash,
          content: input.content,
        });
        throw new KnowledgeOperationError("BODY_TOO_LARGE");
      }
      const content = parseManagedContent(input.content);
      const operation = parseOperation({ ...input, content }, "knowledge.store.apply-replace");
      const result = await this.store.replaceManagedKnowledge({
        context,
        ...(approvalTaskId === undefined ? {} : { approvalTaskId }),
        itemId: operation.itemId,
        expectedRevision: operation.expectedRevision,
        previewHash: operation.previewHash,
        content: operation.content,
      });
      return managedKnowledgeResultSchema.parse({
        schema: "openlifewiki.managed-knowledge-result/v1",
        taskId: context.taskId,
        ...result,
      });
    });
  }

  async share(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.share" }>,
  ): Promise<KnowledgeRegistrationResult> {
    return await this.run(async () => {
      const operation = parseOperation(input, "knowledge.share");
      const result = await this.store.shareItem({
        context,
        itemId: operation.itemId,
        targetPrincipalId: operation.targetPrincipalId,
        capabilities: operation.capabilities,
      });
      return knowledgeRegistrationResultSchema.parse({
        schema: "openlifewiki.knowledge-registration-result/v1",
        taskId: context.taskId,
        item: result.item,
        locations: result.locations,
      });
    });
  }

  async listLocations(
    context: AccessContext,
    input: { readonly itemId: string },
  ): Promise<readonly KnowledgeLocation[]> {
    return await this.run(async () => z.array(knowledgeLocationSchema).parse(
      await this.store.listLocationsAuthorized({ context, itemId: input.itemId }),
    ));
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KnowledgeOperationError) throw error;
      if (error instanceof AdapterError && isKnowledgeErrorCode(error.code)) {
        throw new KnowledgeOperationError(error.code);
      }
      throw new KnowledgeOperationError("INVALID_OPERATION");
    }
  }
}

function operationErrorMessage(code: KnowledgeErrorCode): string {
  switch (code) {
    case "BODY_TOO_LARGE": return "Managed Markdown exceeds the P0 size limit";
    case "KNOWLEDGE_NOT_FOUND": return "Authorized knowledge was not found";
    case "KNOWLEDGE_CONFLICT": return "The knowledge identity or locator conflicts with an existing record";
    case "REVISION_CONFLICT": return "The knowledge revision changed";
    case "APPROVAL_REQUIRED": return "The exact managed knowledge preview must be approved";
    case "DELEGATION_DENIED": return "The delegated knowledge operation is not authorized";
    default: return "The knowledge operation could not be completed";
  }
}

function parseManagedContent(input: unknown): z.infer<typeof managedMarkdownInputSchema> {
  return managedMarkdownInputSchema.parse(input);
}

function hasOversizedBody(input: unknown): input is { readonly bodyMarkdown: string } {
  return typeof input === "object" && input !== null && "bodyMarkdown" in input
    && typeof input.bodyMarkdown === "string"
    && Buffer.byteLength(input.bodyMarkdown, "utf8") > 1_048_576;
}

function parseOperation<K extends KnowledgeOperation["kind"]>(
  input: unknown,
  kind: K,
): Extract<KnowledgeOperation, { kind: K }> {
  const operation = knowledgeOperationSchema.parse(input);
  if (operation.kind !== kind) throw new KnowledgeOperationError("INVALID_OPERATION");
  return operation as Extract<KnowledgeOperation, { kind: K }>;
}

export type { KnowledgeCapability };

function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(value);
}
