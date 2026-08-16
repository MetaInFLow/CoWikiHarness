import { tool } from "@openai/agents";
import { z } from "zod";

import type { KnowledgeAgentContext } from "./context.js";
import type { KnowledgeOperations } from "./operations.js";

const searchParameters = z.strictObject({
  query: z.string().min(1).max(8_000),
  limit: z.int().min(1).max(50),
});

const getParameters = z.strictObject({
  itemId: z.string().min(1).max(256),
  locationId: z.string().min(1).max(256),
  versionId: z.string().min(1).max(256).nullable(),
});

export function createKnowledgeReadTools(operations: KnowledgeOperations) {
  const knowledgeSearchTool = tool<typeof searchParameters, KnowledgeAgentContext>({
    name: "knowledge_search",
    description: "Search only knowledge authorized for the represented user. Returns candidate metadata, never hidden rows.",
    parameters: searchParameters,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      return await operations.query(runContext.context.access, input);
    },
  });

  const knowledgeGetTool = tool<typeof getParameters, KnowledgeAgentContext>({
    name: "knowledge_get",
    description: "Retrieve one exact authorized item location and version for grounded citation.",
    parameters: getParameters,
    async execute(input, runContext) {
      if (runContext === undefined) throw new Error("Knowledge Agent context is required");
      const evidence = await operations.get(runContext.context.access, input);
      runContext.context.retrievedCitations.push(evidence.citation);
      return evidence;
    },
  });

  return [knowledgeSearchTool, knowledgeGetTool] as const;
}
