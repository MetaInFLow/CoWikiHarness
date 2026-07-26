import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_RUNTIMES,
  CONNECTOR_STATUSES,
  CONNECTOR_TYPES,
  MCP_ROLES,
  type AgentHostConfig,
  type AuthorizedSourceV1,
  type McpPrincipal,
  type ScanCheckpoint,
  type ScanDecision,
  type ScanPlan,
  type ScanProgress,
  type SkeletonNode,
  type SkeletonPage,
  type WikiApproval,
  type WikiProposal,
} from "../src/index.js";

describe("V1 protocol contracts", () => {
  it("freezes the supported connector and status values", () => {
    expect(CONNECTOR_TYPES).toEqual(["local-folder", "github", "feishu", "codex-history"]);
    expect(CONNECTOR_STATUSES).toEqual(["connected", "auth-required", "missing", "blocked"]);
  });

  it("freezes six agent runtimes and the two MCP roles", () => {
    expect(AGENT_RUNTIMES).toEqual(["codex", "claude", "gemini", "pi", "openclaw", "hermes"]);
    expect(MCP_ROLES).toEqual(["visitor", "admin"]);
  });

  it("exposes the complete modular V1 contract surface", () => {
    expectTypeOf<AgentHostConfig>().toBeObject();
    expectTypeOf<AuthorizedSourceV1>().toBeObject();
    expectTypeOf<McpPrincipal>().toBeObject();
    expectTypeOf<ScanCheckpoint>().toBeObject();
    expectTypeOf<ScanDecision>().toBeObject();
    expectTypeOf<ScanPlan>().toBeObject();
    expectTypeOf<ScanProgress>().toBeObject();
    expectTypeOf<SkeletonNode>().toBeObject();
    expectTypeOf<SkeletonPage>().toBeObject();
    expectTypeOf<WikiApproval>().toBeObject();
    expectTypeOf<WikiProposal>().toBeObject();
  });
});
