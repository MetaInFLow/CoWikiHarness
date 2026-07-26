import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  emptyConfig,
  resolveRuntimeLayout,
  updateP0Compatibility,
  writeConfig,
  writeJsonAtomic,
  type CommandRunner,
} from "@openlifewiki/adapters";
import type { DurableStateV1 } from "@openlifewiki/protocol";

import { companionServerStatus, startCompanionServer } from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Management Companion server", () => {
  it("serves the product shell and protects every API with the local token", async () => {
    const layout = await preparedLayout(true);
    const calls: string[] = [];
    const runner = fakeRunner(layout, calls);
    const handle = await startCompanionServer({
      layout,
      runner,
      repoRoot: "/tmp/openlifewiki-repo",
      token: "contract-token",
      port: 0,
    });

    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const shell = await fetch(origin);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await shell.text()).toContain("Management Companion");

      const unauthorized = await fetch(`${origin}/api/status`);
      expect(unauthorized.status).toBe(401);

      const foreignOrigin = await fetch(`${origin}/api/status`, {
        headers: {
          Origin: "https://example.com",
          "X-openLifeWiki-Session": "contract-token",
        },
      });
      expect(foreignOrigin.status).toBe(401);

      const response = await api(origin, "/api/status", "contract-token");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        schema: "openlifewiki.companion-status/v1",
        stableState: "INITIALIZED",
        source: {
          authorized: false,
          count: 0,
          path: null,
          collection: null,
          mask: null,
          items: [],
        },
        mcp: { ready: false, registered: false },
      });
    } finally {
      await handle.close();
    }

    await expect(companionServerStatus(layout)).resolves.toMatchObject({ status: "stopped" });
  });

  it("requires the current plan digest and opens only the fixed workspace", async () => {
    const layout = await preparedLayout(true);
    const calls: string[] = [];
    const handle = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, calls),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "operation-token",
      port: 0,
    });

    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const preview = await api(origin, "/api/operations/activate/preview", "operation-token", {
        method: "POST",
        body: "{}",
      });
      const previewBody = await preview.json() as { digest: string; plan: { source: { path: string } } };
      expect(previewBody.plan.source.path).toBe(layout.sourcesDir);

      const rejected = await api(origin, "/api/operations/activate/execute", "operation-token", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, digest: "wrong" }),
      });
      expect(rejected.status).toBe(409);

      const executed = await api(origin, "/api/operations/activate/execute", "operation-token", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, digest: previewBody.digest }),
      });
      expect(executed.status).toBe(200);
      expect(await executed.json()).toMatchObject({
        result: { status: "source-empty", stableState: "INITIALIZED" },
      });

      const opened = await api(origin, "/api/actions/open-workspace", "operation-token", {
        method: "POST",
        body: JSON.stringify({ path: "/tmp/foreign" }),
      });
      expect(opened.status).toBe(200);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      expect(calls).toContain(`${opener} ${layout.workspaceRoot}`);
      expect(calls.some((call) => call.includes("/tmp/foreign"))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("renders INSTALLED before initialization without probing QMD", async () => {
    const layout = await preparedLayout(false);
    const calls: string[] = [];
    const handle = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, calls),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "installed-token",
      port: 0,
    });

    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const response = await api(origin, "/api/status", "installed-token");
      expect(await response.json()).toMatchObject({
        stableState: "INSTALLED",
        nextAction: "initialize",
      });
      expect(calls.some((call) => call.includes("--version"))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("registers the exact source-checkout MCP through the Codex CLI", async () => {
    const layout = await preparedLayout(true);
    await updateP0Compatibility(layout.configFile, 0, (compatibility) => ({
      ...compatibility,
      p0Sources: [{
        id: "default-local",
        kind: "local-folder",
        path: layout.sourcesDir,
        collection: "openlifewiki-sources",
        mask: "**/*.md",
        authorizedAt: "2026-07-22T00:00:00.000Z",
      }],
    }));
    await writeJsonAtomic(layout.stateFile, { ...initializedState(), stableState: "ACTIVE" });
    const calls: string[] = [];
    let registered = false;
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        if (command === layout.qmdExecutable && args[0] === "--version") {
          return { stdout: "qmd 2.5.3\n", stderr: "" };
        }
        if (command === "codex" && args[0] === "mcp" && args[1] === "get") {
          if (!registered) throw new Error("not registered");
          return {
            stdout: JSON.stringify({
              transport: {
                type: "stdio",
                command: "pnpm",
                args: ["--dir", "/tmp/openlifewiki-repo", "openlifewiki", "mcp", "--stdio"],
              },
            }),
            stderr: "",
          };
        }
        if (command === "codex" && args[0] === "mcp" && args[1] === "add") {
          registered = true;
        }
        return { stdout: "ok\n", stderr: "" };
      },
    };
    const handle = await startCompanionServer({
      layout,
      runner,
      repoRoot: "/tmp/openlifewiki-repo",
      token: "registration-token",
      port: 0,
    });

    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const planResponse = await api(origin, "/api/mcp/codex-config", "registration-token");
      const plan = await planResponse.json() as { digest: string; ready: boolean; registered: boolean };
      expect(plan).toMatchObject({ ready: true, registered: false });

      const response = await api(origin, "/api/mcp/register", "registration-token", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, digest: plan.digest }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ registered: true, status: { mcp: { registered: true } } });
      expect(calls.some((call) => call.includes("codex mcp add --env") && call.includes("openlifewiki mcp --stdio")))
        .toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("reports historical subfolder P0 Sources without implicitly selecting a default", async () => {
    const layout = await preparedLayout(false);
    await mkdir(layout.sourcesDir, { recursive: true });
    await writeConfig(layout.configFile, {
      schema: "openlifewiki.config/v1",
      sources: [{
        id: "local-historical-feishu", kind: "local-folder", path: join(layout.sourcesDir, "feishu"),
        collection: "openlifewiki-feishu", mask: "**/*.md",
        authorizedAt: "2026-07-22T00:00:00.000Z", enabled: true,
      }],
      agentBindings: ["codex"],
    });
    await writeJsonAtomic(layout.stateFile, { ...initializedState(), stableState: "ACTIVE" });
    const handle = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, []),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "historical-source-token",
      port: 0,
    });

    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const historical = await api(origin, "/api/status", "historical-source-token");
      expect(await historical.json()).toMatchObject({
        stableState: "ACTIVE",
        source: {
          authorized: true,
          count: 1,
          path: join(layout.sourcesDir, "feishu"),
          collection: "openlifewiki-feishu",
          mask: "**/*.md",
          items: [{
            id: "local-historical-feishu",
            path: join(layout.sourcesDir, "feishu"),
            collection: "openlifewiki-feishu",
            mask: "**/*.md",
            enabled: true,
          }],
        },
      });

      await writeConfig(layout.configFile, {
        schema: "openlifewiki.config/v1",
        sources: [
          {
            id: "local-historical-feishu", kind: "local-folder", path: join(layout.sourcesDir, "feishu"),
            collection: "openlifewiki-feishu", mask: "**/*.md",
            authorizedAt: "2026-07-22T00:00:00.000Z", enabled: true,
          },
          {
            id: "local-historical-github", kind: "local-folder", path: join(layout.sourcesDir, "github"),
            collection: "openlifewiki-github", mask: "**/*.md",
            authorizedAt: "2026-07-23T00:00:00.000Z", enabled: true,
          },
        ],
        agentBindings: ["codex"],
      });
      const multiple = await api(origin, "/api/status", "historical-source-token");
      expect(await multiple.json()).toMatchObject({
        stableState: "ACTIVE",
        source: { authorized: true, count: 2, path: null, collection: null, mask: null },
      });
      const multipleBody = await api(origin, "/api/status", "historical-source-token");
      const value = await multipleBody.json() as { source: { items: Array<{ id: string; path: string; enabled?: boolean }> } };
      expect(value.source.items).toEqual([
        expect.objectContaining({ id: "local-historical-feishu", path: join(layout.sourcesDir, "feishu"), enabled: true }),
        expect.objectContaining({ id: "local-historical-github", path: join(layout.sourcesDir, "github"), enabled: true }),
      ]);
    } finally {
      await handle.close();
    }
  });

  it("serves four Connector rows from one revision across restart", async () => {
    const layout = await preparedLayout(true);
    const first = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, []),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "sources-token",
      port: 0,
    });
    let firstBody: { revision: number; sources: Array<{ connectorType: string }> };
    try {
      const origin = `http://127.0.0.1:${first.info.port}`;
      const response = await api(origin, "/api/sources", "sources-token");
      expect(response.status).toBe(200);
      firstBody = await response.json() as typeof firstBody;
      expect(firstBody.sources.map(({ connectorType }) => connectorType)).toEqual([
        "local-folder", "github", "feishu", "codex-history",
      ]);
    } finally {
      await first.close();
    }

    const second = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, []),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "sources-token-2",
      port: 0,
    });
    try {
      const origin = `http://127.0.0.1:${second.info.port}`;
      const response = await api(origin, "/api/sources", "sources-token-2");
      const body = await response.json() as typeof firstBody;
      expect(body.revision).toBe(firstBody!.revision);
      expect(body.sources).toHaveLength(4);
    } finally {
      await second.close();
    }
  });

  it("protects exact Source authorization preview and execution with session and digest", async () => {
    const layout = await preparedLayout(true);
    const handle = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, []),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "source-auth-token",
      port: 0,
    });
    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const request = localAuthorizationRequest(layout.sourcesDir);
      const unauthorized = await fetch(`${origin}/api/sources/authorization/preview`, {
        method: "POST", body: JSON.stringify({ request }),
      });
      expect(unauthorized.status).toBe(401);

      const previewResponse = await api(origin, "/api/sources/authorization/preview", "source-auth-token", {
        method: "POST", body: JSON.stringify({ request }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { previewHash: string };

      const stale = await api(origin, "/api/sources/authorization/execute", "source-auth-token", {
        method: "POST", body: JSON.stringify({ request, confirmed: true, digest: "sha256:stale" }),
      });
      expect(stale.status).toBe(409);

      const executed = await api(origin, "/api/sources/authorization/execute", "source-auth-token", {
        method: "POST", body: JSON.stringify({ request, confirmed: true, digest: preview.previewHash }),
      });
      expect(executed.status).toBe(200);
      const sources = await api(origin, "/api/sources", "source-auth-token");
      const sourceStatus = await sources.json() as {
        revision: number;
        sources: Array<{ connectorType: string; status: string }>;
      };
      expect(sourceStatus.revision).toBe(1);
      expect(sourceStatus.sources.find(({ connectorType }) => connectorType === "local-folder"))
        .toMatchObject({ status: "connected" });
    } finally {
      await handle.close();
    }
  });

  it("migrates legacy config only through the current session and exact Owner digest", async () => {
    const layout = await preparedLayout(false);
    await writeConfig(layout.configFile, {
      schema: "openlifewiki.config/v1",
      sources: [{
        id: "default-local", kind: "local-folder", path: layout.sourcesDir,
        collection: "openlifewiki-sources", mask: "**/*.md",
        authorizedAt: "2026-07-22T00:00:00.000Z", enabled: true,
      }],
      agentBindings: ["codex"],
    });
    const handle = await startCompanionServer({
      layout,
      runner: fakeRunner(layout, []),
      repoRoot: "/tmp/openlifewiki-repo",
      token: "migration-token",
      port: 0,
    });
    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const legacySources = await api(origin, "/api/sources", "migration-token");
      expect(await legacySources.json()).toMatchObject({
        revision: null,
        migrationRequired: true,
        authorizations: [],
      });
      const previewResponse = await api(origin, "/api/config/migration/preview", "migration-token", {
        method: "POST", body: "{}",
      });
      const preview = await previewResponse.json() as { previewHash: string; preservedP0Sources: number; v1AuthorizationsAdded: number };
      expect(preview).toMatchObject({ preservedP0Sources: 1, v1AuthorizationsAdded: 0 });

      const stale = await api(origin, "/api/config/migration/execute", "migration-token", {
        method: "POST", body: JSON.stringify({ confirmed: true, digest: "sha256:stale" }),
      });
      expect(stale.status).toBe(409);

      const execute = await api(origin, "/api/config/migration/execute", "migration-token", {
        method: "POST", body: JSON.stringify({ confirmed: true, digest: preview.previewHash }),
      });
      expect(execute.status).toBe(200);
      expect(await execute.json()).toMatchObject({ revision: 0 });

      const sources = await api(origin, "/api/sources", "migration-token");
      expect(await sources.json()).toMatchObject({ revision: 0, migrationRequired: false });
    } finally {
      await handle.close();
    }
  });

  it("redacts unexpected provider and filesystem errors from the public API", async () => {
    const layout = await preparedLayout(true);
    const handle = await startCompanionServer({
      layout,
      runner: { async run() { throw new Error("raw-secret-provider-output"); } },
      repoRoot: "/tmp/openlifewiki-repo",
      token: "redaction-token",
      port: 0,
    });
    try {
      const origin = `http://127.0.0.1:${handle.info.port}`;
      const response = await api(origin, "/api/actions/open-workspace", "redaction-token", {
        method: "POST", body: "{}",
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain("Local management request failed");
      expect(text).not.toContain("raw-secret-provider-output");
    } finally {
      await handle.close();
    }
  });
});

function localAuthorizationRequest(root: string) {
  return {
    schema: "openlifewiki.source-authorization-request/v1",
    sourceId: "source-local",
    connectorType: "local-folder",
    rootNodeId: "root",
    scope: { schema: "openlifewiki.scope/local-folder/v1", root, symlinkPolicy: "within-root" },
    include: ["**/*.md"],
    exclude: [".git/**"],
    sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 1000, maxBodyBytes: 10_000_000, maxAgentCalls: 100 },
  };
}

async function preparedLayout(initialized: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "openlifewiki-companion-test-"));
  temporaryRoots.push(temporary);
  const layout = resolveRuntimeLayout({
    OPENLIFEWIKI_HOME: join(temporary, "runtime"),
    OPENLIFEWIKI_WORKSPACE: join(temporary, "workspace"),
  });
  if (initialized) {
    await mkdir(layout.sourcesDir, { recursive: true });
    await writeConfig(layout.configFile, emptyConfig());
    await writeJsonAtomic(layout.stateFile, initializedState());
  }
  return layout;
}

function initializedState(): DurableStateV1 {
  return {
    schema: "openlifewiki.state/v1",
    stableState: "INITIALIZED",
    completedAt: "2026-07-22T00:00:00.000Z",
    components: [{
      id: "qmd",
      version: "2.5.3",
      integrity: "sha512-example",
      executable: "/tmp/qmd",
      installedAt: "2026-07-22T00:00:00.000Z",
    }],
  };
}

function fakeRunner(layout: ReturnType<typeof resolveRuntimeLayout>, calls: string[]): CommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      if (command === layout.qmdExecutable && args[0] === "--version") {
        return { stdout: "qmd 2.5.3\n", stderr: "" };
      }
      if (command === "codex" && args[0] === "mcp" && args[1] === "get") {
        throw new Error("not registered");
      }
      return { stdout: "ok\n", stderr: "" };
    },
  };
}

async function api(
  origin: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-openLifeWiki-Session": token,
      ...(init.headers ?? {}),
    },
  });
}
