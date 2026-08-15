import type {
  AccessContext,
  Delegation,
  KnowledgeCapability,
  McpPrincipal,
  McpToolName,
  ResourceGrant,
} from "@openlifewiki/protocol";

const VISITOR_TOOLS = ["query"] as const satisfies readonly McpToolName[];

const ADMIN_TOOLS = [
  "query",
  "status",
  "connectors.list",
  "connectors.authorize",
  "scan.preview",
  "scan.status",
  "scan.progress",
  "scan.start",
  "scan.pause",
  "scan.resume",
  "scan.cancel",
  "scan.retry",
  "wiki-proposal.create",
  "wiki-proposal.show",
  "wiki-proposal.approve",
  "wiki-proposal.reject",
  "wiki-proposal.publish",
] as const satisfies readonly McpToolName[];

export function listMcpTools(principal: McpPrincipal): readonly McpToolName[] {
  return principal.role === "visitor" ? VISITOR_TOOLS : ADMIN_TOOLS;
}

export interface KnowledgeResource {
  readonly orgId: string;
  readonly itemId: string | null;
  readonly sourceId: string | null;
  readonly tags: readonly string[];
}

export type KnowledgeAccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: "DELEGATION_DENIED" };

export function authorizeKnowledgeOperation(input: {
  readonly context: AccessContext;
  readonly capability: KnowledgeCapability;
  readonly resource: KnowledgeResource;
  readonly userGrants: readonly ResourceGrant[];
  readonly agentCapabilities: readonly KnowledgeCapability[];
  readonly delegation: Delegation | null;
  readonly now: Date;
}): KnowledgeAccessDecision {
  if (input.context.orgId !== input.resource.orgId) {
    return { allowed: false, code: "DELEGATION_DENIED" };
  }
  if (input.context.actorAgentId !== null) {
    const delegation = input.delegation;
    if (delegation === null
      || delegation.delegationId !== input.context.delegationId
      || delegation.agentPrincipalId !== input.context.actorAgentId
      || delegation.userPrincipalId !== input.context.onBehalfOfUserId
      || delegation.orgId !== input.context.orgId
      || delegation.revokedAt !== null
      || Date.parse(delegation.expiresAt) <= input.now.getTime()
      || !delegation.capabilities.includes(input.capability)
      || !input.agentCapabilities.includes(input.capability)
      || !delegation.resourceScopes.some((scope) => scopeMatches(scope, input.resource))) {
      return { allowed: false, code: "DELEGATION_DENIED" };
    }
  }
  const userAllowed = input.userGrants.some((grant) => (
    grant.orgId === input.context.orgId
    && grant.principalId === input.context.onBehalfOfUserId
    && grant.revokedAt === null
    && (grant.expiresAt === null || Date.parse(grant.expiresAt) > input.now.getTime())
    && grant.capabilities.includes(input.capability)
    && scopeMatches(grant.scope, input.resource)
  ));
  return userAllowed
    ? { allowed: true }
    : { allowed: false, code: "DELEGATION_DENIED" };
}

function scopeMatches(
  scope: ResourceGrant["scope"] | Delegation["resourceScopes"][number],
  resource: KnowledgeResource,
): boolean {
  if (scope.kind === "organization") return scope.id === resource.orgId;
  if (scope.kind === "item") return scope.id === resource.itemId;
  if (scope.kind === "source") return scope.id === resource.sourceId;
  return resource.tags.includes(scope.id);
}
