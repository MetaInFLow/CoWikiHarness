import {
  OpenAIProvider,
  type Agent,
  type Model,
  type ModelProvider,
  type ModelSettings,
} from "@openai/agents";
import {
  createKnowledgeAgent,
  type KnowledgeAgentContext,
  type KnowledgeReadOperations,
  type KnowledgeToolOperations,
} from "@openlifewiki/knowledge-agent";

import type { ServerConfig } from "./config.js";

export interface KnowledgeModelRuntime {
  readonly model: Model;
  readonly modelSettings: ModelSettings;
  close(): Promise<void>;
}

export async function createKnowledgeModelRuntime(
  config: ServerConfig,
  providerFactory: (options: {
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly useResponses: true;
  }) => ModelProvider & { close?: () => Promise<void> } = (options) => new OpenAIProvider(options),
): Promise<KnowledgeModelRuntime> {
  const provider = providerFactory({
    apiKey: config.openAIApiKey,
    ...(config.openAIBaseUrl === undefined ? {} : { baseURL: config.openAIBaseUrl }),
    useResponses: true,
  });
  const model = await provider.getModel(config.model);
  const modelSettings: ModelSettings = {
    reasoning: { effort: config.modelReasoningEffort },
    store: false,
  };
  return {
    model,
    modelSettings,
    async close() { await provider.close?.(); },
  };
}

export function createConfiguredKnowledgeAgent(input: {
  readonly runtime: KnowledgeModelRuntime;
  readonly operations: KnowledgeToolOperations;
}): Agent<KnowledgeAgentContext, any> {
  const readOperations: KnowledgeReadOperations = {
    query: async (context, operation) => await input.operations.query(context, operation),
    get: async (context, operation) => await input.operations.get(context, operation),
  };
  return createKnowledgeAgent({
    model: input.runtime.model,
    modelSettings: input.runtime.modelSettings,
    operations: readOperations,
  });
}
