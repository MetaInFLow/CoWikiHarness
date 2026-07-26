import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical, type OpenLifeWikiConfigV2 } from "@openlifewiki/protocol";

import {
  currentOwnerIdentityFingerprint,
  executeCodexNativeSelection,
  previewCodexNativeSelection,
  readConfigSnapshot,
  updateConfigV2,
  writeConfig,
  type CodexNativeSelectionApproval,
  type CodexNativeSelectionPreview,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("selected logged-in Codex config", () => {
  it("previews config/null without mutation and commits the exact Owner-approved CAS", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    const before = await readFile(path);

    const preview = await previewCodexNativeSelection({ configPath: path });

    expect(await readFile(path)).toEqual(before);
    expect(preview).toMatchObject({
      schema: "openlifewiki.codex-native-selection-preview/v1",
      label: "Use logged-in Codex",
      configRevision: 0,
      targetHostConfig: {
        schema: "openlifewiki.host-config/v1",
        selectedAgentId: "agent_codex_native",
        agents: [{ id: "agent_codex_native", runtime: "codex", mode: "native-cli" }],
      },
    });

    const result = await executeCodexNativeSelection({
      configPath: path,
      preview,
      approval: approvalFor(preview),
    });
    expect(result.config.revision).toBe(1);
    expect(result.config.hostConfig).toEqual(preview.targetHostConfig);
  });

  it("preserves other valid Agents and canonicalizes only the selected Codex entry", async () => {
    const path = await configPath();
    await writeConfig(path, {
      ...emptyConfig(),
      hostConfig: {
        schema: "openlifewiki.host-config/v1",
        selectedAgentId: "agent_openclaw",
        agents: [
          {
            id: "agent_openclaw",
            runtime: "openclaw",
            mode: "provider-runtime",
            provider: { credentialRef: "env://openlifewiki/provider", model: "approved-model" },
          },
          { id: "agent_codex_native", runtime: "claude", mode: "native-cli" },
        ],
      },
    });

    const preview = await previewCodexNativeSelection({ configPath: path });

    expect(preview.targetHostConfig.agents).toEqual([
      {
        id: "agent_openclaw",
        runtime: "openclaw",
        mode: "provider-runtime",
        provider: { credentialRef: "env://openlifewiki/provider", model: "approved-model" },
      },
      { id: "agent_codex_native", runtime: "codex", mode: "native-cli" },
    ]);
    const codex = preview.targetHostConfig.agents.find(({ id }) => id === "agent_codex_native");
    expect(Object.keys(codex ?? {}).sort()).toEqual(["id", "mode", "runtime"]);
  });

  it("rejects stale previews and replay after the first matching revision commits", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    const stale = await previewCodexNativeSelection({ configPath: path });
    await updateConfigV2(path, 0, (config) => config);

    await expect(executeCodexNativeSelection({
      configPath: path, preview: stale, approval: approvalFor(stale),
    })).rejects.toMatchObject({ code: "PLAN_CHANGED" });

    const current = await previewCodexNativeSelection({ configPath: path });
    const approval = approvalFor(current);
    await executeCodexNativeSelection({ configPath: path, preview: current, approval });
    await expect(executeCodexNativeSelection({ configPath: path, preview: current, approval }))
      .rejects.toMatchObject({ code: "PLAN_CHANGED" });
  });

  it("rejects a self-consistent approval from a foreign Owner", async () => {
    const path = await configPath();
    await writeConfig(path, emptyConfig());
    const preview = await previewCodexNativeSelection({ configPath: path });
    const approval = approvalFor(preview, "sha256:foreign-owner");

    await expect(executeCodexNativeSelection({ configPath: path, preview, approval }))
      .rejects.toMatchObject({ code: "PLAN_CHANGED" });
    expect((await readConfigSnapshot(path))?.config).toEqual(emptyConfig());
  });
});

function approvalFor(
  preview: CodexNativeSelectionPreview,
  ownerIdentityFingerprint = currentOwnerIdentityFingerprint(),
): CodexNativeSelectionApproval {
  const unsigned = {
    schema: "openlifewiki.codex-native-selection-approval/v1" as const,
    approvedBy: "human:owner" as const,
    approvedAt: "2026-07-27T00:00:00.000Z",
    ownerIdentityFingerprint,
    previewHash: preview.previewHash,
    configHash: preview.configHash,
    configRevision: preview.configRevision,
    targetHostConfigHash: preview.targetHostConfigHash,
  };
  return { ...unsigned, approvalHash: sha256Canonical(unsigned) };
}

function emptyConfig(): OpenLifeWikiConfigV2 {
  return {
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources: [],
    hostConfig: null,
    compatibility: { p0Sources: [], agentBindings: [] },
  };
}

async function configPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-agent-selection-test-"));
  roots.push(root);
  return join(root, "config.json");
}
