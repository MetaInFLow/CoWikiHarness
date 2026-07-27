import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorStatus, OpenLifeWikiConfigV2 } from "@openlifewiki/protocol";

import {
  AdapterError,
  executeSourceAuthorization,
  executeSourceRevocation,
  normalizeSourceAuthorizationRequest,
  previewSourceAuthorization,
  previewSourceRevocation,
  readConfigSnapshot,
  updateConfigV2,
  writeConfig,
  type SourceProbe,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V1 Source authorization", () => {
  it("strictly normalizes the four exact scope shapes", () => {
    expect(normalizeSourceAuthorizationRequest(localRequest())).toMatchObject({
      connectorType: "local-folder",
      scope: { root: "/knowledge", symlinkPolicy: "deny" },
      include: ["**/*.md"],
    });
    expect(normalizeSourceAuthorizationRequest(githubRequest())).toMatchObject({
      scope: { hostname: "github.com", repository: "MetaInFLow/openLifeWiki", path: null, ref: "main" },
    });
    expect(normalizeSourceAuthorizationRequest(feishuRequest())).toMatchObject({
      scope: {
        profile: "metainflow-feishu",
        expectedTenantId: "tenant-1",
        documentIds: ["doc-a"],
        wikiNodeIds: ["wiki-a"],
        baseIds: ["base-a"],
      },
    });
    expect(normalizeSourceAuthorizationRequest(codexRequest())).toMatchObject({
      scope: { projectRoots: ["/projects/openLifeWiki"], threadIds: ["thread-a"] },
    });

    expect(() => normalizeSourceAuthorizationRequest({ ...githubRequest(), token: "secret" }))
      .toThrow(/unknown|field/i);
    expect(() => normalizeSourceAuthorizationRequest({
      ...feishuRequest(),
      scope: { ...(feishuRequest().scope as object), profile: "" },
    })).toThrow(/profile/i);
    expect(() => normalizeSourceAuthorizationRequest({
      ...localRequest(),
      budget: { maxNodes: -1, maxBodyBytes: 1, maxAgentCalls: 1 },
    })).toThrow(/budget/i);
  });

  it("previews without writing and binds approval to config, scope and provider identity", async () => {
    const path = await configPath();
    await writeConfig(path, emptyV2());
    const before = await readFile(path);
    const preview = await previewSourceAuthorization({
      configPath: path,
      request: githubRequest(),
      probe: connectedProbe("identity-A"),
      now: fixedNow,
    });

    expect(await readFile(path)).toEqual(before);
    expect(preview).toMatchObject({
      schema: "openlifewiki.source-authorization-preview/v1",
      action: "authorize",
      configRevision: 0,
      previousAuthorizationHash: null,
      provider: {
        status: "connected",
        identityFingerprint: "identity-A",
        identity: { account: "u***r", fingerprint: "identity-A" },
      },
    });
    expect(preview.previewHash).toMatch(/^sha256:/u);
    expect(preview.configHash).toMatch(/^sha256:/u);
  });

  it("approves, reloads, narrows and revokes through exact preview hashes", async () => {
    const path = await configPath();
    await writeConfig(path, emptyV2());
    const probe = connectedProbe("identity-A");

    const first = await previewSourceAuthorization({ configPath: path, request: githubRequest(), probe, now: fixedNow });
    await executeSourceAuthorization({
      configPath: path,
      request: githubRequest(),
      expectedPreviewHash: first.previewHash,
      probe,
      now: fixedNow,
    });
    let snapshot = await readConfigSnapshot(path);
    expect(snapshot?.config.schema).toBe("openlifewiki.config/v2");
    expect((snapshot?.config as OpenLifeWikiConfigV2).revision).toBe(1);
    expect((snapshot?.config as OpenLifeWikiConfigV2).sources[0]).toMatchObject({
      sourceId: "source-github",
      approvedBy: "human:owner",
      identityFingerprint: "identity-A",
      approval: {
        schema: "openlifewiki.source-owner-approval/v1",
        approvedBy: "human:owner",
        previewHash: first.previewHash,
        configHash: first.configHash,
        configRevision: 0,
      },
      providerObservation: {
        providerName: "test-provider", providerVersion: "1.0.0", contractHash: null,
      },
    });

    const narrowedRequest = {
      ...githubRequest(),
      scope: { ...(githubRequest().scope as object), path: "docs" },
    };
    const narrow = await previewSourceAuthorization({ configPath: path, request: narrowedRequest, probe, now: fixedNow });
    expect(narrow.action).toBe("narrow");
    await executeSourceAuthorization({
      configPath: path,
      request: narrowedRequest,
      expectedPreviewHash: narrow.previewHash,
      probe,
      now: fixedNow,
    });
    snapshot = await readConfigSnapshot(path);
    expect((snapshot?.config as OpenLifeWikiConfigV2).sources[0]?.scope).toMatchObject({ path: "docs" });

    const revoke = await previewSourceRevocation({ configPath: path, sourceId: "source-github" });
    await executeSourceRevocation({
      configPath: path,
      sourceId: "source-github",
      expectedPreviewHash: revoke.previewHash,
    });
    snapshot = await readConfigSnapshot(path);
    expect((snapshot?.config as OpenLifeWikiConfigV2).sources).toEqual([]);
  });

  it("fails closed when revision or provider identity changes", async () => {
    const path = await configPath();
    await writeConfig(path, emptyV2());
    const request = githubRequest();
    const preview = await previewSourceAuthorization({
      configPath: path,
      request,
      probe: connectedProbe("identity-A"),
      now: fixedNow,
    });

    await updateConfigV2(path, 0, (config) => config);
    await expect(executeSourceAuthorization({
      configPath: path,
      request,
      expectedPreviewHash: preview.previewHash,
      probe: connectedProbe("identity-A"),
      now: fixedNow,
    })).rejects.toMatchObject({ code: "PLAN_CHANGED" });

    const identityPath = await configPath();
    await writeConfig(identityPath, emptyV2());
    const current = await previewSourceAuthorization({
      configPath: identityPath,
      request,
      probe: connectedProbe("identity-A"),
      now: fixedNow,
    });
    await expect(executeSourceAuthorization({
      configPath: identityPath,
      request,
      expectedPreviewHash: current.previewHash,
      probe: connectedProbe("identity-B"),
      now: fixedNow,
    })).rejects.toMatchObject({ code: "PLAN_CHANGED" });
  });

  it("preserves safe selected-profile diagnostics when a Feishu preview is blocked", async () => {
    const path = await configPath();
    await writeConfig(path, emptyV2());
    const probe: SourceProbe = async ({ source, now }) => ({
      schema: "openlifewiki.connector-status/v1",
      sourceId: source.sourceId,
      connectorType: "feishu",
      providerName: "lark-cli",
      providerVersion: "1.0.64",
      identity: {
        profile: "metainflow-feishu", account: "A***F", tenant: "o***t",
        effectiveScope: "docs:document.content:read",
      },
      authorizedScope: source.scope,
      status: "blocked",
      lastProbe: now().toISOString(),
      changedItems: 0,
      blocking: { code: "FEISHU_TENANT_MISMATCH", remediation: "Use the approved tenant" },
    });

    const error = await previewSourceAuthorization({
      configPath: path, request: feishuRequest(), probe, now: fixedNow,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({
      code: "SOURCE_PROBE_BLOCKED",
      publicDetails: { connectorStatus: {
        status: "blocked",
        identity: { profile: "metainflow-feishu", tenant: "o***t" },
        blocking: { code: "FEISHU_TENANT_MISMATCH" },
      } },
    });
  });

  it("shows the actual redacted Feishu identity in the exact first-authorization preview", async () => {
    const path = await configPath();
    await writeConfig(path, emptyV2());
    const probe: SourceProbe = async ({ source, now }) => ({
      schema: "openlifewiki.connector-status/v1",
      sourceId: source.sourceId,
      connectorType: "feishu",
      providerName: "lark-cli",
      providerVersion: "1.0.64",
      identity: {
        profile: "metainflow-feishu", account: "A***F", tenant: "t***1",
        effectiveScope: "docs:document.content:read", fingerprint: "feishu-identity",
      },
      authorizedScope: source.scope,
      status: "connected",
      lastProbe: now().toISOString(),
      changedItems: 0,
      blocking: null,
    });
    const preview = await previewSourceAuthorization({
      configPath: path, request: feishuRequest(), probe, now: fixedNow,
    });
    expect(preview.provider).toMatchObject({
      version: "1.0.64",
      identity: {
        profile: "metainflow-feishu", account: "A***F", tenant: "t***1",
        effectiveScope: "docs:document.content:read",
      },
    });
  });
});

function emptyV2(): OpenLifeWikiConfigV2 {
  return {
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources: [],
    hostConfig: null,
    scanPolicy: null,
    compatibility: { p0Sources: [], agentBindings: [] },
  };
}

function baseRequest() {
  return {
    schema: "openlifewiki.source-authorization-request/v1",
    rootNodeId: "root",
    include: [] as string[],
    exclude: [] as string[],
    sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 1000, maxBodyBytes: 10_000_000, maxAgentCalls: 100 },
  } as const;
}

function localRequest() {
  return {
    ...baseRequest(), sourceId: "source-local", connectorType: "local-folder",
    include: ["**/*.md"], scope: {
      schema: "openlifewiki.scope/local-folder/v1", root: "/knowledge", symlinkPolicy: "deny",
    },
  };
}

function githubRequest() {
  return {
    ...baseRequest(), sourceId: "source-github", connectorType: "github", scope: {
      schema: "openlifewiki.scope/github/v1", hostname: "github.com",
      repository: "MetaInFLow/openLifeWiki", path: null, ref: "main",
    },
  };
}

function feishuRequest() {
  return {
    ...baseRequest(), sourceId: "source-feishu", connectorType: "feishu", scope: {
      schema: "openlifewiki.scope/feishu/v1", profile: "metainflow-feishu",
      expectedTenantId: "tenant-1", documentIds: ["doc-a"], wikiNodeIds: ["wiki-a"], baseIds: ["base-a"],
    },
  };
}

function codexRequest() {
  return {
    ...baseRequest(), sourceId: "source-codex", connectorType: "codex-history", scope: {
      schema: "openlifewiki.scope/codex-history/v1", projectRoots: ["/projects/openLifeWiki"], threadIds: ["thread-a"],
    },
  };
}

function connectedProbe(identityFingerprint: string): SourceProbe {
  return async ({ source, now }): Promise<ConnectorStatus> => ({
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: source.connectorType,
    providerName: "test-provider",
    providerVersion: "1.0.0",
    identity: { account: "u***r", fingerprint: identityFingerprint },
    authorizedScope: source.scope,
    status: "connected",
    lastProbe: now().toISOString(),
    changedItems: 0,
    blocking: null,
  });
}

const fixedNow = () => new Date("2026-07-26T00:00:00.000Z");

async function configPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-auth-test-"));
  roots.push(root);
  return join(root, "config.json");
}
