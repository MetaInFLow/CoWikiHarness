import { describe, expect, it } from "vitest";

import type {
  AccessContext,
  Delegation,
  KnowledgeCapability,
  ResourceGrant,
} from "@openlifewiki/protocol";

import { authorizeKnowledgeOperation } from "../src/index.js";

const now = new Date("2026-08-15T00:00:00.000Z");

describe("V2 knowledge authorization", () => {
  it("allows an Owner organization grant to register knowledge", () => {
    expect(authorizeKnowledgeOperation({
      context: humanContext("principal_owner"),
      capability: "knowledge.register",
      resource: { orgId: "org_default", itemId: null, sourceId: null, tags: [] },
      userGrants: [organizationGrant("principal_owner", "knowledge.register")],
      agentCapabilities: [],
      delegation: null,
      now,
    })).toEqual({ allowed: true });
  });

  it("keeps an Owner-only item private from another user", () => {
    expect(authorizeKnowledgeOperation({
      context: humanContext("principal_user_2"),
      capability: "knowledge.query",
      resource: { orgId: "org_default", itemId: "item_private", sourceId: null, tags: [] },
      userGrants: [itemGrant("principal_user_1", "item_private", "knowledge.query")],
      agentCapabilities: [],
      delegation: null,
      now,
    })).toEqual({ allowed: false, code: "DELEGATION_DENIED" });
  });

  it("requires the Agent capability as well as the human grant", () => {
    const delegation = activeDelegation(["knowledge.query"]);
    expect(authorizeKnowledgeOperation({
      context: agentContext(),
      capability: "knowledge.query",
      resource: { orgId: "org_default", itemId: "item_shared", sourceId: null, tags: [] },
      userGrants: [itemGrant("principal_user_1", "item_shared", "knowledge.query")],
      agentCapabilities: [],
      delegation,
      now,
    })).toEqual({ allowed: false, code: "DELEGATION_DENIED" });
  });

  it("rejects an expired delegation", () => {
    const delegation = { ...activeDelegation(["knowledge.query"]), expiresAt: "2026-08-14T00:00:00.000Z" };
    expect(authorizeKnowledgeOperation({
      context: agentContext(),
      capability: "knowledge.query",
      resource: { orgId: "org_default", itemId: "item_shared", sourceId: null, tags: [] },
      userGrants: [itemGrant("principal_user_1", "item_shared", "knowledge.query")],
      agentCapabilities: ["knowledge.query"],
      delegation,
      now,
    })).toEqual({ allowed: false, code: "DELEGATION_DENIED" });
  });

  it("allows an explicit item grant to query", () => {
    expect(authorizeKnowledgeOperation({
      context: humanContext("principal_user_1"),
      capability: "knowledge.query",
      resource: { orgId: "org_default", itemId: "item_shared", sourceId: null, tags: [] },
      userGrants: [itemGrant("principal_user_1", "item_shared", "knowledge.query")],
      agentCapabilities: [],
      delegation: null,
      now,
    })).toEqual({ allowed: true });
  });

  it("uses a tag grant only when the item carries that tag", () => {
    const input = {
      context: humanContext("principal_user_1"),
      capability: "knowledge.query" as const,
      resource: { orgId: "org_default", itemId: "item_tagged", sourceId: null, tags: [] as string[] },
      userGrants: [tagGrant("principal_user_1", "tag_shared", "knowledge.query")],
      agentCapabilities: [],
      delegation: null,
      now,
    };
    expect(authorizeKnowledgeOperation(input)).toEqual({ allowed: false, code: "DELEGATION_DENIED" });
    expect(authorizeKnowledgeOperation({
      ...input,
      resource: { ...input.resource, tags: ["tag_shared"] },
    })).toEqual({ allowed: true });
  });
});

function humanContext(userPrincipalId: string): AccessContext {
  return {
    schema: "openlifewiki.access-context/v1",
    orgId: "org_default",
    actorPrincipalId: userPrincipalId,
    actorAgentId: null,
    onBehalfOfUserId: userPrincipalId,
    delegationId: null,
    taskId: "task_abc",
  };
}

function agentContext(): AccessContext {
  return {
    schema: "openlifewiki.access-context/v1",
    orgId: "org_default",
    actorPrincipalId: "principal_agent_1",
    actorAgentId: "principal_agent_1",
    onBehalfOfUserId: "principal_user_1",
    delegationId: "delegation_1",
    taskId: "task_abc",
  };
}

function activeDelegation(capabilities: readonly KnowledgeCapability[]): Delegation {
  return {
    schema: "openlifewiki.delegation/v1",
    delegationId: "delegation_1",
    orgId: "org_default",
    agentPrincipalId: "principal_agent_1",
    userPrincipalId: "principal_user_1",
    capabilities: [...capabilities],
    resourceScopes: [{ kind: "organization", id: "org_default" }],
    expiresAt: "2026-08-16T00:00:00.000Z",
    revokedAt: null,
  };
}

function organizationGrant(principalId: string, capability: KnowledgeCapability): ResourceGrant {
  return grant(principalId, { kind: "organization", id: "org_default" }, capability);
}

function itemGrant(principalId: string, itemId: string, capability: KnowledgeCapability): ResourceGrant {
  return grant(principalId, { kind: "item", id: itemId }, capability);
}

function tagGrant(principalId: string, tagId: string, capability: KnowledgeCapability): ResourceGrant {
  return grant(principalId, { kind: "tag", id: tagId }, capability);
}

function grant(
  principalId: string,
  scope: ResourceGrant["scope"],
  capability: KnowledgeCapability,
): ResourceGrant {
  return {
    schema: "openlifewiki.resource-grant/v1",
    grantId: `grant_${principalId}`,
    orgId: "org_default",
    principalId,
    scope,
    capabilities: [capability],
    expiresAt: null,
    revokedAt: null,
  };
}
