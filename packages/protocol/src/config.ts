import { z } from "zod";

import type { HostConfigV1 } from "./agent.js";
import type { AuthorizedSourceV1 } from "./connector.js";
import { sha256Canonical } from "./hashing.js";

export interface AuthorizedSource {
  readonly id: string;
  readonly kind: "local-folder";
  readonly path: string;
  readonly collection: string;
  readonly mask: "**/*.md";
  readonly authorizedAt: string;
}

export interface OpenLifeWikiConfigV1 {
  readonly schema: "openlifewiki.config/v1";
  readonly sources: readonly AuthorizedSource[];
  readonly agentBindings: readonly string[];
}

export interface OpenLifeWikiConfigCompatibilityV1 {
  readonly p0Sources: readonly AuthorizedSource[];
  readonly agentBindings: readonly string[];
}

export interface OpenLifeWikiConfigV2 {
  readonly schema: "openlifewiki.config/v2";
  readonly revision: number;
  readonly sources: readonly AuthorizedSourceV1[];
  readonly hostConfig: HostConfigV1 | null;
  readonly compatibility: OpenLifeWikiConfigCompatibilityV1;
}

export type OpenLifeWikiConfig = OpenLifeWikiConfigV1 | OpenLifeWikiConfigV2;

const nonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "value cannot be blank",
});
const nonNegativeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();

const p0SourceSchema = z.strictObject({
  id: nonEmptyString,
  kind: z.literal("local-folder"),
  path: nonEmptyString,
  collection: nonEmptyString,
  mask: z.literal("**/*.md"),
  authorizedAt: nonEmptyString,
});

const sourceSensitivityRuleSchema = z.strictObject({
  match: nonEmptyString,
  level: z.enum(["normal", "sensitive"]),
});

const sourceProviderObservationSchema = z.strictObject({
  providerName: nonEmptyString,
  providerVersion: nonEmptyString,
  contractHash: nonEmptyString.nullable(),
});

const sourceOwnerApprovalSchema = z.strictObject({
  schema: z.literal("openlifewiki.source-owner-approval/v1"),
  action: z.enum(["authorize", "narrow", "reauthorize"]),
  approvedBy: z.literal("human:owner"),
  approvedAt: nonEmptyString,
  ownerIdentityFingerprint: nonEmptyString,
  previewHash: nonEmptyString,
  configHash: nonEmptyString,
  configRevision: nonNegativeInteger,
  previousAuthorizationHash: nonEmptyString.nullable(),
  approvalHash: nonEmptyString,
});

const authorizedSourceCommonShape = {
  schema: z.literal("openlifewiki.authorized-source/v1"),
  sourceId: nonEmptyString,
  rootNodeId: nonEmptyString,
  identityFingerprint: nonEmptyString,
  approval: sourceOwnerApprovalSchema,
  providerObservation: sourceProviderObservationSchema.optional(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  sensitivity: z.strictObject({
    default: z.enum(["normal", "sensitive"]),
    rules: z.array(sourceSensitivityRuleSchema),
  }),
  budget: z.strictObject({
    maxNodes: positiveInteger,
    maxBodyBytes: positiveInteger,
    maxAgentCalls: positiveInteger,
  }),
  approvedBy: z.literal("human:owner"),
  approvedAt: nonEmptyString,
  authorizationHash: nonEmptyString,
} as const;

const localFolderAuthorizedSourceSchema = z.strictObject({
  ...authorizedSourceCommonShape,
  connectorType: z.literal("local-folder"),
  scope: z.strictObject({
    schema: z.literal("openlifewiki.scope/local-folder/v1"),
    root: nonEmptyString,
    symlinkPolicy: z.enum(["deny", "within-root"]),
  }),
});

const githubAuthorizedSourceSchema = z.strictObject({
  ...authorizedSourceCommonShape,
  connectorType: z.literal("github"),
  scope: z.strictObject({
    schema: z.literal("openlifewiki.scope/github/v1"),
    hostname: nonEmptyString,
    repository: nonEmptyString,
    path: z.string().nullable(),
    ref: nonEmptyString,
  }),
});

const feishuAuthorizedSourceSchema = z.strictObject({
  ...authorizedSourceCommonShape,
  connectorType: z.literal("feishu"),
  scope: z.strictObject({
    schema: z.literal("openlifewiki.scope/feishu/v1"),
    profile: nonEmptyString,
    expectedTenantId: nonEmptyString,
    documentIds: z.array(nonEmptyString),
    wikiNodeIds: z.array(nonEmptyString),
    baseIds: z.array(nonEmptyString),
  }).superRefine((value, context) => {
    if (value.documentIds.length + value.wikiNodeIds.length + value.baseIds.length === 0) {
      context.addIssue({ code: "custom", message: "Feishu scope requires an explicit object" });
    }
  }),
});

const codexHistoryAuthorizedSourceSchema = z.strictObject({
  ...authorizedSourceCommonShape,
  connectorType: z.literal("codex-history"),
  scope: z.strictObject({
    schema: z.literal("openlifewiki.scope/codex-history/v1"),
    projectRoots: z.array(nonEmptyString),
    threadIds: z.array(nonEmptyString),
  }).superRefine((value, context) => {
    if (value.projectRoots.length + value.threadIds.length === 0) {
      context.addIssue({ code: "custom", message: "Codex History scope requires an explicit root or thread" });
    }
  }),
});

const authorizedSourceSchema = z.discriminatedUnion("connectorType", [
  localFolderAuthorizedSourceSchema,
  githubAuthorizedSourceSchema,
  feishuAuthorizedSourceSchema,
  codexHistoryAuthorizedSourceSchema,
]);

const nativeAgentSchema = z.strictObject({
  id: nonEmptyString,
  runtime: z.enum(["codex", "claude", "gemini"]),
  mode: z.literal("native-cli"),
});

const credentialRefSchema = nonEmptyString.superRefine((value, context) => {
  let reference: URL;
  try {
    reference = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "credentialRef must be a valid URL" });
    return;
  }
  if (!["env:", "keychain:", "host:", "file:"].includes(reference.protocol)) {
    context.addIssue({ code: "custom", message: "credentialRef uses an unsafe scheme" });
  }
  if (reference.username || reference.password || reference.search || reference.hash) {
    context.addIssue({ code: "custom", message: "credentialRef cannot contain secrets" });
  }
  if (!reference.hostname && ["", "/"].includes(reference.pathname)) {
    context.addIssue({ code: "custom", message: "credentialRef must identify a reference" });
  }
});

const baseUrlSchema = nonEmptyString.superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "baseUrl must be a valid URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "baseUrl must use HTTP or HTTPS" });
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "baseUrl cannot contain userinfo, query or fragment" });
  }
});

const providerAgentSchema = z.strictObject({
  id: nonEmptyString,
  runtime: z.enum(["pi", "openclaw", "hermes"]),
  mode: z.literal("provider-runtime"),
  provider: z.strictObject({
    baseUrl: baseUrlSchema.optional(),
    credentialRef: credentialRefSchema,
    model: nonEmptyString,
  }),
});

const hostConfigSchema = z.strictObject({
  schema: z.literal("openlifewiki.host-config/v1"),
  selectedAgentId: nonEmptyString,
  agents: z.array(z.discriminatedUnion("mode", [nativeAgentSchema, providerAgentSchema])),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.agents.forEach((agent, index) => {
    if (ids.has(agent.id)) {
      context.addIssue({ code: "custom", path: ["agents", index, "id"], message: "duplicate Agent id" });
    }
    ids.add(agent.id);
  });
  if (!ids.has(value.selectedAgentId)) {
    context.addIssue({ code: "custom", path: ["selectedAgentId"], message: "selected Agent is missing" });
  }
});

const compatibilitySchema = z.strictObject({
  p0Sources: z.array(p0SourceSchema),
  agentBindings: z.array(z.string()),
});

export const openLifeWikiConfigV1Schema = z.strictObject({
  schema: z.literal("openlifewiki.config/v1"),
  sources: z.array(p0SourceSchema),
  agentBindings: z.array(z.string()),
});

export const openLifeWikiConfigV2Schema = z.strictObject({
  schema: z.literal("openlifewiki.config/v2"),
  revision: nonNegativeInteger,
  sources: z.array(authorizedSourceSchema),
  hostConfig: hostConfigSchema.nullable(),
  compatibility: compatibilitySchema,
}).superRefine((value, context) => {
  const sourceIds = new Set<string>();
  const connectorTypes = new Set<string>();
  value.sources.forEach((source, index) => {
    if (sourceIds.has(source.sourceId)) {
      context.addIssue({ code: "custom", path: ["sources", index, "sourceId"], message: "duplicate Source id" });
    }
    sourceIds.add(source.sourceId);
    if (connectorTypes.has(source.connectorType)) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "connectorType"],
        message: "duplicate Connector authorization",
      });
    }
    connectorTypes.add(source.connectorType);
    const { approvalHash, ...approvalUnsigned } = source.approval;
    if (sha256Canonical(approvalUnsigned) !== approvalHash) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "approval", "approvalHash"],
        message: "Owner approval hash does not match the exact approval receipt",
      });
    }
    const { authorizationHash, ...unsigned } = source;
    if (sha256Canonical(unsigned) !== authorizationHash) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "authorizationHash"],
        message: "authorization hash does not match the exact Source record",
      });
    }
  });
});

export function parseOpenLifeWikiConfigV1(value: unknown): OpenLifeWikiConfigV1 {
  return openLifeWikiConfigV1Schema.parse(value) as OpenLifeWikiConfigV1;
}

export function parseOpenLifeWikiConfigV2(value: unknown): OpenLifeWikiConfigV2 {
  return openLifeWikiConfigV2Schema.parse(value) as OpenLifeWikiConfigV2;
}
