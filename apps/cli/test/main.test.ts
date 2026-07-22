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
