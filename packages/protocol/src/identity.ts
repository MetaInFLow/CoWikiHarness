import { z } from "zod";

export const PRINCIPAL_TYPES = ["user", "agent", "relay"] as const;
export const ORGANIZATION_ROLES = ["owner", "member"] as const;
export const KNOWLEDGE_CAPABILITIES = [
  "knowledge.query",
  "knowledge.register",
  "knowledge.store",
  "knowledge.organize",
  "knowledge.share",
  "principal.manage",
  "relay.serve",
] as const;
export const RESOURCE_SCOPE_KINDS = ["organization", "item", "source", "tag"] as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const timestamp = z.iso.datetime({ offset: true });

export const resourceScopeSchema = z.strictObject({
  kind: z.enum(RESOURCE_SCOPE_KINDS),
  id,
});

export const principalSchema = z.strictObject({
  schema: z.literal("openlifewiki.principal/v1"),
  principalId: id,
  orgId: id,
  type: z.enum(PRINCIPAL_TYPES),
  displayName: z.string().min(1).max(200),
  organizationRole: z.enum(ORGANIZATION_ROLES).nullable(),
  capabilities: z.array(z.enum(KNOWLEDGE_CAPABILITIES)),
  status: z.enum(["active", "revoked"]),
});

export const delegationSchema = z.strictObject({
  schema: z.literal("openlifewiki.delegation/v1"),
  delegationId: id,
  orgId: id,
  agentPrincipalId: id,
  userPrincipalId: id,
  capabilities: z.array(z.enum(KNOWLEDGE_CAPABILITIES)).min(1),
  resourceScopes: z.array(resourceScopeSchema).min(1),
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
});

export const resourceGrantSchema = z.strictObject({
  schema: z.literal("openlifewiki.resource-grant/v1"),
  grantId: id,
  orgId: id,
  principalId: id,
  scope: resourceScopeSchema,
  capabilities: z.array(z.enum(KNOWLEDGE_CAPABILITIES)).min(1),
  expiresAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});

export const accessContextSchema = z.strictObject({
  schema: z.literal("openlifewiki.access-context/v1"),
  orgId: id,
  actorPrincipalId: id,
  actorAgentId: id.nullable(),
  onBehalfOfUserId: id,
  delegationId: id.nullable(),
  taskId: id,
}).superRefine((value, context) => {
  const delegated = value.actorAgentId !== null;
  if (delegated !== (value.delegationId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["delegationId"],
      message: "agent authority requires one delegation",
    });
  }
  if (!delegated && value.actorPrincipalId !== value.onBehalfOfUserId) {
    context.addIssue({
      code: "custom",
      path: ["onBehalfOfUserId"],
      message: "a human actor acts only for itself",
    });
  }
});

export type Principal = z.infer<typeof principalSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export type AccessContext = z.infer<typeof accessContextSchema>;
export type KnowledgeCapability = (typeof KNOWLEDGE_CAPABILITIES)[number];
