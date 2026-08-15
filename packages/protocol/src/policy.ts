import { z } from "zod";

import { sha256Canonical } from "./hashing.js";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(8_192);
const policyPattern = z.string().min(1).max(1_024);
const nonNegativeInteger = z.number().int().nonnegative().safe();

export const indexingDispositionSchema = z.enum(["qmd-current", "metadata-only", "excluded"]);
export type IndexingDisposition = z.infer<typeof indexingDispositionSchema>;

const scanNarrowingPolicyBaseSchema = z.strictObject({
  schema: z.literal("openlifewiki.scan-narrowing-policy/v1"),
  include: z.array(policyPattern).min(1).max(128),
  exclude: z.array(policyPattern).max(128),
  sensitivity: z.strictObject({
    default: z.enum(["normal", "sensitive"]),
    rules: z.array(z.strictObject({
      match: policyPattern,
      level: z.enum(["normal", "sensitive"]),
    })).max(128),
  }),
  budget: z.strictObject({
    maxNodes: nonNegativeInteger.optional(),
    maxBodyBytes: nonNegativeInteger.optional(),
    maxAgentCalls: nonNegativeInteger.optional(),
  }),
  indexing: z.strictObject({
    default: indexingDispositionSchema,
    rules: z.array(z.strictObject({
      match: policyPattern,
      disposition: indexingDispositionSchema,
    })).max(128),
  }),
});

export const scanNarrowingPolicySchema = scanNarrowingPolicyBaseSchema.superRefine((value, context) => {
  for (const [key, rules] of [
    ["sensitivity", value.sensitivity.rules],
    ["indexing", value.indexing.rules],
  ] as const) {
    if (new Set(rules.map(({ match }) => match)).size !== rules.length) {
      context.addIssue({
        code: "custom",
        path: [key, "rules"],
        message: `${key} rule match must be unique`,
      });
    }
  }
});

export type ScanNarrowingPolicyV1 = z.infer<typeof scanNarrowingPolicySchema>;
export const resolvedScanPolicySchema = scanNarrowingPolicyBaseSchema.extend({
  includeSets: z.array(z.array(policyPattern).min(1).max(128)).min(1).max(3),
}).superRefine((value, context) => {
  if (value.includeSets.some((patterns) => new Set(patterns).size !== patterns.length)) {
    context.addIssue({ code: "custom", path: ["includeSets"], message: "include set patterns must be unique" });
  }
  for (const [key, rules] of [
    ["sensitivity", value.sensitivity.rules],
    ["indexing", value.indexing.rules],
  ] as const) {
    if (new Set(rules.map(({ match }) => match)).size !== rules.length) {
      context.addIssue({ code: "custom", path: [key, "rules"], message: `${key} rule match must be unique` });
    }
  }
});
export type ResolvedScanPolicyV1 = z.infer<typeof resolvedScanPolicySchema>;

const absentPolicyBindingSchema = z.strictObject({
  schema: z.literal("openlifewiki.policy-binding/v1"),
  kind: z.enum(["host", "wiki"]),
  state: z.literal("absent"),
  bindingHash: hash,
});
const presentPolicyBindingSchema = z.strictObject({
  schema: z.literal("openlifewiki.policy-binding/v1"),
  kind: z.enum(["host", "wiki"]),
  state: z.literal("present"),
  contentHash: hash,
  normalizedPolicyHash: hash,
  bindingHash: hash,
});
export const policyBindingSchema = z.discriminatedUnion("state", [
  absentPolicyBindingSchema,
  presentPolicyBindingSchema,
]);
export type PolicyBindingV1 = z.infer<typeof policyBindingSchema>;

export function createPolicyBinding(input:
  | { readonly kind: "host" | "wiki"; readonly state: "absent" }
  | {
    readonly kind: "host" | "wiki";
    readonly state: "present";
    readonly contentHash: string;
    readonly normalizedPolicyHash: string;
  }): PolicyBindingV1 {
  const payload = input.state === "absent"
    ? { schema: "openlifewiki.policy-binding/v1" as const, ...input }
    : {
      schema: "openlifewiki.policy-binding/v1" as const,
      kind: input.kind,
      state: input.state,
      contentHash: hash.parse(input.contentHash),
      normalizedPolicyHash: hash.parse(input.normalizedPolicyHash),
    };
  return policyBindingSchema.parse({ ...payload, bindingHash: sha256Canonical(payload) });
}

export function assertPolicyBinding(input: unknown): asserts input is PolicyBindingV1 {
  const binding = policyBindingSchema.parse(input);
  const { bindingHash, ...payload } = binding;
  if (sha256Canonical(payload) !== bindingHash) throw new Error("policy binding hash mismatch");
}

export const priorityDocumentReferenceSchema = z.strictObject({
  schema: z.literal("openlifewiki.priority-document-reference/v1"),
  sourceId: boundedText,
  authorizationHash: hash,
  normalizedLocator: boundedText,
  relationMode: z.enum(["exact", "hierarchical"]),
  referenceHash: hash,
});
export type PriorityDocumentReferenceV1 = z.infer<typeof priorityDocumentReferenceSchema>;

export function createPriorityDocumentReference(
  input: Omit<PriorityDocumentReferenceV1, "schema" | "referenceHash">,
): PriorityDocumentReferenceV1 {
  const payload = priorityDocumentReferenceSchema.omit({ referenceHash: true }).parse({
    schema: "openlifewiki.priority-document-reference/v1",
    ...input,
  });
  return { ...payload, referenceHash: sha256Canonical(payload) };
}

export function assertPriorityDocumentReference(input: unknown): asserts input is PriorityDocumentReferenceV1 {
  const reference = priorityDocumentReferenceSchema.parse(input);
  const { referenceHash, ...payload } = reference;
  if (sha256Canonical(payload) !== referenceHash) throw new Error("priority document reference hash mismatch");
}

export function createPolicyResolutionHash(input: {
  readonly ownerPolicy: ScanNarrowingPolicyV1;
  readonly policyBindings: { readonly host: PolicyBindingV1; readonly wiki: PolicyBindingV1 };
  readonly priorityDocumentRefs: readonly PriorityDocumentReferenceV1[];
  readonly policy: ResolvedScanPolicyV1;
}): string {
  return sha256Canonical({
    ownerPolicy: scanNarrowingPolicySchema.parse(input.ownerPolicy),
    policyBindings: input.policyBindings,
    priorityDocumentRefs: input.priorityDocumentRefs,
    policy: resolvedScanPolicySchema.parse(input.policy),
  });
}

export function createScanPlanPolicyMaterial(input: {
  readonly ownerPolicy: ScanNarrowingPolicyV1;
  readonly hostBinding?: PolicyBindingV1;
  readonly wikiBinding?: PolicyBindingV1;
  readonly priorityDocumentRefs?: readonly PriorityDocumentReferenceV1[];
  readonly policy?: ResolvedScanPolicyV1;
}): {
  readonly policyBindings: { readonly host: PolicyBindingV1; readonly wiki: PolicyBindingV1 };
  readonly priorityDocumentRefs: readonly PriorityDocumentReferenceV1[];
  readonly ownerPolicy: ScanNarrowingPolicyV1;
  readonly policy: ResolvedScanPolicyV1;
  readonly policyResolutionHash: string;
} {
  const ownerPolicy = scanNarrowingPolicySchema.parse(input.ownerPolicy);
  const policy = resolvedScanPolicySchema.parse(input.policy ?? {
    ...ownerPolicy,
    includeSets: [[...ownerPolicy.include]],
  });
  const policyBindings = {
    host: input.hostBinding ?? createPolicyBinding({ kind: "host", state: "absent" }),
    wiki: input.wikiBinding ?? createPolicyBinding({ kind: "wiki", state: "absent" }),
  };
  const priorityDocumentRefs = input.priorityDocumentRefs ?? [];
  assertPolicyBinding(policyBindings.host);
  assertPolicyBinding(policyBindings.wiki);
  priorityDocumentRefs.forEach(assertPriorityDocumentReference);
  return {
    policyBindings,
    priorityDocumentRefs,
    ownerPolicy,
    policy,
    policyResolutionHash: createPolicyResolutionHash({
      ownerPolicy,
      policyBindings,
      priorityDocumentRefs,
      policy,
    }),
  };
}
