import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseOpenLifeWikiConfigV2,
  type OpenLifeWikiConfigV2,
} from "../src/index.js";

const validConfig = {
  schema: "openlifewiki.config/v2",
  revision: 3,
  sources: [{
    schema: "openlifewiki.authorized-source/v1",
    sourceId: "source-local",
    connectorType: "local-folder",
    rootNodeId: "root-local",
    identityFingerprint: "identity-local",
    scope: {
      schema: "openlifewiki.scope/local-folder/v1",
      root: "/approved",
      symlinkPolicy: "deny",
    },
    include: ["**/*.md"],
    exclude: ["private/**"],
    sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
    approvedBy: "owner-1",
    approvedAt: "2026-07-26T00:00:00.000Z",
    authorizationHash: "authorization-local",
  }],
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
      sources: [{
        ...validConfig.sources[0],
        scope: { ...validConfig.sources[0].scope, symlinkPolicy: "within-root" },
      }],
    })).not.toThrow();
    expect(() => parseOpenLifeWikiConfigV2({
      ...validConfig,
      sources: [{
        ...validConfig.sources[0],
        sourceId: "source-codex",
        connectorType: "codex-history",
        scope: {
          schema: "openlifewiki.scope/codex-history/v1",
          projectRoots: [],
          threadIds: ["thread-1"],
        },
      }],
    })).not.toThrow();
  });
});
