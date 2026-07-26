import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical, type AuthorizedSourceV1 } from "@openlifewiki/protocol";

import {
  listConnectorStatuses,
  probeSourceCandidate,
  type CommandRunner,
} from "../src/index.js";

const roots: string[] = [];
const now = () => new Date("2026-07-26T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("metadata-only Connector probes", () => {
  it("keeps all four ordered rows visible without invoking an unauthorized provider", async () => {
    const calls: string[] = [];
    const statuses = await listConnectorStatuses({
      sources: [], runner: recordingRunner(calls), now,
    });

    expect(statuses.map(({ connectorType }) => connectorType)).toEqual([
      "local-folder", "github", "feishu", "codex-history",
    ]);
    expect(statuses.every(({ status, changedItems, lastScan }) => (
      status === "auth-required" && changedItems === 0 && lastScan === undefined
    ))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("probes Local Folder with filesystem metadata and no external or body command", async () => {
    const root = await temporaryRoot("local");
    const calls: string[] = [];
    const status = await probeSourceCandidate({
      source: localSource(root), runner: recordingRunner(calls), now,
    });

    expect(status).toMatchObject({
      connectorType: "local-folder", status: "connected", providerProject: "openLifeWiki",
      identity: { profile: "local" }, changedItems: 0,
    });
    expect(status.identity?.fingerprint).toMatch(/^sha256:/u);
    expect(calls).toEqual([]);
  });

  it("invalidates a persisted authorization when the current identity fingerprint changes", async () => {
    const root = await temporaryRoot("identity-drift");
    const statuses = await listConnectorStatuses({
      sources: [localSource(root)], runner: recordingRunner([]), now,
    });
    expect(statuses[0]).toMatchObject({
      connectorType: "local-folder", status: "blocked",
      blocking: { code: "SOURCE_IDENTITY_CHANGED" },
    });
  });

  it("uses only GitHub version, active auth and approved repository metadata", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (line === "gh --version") return { stdout: "gh version 2.87.3\n", stderr: "" };
        if (line === "gh auth status --active --hostname github.com --json hosts") {
          return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "HaodiFan", active: true }] } }), stderr: "" };
        }
        if (line === "gh repo view MetaInFLow/openLifeWiki --json nameWithOwner,url,defaultBranchRef") {
          return { stdout: JSON.stringify({ nameWithOwner: "MetaInFLow/openLifeWiki", url: "https://github.com/MetaInFLow/openLifeWiki" }), stderr: "" };
        }
        throw new Error(`Unexpected provider command ${line}`);
      },
    };
    const status = await probeSourceCandidate({ source: githubSource(), runner, now });

    expect(status).toMatchObject({ connectorType: "github", status: "connected", identity: { account: "H***n" } });
    expect(status.identity?.fingerprint).toMatch(/^sha256:/u);
    expect(calls.join(" ")).not.toMatch(/show-token|contents|graphql|api /iu);
  });

  it("passes the approved Feishu profile on every call and safely reports tenant drift", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (args.at(-1) === "--version") return { stdout: "lark-cli 1.0.64\n", stderr: "" };
        return {
          stdout: JSON.stringify({ verified: true, tenant_id: "other-tenant", name: "Anthony.F", scopes: ["wiki:read"] }),
          stderr: "raw-provider-secret-must-not-surface",
        };
      },
    };
    const status = await probeSourceCandidate({ source: feishuSource(), runner, now });

    expect(calls).toEqual([
      "lark-cli --profile metainflow-feishu --version",
      "lark-cli --profile metainflow-feishu auth status --json --verify",
    ]);
    expect(status).toMatchObject({
      connectorType: "feishu", status: "blocked",
      identity: { profile: "metainflow-feishu", account: "A***F", tenant: "o***t", effectiveScope: "wiki:read" },
      blocking: { code: "FEISHU_TENANT_MISMATCH" },
    });
    expect(JSON.stringify(status)).not.toContain("raw-provider-secret");
  });

  it("blocks a Codex app-server schema mismatch without listing or reading threads and removes scratch", async () => {
    const scratchRoot = await temporaryRoot("codex-scratch");
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (line === "codex --version") return { stdout: "codex-cli 0.146.0\n", stderr: "" };
        if (line === "codex login status") return { stdout: "Logged in using ChatGPT\n", stderr: "" };
        if (args[0] === "app-server" && args[1] === "generate-json-schema") {
          const out = args[3]!;
          await mkdir(out, { recursive: true });
          await writeFile(join(out, "schema.json"), JSON.stringify({ methods: ["thread/list"] }));
          return { stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected provider command ${line}`);
      },
    };
    const status = await probeSourceCandidate({ source: codexSource(), runner, now, scratchRoot });

    expect(status).toMatchObject({ status: "blocked", blocking: { code: "CODEX_SCHEMA_MISMATCH" } });
    expect(calls.some((call) => /thread (list|read)|thread\/(list|read) /u.test(call))).toBe(false);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("accepts the required Codex app-server v2 schema and still performs zero history reads", async () => {
    const scratchRoot = await temporaryRoot("codex-schema");
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (line === "codex --version") return { stdout: "codex-cli 0.146.0\n", stderr: "" };
        if (line === "codex login status") return { stdout: "Logged in using ChatGPT\n", stderr: "" };
        const out = args[3]!;
        await mkdir(out, { recursive: true });
        await writeFile(join(out, "schema.json"), JSON.stringify({
          methods: ["thread/list", "thread/read"], properties: {
            cwd: {}, cursor: {}, useStateDbOnly: {}, threadId: {}, includeTurns: {},
          },
        }));
        return { stdout: "", stderr: "" };
      },
    };
    const status = await probeSourceCandidate({ source: codexSource(), runner, now, scratchRoot });
    expect(status).toMatchObject({ status: "connected", identity: { account: "ChatGPT login" } });
    expect(calls).toHaveLength(3);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("reuses the approved Codex contract across status refreshes and blocks a version change", async () => {
    const contractHash = "sha256:approved-contract";
    const source = {
      ...codexSource(),
      identityFingerprint: sha256Canonical({
        provider: "codex", version: "0.146.0", loginMode: "ChatGPT login", schema: contractHash,
      }),
      providerObservation: {
        providerName: "codex app-server v2", providerVersion: "0.146.0", contractHash,
      },
    };
    let version = "0.146.0";
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (line === "codex --version") return { stdout: `codex-cli ${version}\n`, stderr: "" };
        if (line === "codex login status") return { stdout: "Logged in using ChatGPT\n", stderr: "" };
        throw new Error("Schema generation must not repeat for an unchanged approved version");
      },
    };

    const first = await listConnectorStatuses({ sources: [source], runner, now });
    const second = await listConnectorStatuses({ sources: [source], runner, now });
    expect(first[3]).toMatchObject({ status: "connected", providerContractHash: contractHash });
    expect(second[3]).toMatchObject({ status: "connected", providerContractHash: contractHash });
    expect(calls.filter((call) => call.includes("generate-json-schema"))).toHaveLength(0);

    version = "0.147.0";
    const changed = await listConnectorStatuses({ sources: [source], runner, now });
    expect(changed[3]).toMatchObject({ status: "blocked", blocking: { code: "CODEX_VERSION_CHANGED" } });
    expect(calls.filter((call) => call.includes("generate-json-schema"))).toHaveLength(0);
  });
});

function recordingRunner(calls: string[]): CommandRunner {
  return { async run(command, args) { calls.push([command, ...args].join(" ")); return { stdout: "", stderr: "" }; } };
}

function base(connectorType: AuthorizedSourceV1["connectorType"], scope: Readonly<Record<string, unknown>>): AuthorizedSourceV1 {
  return {
    schema: "openlifewiki.authorized-source/v1", sourceId: `source-${connectorType}`,
    connectorType, rootNodeId: "root", identityFingerprint: "approved-identity", scope,
    include: [], exclude: [], sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 1000, maxAgentCalls: 10 },
    approvedBy: "human:owner", approvedAt: "2026-07-26T00:00:00.000Z", authorizationHash: "sha256:approved",
  };
}

function localSource(root: string) {
  return base("local-folder", { schema: "openlifewiki.scope/local-folder/v1", root, symlinkPolicy: "within-root" });
}
function githubSource() {
  return base("github", { schema: "openlifewiki.scope/github/v1", hostname: "github.com", repository: "MetaInFLow/openLifeWiki", path: null, ref: "main" });
}
function feishuSource() {
  return base("feishu", { schema: "openlifewiki.scope/feishu/v1", profile: "metainflow-feishu", expectedTenantId: "tenant-1", documentIds: ["doc-a"], wikiNodeIds: [], baseIds: [] });
}
function codexSource() {
  return base("codex-history", { schema: "openlifewiki.scope/codex-history/v1", projectRoots: ["/projects/openLifeWiki"], threadIds: ["thread-a"] });
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `openlifewiki-${label}-`));
  roots.push(root);
  return root;
}
