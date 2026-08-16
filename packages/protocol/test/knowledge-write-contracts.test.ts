import { describe, expect, it } from "vitest";

import {
  knowledgeAgentResultSchema,
  knowledgeOperationSchema,
  knowledgeRegistrationResultSchema,
  managedKnowledgeResultSchema,
  storePreviewSchema,
} from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-16T00:00:00.000Z";

const item = {
  schema: "openlifewiki.knowledge-item/v1",
  itemId: "item_1",
  orgId: "org_1",
  ownerPrincipalId: "principal_1",
  title: "Decision",
  aliases: [],
  status: "draft",
  currentVersionId: "version_1",
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const location = {
  schema: "openlifewiki.knowledge-location/v1",
  locationId: "location_1",
  itemId: "item_1",
  kind: "managed-markdown",
  role: "canonical",
  locator: "openlifewiki-managed://item_1",
  connectorInstanceId: null,
  ownerPrincipalId: "principal_1",
  metadata: {},
  observedProviderVersion: null,
  availability: "available",
  revision: 0,
  lastVerifiedAt: NOW,
} as const;

const version = {
  schema: "openlifewiki.knowledge-version/v1",
  versionId: "version_1",
  itemId: "item_1",
  locationId: "location_1",
  ordinal: 1,
  bodyHash: HASH,
  bodyMarkdown: "# Decision",
  providerVersion: null,
  provenance: {},
  createdByPrincipalId: "principal_1",
  createdAt: NOW,
} as const;

describe("knowledge write protocol contracts", () => {
  it("accepts each strict result variant in the Agent result union", () => {
    const registration = {
      schema: "openlifewiki.knowledge-registration-result/v1",
      taskId: "task_1",
      item,
      locations: [location],
    } as const;
    const managed = {
      schema: "openlifewiki.managed-knowledge-result/v1",
      taskId: "task_1",
      item,
      location,
      version,
    } as const;
    const preview = {
      schema: "openlifewiki.store-preview/v1",
      taskId: "task_1",
      itemId: "item_1",
      expectedRevision: 0,
      oldBodyHash: HASH,
      newBodyHash: `sha256:${"b".repeat(64)}`,
      oldTitle: "Decision",
      newTitle: "Updated decision",
      previewHash: `sha256:${"c".repeat(64)}`,
    } as const;

    expect(knowledgeRegistrationResultSchema.parse(registration)).toEqual(registration);
    expect(managedKnowledgeResultSchema.parse(managed)).toEqual(managed);
    expect(storePreviewSchema.parse(preview)).toEqual(preview);
    expect(knowledgeAgentResultSchema.parse(registration)).toEqual(registration);
    expect(knowledgeAgentResultSchema.parse(managed)).toEqual(managed);
    expect(knowledgeAgentResultSchema.parse(preview)).toEqual(preview);
    expect(() => knowledgeAgentResultSchema.parse({ ...preview, leaked: true })).toThrow();
  });

  it("accepts preview, exact apply and constrained share operations", () => {
    const content = { title: "Updated", bodyMarkdown: "# Updated", aliases: [], tags: [] };
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.preview-replace",
      itemId: "item_1",
      expectedRevision: 1,
      content,
    })).toMatchObject({ kind: "knowledge.store.preview-replace" });
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store.apply-replace",
      itemId: "item_1",
      expectedRevision: 1,
      previewHash: HASH,
      content,
    })).toMatchObject({ kind: "knowledge.store.apply-replace" });
    expect(knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.share",
      itemId: "item_1",
      targetPrincipalId: "principal_2",
      capabilities: ["knowledge.query", "knowledge.store", "knowledge.organize"],
    })).toMatchObject({ kind: "knowledge.share" });
    expect(() => knowledgeOperationSchema.parse({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.share",
      itemId: "item_1",
      targetPrincipalId: "principal_2",
      capabilities: ["knowledge.share"],
    })).toThrow();
  });
});
