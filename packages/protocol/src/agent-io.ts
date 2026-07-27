import { z } from "zod";

import { AGENT_RUNTIMES } from "./agent.js";
import { sha256Canonical } from "./hashing.js";

export const AGENT_IO_SCHEMA_IDS = [
  "openlifewiki.agent-scan-result/v1",
  "openlifewiki.agent-query-result/v1",
  "openlifewiki.agent-wiki-semantics/v1",
  "openlifewiki.agent-failure/v1",
] as const;

export const AGENT_IO_SEMANTIC_RULES_VERSION = "3" as const;
export const AGENT_IO_SEMANTIC_RULES = Object.freeze([
  "agent.runtime-mode-match:codex-claude-gemini-native;pi-openclaw-hermes-provider",
  "binding.envelope-identity:operation-scan-query-proposal-and-failure-identities-match-trusted-context",
  "binding.query-citations:every-returned-citation-exactly-matches-bound-current-retrieval-metadata",
  "binding.scan-layer:complete-child-decision-target-system-outcome-budget-and-sensitivity-context-is-exact",
  "binding.scan-input-hash:layer-children-targets-intent-skill-and-resolved-policy-effects-are-canonical",
  "binding.wiki-context:concept-provenance-and-base-links-resolve-to-frozen-evidence-and-base-page-metadata",
  "failure.code-presentation-match:each-code-has-one-fixed-message-key-and-remediation-action-target",
  "failure.remote-state-flag-match:true-iff-code-is-agent-ambiguous-remote-state",
  "query.claim-and-citation-identities:claim-ids-and-citation-ids-unique",
  "query.citation-resolution:all-claim-and-raw-citation-ids-resolve-and-no-citation-is-unused",
  "query.evidence-mode-structure:grounded-nonempty;partial-cited-with-gap;conflicting-two-cited-with-conflict-gap;no-evidence-gap-only",
  "query.raw-exposure:non-included-has-no-citations;no-evidence-cannot-include",
  "scan.layer-coverage:decision-ready-requires-complete-page-no-open-cursor-and-known-child-count",
  "scan.layer-targets:agent-targets-exactly-match-decision-set-and-union-system-outcomes-covers-child-set",
  "scan.outcome-fields:skip-empty;defer-with-revisit;ask-user-with-question;descend-no-question-or-revisit",
  "scan.outcome-actions:connector-actions-and-receipt-hashes-are-control-plane-derived-never-agent-authored",
  "scan.outcome-budget:aggregate-descend-node-body-byte-and-agent-call-cost-is-lte-trusted-remaining-budget",
  "scan.outcome-sensitivity:pending-owner-approval-requires-ask-user-for-the-exact-target",
  "wiki.alias-membership:taxonomy-and-concept-aliases-match-bidirectionally",
  "wiki.concept-identities:page-uid-and-path-unique",
  "wiki.folder-hierarchy:root-dot-required;folder-paths-unique;every-folder-parent-and-concept-primary-folder-declared",
  "wiki.folder-index-membership:each-folder-has-one-folder-index-path-with-exact-direct-concept-and-child-folder-membership",
  "wiki.freshness-provenance:each-concept-has-one-freshness-result-bound-to-its-sources-and-stale-after",
  "wiki.link-target-resolution:proposed-target-resolves;base-target-binds-base-wiki-hash",
  "wiki.move-target-resolution:move-destination-matches-proposed-concept-path",
  "wiki.tag-membership:tag-names-unique-and-all-concept-tags-declared",
].sort());

export type AgentIoSchemaId = (typeof AGENT_IO_SCHEMA_IDS)[number];

const safeIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const identifier = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(8_192);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeLocator = z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/(?![^/\s]*@)\S+$/i).max(4_096);
const nullableBoundedText = boundedText.nullable();
const nonNegativeInteger = z.int().nonnegative();

const agentIoAgentBaseSchema = z.strictObject({
  id: safeIdentifier,
  runtime: z.enum(AGENT_RUNTIMES),
  mode: z.enum(["native-cli", "provider-runtime"]),
  driverContractVersion: safeIdentifier,
});

export function validateAgentIoAgentSemantics(
  value: z.infer<typeof agentIoAgentBaseSchema>,
  context: z.RefinementCtx<z.infer<typeof agentIoAgentBaseSchema>>,
): void {
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
}

export function buildAgentIoAgentSchema() {
  return agentIoAgentBaseSchema.superRefine(validateAgentIoAgentSemantics);
}

export const agentScanTargetSchema = z.strictObject({
  nodeId: safeIdentifier,
  parentId: safeIdentifier,
  nodeVersion: identifier,
  kind: z.enum(["container", "leaf"]),
});
export const agentScanCoverageSchema = z.strictObject({
  directChildrenEnumerated: nonNegativeInteger,
  pageComplete: z.boolean(),
  openCursor: z.boolean(),
  unknownChildCount: z.boolean(),
});
export const agentScanCostSchema = z.strictObject({
  nodes: nonNegativeInteger,
  bodyBytes: nonNegativeInteger,
  agentCalls: nonNegativeInteger,
});
export const agentScanSystemOutcomeSchema = z.strictObject({
  targetNodeId: safeIdentifier,
  outcome: z.literal("blocked"),
  code: safeIdentifier,
});
export const agentScanLayerSchema = z.strictObject({
  sourceId: safeIdentifier,
  parentNodeId: safeIdentifier,
  parentNodeVersion: identifier,
  summaryHash: hash,
  childSetHash: hash,
  decisionTargetSetHash: hash,
  coverage: agentScanCoverageSchema,
  systemOutcomes: z.array(agentScanSystemOutcomeSchema),
});
export const agentScanChildOutcomeSchema = z.strictObject({
  target: agentScanTargetSchema,
  outcome: z.enum(["descend", "skip", "defer", "ask-user"]),
  reason: boundedText,
  estimatedCost: agentScanCostSchema,
  revisitCondition: nullableBoundedText,
  question: nullableBoundedText,
});
export const agentScanTrustedChildSchema = z.strictObject({
  target: agentScanTargetSchema,
  metadataHash: hash,
});
export const agentScanTargetPolicyEffectSchema = z.strictObject({
  targetNodeId: safeIdentifier,
  eligible: z.literal(true),
  effectiveSensitivity: z.enum(["normal", "sensitive"]),
  ownerApprovalRequired: z.boolean(),
  indexingDisposition: z.enum(["qmd-current", "metadata-only", "excluded"]),
  priorityRelation: z.enum(["none", "exact", "ancestor"]),
  matchedPriorityReferenceHashes: z.array(hash),
  matchedNarrowingRuleHashes: z.array(hash),
});
export const agentResolvedScanPolicySchema = z.strictObject({
  resolutionHash: hash,
  hostBindingHash: hash,
  wikiBindingHash: hash,
  priorityReferenceHashes: z.array(hash),
  include: z.array(boundedText).min(1),
  exclude: z.array(boundedText),
  remainingBudget: agentScanCostSchema,
  indexing: z.strictObject({
    default: z.enum(["qmd-current", "metadata-only", "excluded"]),
    rules: z.array(z.strictObject({
      match: boundedText,
      disposition: z.enum(["qmd-current", "metadata-only", "excluded"]),
    })),
  }),
  targetEffects: z.array(agentScanTargetPolicyEffectSchema),
});
export const agentScanInputContextSchema = z.strictObject({
  scanId: safeIdentifier,
  scanPlanHash: hash,
  skeletonVersion: hash,
  layer: agentScanLayerSchema,
  completeChildren: z.array(agentScanTrustedChildSchema),
  decisionTargets: z.array(agentScanTargetSchema),
  scanIntent: boundedText,
  resolvedPolicy: agentResolvedScanPolicySchema,
  skillHash: hash,
});

export type AgentScanInputContext = z.infer<typeof agentScanInputContextSchema>;

export function buildAgentScanInputSetHash(input: AgentScanInputContext): string {
  return sha256Canonical(agentScanInputContextSchema.parse(input));
}

const agentScanResultBaseSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-scan-result/v1"),
  operationId: safeIdentifier,
  scanId: safeIdentifier,
  scanPlanHash: hash,
  skeletonVersion: hash,
  skillHash: hash,
  inputSetHash: hash,
  agent: buildAgentIoAgentSchema(),
  layer: agentScanLayerSchema,
  childOutcomes: z.array(agentScanChildOutcomeSchema),
  status: z.literal("decision-ready"),
});

export function validateAgentScanSemantics(
  value: z.infer<typeof agentScanResultBaseSchema>,
  context: z.RefinementCtx<z.infer<typeof agentScanResultBaseSchema>>,
): void {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const coverage = value.layer.coverage;
  if (!coverage.pageComplete || coverage.openCursor || coverage.unknownChildCount) {
    issue(["layer", "coverage"], "decision-ready requires complete known layer coverage");
  }

  const systemIds = new Set<string>();
  value.layer.systemOutcomes.forEach((outcome, index) => {
    if (systemIds.has(outcome.targetNodeId)) {
      issue(["layer", "systemOutcomes", index, "targetNodeId"], "system target IDs must be unique");
    }
    systemIds.add(outcome.targetNodeId);
  });

  const targetIds = new Set<string>();
  value.childOutcomes.forEach((outcome, index) => {
    if (targetIds.has(outcome.target.nodeId)) {
      issue(["childOutcomes", index, "target", "nodeId"], "decision target IDs must be unique");
    }
    targetIds.add(outcome.target.nodeId);
    if (outcome.target.parentId !== value.layer.parentNodeId) {
      issue(["childOutcomes", index, "target", "parentId"], "target must be a direct layer child");
    }
    if (systemIds.has(outcome.target.nodeId)) {
      issue(["childOutcomes", index, "target", "nodeId"], "Agent and system outcomes must be disjoint");
    }

    if (outcome.outcome === "skip") {
      if (outcome.question !== null) issue(["childOutcomes", index, "question"], "skip cannot ask a question");
      if (outcome.revisitCondition !== null) {
        issue(["childOutcomes", index, "revisitCondition"], "skip cannot set a revisit condition");
      }
      if (outcome.estimatedCost.nodes !== 0
        || outcome.estimatedCost.bodyBytes !== 0
        || outcome.estimatedCost.agentCalls !== 0) {
        issue(["childOutcomes", index, "estimatedCost"], "skip cannot reserve follow-up cost");
      }
    } else if (outcome.outcome === "defer") {
      if (outcome.revisitCondition === null) {
        issue(["childOutcomes", index, "revisitCondition"], "defer requires a concrete revisit condition");
      }
      if (outcome.question !== null) issue(["childOutcomes", index, "question"], "defer cannot ask a question");
    } else if (outcome.outcome === "ask-user") {
      if (outcome.question === null) {
        issue(["childOutcomes", index, "question"], "ask-user requires a bounded question");
      }
      if (outcome.revisitCondition !== null) {
        issue(["childOutcomes", index, "revisitCondition"], "ask-user cannot set a revisit condition");
      }
    } else {
      if (outcome.question !== null) issue(["childOutcomes", index, "question"], "descend cannot ask a question");
      if (outcome.revisitCondition !== null) {
        issue(["childOutcomes", index, "revisitCondition"], "descend cannot set a revisit condition");
      }
    }
  });

  if (targetIds.size + systemIds.size !== coverage.directChildrenEnumerated) {
    issue(["layer", "coverage"], "Agent and system outcomes must cover every direct child");
  }
}

export function buildAgentScanResultSchema() {
  return agentScanResultBaseSchema.superRefine(validateAgentScanSemantics);
}

export const agentCitationSchema = z.strictObject({
  citationId: safeIdentifier,
  locator: safeLocator,
  sourceId: safeIdentifier,
  nodeId: safeIdentifier,
  nodeVersion: identifier,
});
const factClaimSchema = z.strictObject({
  claimId: safeIdentifier,
  type: z.literal("fact"),
  text: boundedText,
  citationIds: z.array(safeIdentifier).min(1),
});
const inferenceClaimSchema = z.strictObject({
  claimId: safeIdentifier,
  type: z.literal("inference"),
  text: boundedText,
  citationIds: z.array(safeIdentifier),
});
const gapClaimSchema = z.strictObject({
  claimId: safeIdentifier,
  type: z.literal("gap"),
  text: boundedText,
  citationIds: z.array(safeIdentifier).max(0),
});
const queryGapSchema = z.strictObject({
  code: safeIdentifier,
  kind: z.enum(["coverage", "freshness", "authorization", "conflict"]),
  description: boundedText,
  sourceIds: z.array(safeIdentifier),
});

const agentQueryResultBaseSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-query-result/v1"),
  queryId: safeIdentifier,
  inputSetHash: hash,
  skillHash: hash,
  activeGeneration: z.strictObject({
    generationId: safeIdentifier,
    manifestHash: hash,
  }),
  agent: buildAgentIoAgentSchema(),
  evidenceMode: z.enum([
    "grounded",
    "no-evidence",
    "partial-evidence",
    "conflicting-evidence",
  ]),
  answer: boundedText,
  claims: z.array(z.discriminatedUnion("type", [
    factClaimSchema,
    inferenceClaimSchema,
    gapClaimSchema,
  ])),
  citations: z.array(agentCitationSchema),
  gaps: z.array(queryGapSchema),
  rawExposure: z.strictObject({
    status: z.enum(["not-requested", "denied", "included"]),
    citationIds: z.array(safeIdentifier),
  }),
  status: z.literal("answer-ready"),
});

export function validateAgentQuerySemantics(
  value: z.infer<typeof agentQueryResultBaseSchema>,
  context: z.RefinementCtx<z.infer<typeof agentQueryResultBaseSchema>>,
): void {
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

  const claimIds = new Set<string>();
  const referencedCitationIds = new Set<string>();
  value.claims.forEach((claim, claimIndex) => {
    if (claimIds.has(claim.claimId)) {
      context.addIssue({
        code: "custom",
        path: ["claims", claimIndex, "claimId"],
        message: "claim IDs must be unique",
      });
    }
    claimIds.add(claim.claimId);
    claim.citationIds.forEach((citationId, citationIndex) => {
      referencedCitationIds.add(citationId);
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
    referencedCitationIds.add(citationId);
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
  value.citations.forEach((citation, index) => {
    if (!referencedCitationIds.has(citation.citationId)) {
      context.addIssue({
        code: "custom",
        path: ["citations", index, "citationId"],
        message: "every citation must support a claim or approved raw exposure",
      });
    }
  });

  const evidenceClaims = value.claims.filter(({ type }) => type !== "gap");
  if (value.evidenceMode === "grounded") {
    if (evidenceClaims.length === 0 || value.citations.length === 0) {
      context.addIssue({ code: "custom", path: [], message: "grounded evidence cannot be empty" });
    }
  } else if (value.evidenceMode === "partial-evidence") {
    if (evidenceClaims.length === 0 || value.citations.length === 0 || value.gaps.length === 0) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "partial evidence requires claims, citations and explicit gaps",
      });
    }
  } else if (value.evidenceMode === "conflicting-evidence") {
    if (
      evidenceClaims.length === 0
      || value.citations.length < 2
      || !value.gaps.some(({ kind }) => kind === "conflict")
      || referencedCitationIds.size < 2
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "conflicting evidence requires two citations and an explicit conflict gap",
      });
    }
  } else {
    if (value.citations.length !== 0 || evidenceClaims.length !== 0 || value.gaps.length === 0) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "no-evidence requires explicit gaps and no factual or inference claims",
      });
    }
    if (value.rawExposure.status === "included") {
      context.addIssue({
        code: "custom",
        path: ["rawExposure", "status"],
        message: "no-evidence cannot include raw exposure",
      });
    }
  }
}

export function buildAgentQueryResultSchema() {
  return agentQueryResultBaseSchema.superRefine(validateAgentQuerySemantics);
}

export const agentWikiSourceSchema = z.strictObject({
  id: safeIdentifier,
  resource: safeLocator,
  title: boundedText,
  sourceId: safeIdentifier,
  nodeId: safeIdentifier,
  nodeVersion: identifier,
});
export const agentBaseWikiPageSchema = z.strictObject({
  page_uid: safeIdentifier,
  path: z.string().min(1).max(2_048),
});
const wikiLinkTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("proposed"),
    page_uid: safeIdentifier,
    path: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    kind: z.literal("base-wiki"),
    page_uid: safeIdentifier,
    path: z.string().min(1).max(2_048),
    baseWikiHash: hash,
  }),
]);
const wikiConceptSchema = z.strictObject({
  page_uid: safeIdentifier,
  type: identifier,
  title: boundedText,
  description: boundedText,
  path: z.string().min(1).max(2_048),
  body: z.string().min(1).max(262_144),
  sources: z.array(agentWikiSourceSchema).min(1),
  tags: z.array(identifier),
  aliases: z.array(boundedText),
  links: z.array(z.strictObject({
    text: boundedText,
    target: wikiLinkTargetSchema,
  })),
  status: z.enum(["draft", "stable", "deprecated"]),
  stale_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
const wikiFolderSchema = z.strictObject({
  path: z.string().min(1).max(2_048),
  title: boundedText,
  description: boundedText,
});
const wikiIndexSchema = z.strictObject({
  folderPath: z.string().min(1).max(2_048),
  path: z.string().min(1).max(2_048),
  title: boundedText,
  description: boundedText,
  conceptPageUids: z.array(safeIdentifier),
  childFolderPaths: z.array(z.string().min(1).max(2_048)),
});
const wikiFreshnessSchema = z.strictObject({
  page_uid: safeIdentifier,
  status: z.enum(["current", "stale", "unknown"]),
  stale_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reason: boundedText,
  sourceIds: z.array(safeIdentifier).min(1),
});

export function agentWikiParentFolder(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "." : path.slice(0, separator);
}

export function agentWikiDirectChildFolders(
  folderPath: string,
  folderPaths: ReadonlySet<string>,
): string[] {
  const prefix = folderPath === "." ? "" : `${folderPath}/`;
  return [...folderPaths].filter((candidate) => {
    if (candidate === folderPath || !candidate.startsWith(prefix)) return false;
    return !candidate.slice(prefix.length).includes("/");
  }).sort();
}

export function agentWikiSameStringSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actual.length === new Set(actual).size
    && actual.length === expected.length
    && actualSorted.every((value, index) => value === expectedSorted[index]);
}

const agentWikiSemanticsBaseSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-wiki-semantics/v1"),
  proposalId: safeIdentifier,
  baseWikiHash: hash,
  evidenceManifestHash: hash,
  inputSetHash: hash,
  skillHash: hash,
  agent: buildAgentIoAgentSchema(),
  folders: z.array(wikiFolderSchema),
  tags: z.array(z.strictObject({
    name: identifier,
    description: boundedText,
  })),
  aliases: z.array(z.strictObject({
    alias: boundedText,
    page_uid: safeIdentifier,
  })),
  concepts: z.array(wikiConceptSchema).min(1),
  indexes: z.array(wikiIndexSchema),
  freshness: z.array(wikiFreshnessSchema),
  moves: z.array(z.strictObject({
    page_uid: safeIdentifier,
    from: z.string().min(1).max(2_048),
    to: z.string().min(1).max(2_048),
    reason: boundedText,
  })),
  knownGaps: z.array(z.strictObject({
    code: safeIdentifier,
    description: boundedText,
    sourceIds: z.array(safeIdentifier),
  })),
  status: z.literal("proposal-ready"),
});

export function validateAgentWikiSemantics(
  value: z.infer<typeof agentWikiSemanticsBaseSchema>,
  context: z.RefinementCtx<z.infer<typeof agentWikiSemanticsBaseSchema>>,
): void {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const conceptById = new Map<string, (typeof value.concepts)[number]>();
  const conceptPaths = new Set<string>();
  value.concepts.forEach((concept, index) => {
    if (conceptById.has(concept.page_uid)) {
      issue(["concepts", index, "page_uid"], "Concept page_uid values must be unique");
    }
    if (conceptPaths.has(concept.path)) {
      issue(["concepts", index, "path"], "Concept paths must be unique");
    }
    conceptById.set(concept.page_uid, concept);
    conceptPaths.add(concept.path);
  });

  const folderPaths = new Set(value.folders.map(({ path }) => path));
  if (folderPaths.size !== value.folders.length) issue(["folders"], "folder paths must be unique");
  if (!folderPaths.has(".")) issue(["folders"], "root folder . must be declared");
  value.folders.forEach((folder, index) => {
    const parent = agentWikiParentFolder(folder.path);
    if (folder.path !== "." && !folderPaths.has(parent)) {
      issue(["folders", index, "path"], "nested folder requires its declared parent folder");
    }
  });

  const tagNames = new Set(value.tags.map(({ name }) => name));
  if (tagNames.size !== value.tags.length) issue(["tags"], "tag names must be unique");
  value.concepts.forEach((concept, conceptIndex) => {
    if (!folderPaths.has(agentWikiParentFolder(concept.path))) {
      issue(["concepts", conceptIndex, "path"], "Concept primary folder must be declared");
    }
    concept.tags.forEach((tag, tagIndex) => {
      if (!tagNames.has(tag)) {
        issue(["concepts", conceptIndex, "tags", tagIndex], "Concept tag must be declared");
      }
    });
    concept.links.forEach((link, linkIndex) => {
      if (link.target.kind === "proposed") {
        const target = conceptById.get(link.target.page_uid);
        if (target === undefined || target.path !== link.target.path) {
          issue(
            ["concepts", conceptIndex, "links", linkIndex, "target"],
            "proposed link target must resolve to the declared Concept path",
          );
        }
      } else if (link.target.baseWikiHash !== value.baseWikiHash) {
        issue(
          ["concepts", conceptIndex, "links", linkIndex, "target", "baseWikiHash"],
          "base-Wiki link target must bind the proposal base Wiki hash",
        );
      }
    });
  });

  const aliasKeys = new Set<string>();
  value.aliases.forEach((alias, index) => {
    const concept = conceptById.get(alias.page_uid);
    const key = `${alias.page_uid}\u0000${alias.alias}`;
    if (aliasKeys.has(key)) issue(["aliases", index], "taxonomy aliases must be unique");
    aliasKeys.add(key);
    if (concept === undefined || !concept.aliases.includes(alias.alias)) {
      issue(["aliases", index], "taxonomy alias must match its proposed Concept");
    }
  });
  value.concepts.forEach((concept, conceptIndex) => {
    concept.aliases.forEach((alias, aliasIndex) => {
      if (!aliasKeys.has(`${concept.page_uid}\u0000${alias}`)) {
        issue(
          ["concepts", conceptIndex, "aliases", aliasIndex],
          "Concept alias must be declared in taxonomy aliases",
        );
      }
    });
  });

  const indexByFolder = new Map<string, (typeof value.indexes)[number]>();
  value.indexes.forEach((indexEntry, index) => {
    if (!folderPaths.has(indexEntry.folderPath)) {
      issue(["indexes", index, "folderPath"], "index folder must be declared");
    }
    if (indexByFolder.has(indexEntry.folderPath)) {
      issue(["indexes", index, "folderPath"], "each folder requires exactly one index");
    }
    indexByFolder.set(indexEntry.folderPath, indexEntry);
    const expectedPath = indexEntry.folderPath === "."
      ? "index.md"
      : `${indexEntry.folderPath}/index.md`;
    if (indexEntry.path !== expectedPath) {
      issue(["indexes", index, "path"], "index path must be the folder index.md");
    }
    const expectedConcepts = value.concepts
      .filter((concept) => agentWikiParentFolder(concept.path) === indexEntry.folderPath)
      .map(({ page_uid }) => page_uid);
    if (!agentWikiSameStringSet(indexEntry.conceptPageUids, expectedConcepts)) {
      issue(["indexes", index, "conceptPageUids"], "index membership must match direct Concepts");
    }
    if (!agentWikiSameStringSet(
      indexEntry.childFolderPaths,
      agentWikiDirectChildFolders(indexEntry.folderPath, folderPaths),
    )) {
      issue(
        ["indexes", index, "childFolderPaths"],
        "index child folders must match declared direct children",
      );
    }
  });
  value.folders.forEach((folder, index) => {
    if (!indexByFolder.has(folder.path)) {
      issue(["folders", index, "path"], "every declared folder requires index semantics");
    }
  });

  const freshnessByConcept = new Set<string>();
  value.freshness.forEach((freshness, index) => {
    const concept = conceptById.get(freshness.page_uid);
    if (freshnessByConcept.has(freshness.page_uid)) {
      issue(["freshness", index, "page_uid"], "each Concept requires one freshness result");
    }
    freshnessByConcept.add(freshness.page_uid);
    if (concept === undefined) {
      issue(["freshness", index, "page_uid"], "freshness must resolve to a proposed Concept");
      return;
    }
    if (freshness.stale_after !== concept.stale_after) {
      issue(["freshness", index, "stale_after"], "freshness must match Concept stale_after");
    }
    const provenanceSourceIds = new Set(concept.sources.map(({ sourceId }) => sourceId));
    freshness.sourceIds.forEach((sourceId, sourceIndex) => {
      if (!provenanceSourceIds.has(sourceId)) {
        issue(
          ["freshness", index, "sourceIds", sourceIndex],
          "freshness source must resolve to Concept provenance",
        );
      }
    });
  });
  value.concepts.forEach((concept, index) => {
    if (!freshnessByConcept.has(concept.page_uid)) {
      issue(["concepts", index, "page_uid"], "every Concept requires explicit freshness");
    }
  });

  value.moves.forEach((move, index) => {
    const concept = conceptById.get(move.page_uid);
    if (concept === undefined || concept.path !== move.to) {
      issue(["moves", index], "move must resolve to the proposed Concept destination");
    }
  });
}

export function buildAgentWikiSemanticsSchema() {
  return agentWikiSemanticsBaseSchema.superRefine(validateAgentWikiSemantics);
}

export const AGENT_FAILURE_CODES = [
  "AGENT_MISSING",
  "AGENT_UNSUPPORTED_VERSION",
  "AGENT_CONTRACT_UNSUPPORTED",
  "AGENT_AUTH_REQUIRED",
  "AGENT_HOST_CONFIG_INVALID",
  "AGENT_SPAWN_FAILED",
  "AGENT_TIMEOUT",
  "AGENT_CANCELLED",
  "AGENT_PROVIDER_FAILED",
  "AGENT_TOOL_ERROR",
  "AGENT_OUTPUT_INVALID",
  "AGENT_EXIT_NONZERO",
  "AGENT_AMBIGUOUS_REMOTE_STATE",
  "AGENT_REFUSAL",
] as const;

export const AGENT_FAILURE_MESSAGE_KEYS = [
  "agent.missing",
  "agent.unsupported-version",
  "agent.contract-unsupported",
  "agent.auth-required",
  "agent.host-config-invalid",
  "agent.spawn-failed",
  "agent.timeout",
  "agent.cancelled",
  "agent.provider-failed",
  "agent.tool-error",
  "agent.output-invalid",
  "agent.exit-nonzero",
  "agent.ambiguous-remote-state",
  "agent.refusal",
] as const;

export const AGENT_FAILURE_PRESENTATION = {
  AGENT_MISSING: {
    messageKey: "agent.missing",
    remediation: { action: "install-agent", target: "agent-runtime" },
  },
  AGENT_UNSUPPORTED_VERSION: {
    messageKey: "agent.unsupported-version",
    remediation: { action: "update-agent", target: "agent-runtime" },
  },
  AGENT_CONTRACT_UNSUPPORTED: {
    messageKey: "agent.contract-unsupported",
    remediation: { action: "update-agent-contract", target: "agent-runtime" },
  },
  AGENT_AUTH_REQUIRED: {
    messageKey: "agent.auth-required",
    remediation: { action: "reauthenticate-agent", target: "agent-login" },
  },
  AGENT_HOST_CONFIG_INVALID: {
    messageKey: "agent.host-config-invalid",
    remediation: { action: "fix-host-config", target: "host-config" },
  },
  AGENT_SPAWN_FAILED: {
    messageKey: "agent.spawn-failed",
    remediation: { action: "inspect-agent-runtime", target: "agent-runtime" },
  },
  AGENT_TIMEOUT: {
    messageKey: "agent.timeout",
    remediation: { action: "retry-operation", target: "operation" },
  },
  AGENT_CANCELLED: {
    messageKey: "agent.cancelled",
    remediation: { action: "no-action", target: "none" },
  },
  AGENT_PROVIDER_FAILED: {
    messageKey: "agent.provider-failed",
    remediation: { action: "retry-operation", target: "operation" },
  },
  AGENT_TOOL_ERROR: {
    messageKey: "agent.tool-error",
    remediation: { action: "retry-operation", target: "operation" },
  },
  AGENT_OUTPUT_INVALID: {
    messageKey: "agent.output-invalid",
    remediation: { action: "review-output-contract", target: "operation" },
  },
  AGENT_EXIT_NONZERO: {
    messageKey: "agent.exit-nonzero",
    remediation: { action: "inspect-agent-runtime", target: "agent-runtime" },
  },
  AGENT_AMBIGUOUS_REMOTE_STATE: {
    messageKey: "agent.ambiguous-remote-state",
    remediation: { action: "inspect-agent-runtime", target: "operation" },
  },
  AGENT_REFUSAL: {
    messageKey: "agent.refusal",
    remediation: { action: "no-action", target: "none" },
  },
} as const satisfies Record<
  (typeof AGENT_FAILURE_CODES)[number],
  {
    readonly messageKey: (typeof AGENT_FAILURE_MESSAGE_KEYS)[number];
    readonly remediation: {
      readonly action:
        | "install-agent"
        | "update-agent"
        | "update-agent-contract"
        | "reauthenticate-agent"
        | "fix-host-config"
        | "retry-operation"
        | "review-output-contract"
        | "inspect-agent-runtime"
        | "no-action";
      readonly target: "agent-runtime" | "agent-login" | "host-config" | "operation" | "none";
    };
  }
>;

const agentFailureBaseSchema = z.strictObject({
  schema: z.literal("openlifewiki.agent-failure/v1"),
  operationId: safeIdentifier,
  inputSetHash: hash,
  skillHash: hash,
  agent: buildAgentIoAgentSchema(),
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
  messageKey: z.enum(AGENT_FAILURE_MESSAGE_KEYS),
  remediation: z.strictObject({
    action: z.enum([
      "install-agent",
      "update-agent",
      "update-agent-contract",
      "reauthenticate-agent",
      "fix-host-config",
      "retry-operation",
      "review-output-contract",
      "inspect-agent-runtime",
      "no-action",
    ]),
    target: z.enum(["agent-runtime", "agent-login", "host-config", "operation", "none"]),
  }),
  retryable: z.boolean(),
  ambiguousRemoteState: z.boolean(),
  status: z.literal("failed"),
});

export function validateAgentFailureSemantics(
  value: z.infer<typeof agentFailureBaseSchema>,
  context: z.RefinementCtx<z.infer<typeof agentFailureBaseSchema>>,
): void {
  const expectedPresentation = AGENT_FAILURE_PRESENTATION[value.code];
  if (value.messageKey !== expectedPresentation.messageKey) {
    context.addIssue({
      code: "custom",
      path: ["messageKey"],
      message: "failure messageKey must match its code",
    });
  }
  if (
    value.remediation.action !== expectedPresentation.remediation.action
    || value.remediation.target !== expectedPresentation.remediation.target
  ) {
    context.addIssue({
      code: "custom",
      path: ["remediation"],
      message: "failure remediation must match its code",
    });
  }
  const expectedAmbiguity = value.code === "AGENT_AMBIGUOUS_REMOTE_STATE";
  if (value.ambiguousRemoteState !== expectedAmbiguity) {
    context.addIssue({
      code: "custom",
      path: ["ambiguousRemoteState"],
      message: "ambiguousRemoteState must match the failure code",
    });
  }
}

export function buildAgentFailureSchema() {
  return agentFailureBaseSchema.superRefine(validateAgentFailureSemantics);
}

export const AGENT_IO_SCHEMA_BUILDERS = Object.freeze({
  "openlifewiki.agent-scan-result/v1": buildAgentScanResultSchema,
  "openlifewiki.agent-query-result/v1": buildAgentQueryResultSchema,
  "openlifewiki.agent-wiki-semantics/v1": buildAgentWikiSemanticsSchema,
  "openlifewiki.agent-failure/v1": buildAgentFailureSchema,
} as const satisfies Record<AgentIoSchemaId, () => z.ZodType>);

export type AgentIoAgent = z.infer<ReturnType<typeof buildAgentIoAgentSchema>>;
export type AgentScanResult = z.infer<ReturnType<typeof buildAgentScanResultSchema>>;
export type AgentQueryResult = z.infer<ReturnType<typeof buildAgentQueryResultSchema>>;
export type AgentWikiSemantics = z.infer<ReturnType<typeof buildAgentWikiSemanticsSchema>>;
export type AgentFailure = z.infer<ReturnType<typeof buildAgentFailureSchema>>;
export type AgentIoEnvelope =
  | AgentScanResult
  | AgentQueryResult
  | AgentWikiSemantics
  | AgentFailure;
