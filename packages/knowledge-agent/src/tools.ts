import { tool } from "@openai/agents";
import type {
  AccessContext,
  KnowledgeEvidence,
  KnowledgeSearchCandidate,
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

function isKnowledgeNotFound(error: unknown): error is KnowledgeOperationError {
  return error instanceof KnowledgeOperationError
    && error.code === "KNOWLEDGE_NOT_FOUND";
}
