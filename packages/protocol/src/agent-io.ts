import { z } from "zod";

import { AGENT_RUNTIMES } from "./agent.js";

export const AGENT_IO_SCHEMA_IDS = [
  "openlifewiki.agent-scan-result/v1",
  "openlifewiki.agent-query-result/v1",
  "openlifewiki.agent-wiki-semantics/v1",
  "openlifewiki.agent-failure/v1",
] as const;

export type AgentIoSchemaId = (typeof AGENT_IO_SCHEMA_IDS)[number];

const identifier = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(8_192);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nullableBoundedText = boundedText.nullable();
const nonNegativeInteger = z.int().nonnegative();

export const agentIoAgentSchema = z.strictObject({
  id: identifier,
  runtime: z.enum(AGENT_RUNTIMES),
  mode: z.enum(["native-cli", "provider-runtime"]),
  driverContractVersion: identifier,
}).superRefine((value, context) => {
  const nativeRuntime = value.runtime === "codex"
    || value.runtime === "claude"
    || value.runtime === "gemini";
  const expectedMode = nativeRuntime ? "native-cli" : "provider-runtime";
  if (value.mode !== expectedMode) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: `${value.runtime} requires ${expectedMode}`,
    });
  }
});

const probeActionSchema = z.strictObject({
  action: z.literal("probe"),
});

const listRootsMetadataActionSchema = z.strictObject({
  action: z.literal("listRootsMetadata"),
  limit: z.int().positive(),
  cursor: z.string().min(1).max(2_048).nullable(),
});

const listChildrenMetadataActionSchema = z.strictObject({
  action: z.literal("listChildrenMetadata"),
  parent: identifier,
  limit: z.int().positive(),
  cursor: z.string().min(1).max(2_048).nullable(),
});

const getVersionActionSchema = z.strictObject({
  action: z.literal("getVersion"),
  node: identifier,
});

const readApprovedLeafBodyActionSchema = z.strictObject({
  action: z.literal("readApprovedLeafBody"),
  node: identifier,
  expectedVersion: identifier,
  descendReceipt: hash,
});

export const agentConnectorActionSchema = z.discriminatedUnion("action", [
  probeActionSchema,
  listRootsMetadataActionSchema,
  listChildrenMetadataActionSchema,
  getVersionActionSchema,
  readApprovedLeafBodyActionSchema,
]);

export const agentScanResultSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-scan-result/v1"),
  operationId: identifier,
  scanId: identifier,
  scanPlanHash: hash,
  skeletonVersion: hash,
  skillHash: hash,
  inputSetHash: hash,
  agent: agentIoAgentSchema,
  node: z.strictObject({
    sourceId: identifier,
    nodeId: identifier,
    nodeVersion: identifier,
    summaryHash: hash,
  }),
  decision: z.enum(["descend", "skip", "defer", "ask-user"]),
  reason: boundedText,
  coverage: z.strictObject({
    directChildrenEnumerated: nonNegativeInteger,
    pageComplete: z.boolean(),
    openCursor: z.boolean(),
    unknownChildCount: z.boolean(),
  }),
  budget: z.strictObject({
    remainingNodes: nonNegativeInteger,
    remainingBodyBytes: nonNegativeInteger,
    remainingAgentCalls: nonNegativeInteger,
    estimatedNextNodes: nonNegativeInteger.nullable(),
    estimatedNextBodyBytes: nonNegativeInteger.nullable(),
    estimatedNextAgentCalls: nonNegativeInteger.nullable(),
  }),
  sensitivity: z.strictObject({
    effective: z.enum(["normal", "sensitive"]),
    ownerApprovalRequired: z.boolean(),
  }),
  nextConnectorActions: z.array(agentConnectorActionSchema).max(2),
  revisitCondition: nullableBoundedText,
  question: nullableBoundedText,
  status: z.literal("decision-ready"),
}).superRefine((value, context) => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const actions = value.nextConnectorActions;
  const isBoundMetadataAction = actions.length === 0
    || (actions.length === 1 && (
      actions[0]?.action === "probe"
      || actions[0]?.action === "listRootsMetadata"
      || (actions[0]?.action === "listChildrenMetadata"
        && actions[0].parent === value.node.nodeId)
      || (actions[0]?.action === "getVersion" && actions[0].node === value.node.nodeId)
    ));

  if (value.decision === "skip") {
    if (value.nextConnectorActions.length !== 0) {
      issue(["nextConnectorActions"], "skip cannot request a Connector action");
    }
    if (value.question !== null) issue(["question"], "skip cannot ask a question");
    if (value.revisitCondition !== null) {
      issue(["revisitCondition"], "skip cannot set a revisit condition");
    }
    return;
  }

  if (value.decision === "defer") {
    if (value.revisitCondition === null) {
      issue(["revisitCondition"], "defer requires a concrete revisit condition");
    }
    if (value.question !== null) issue(["question"], "defer cannot ask a question");
    if (!isBoundMetadataAction) {
      issue(
        ["nextConnectorActions"],
        "defer may request at most one metadata action bound to the current node",
      );
    }
    return;
  }

  if (value.decision === "ask-user") {
    if (value.nextConnectorActions.length !== 0) {
      issue(["nextConnectorActions"], "ask-user cannot request a Connector action");
    }
    if (value.question === null) issue(["question"], "ask-user requires a bounded question");
    if (value.revisitCondition !== null) {
      issue(["revisitCondition"], "ask-user cannot set a revisit condition");
    }
    return;
  }

  if (value.question !== null) issue(["question"], "descend cannot ask a question");
  if (value.revisitCondition !== null) {
    issue(["revisitCondition"], "descend cannot set a revisit condition");
  }

  const isProbe = actions.length === 1 && actions[0]?.action === "probe";
  const isRootList = actions.length === 1 && actions[0]?.action === "listRootsMetadata";
  const isChildList = actions.length === 1
    && actions[0]?.action === "listChildrenMetadata"
    && actions[0].parent === value.node.nodeId;
  const isLeafRead = actions.length === 2
    && actions[0]?.action === "getVersion"
    && actions[1]?.action === "readApprovedLeafBody"
    && actions[0].node === value.node.nodeId
    && actions[1].node === value.node.nodeId
    && actions[1].expectedVersion === value.node.nodeVersion;

  if (!isProbe && !isRootList && !isChildList && !isLeafRead) {
    issue(
      ["nextConnectorActions"],
      "descend requires one bounded metadata action or an exact getVersion/body-read pair",
    );
  }
});

const citationSchema = z.strictObject({
  citationId: identifier,
  locator: z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i).max(4_096),
  sourceId: identifier,
  nodeId: identifier,
  nodeVersion: identifier,
});

const factClaimSchema = z.strictObject({
  claimId: identifier,
  type: z.literal("fact"),
  text: boundedText,
  material: z.boolean(),
  citationIds: z.array(identifier),
});

const inferenceClaimSchema = z.strictObject({
  claimId: identifier,
  type: z.literal("inference"),
  text: boundedText,
  citationIds: z.array(identifier),
});

const gapClaimSchema = z.strictObject({
  claimId: identifier,
  type: z.literal("gap"),
  text: boundedText,
  citationIds: z.array(identifier).max(0),
});

export const agentQueryResultSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-query-result/v1"),
  queryId: identifier,
  inputSetHash: hash,
  activeGeneration: z.strictObject({
    generationId: identifier,
    manifestHash: hash,
  }),
  agent: agentIoAgentSchema,
  evidenceMode: z.enum([
    "grounded",
    "no-evidence",
    "partial-evidence",
    "conflicting-evidence",
  ]),
  answer: z.string().max(65_536),
  claims: z.array(z.discriminatedUnion("type", [
    factClaimSchema,
    inferenceClaimSchema,
    gapClaimSchema,
  ])),
  citations: z.array(citationSchema),
  gaps: z.array(z.strictObject({
    code: identifier,
    description: boundedText,
    sourceIds: z.array(identifier),
  })),
  rawExposure: z.strictObject({
    status: z.enum(["not-requested", "denied", "included"]),
    citationIds: z.array(identifier),
  }),
  status: z.literal("answer-ready"),
}).superRefine((value, context) => {
  const citationIds = new Set<string>();
  value.citations.forEach((citation, index) => {
    if (citationIds.has(citation.citationId)) {
      context.addIssue({
        code: "custom",
        path: ["citations", index, "citationId"],
        message: "citation IDs must be unique",
      });
    }
    citationIds.add(citation.citationId);
  });

  value.claims.forEach((claim, claimIndex) => {
    if (claim.type === "fact" && claim.material && claim.citationIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["claims", claimIndex, "citationIds"],
        message: "a material factual claim requires at least one citation",
      });
    }
    claim.citationIds.forEach((citationId, citationIndex) => {
      if (!citationIds.has(citationId)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "citationIds", citationIndex],
          message: "claim citation must resolve in this result",
        });
      }
    });
  });

  value.rawExposure.citationIds.forEach((citationId, index) => {
    if (!citationIds.has(citationId)) {
      context.addIssue({
        code: "custom",
        path: ["rawExposure", "citationIds", index],
        message: "raw exposure citation must resolve in this result",
      });
    }
  });

  if (value.rawExposure.status !== "included" && value.rawExposure.citationIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["rawExposure", "citationIds"],
      message: "only included raw exposure may identify citations",
    });
  }
  if (value.evidenceMode === "no-evidence" && value.citations.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["citations"],
      message: "no-evidence cannot carry citations",
    });
  }
  if (value.evidenceMode === "grounded" && value.citations.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["citations"],
      message: "grounded requires current citations",
    });
  }
});

const wikiSourceSchema = z.strictObject({
  id: identifier,
  resource: z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i).max(4_096),
  title: boundedText,
  sourceId: identifier,
  nodeId: identifier,
  nodeVersion: identifier,
});

const wikiConceptSchema = z.strictObject({
  page_uid: identifier,
  type: identifier,
  title: boundedText,
  description: boundedText,
  path: z.string().min(1).max(2_048),
  body: z.string().max(262_144),
  sources: z.array(wikiSourceSchema),
  tags: z.array(identifier),
  aliases: z.array(boundedText),
  links: z.array(z.strictObject({
    target_page_uid: identifier,
    path: z.string().min(1).max(2_048),
    text: boundedText,
  })),
  status: z.enum(["draft", "stable", "deprecated"]),
  stale_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export const agentWikiSemanticsSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-wiki-semantics/v1"),
  proposalId: identifier,
  baseWikiHash: hash,
  evidenceManifestHash: hash,
  inputSetHash: hash,
  agent: agentIoAgentSchema,
  folders: z.array(z.strictObject({
    path: z.string().min(1).max(2_048),
    title: boundedText,
    description: boundedText,
  })),
  tags: z.array(z.strictObject({
    name: identifier,
    description: boundedText,
  })),
  aliases: z.array(z.strictObject({
    alias: boundedText,
    page_uid: identifier,
  })),
  concepts: z.array(wikiConceptSchema),
  moves: z.array(z.strictObject({
    page_uid: identifier,
    from: z.string().min(1).max(2_048),
    to: z.string().min(1).max(2_048),
    reason: boundedText,
  })),
  knownGaps: z.array(z.strictObject({
    code: identifier,
    description: boundedText,
    sourceIds: z.array(identifier),
  })),
  status: z.literal("proposal-ready"),
}).superRefine((value, context) => {
  const conceptIds = new Set<string>();
  const conceptPaths = new Set<string>();
  value.concepts.forEach((concept, index) => {
    if (conceptIds.has(concept.page_uid)) {
      context.addIssue({
        code: "custom",
        path: ["concepts", index, "page_uid"],
        message: "Concept page_uid values must be unique",
      });
    }
    if (conceptPaths.has(concept.path)) {
      context.addIssue({
        code: "custom",
        path: ["concepts", index, "path"],
        message: "Concept paths must be unique",
      });
    }
    conceptIds.add(concept.page_uid);
    conceptPaths.add(concept.path);
  });

  value.aliases.forEach((alias, index) => {
    if (!conceptIds.has(alias.page_uid)) {
      context.addIssue({
        code: "custom",
        path: ["aliases", index, "page_uid"],
        message: "taxonomy alias must resolve to a proposed Concept",
      });
    }
  });
  value.moves.forEach((move, index) => {
    if (!conceptIds.has(move.page_uid)) {
      context.addIssue({
        code: "custom",
        path: ["moves", index, "page_uid"],
        message: "move must resolve to a proposed Concept",
      });
    }
  });
});

export const AGENT_FAILURE_CODES = [
  "NOT_INSTALLED",
  "UNSUPPORTED_VERSION",
  "CONTRACT_UNSUPPORTED",
  "AUTH_REQUIRED",
  "HOST_CONFIG_INVALID",
  "SPAWN_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "PROVIDER_ERROR",
  "TOOL_ERROR",
  "OUTPUT_INVALID",
  "EXIT_NONZERO",
  "AMBIGUOUS_REMOTE_STATE",
  "REFUSAL",
  "AGENT_MISSING",
  "AGENT_AUTH_REQUIRED",
  "AGENT_PROVIDER_FAILED",
  "AGENT_OUTPUT_INVALID",
] as const;

const safeFailureMessage = z.string().min(1).max(2_048).superRefine((message, context) => {
  if (/\b(?:token|secret|password|api[_ -]?key|bearer|credential)\b\s*[:=]/i.test(message)) {
    context.addIssue({ code: "custom", message: "failure message contains credential-like data" });
  }
});

export const agentFailureSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-failure/v1"),
  operationId: identifier,
  inputSetHash: hash,
  agent: agentIoAgentSchema,
  code: z.enum(AGENT_FAILURE_CODES),
  phase: z.enum([
    "probe-runtime",
    "validate-host-config",
    "spawn",
    "invoke",
    "tool-call",
    "validate-output",
    "normalize-output",
    "cancel",
  ]),
  message: safeFailureMessage,
  retryable: z.boolean(),
  ambiguousRemoteState: z.boolean(),
  status: z.literal("failed"),
}).superRefine((value, context) => {
  if (value.code === "AMBIGUOUS_REMOTE_STATE" && !value.ambiguousRemoteState) {
    context.addIssue({
      code: "custom",
      path: ["ambiguousRemoteState"],
      message: "AMBIGUOUS_REMOTE_STATE must be marked ambiguous",
    });
  }
});

export const agentIoSchemas = {
  "openlifewiki.agent-scan-result/v1": agentScanResultSchema,
  "openlifewiki.agent-query-result/v1": agentQueryResultSchema,
  "openlifewiki.agent-wiki-semantics/v1": agentWikiSemanticsSchema,
  "openlifewiki.agent-failure/v1": agentFailureSchema,
} as const satisfies Record<AgentIoSchemaId, z.ZodType>;

export type AgentIoAgent = z.infer<typeof agentIoAgentSchema>;
export type AgentConnectorAction = z.infer<typeof agentConnectorActionSchema>;
export type AgentScanResult = z.infer<typeof agentScanResultSchema>;
export type AgentQueryResult = z.infer<typeof agentQueryResultSchema>;
export type AgentWikiSemantics = z.infer<typeof agentWikiSemanticsSchema>;
export type AgentFailure = z.infer<typeof agentFailureSchema>;
export type AgentIoEnvelope =
  | AgentScanResult
  | AgentQueryResult
  | AgentWikiSemantics
  | AgentFailure;
