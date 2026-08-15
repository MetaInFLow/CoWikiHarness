import {
  AdapterError,
  PostgresKnowledgeStore,
  type ManagedKnowledgeResult,
  type RegisterLocationsResult,
} from "@openlifewiki/adapters";
import {
  KNOWLEDGE_ERROR_CODES,
  managedMarkdownInputSchema,
  type AccessContext,
  type KnowledgeCapability,
  type KnowledgeErrorCode,
  type KnowledgeEvidence,
  type KnowledgeOperation,
  type KnowledgeSearchCandidate,
} from "@openlifewiki/protocol";

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
  ): Promise<RegisterLocationsResult> {
    return await this.run(() => this.store.registerLocations({
      context,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      title: input.title,
      aliases: input.aliases,
      tags: input.tags,
      locations: input.locations,
    }));
  }

  async storeManaged(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.store" }>,
  ): Promise<ManagedKnowledgeResult> {
    return await this.run(async () => {
      const content = managedMarkdownInputSchema.parse(input.content);
      const bytes = Buffer.byteLength(content.bodyMarkdown, "utf8");
      if (bytes > 1_048_576) throw new KnowledgeOperationError("BODY_TOO_LARGE");
      return await this.store.createManagedKnowledge({ context, content });
    });
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
    case "DELEGATION_DENIED": return "The delegated knowledge operation is not authorized";
    default: return "The knowledge operation could not be completed";
  }
}

export type { KnowledgeCapability };

function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(value);
}
