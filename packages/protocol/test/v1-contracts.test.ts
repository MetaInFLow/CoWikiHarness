import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_RUNTIMES,
  CONNECTOR_STATUSES,
  CONNECTOR_TYPES,
  MCP_ROLES,
  type AgentHostConfig,
  type AuthorizedSourceV1,
  type ConnectorDescriptor,
  type LeafSelectionReceipt,
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

const notionPlaceholder = {
  schema: "openlifewiki.connector-descriptor/v1",
  connectorType: "notion",
  displayName: "Notion",
  classification: ["source", "notion"],
  supportStatus: "placeholder",
  provider: {
    project: "notion/notion",
    publicSurface: "public-api",
    executable: null,
    versionCommand: [],
  },
  capabilities: {
    hierarchy: true,
    pagination: "cursor",
    modifiedVersion: "provider-version",
    representativeMetadata: true,
    leafBodies: true,
    nodeKinds: ["page"],
  },
  scopeSchema: "openlifewiki.scope/notion/v1",
} as const satisfies ConnectorDescriptor;

describe("V1 protocol contracts", () => {
  it("freezes the supported connector and status values", () => {
    expect(CONNECTOR_TYPES).toEqual(["local-folder", "github", "feishu", "codex-history"]);
    expect(CONNECTOR_STATUSES).toEqual(["connected", "auth-required", "missing", "blocked"]);
  });

  it("allows future connector descriptors to remain explicit placeholders", () => {
    expect(notionPlaceholder.connectorType).toBe("notion");
    expect(notionPlaceholder.supportStatus).toBe("placeholder");
  });

  it("freezes six agent runtimes and the two MCP roles", () => {
    expect(AGENT_RUNTIMES).toEqual(["codex", "claude", "gemini", "pi", "openclaw", "hermes"]);
    expect(MCP_ROLES).toEqual(["visitor", "admin"]);
  });

  it("exposes the complete modular V1 contract surface", () => {
    expectTypeOf<AgentHostConfig>().toBeObject();
    expectTypeOf<AuthorizedSourceV1>().toBeObject();
    expectTypeOf<LeafSelectionReceipt>().toBeObject();
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
