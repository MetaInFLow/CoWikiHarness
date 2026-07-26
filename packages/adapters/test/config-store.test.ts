import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "@openlifewiki/protocol";

import {
  emptyConfig,
  currentOwnerIdentityFingerprint,
  executeConfigV1Migration,
  getAgentBindings,
  getP0Sources,
  previewConfigV1Migration,
  readConfigSnapshot,
  updateConfigV2,
  updateP0Compatibility,
  writeConfig,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("single config/v2 store", () => {
  it("creates a strict zero-authority v2 configuration", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());

    const snapshot = await readConfigSnapshot(path);

    expect(snapshot?.config).toEqual({
      schema: "openlifewiki.config/v2",
      revision: 0,
      sources: [],
      hostConfig: null,
      compatibility: { p0Sources: [], agentBindings: [] },
    });
  });

  it("returns the exact raw bytes and their byte hash for v1 and v2", async () => {
    const path = await configPath();
    const raw = "{\n  \"schema\": \"openlifewiki.config/v1\",\n  \"sources\": [],\n  \"agentBindings\": []\n}\n";
    await writeFile(path, raw);

    const v1 = await readConfigSnapshot(path);

    expect(Buffer.from(v1!.raw).toString("utf8")).toBe(raw);
    expect(v1!.hash).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);

    await executeConfigV1Migration(path, {
      expectedOwnerId: "owner-1",
      approval: {
        approvedBy: "owner-1",
        sourceConfigHash: v1!.hash,
        previewHash: (await previewConfigV1Migration(path, "owner-1")).previewHash,
      },
    });
    expect((await readConfigSnapshot(path))?.config.schema).toBe("openlifewiki.config/v2");
  });

  it("previews without mutation then migrates only the exact Owner-approved bytes", async () => {
    const path = await configPath();
    const legacy = legacyConfig();
    await writeConfig(path, legacy);
    const before = await readFile(path);

    const preview = await previewConfigV1Migration(path, "owner-1");

    expect(await readFile(path)).toEqual(before);
    expect(preview).toMatchObject({
      schema: "openlifewiki.config-migration-preview/v1",
      fromSchema: "openlifewiki.config/v1",
      toSchema: "openlifewiki.config/v2",
      ownerId: "owner-1",
      v1AuthorizationsAdded: 0,
      preservedP0Sources: 1,
    });

    await expect(executeConfigV1Migration(path, {
      expectedOwnerId: "owner-1",
      approval: { approvedBy: "other", sourceConfigHash: preview.sourceConfigHash, previewHash: preview.previewHash },
    })).rejects.toMatchObject({ code: "CONFIG_MIGRATION_REJECTED" });

    const migrated = await executeConfigV1Migration(path, {
      expectedOwnerId: "owner-1",
      approval: {
        approvedBy: "owner-1",
        sourceConfigHash: preview.sourceConfigHash,
        previewHash: preview.previewHash,
      },
    });

    expect(migrated.config).toMatchObject({
      schema: "openlifewiki.config/v2",
      revision: 0,
      sources: [],
      hostConfig: null,
      compatibility: { p0Sources: legacy.sources, agentBindings: ["codex"] },
    });
    expect(getP0Sources(migrated.config)).toEqual(legacy.sources);
    expect(getAgentBindings(migrated.config)).toEqual(["codex"]);
  });

  it("rejects migration after the previewed bytes or preview hash change", async () => {
    const path = await configPath();
    await writeConfig(path, legacyConfig());
    const preview = await previewConfigV1Migration(path, "owner-1");
    await writeConfig(path, { ...legacyConfig(), agentBindings: ["claude"] });

    await expect(executeConfigV1Migration(path, {
      expectedOwnerId: "owner-1",
      approval: {
        approvedBy: "owner-1",
        sourceConfigHash: preview.sourceConfigHash,
        previewHash: preview.previewHash,
      },
    })).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });

    const fresh = await previewConfigV1Migration(path, "owner-1");
    await expect(executeConfigV1Migration(path, {
      expectedOwnerId: "owner-1",
      approval: {
        approvedBy: "owner-1",
        sourceConfigHash: fresh.sourceConfigHash,
        previewHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    })).rejects.toMatchObject({ code: "CONFIG_MIGRATION_REJECTED" });
  });

  it("increments revision by CAS and rejects a stale concurrent write", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());

    const first = await updateConfigV2(path, 0, (config) => ({
      ...config,
      hostConfig: {
        schema: "openlifewiki.host-config/v1",
        selectedAgentId: "codex-native",
        agents: [{ id: "codex-native", runtime: "codex", mode: "native-cli" }],
      },
    }));
    expect(first.config.revision).toBe(1);

    await expect(updateP0Compatibility(path, 0, (compatibility) => ({
      ...compatibility,
      agentBindings: ["legacy"],
    }))).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
    expect((await readConfigSnapshot(path))?.config).toEqual(first.config);
  });

  it("serializes simultaneous writers so only one matching revision can commit", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());

    const results = await Promise.allSettled([
      updateConfigV2(path, 0, (config) => ({ ...config, sources: [authorizedSource()] })),
      updateP0Compatibility(path, 0, (compatibility) => ({
        ...compatibility,
        agentBindings: ["legacy"],
      })),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const final = await readConfigSnapshot(path);
    expect(final?.config.schema).toBe("openlifewiki.config/v2");
    if (final?.config.schema !== "openlifewiki.config/v2") throw new Error("Expected config/v2");
    expect(final.config.revision).toBe(1);
  });

  it("recovers a lock left by a terminated writer before the next CAS", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    await mkdir(`${path}.lock`);
    await writeFile(join(`${path}.lock`, "owner.json"), JSON.stringify({
      schema: "openlifewiki.config-lock/v1",
      pid: 2_147_483_647,
      createdAt: "2026-07-26T00:00:00.000Z",
    }));

    const result = await updateConfigV2(path, 0, (config) => config);
    expect(result.config.revision).toBe(1);
  });

  it("fences simultaneous stale-lock recovery so only one same-revision writer commits", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    await mkdir(`${path}.lock`);
    await writeFile(join(`${path}.lock`, "owner.json"), JSON.stringify({
      schema: "openlifewiki.config-lock/v1",
      pid: 2_147_483_647,
      token: "terminated-writer",
      createdAt: "2026-07-26T00:00:00.000Z",
    }));

    const results = await Promise.allSettled([
      updateConfigV2(path, 0, (config) => ({ ...config, compatibility: { ...config.compatibility, agentBindings: ["a"] } })),
      updateConfigV2(path, 0, (config) => ({ ...config, compatibility: { ...config.compatibility, agentBindings: ["b"] } })),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("prevents legacy writes from downgrading an existing config/v2", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());

    await expect(writeConfig(path, legacyConfig())).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
    expect((await readConfigSnapshot(path))?.config.schema).toBe("openlifewiki.config/v2");
  });

  it("rejects a self-consistent Source approval copied from another local Owner", async () => {
    const path = await configPath();
    const source = authorizedSource();
    const { approvalHash: _approvalHash, ...approvalUnsigned } = {
      ...source.approval,
      ownerIdentityFingerprint: "sha256:different-owner",
    };
    const approval = { ...approvalUnsigned, approvalHash: sha256Canonical(approvalUnsigned) };
    const { authorizationHash: _authorizationHash, ...sourceUnsigned } = { ...source, approval };
    const copied = { ...sourceUnsigned, authorizationHash: sha256Canonical(sourceUnsigned) };

    await expect(writeConfig(path, { ...emptyConfig(), sources: [copied] }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("updates only P0 compatibility and preserves concurrent V1 fields", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    const withV1Fields = await updateConfigV2(path, 0, (config) => ({
      ...config,
      sources: [authorizedSource()],
      hostConfig: {
        schema: "openlifewiki.host-config/v1",
        selectedAgentId: "codex-native",
        agents: [{ id: "codex-native", runtime: "codex", mode: "native-cli" }],
      },
    }));

    const afterP0 = await updateP0Compatibility(path, 1, (compatibility) => ({
      ...compatibility,
      p0Sources: legacyConfig().sources,
    }));

    expect(afterP0.config.sources).toEqual(withV1Fields.config.sources);
    expect(afterP0.config.hostConfig).toEqual(withV1Fields.config.hostConfig);
    expect(getP0Sources(afterP0.config)).toEqual(legacyConfig().sources);
  });
});

async function configPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-config-test-"));
  temporaryRoots.push(root);
  return join(root, "config.json");
}

function legacyConfig() {
  return {
    schema: "openlifewiki.config/v1" as const,
    sources: [{
      id: "default-local",
      kind: "local-folder" as const,
      path: "/approved",
      collection: "openlifewiki-sources",
      mask: "**/*.md" as const,
      authorizedAt: "2026-07-26T00:00:00.000Z",
      enabled: true,
    }],
    agentBindings: ["codex"],
  };
}

function authorizedSource() {
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source-local",
    connectorType: "local-folder" as const,
    rootNodeId: "root-local",
    identityFingerprint: "identity-local",
    approval: testSourceApproval(),
    scope: {
      schema: "openlifewiki.scope/local-folder/v1" as const,
      root: "/approved",
      symlinkPolicy: "deny" as const,
    },
    include: ["**/*.md"],
    exclude: [],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-26T00:00:00.000Z",
  };
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) };
}

function testSourceApproval() {
  const unsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-26T00:00:00.000Z",
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    previewHash: "sha256:preview",
    configHash: "sha256:config",
    configRevision: 0,
    previousAuthorizationHash: null,
  };
  return { ...unsigned, approvalHash: sha256Canonical(unsigned) };
}
