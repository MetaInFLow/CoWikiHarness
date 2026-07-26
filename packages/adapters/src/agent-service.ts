import type { AgentDriver, AgentScanInvocation, AgentScanRequest } from "./agents/agent-driver.js";

/** Shared application boundary for selected Agent invocations. */
export class AgentService {
  constructor(private readonly driver: AgentDriver) {}

  decideScan(request: AgentScanRequest): Promise<AgentScanInvocation> {
    return this.driver.decideScan(request);
  }
}
