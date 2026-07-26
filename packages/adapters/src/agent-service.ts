import type { AgentDriver, AgentScanDecision, AgentScanRequest } from "./agents/agent-driver.js";

/** Shared application boundary for selected Agent invocations. */
export class AgentService {
  constructor(private readonly driver: AgentDriver) {}

  decideScan(request: AgentScanRequest): Promise<AgentScanDecision> {
    return this.driver.decideScan(request);
  }
}
