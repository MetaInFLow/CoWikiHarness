import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveRuntimeLayout,
  type CommandRunner,
  type InteractiveProcessRunner,
} from "@openlifewiki/adapters";
import type { DurableStateV1 } from "@openlifewiki/protocol";

import { main, type CliIo } from "../src/main.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("openlifewiki CLI", () => {
  it("shows the required bootstrap credential file in top-level help", async () => {
    const capture = createCapture();

    await expect(main(["--help"], await context(), capture.io)).resolves.toBe(0);

    expect(capture.stdout.join("")).toContain(
      "cloud bootstrap --organization <name> --owner <name> --agent <name> --credential-file <absolute-path> --json",
    );
  });

  it("reports the full lifecycle and defers later components", async () => {
    const capture = createCapture();
    await expect(main(["lifecycle", "--json"], await context(), capture.io)).resolves.toBe(0);
    const result = JSON.parse(capture.stdout[0]!);

    expect(result.stages.map(({ id }: { id: string }) => id)).toEqual([
      "discover",
      "install",
      "initialize",
      "activate",
      "use",
      "maintain",
      "uninstall",
    ]);
    expect(result.components.filter(({ firstRequiredStage }: { firstRequiredStage: string }) => (
      firstRequiredStage === "initialize"
    )).map(({ id }: { id: string }) => id)).toEqual(["qmd"]);
  });

  it("reports INSTALLED before initialization", async () => {
    const capture = createCapture();
    await expect(main(["status", "--json"], await context(), capture.io)).resolves.toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      schema: "openlifewiki.status/v1",
      stableState: "INSTALLED",
      ready: false,
      nextAction: "initialize",
    });
  });

  it("keeps init dry-run read-only", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const capture = createCapture();
    await expect(main(
      ["init", "--dry-run", "--json"],
      { layout: testLayout(root), runner: noOpRunner },
      capture.io,
    )).resolves.toBe(0);

    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({ approvalRequired: true });
    await expect(access(root)).rejects.toThrow();
  });

  it("rejects initialization without an explicit mode", async () => {
    const capture = createCapture();
    await expect(main(["init", "--json"], await context(), capture.io)).resolves.toBe(2);
    expect(JSON.parse(capture.stderr[0]!)).toMatchObject({ code: "INVALID_INVOCATION" });
  });

  it("previews activation without reading the Source", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const capture = createCapture();

    await expect(main(
      ["activate", "--dry-run", "--json"],
      { layout: testLayout(root), runner: noOpRunner },
      capture.io,
    )).resolves.toBe(0);

    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      schema: "openlifewiki.activation-plan/v1",
      approvalRequired: true,
      source: { path: join(root, "workspace", "sources") },
    });
    await expect(access(root)).rejects.toThrow();
  });

  it("delegates the stdio MCP launch without writing protocol output", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await Promise.all([
      mkdir(layout.root, { recursive: true }),
      mkdir(layout.sourcesDir, { recursive: true }),
    ]);
    await writeFile(layout.stateFile, `${JSON.stringify(activeState())}\n`);
    await writeFile(layout.configFile, `${JSON.stringify({
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
    })}\n`);
    const capture = createCapture();
    const launches: string[] = [];
    const interactiveRunner: InteractiveProcessRunner = {
      async run(command, args, options) {
        launches.push(`${command} ${args.join(" ")} ${options.cwd} ${options.env.QMD_CONFIG_DIR}`);
        return 0;
      },
    };
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return { stdout: "qmd 2.5.3\n", stderr: "" };
        if (args[0] === "collection" && args[1] === "list") {
          return { stdout: "openlifewiki-sources (qmd://openlifewiki-sources/)\n", stderr: "" };
        }
        if (args[0] === "collection" && args[1] === "show") {
          return {
            stdout: `Collection: openlifewiki-sources\n  Path: ${layout.sourcesDir}\n  Pattern: **/*.md\n`,
            stderr: "",
          };
        }
        return { stdout: "updated\n", stderr: "" };
      },
    };

    await expect(main(
      ["mcp", "--stdio"],
      { layout, runner, interactiveRunner },
      capture.io,
    )).resolves.toBe(0);

    expect(capture.stdout).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(launches).toEqual([
      `${layout.qmdExecutable} mcp ${layout.root} ${layout.qmdConfigDir}`,
    ]);
  });

  it("lists all four Connector rows even when none is authorized", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await mkdir(layout.root, { recursive: true });
    await writeFile(layout.configFile, `${JSON.stringify(emptyV2())}\n`);
    const capture = createCapture();

    await expect(main(["sources", "list", "--json"], { layout, runner: noOpRunner }, capture.io)).resolves.toBe(0);
    const value = JSON.parse(capture.stdout[0]!);
    expect(value.sources.map(({ connectorType }: { connectorType: string }) => connectorType)).toEqual([
      "local-folder", "github", "feishu", "codex-history",
    ]);
  });

  it("recognizes a historical enabled config/v1 Source as migration-required", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await mkdir(layout.root, { recursive: true });
    await writeFile(layout.configFile, `${JSON.stringify({
      schema: "openlifewiki.config/v1",
      sources: [{
        id: "default-local", kind: "local-folder", path: layout.sourcesDir,
        collection: "openlifewiki-sources", mask: "**/*.md",
        authorizedAt: "2026-07-22T00:00:00.000Z", enabled: true,
      }],
      agentBindings: ["codex"],
    })}\n`);
    const capture = createCapture();

    await expect(main(["sources", "list", "--json"], { layout, runner: noOpRunner }, capture.io)).resolves.toBe(1);
    expect(JSON.parse(capture.stderr[0]!)).toMatchObject({ code: "CONFIG_MIGRATION_REQUIRED" });
    expect(capture.stderr[0]).not.toContain("CONFIG_INVALID");
  });

  it("authorizes from a request file only after exact digest approval", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await Promise.all([mkdir(layout.root, { recursive: true }), mkdir(layout.sourcesDir, { recursive: true })]);
    await writeFile(layout.configFile, `${JSON.stringify(emptyV2())}\n`);
    const requestFile = join(root, "local-source-request.json");
    await writeFile(requestFile, JSON.stringify(localAuthorizationRequest(layout.sourcesDir)));

    const previewCapture = createCapture();
    await expect(main([
      "sources", "authorize", "--request-file", requestFile, "--dry-run", "--json",
    ], { layout, runner: noOpRunner, now: fixedNow }, previewCapture.io)).resolves.toBe(0);
    const preview = JSON.parse(previewCapture.stdout[0]!) as { previewHash: string };

    const staleCapture = createCapture();
    await expect(main([
      "sources", "authorize", "--request-file", requestFile,
      "--digest", "sha256:stale", "--yes", "--json",
    ], { layout, runner: noOpRunner, now: fixedNow }, staleCapture.io)).resolves.toBe(1);
    expect(JSON.parse(staleCapture.stderr[0]!)).toMatchObject({ code: "PLAN_CHANGED" });

    const executeCapture = createCapture();
    await expect(main([
      "sources", "authorize", "--request-file", requestFile,
      "--digest", preview.previewHash, "--yes", "--json",
    ], { layout, runner: noOpRunner, now: fixedNow }, executeCapture.io)).resolves.toBe(0);
    expect(JSON.parse(executeCapture.stdout[0]!)).toMatchObject({
      source: { sourceId: "source-local", approvedBy: "human:owner" },
    });

    const revokePreviewCapture = createCapture();
    await expect(main([
      "sources", "revoke", "--source-id", "source-local", "--dry-run", "--json",
    ], { layout, runner: noOpRunner }, revokePreviewCapture.io)).resolves.toBe(0);
    const revoke = JSON.parse(revokePreviewCapture.stdout[0]!) as { previewHash: string };
    const revokeCapture = createCapture();
    await expect(main([
      "sources", "revoke", "--source-id", "source-local",
      "--digest", revoke.previewHash, "--yes", "--json",
    ], { layout, runner: noOpRunner }, revokeCapture.io)).resolves.toBe(0);
    expect(JSON.parse(revokeCapture.stdout[0]!)).toMatchObject({ sourceId: "source-local", revoked: true });
  });

  it("rejects Source scope values in argv and incomplete approval modes", async () => {
    const capture = createCapture();
    await expect(main([
      "sources", "authorize", "--repository", "owner/repo", "--yes", "--json",
    ], await context(), capture.io)).resolves.toBe(2);
    expect(JSON.parse(capture.stderr[0]!)).toMatchObject({ code: "INVALID_INVOCATION" });
  });

  it("redacts unexpected local errors from public CLI output", async () => {
    const capture = createCapture();
    await expect(main([
      "sources", "authorize", "--request-file", "/private/raw-secret-request.json", "--dry-run", "--json",
    ], await context(), capture.io)).resolves.toBe(1);
    expect(JSON.parse(capture.stderr[0]!)).toMatchObject({
      code: "UNEXPECTED_ERROR", message: "openLifeWiki command failed",
    });
    expect(capture.stderr[0]).not.toContain("raw-secret-request");
  });
});

const noOpRunner: CommandRunner = {
  async run() {
    return { stdout: "", stderr: "" };
  },
};

async function context() {
  const root = join(await createTemporaryRoot(), "home");
  return {
    layout: testLayout(root),
    runner: noOpRunner,
  };
}

function testLayout(root: string) {
  return resolveRuntimeLayout({
    OPENLIFEWIKI_HOME: root,
    OPENLIFEWIKI_WORKSPACE: join(root, "workspace"),
  });
}

function activeState(): DurableStateV1 {
  return {
    schema: "openlifewiki.state/v1",
    stableState: "ACTIVE",
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

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-cli-test-"));
  temporaryRoots.push(root);
  return root;
}

function createCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      out: (value) => { stdout.push(value); },
      err: (value) => { stderr.push(value); },
    },
    stdout,
    stderr,
  };
}

function emptyV2() {
  return {
    schema: "openlifewiki.config/v2",
    revision: 0,
    sources: [],
    hostConfig: null,
    scanPolicy: null,
    compatibility: { p0Sources: [], agentBindings: [] },
  };
}

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

const fixedNow = () => new Date("2026-07-26T00:00:00.000Z");
