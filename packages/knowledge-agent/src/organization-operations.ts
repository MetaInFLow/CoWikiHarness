import { AdapterError } from "@openlifewiki/adapters";
import type { KnowledgeHierarchyWritePort } from "@openlifewiki/core";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeCollectionResultSchema,
  knowledgeOperationSchema,
  knowledgePlacementResultSchema,
  type AccessContext,
  type KnowledgeErrorCode,
  type KnowledgeCollectionResult,
  type KnowledgeOperation,
  type KnowledgePlacementResult,
} from "@openlifewiki/protocol";

import { KnowledgeOperationError } from "./operations.js";

export class KnowledgeOrganizationOperations {
  constructor(private readonly port: KnowledgeHierarchyWritePort) {}

  async createCollection(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.collection.create" }>,
  ): Promise<KnowledgeCollectionResult> {
    return await this.run(async () => {
      const operation = knowledgeOperationSchema.parse(input);
      if (operation.kind !== "knowledge.collection.create") {
        throw new KnowledgeOperationError("INVALID_OPERATION");
      }
      const collection = await this.port.createCollection({
        context,
        expectedRegistryRevision: operation.expectedRegistryRevision,
        parentCollectionId: operation.parentCollectionId,
        name: operation.name,
        description: operation.description,
        now: new Date(),
      });
      return knowledgeCollectionResultSchema.parse({
        schema: "cowikiharness.collection-result/v1",
        taskId: context.taskId,
        collection,
      });
    });
  }

  async moveCollection(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.collection.move" }>,
  ): Promise<KnowledgeCollectionResult> {
    return await this.run(async () => {
      const operation = knowledgeOperationSchema.parse(input);
      if (operation.kind !== "knowledge.collection.move") {
        throw new KnowledgeOperationError("INVALID_OPERATION");
      }
      const collection = await this.port.moveCollection({
        context,
        collectionId: operation.collectionId,
        expectedRevision: operation.expectedRevision,
        parentCollectionId: operation.parentCollectionId,
        name: operation.name,
        description: operation.description,
        now: new Date(),
      });
      return knowledgeCollectionResultSchema.parse({
        schema: "cowikiharness.collection-result/v1",
        taskId: context.taskId,
        collection,
      });
    });
  }

  async placeKnowledge(
    context: AccessContext,
    input: Extract<KnowledgeOperation, { kind: "knowledge.place" }>,
  ): Promise<KnowledgePlacementResult> {
    return await this.run(async () => {
      const operation = knowledgeOperationSchema.parse(input);
      if (operation.kind !== "knowledge.place") {
        throw new KnowledgeOperationError("INVALID_OPERATION");
      }
      const placement = await this.port.placeKnowledge({
        context,
        itemId: operation.itemId,
        collectionId: operation.collectionId,
        expectedPlacementRevision: operation.expectedPlacementRevision,
        now: new Date(),
      });
      return knowledgePlacementResultSchema.parse({
        schema: "cowikiharness.placement-result/v1",
        taskId: context.taskId,
        placement,
      });
    });
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AdapterError && isKnowledgeErrorCode(error.code)) {
        throw new KnowledgeOperationError(error.code);
      }
      throw new KnowledgeOperationError("INVALID_OPERATION");
    }
  }
}

function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(value);
}
