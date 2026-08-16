import { protocol, type AgentInputItem, type Session } from "@openai/agents";
import { AdapterError, type PostgresKnowledgeStore } from "@openlifewiki/adapters";

export class PostgresAgentSession implements Session {
  constructor(
    private readonly store: PostgresKnowledgeStore,
    private readonly sessionId: string,
    private readonly orgId: string,
    private readonly ownerPrincipalId: string,
  ) {}

  async getSessionId(): Promise<string> {
    await this.store.ensureAgentSession({
      sessionId: this.sessionId,
      orgId: this.orgId,
      ownerPrincipalId: this.ownerPrincipalId,
    });
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new AdapterError("INVALID_OPERATION", "Agent session limit must be a non-negative integer");
    }
    await this.getSessionId();
    const items = await this.store.readAgentSession(this.scope());
    const selected = limit === undefined ? items : limit === 0 ? [] : items.slice(-limit);
    try {
      return selected.map((item) => protocol.ModelItem.parse(item));
    } catch {
      throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
    }
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.getSessionId();
    await this.store.appendAgentSession({ ...this.scope(), items });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    await this.getSessionId();
    const item = await this.store.popAgentSession(this.scope(), (candidate) => {
      try {
        protocol.ModelItem.parse(candidate);
      } catch {
        throw new AdapterError("INVALID_OPERATION", "Agent session history is invalid");
      }
    });
    return item as AgentInputItem | undefined;
  }

  async clearSession(): Promise<void> {
    await this.getSessionId();
    await this.store.clearAgentSession(this.scope());
  }

  private scope() {
    return {
      sessionId: this.sessionId,
      orgId: this.orgId,
      ownerPrincipalId: this.ownerPrincipalId,
    };
  }
}
