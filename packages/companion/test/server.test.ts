import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  emptyConfig,
  resolveRuntimeLayout,
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
        source: { authorized: false, mask: "**/*.md" },
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
    await writeConfig(layout.configFile, {
      schema: "openlifewiki.config/v1",
      sources: [{
        id: "default-local",
        kind: "local-folder",
        path: layout.sourcesDir,
        collection: "openlifewiki-sources",
        mask: "**/*.md",
        authorizedAt: "2026-07-22T00:00:00.000Z",
      }],
      agentBindings: [],
    });
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
});

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
