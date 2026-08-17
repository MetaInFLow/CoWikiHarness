import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openlifewiki/adapters", async () => {
  const actual = await vi.importActual<typeof import("@openlifewiki/adapters")>("@openlifewiki/adapters");
  return {
    ...actual,
    createDatabase: vi.fn(),
    PostgresKnowledgeStore: vi.fn(),
    runMigrations: vi.fn(),
  };
});

import * as adapters from "@openlifewiki/adapters";

import { runCloudCommand } from "../src/cloud-command.js";

const database = {
  query: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
};
const store = {
  bootstrap: vi.fn(),
  resolveAccessContext: vi.fn(),
  createMember: vi.fn(),
  createDelegatedAgent: vi.fn(),
  grantResource: vi.fn(),
  rotateToken: vi.fn(),
  revokeToken: vi.fn(),
};
const createDatabase = vi.mocked(adapters.createDatabase);
const PostgresKnowledgeStore = vi.mocked(adapters.PostgresKnowledgeStore);
const runMigrations = vi.mocked(adapters.runMigrations);
const temporaryRoots: string[] = [];

const ENV = {
  DATABASE_URL: "postgres://openlifewiki@example.test/openlifewiki",
  OPENLIFEWIKI_TOKEN_HMAC_SECRET: "test-secret-with-at-least-32-bytes-long",
};
const NOW = () => new Date("2026-08-16T00:00:00.000Z");
const BOOTSTRAP_RESULT = {
  orgId: "org_default",
  ownerPrincipalId: "principal_owner",
  agentPrincipalId: "principal_agent",
  delegationId: "delegation_default",
  ownerToken: "owner-token",
  agentToken: "agent-token",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  database.close.mockResolvedValue(undefined);
  createDatabase.mockReturnValue(database as never);
  runMigrations.mockResolvedValue(undefined);
  PostgresKnowledgeStore.mockImplementation(() => store as never);
  store.resolveAccessContext.mockResolvedValue({
    context: {
      schema: "openlifewiki.access-context/v1",
      orgId: "org_default",
      actorPrincipalId: "principal_owner",
      actorAgentId: null,
      onBehalfOfUserId: "principal_owner",
      delegationId: null,
      taskId: "task_owner",
    },
  });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("cloud CLI command", () => {
  it("does not create a database for V1 invocations", async () => {
    const out = vi.fn();

    await expect(runCloudCommand({ argv: ["status", "--json"], env: ENV, out, now: NOW })).resolves.toBeUndefined();
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("requires cloud configuration without requiring a model", async () => {
    const out = vi.fn();

    await expect(runCloudCommand({
      argv: ["cloud", "migrate", "--json"],
      env: {},
      out,
      now: NOW,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("runs migrations and prints one migration result", async () => {
    const out = vi.fn();

    await expect(runCloudCommand({
      argv: ["cloud", "migrate", "--json"],
      env: ENV,
      out,
      now: NOW,
    })).resolves.toBe(0);

    expect(createDatabase).toHaveBeenCalledWith({ connectionString: ENV.DATABASE_URL });
    expect(runMigrations).toHaveBeenCalledWith(
      database,
      { migrationsDir: expect.stringContaining("packages/adapters/migrations") },
    );
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toBe(
      '{"schema":"openlifewiki.cloud-migration/v1","status":"migrated"}\n',
    );
  });

  it("requires a bootstrap credential file before opening the database", async () => {
    const out = vi.fn();

    await expect(runCloudCommand({
      argv: [
        "cloud", "bootstrap",
        "--organization", "openLifeWiki",
        "--owner", "Anthony",
        "--agent", "codex",
        "--json",
      ],
      env: ENV,
      out,
      now: NOW,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("requires an absolute bootstrap credential file path", async () => {
    const out = vi.fn();

    await expect(runCloudCommand({
      argv: bootstrapArgv("bootstrap.json"),
      env: ENV,
      out,
      now: NOW,
    })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "Bootstrap credential file path must be absolute",
    });

    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("persists bootstrap credentials before commit and prints only non-secret metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-bootstrap-"));
    temporaryRoots.push(root);
    const credentialFile = join(root, "bootstrap.json");
    const out = vi.fn();
    store.bootstrap.mockImplementation(async (_input, options) => {
      await options.beforeCommit(BOOTSTRAP_RESULT);
      return BOOTSTRAP_RESULT;
    });

    await expect(runCloudCommand({
      argv: bootstrapArgv(credentialFile),
      env: ENV,
      out,
      now: NOW,
    })).resolves.toBe(0);

    expect(store.bootstrap).toHaveBeenCalledWith(
      {
        organizationName: "openLifeWiki",
        ownerDisplayName: "Anthony",
        agentDisplayName: "codex",
        delegationExpiresAt: "2027-08-16T00:00:00.000Z",
      },
      { beforeCommit: expect.any(Function) },
    );
    expect(JSON.parse(await readFile(credentialFile, "utf8"))).toEqual(BOOTSTRAP_RESULT);
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.mock.calls[0]?.[0] ?? "")).toEqual({
      schema: "openlifewiki.cloud-bootstrap/v1",
      status: "credentials-persisted",
      credentialFile,
      orgId: BOOTSTRAP_RESULT.orgId,
      ownerPrincipalId: BOOTSTRAP_RESULT.ownerPrincipalId,
      agentPrincipalId: BOOTSTRAP_RESULT.agentPrincipalId,
      delegationId: BOOTSTRAP_RESULT.delegationId,
    });
    expect(out.mock.calls[0]?.[0]).not.toContain("ownerToken");
    expect(out.mock.calls[0]?.[0]).not.toContain("agentToken");
    expect(out.mock.calls[0]?.[0]).not.toContain("owner-token");
    expect(out.mock.calls[0]?.[0]).not.toContain("agent-token");
    expect(out.mock.calls[0]?.[0]).not.toContain("digest");
  });

  it("rejects an existing bootstrap credential file inside the transaction hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-bootstrap-existing-"));
    temporaryRoots.push(root);
    const credentialFile = join(root, "bootstrap.json");
    await writeFile(credentialFile, "existing\n", { mode: 0o600 });
    const out = vi.fn();
    let committed = false;
    store.bootstrap.mockImplementation(async (_input, options) => {
      await options.beforeCommit(BOOTSTRAP_RESULT);
      committed = true;
      return BOOTSTRAP_RESULT;
    });

    await expect(runCloudCommand({
      argv: bootstrapArgv(credentialFile),
      env: ENV,
      out,
      now: NOW,
    })).rejects.toThrow("Bootstrap credential file already exists");

    expect(store.bootstrap).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    expect(await readFile(credentialFile, "utf8")).toBe("existing\n");
    expect(await readdir(root)).toEqual(["bootstrap.json"]);
    expect(out).not.toHaveBeenCalled();
  });

  it("prevents bootstrap commit when credential persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-bootstrap-missing-parent-"));
    temporaryRoots.push(root);
    const credentialFile = join(root, "missing", "bootstrap.json");
    const out = vi.fn();
    let committed = false;
    store.bootstrap.mockImplementation(async (_input, options) => {
      await options.beforeCommit(BOOTSTRAP_RESULT);
      committed = true;
      return BOOTSTRAP_RESULT;
    });

    await expect(runCloudCommand({
      argv: bootstrapArgv(credentialFile),
      env: ENV,
      out,
      now: NOW,
    })).rejects.toThrow("Bootstrap credential parent directory is unavailable");

    expect(store.bootstrap).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    expect(out).not.toHaveBeenCalled();
  });

  it("supports owner-managed member, agent, grant, rotation and revoke commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "openlifewiki-cloud-command-"));
    temporaryRoots.push(root);
    const ownerTokenFile = join(root, "owner-token");
    await writeFile(ownerTokenFile, "owner-token\n", { mode: 0o600 });
    const out = vi.fn();
    store.createMember.mockResolvedValue({ principal: { principalId: "principal_member" }, tokenId: "token_member", token: "member-token" });
    store.createDelegatedAgent.mockResolvedValue({
      principal: { principalId: "principal_agent_2" },
      delegation: { delegationId: "delegation_2" },
      tokenId: "token_agent",
      token: "agent-token",
    });
    store.grantResource.mockResolvedValue({ grantId: "grant_1" });
    store.rotateToken.mockResolvedValue({ tokenId: "token_rotated", principalId: "principal_agent_2", token: "rotated-token" });
    store.revokeToken.mockResolvedValue(undefined);

    const commands: readonly (readonly string[])[] = [
      ["cloud", "member", "create", "--name", "Member-2", "--owner-token-file", ownerTokenFile, "--json"],
      ["cloud", "agent", "create", "--name", "Agent-2", "--for-user", "principal_user_2", "--owner-token-file", ownerTokenFile, "--json"],
      ["cloud", "grant", "--principal", "principal_user_2", "--scope", "item:item_1", "--capability", "knowledge.query", "--owner-token-file", ownerTokenFile, "--json"],
      ["cloud", "token", "rotate", "--principal", "principal_agent_2", "--owner-token-file", ownerTokenFile, "--json"],
      ["cloud", "token", "revoke", "--token-id", "token_1", "--owner-token-file", ownerTokenFile, "--json"],
    ];

    for (const argv of commands) {
      await expect(runCloudCommand({ argv, env: ENV, out, now: NOW })).resolves.toBe(0);
    }

    expect(store.createMember).toHaveBeenCalledWith({
      ownerContext: expect.objectContaining({ orgId: "org_default" }),
      displayName: "Member-2",
    });
    expect(store.createDelegatedAgent).toHaveBeenCalledWith(expect.objectContaining({
      userPrincipalId: "principal_user_2",
      displayName: "Agent-2",
      resourceScopes: [{ kind: "organization", id: "org_default" }],
    }));
    expect(store.grantResource).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "principal_user_2",
      scope: { kind: "item", id: "item_1" },
      capabilities: ["knowledge.query"],
    }));
    expect(store.rotateToken).toHaveBeenCalledWith(expect.objectContaining({ principalId: "principal_agent_2" }));
    expect(store.revokeToken).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token_1" }));
    expect(out).toHaveBeenCalledTimes(commands.length);
    expect(out.mock.calls.every(([value]) => !String(value).includes("digest"))).toBe(true);
  });
});

function bootstrapArgv(credentialFile: string): readonly string[] {
  return [
    "cloud", "bootstrap",
    "--organization", "openLifeWiki",
    "--owner", "Anthony",
    "--agent", "codex",
    "--credential-file", credentialFile,
    "--json",
  ];
}
