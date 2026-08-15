import { describe, expect, it } from "vitest";

import {
  accessContextSchema,
  delegationSchema,
  knowledgeCitationSchema,
  knowledgeItemSchema,
  knowledgeLocationInputSchema,
  knowledgeLocationSchema,
  knowledgeQueryResultSchema,
  knowledgeVersionSchema,
  managedMarkdownInputSchema,
  type AccessContext,
} from "../src/index.js";

const access = {
  schema: "openlifewiki.access-context/v1",
  orgId: "org_default",
  actorPrincipalId: "principal_agent_123",
  actorAgentId: "principal_agent_123",
  onBehalfOfUserId: "principal_user_456",
  delegationId: "delegation_789",
  taskId: "task_abc",
} as const satisfies AccessContext;

const item = {
  schema: "openlifewiki.knowledge-item/v1",
  itemId: "item_1",
  orgId: "org_default",
  ownerPrincipalId: "principal_user_1",
  title: "Agent harness decision",
  aliases: ["Harness ADR"],
  status: "stable",
  currentVersionId: "version_1",
  revision: 1,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
} as const;

describe("V2 identity contracts", () => {
  it("accepts an exact delegated access context", () => {
    expect(accessContextSchema.parse(access)).toEqual(access);
  });

  it("rejects unknown authority material", () => {
    expect(() => accessContextSchema.parse({ ...access, admin: true })).toThrow();
  });

  it("requires an agent delegation", () => {
    expect(() => accessContextSchema.parse({ ...access, delegationId: null })).toThrow();
  });

  it("rejects undeclared capabilities", () => {
    expect(() => delegationSchema.parse({
      schema: "openlifewiki.delegation/v1",
      delegationId: "delegation_789",
      orgId: "org_default",
      agentPrincipalId: "principal_agent_123",
      userPrincipalId: "principal_user_456",
      capabilities: ["database.sql"],
      resourceScopes: [{ kind: "organization", id: "org_default" }],
      expiresAt: "2026-08-16T00:00:00.000Z",
      revokedAt: null,
    })).toThrow();
  });
});

describe("V2 knowledge contracts", () => {
  it("accepts one item with two locations and one managed version", () => {
    expect(knowledgeItemSchema.parse(item)).toEqual(item);
    expect(knowledgeLocationSchema.parse({
      schema: "openlifewiki.knowledge-location/v1",
      locationId: "location_managed",
      itemId: "item_1",
      kind: "managed-markdown",
      role: "canonical",
      locator: "openlifewiki-managed://item_1",
      connectorInstanceId: null,
      ownerPrincipalId: "principal_user_1",
      metadata: {},
      observedProviderVersion: null,
      availability: "available",
      revision: 1,
      lastVerifiedAt: "2026-08-15T00:00:00.000Z",
    })).toMatchObject({ locationId: "location_managed" });
    expect(knowledgeLocationSchema.parse({
      schema: "openlifewiki.knowledge-location/v1",
      locationId: "location_github",
      itemId: "item_1",
      kind: "github",
      role: "original",
      locator: "https://github.com/org/repo/blob/main/ADR.md",
      connectorInstanceId: "connector_github",
      ownerPrincipalId: "principal_user_1",
      metadata: {},
      observedProviderVersion: "gh-2.50.0",
      availability: "available",
      revision: 1,
      lastVerifiedAt: null,
    })).toMatchObject({ locationId: "location_github" });
    expect(knowledgeVersionSchema.parse({
      schema: "openlifewiki.knowledge-version/v1",
      versionId: "version_1",
      itemId: "item_1",
      locationId: "location_managed",
      ordinal: 1,
      bodyHash: `sha256:${"a".repeat(64)}`,
      bodyMarkdown: "# Decision",
      providerVersion: null,
      provenance: { source: "owner" },
      createdByPrincipalId: "principal_user_1",
      createdAt: "2026-08-15T00:00:00.000Z",
    })).toMatchObject({ versionId: "version_1" });
  });

  it("rejects credentials in external locators", () => {
    expect(() => knowledgeLocationInputSchema.parse({
      kind: "github",
      role: "original",
      locator: "https://token@example.com/org/repo/blob/main/ADR.md",
      connectorInstanceId: "connector_github",
      ownerPrincipalId: "principal_user_1",
      metadata: {},
    })).toThrow();
  });

  it("enforces the 1 MiB managed Markdown boundary", () => {
    expect(() => managedMarkdownInputSchema.parse({
      title: "Too large",
      bodyMarkdown: "x".repeat(1_048_577),
    })).toThrow();
    expect(managedMarkdownInputSchema.parse({
      title: "Within limit",
      bodyMarkdown: "x".repeat(1_048_576),
    }).bodyMarkdown).toHaveLength(1_048_576);
  });

  it("returns a cited query result with exact item, location and version IDs", () => {
    const citation = {
      citationId: "citation_1",
      itemId: "item_1",
      locationId: "location_managed",
      versionId: "version_1",
      locator: "openlifewiki-managed://item_1",
      title: "Agent harness decision",
      bodyHash: `sha256:${"a".repeat(64)}`,
    };
    expect(knowledgeCitationSchema.parse(citation)).toEqual(citation);
    expect(knowledgeQueryResultSchema.parse({
      schema: "openlifewiki.knowledge-query-result/v1",
      taskId: "task_abc",
      evidenceMode: "grounded",
      answer: "The answer is grounded.",
      citations: [citation],
      gaps: [],
    })).toMatchObject({ citations: [citation] });
  });
});
