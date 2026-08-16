import type {
  AccessContext,
  KnowledgeCitation,
  KnowledgeOperation,
} from "@openlifewiki/protocol";

export interface AgentMessageOperation {
  readonly schema: "openlifewiki.agent-message/v1";
  readonly text: string;
}

export interface KnowledgeAgentContext {
  readonly access: AccessContext;
  readonly operation: KnowledgeOperation | AgentMessageOperation;
  readonly taskId: string;
  readonly retrievedCitations: KnowledgeCitation[];
}
