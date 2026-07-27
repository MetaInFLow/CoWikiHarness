import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseOpenLifeWikiConfigV1,
  parseOpenLifeWikiConfigV2,
  sha256Canonical,
  type OpenLifeWikiConfigV2,
} from "../src/index.js";

const historicalV1Config = {
  schema: "openlifewiki.config/v1",
  sources: [{
    id: "default-local",
    kind: "local-folder",
    path: "/approved",
    collection: "openlifewiki-sources",
    mask: "**/*.md",
    authorizedAt: "2026-07-20T00:00:00.000Z",
    enabled: true,
  }],
  agentBindings: ["codex"],
} as const;

const validSource = withAuthorizationHash({
    schema: "openlifewiki.authorized-source/v1",
    sourceId: "source-local",
    connectorType: "local-folder",
    rootNodeId: "root-local",
    identityFingerprint: "identity-local",
    approval: testSourceApproval(),
    scope: {
      schema: "openlifewiki.scope/local-folder/v1",
      root: "/approved",
      symlinkPolicy: "deny",
    },
    include: ["**/*.md"],
    exclude: ["private/**"],
    sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner",
    approvedAt: "2026-07-26T00:00:00.000Z",
});

const validConfig = {
  schema: "openlifewiki.config/v2",
  revision: 3,
  sources: [validSource],
  scanPolicy: null,
  hostConfig: {
    schema: "openlifewiki.host-config/v1",
    selectedAgentId: "codex-native",
    agents: [{ id: "codex-native", runtime: "codex", mode: "native-cli" }],
  },
  compatibility: { p0Sources: [], agentBindings: [] },
} as const;

describe("openlifewiki.config/v2 protocol", () => {
  it("parses the strict revisioned single-file configuration", () => {
    expect(parseOpenLifeWikiConfigV2(validConfig)).toEqual(validConfig);
    expectTypeOf<OpenLifeWikiConfigV2>().toBeObject();
  });

  it("rejects unknown fields at every owned configuration boundary", () => {
    expect(() => parseOpenLifeWikiConfigV2({ ...validConfig, token: "secret" }))
      .toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [{ ...validConfig.sources[0], unexpected: true }],
    })).toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      hostConfig: { ...validConfig.hostConfig, fallbackAgentId: "other" },
    })).toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      compatibility: { ...validConfig.compatibility, sourceLedger: [] },
    })).toThrow();
  });

  it("requires one explicit absent or strict Host scan policy", () => {
    const { scanPolicy: _missing, ...withoutPolicy } = validConfig;
    expect(() => parseOpenLifeWikiConfigV2(withoutPolicy)).toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      scanPolicy: {
        schema: "openlifewiki.scan-narrowing-policy/v1",
        include: ["/product/**"],
        exclude: ["/product/private/**"],
        sensitivity: { default: "normal", rules: [{ match: "/product/finance/**", level: "sensitive" }] },
        budget: { maxNodes: 50, maxBodyBytes: 500_000, maxAgentCalls: 10 },
        indexing: { default: "qmd-current", rules: [] },
      },
    })).not.toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      scanPolicy: { schema: "openlifewiki.scan-narrowing-policy/v1", include: ["/**"], token: "secret" },
    })).toThrow();
  });

  it("rejects invalid revisions, duplicate Sources and invalid Host selection", () => {
    expect(() => parseOpenLifeWikiConfigV2({ ...validConfig, revision: -1 })).toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [validConfig.sources[0], validConfig.sources[0]],
    })).toThrow(/duplicate/i);
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      hostConfig: { ...validConfig.hostConfig, selectedAgentId: "missing" },
    })).toThrow(/selected/i);
  });

  it("rejects a scope that does not exactly match its Connector", () => {
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [{ ...validConfig.sources[0], scope: { path: "/approved" } }],
    })).toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [
        validConfig.sources[0],
        { ...validConfig.sources[0], sourceId: "source-local-2" },
      ],
    })).toThrow(/connector/i);
  });

  it("accepts bounded Local traversal and thread-only Codex History scopes", () => {
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [withAuthorizationHash({
        ...validConfig.sources[0],
        scope: { ...validConfig.sources[0].scope, symlinkPolicy: "within-root" },
      })],
    })).not.toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [withAuthorizationHash({
        ...validConfig.sources[0],
        sourceId: "source-codex",
        connectorType: "codex-history",
        scope: {
          schema: "openlifewiki.scope/codex-history/v1",
          projectRoots: [],
          threadIds: ["thread-1"],
        },
      })],
    })).not.toThrow();
  });

  it("rejects a Source whose approved fields no longer match its authorization hash", () => {
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [{ ...validConfig.sources[0], include: ["private/**"] }],
    })).toThrow(/authorization hash/i);
  });
});

describe("historical config/v1 compatibility", () => {
  it("accepts and preserves the explicit historical Source enabled flag", () => {
    expect(parseOpenLifeWikiConfigV1(historicalV1Config)).toEqual(historicalV1Config);
  });

  it("continues to reject unknown historical Source fields", () => {
    expect(() => parseOpenLifeWikiConfigV1({
      ...historicalV1Config,
      sources: [{ ...historicalV1Config.sources[0], unexpected: true }],
    })).toThrow();
  });
});

function withAuthorizationHash<T extends Record<string, unknown>>(source: T) {
  const { authorizationHash: _ignored, ...unsigned } = source;
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
}

function testSourceApproval() {
  const unsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-26T00:00:00.000Z",
    ownerIdentityFingerprint: "sha256:owner",
    previewHash: "sha256:preview",
    configHash: "sha256:config",
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  return { ...unsigned, approvalHash: sha256Canonical(unsigned) };
}
