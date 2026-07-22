import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DurableStateV1 } from "@openlifewiki/protocol";

import type { CommandRunner } from "../src/command-runner.js";
import {
  activateDefaultSource,
  emptyConfig,
  previewActivation,
  readConfig,
  readDurableState,
  resolveRuntimeLayout,
  writeConfig,
  writeJsonAtomic,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("default Source activation", () => {
  it("previews the exact Source without reading or writing it", async () => {
    const layout = await preparedLayout(false);

    const plan = previewActivation(layout);

    expect(plan.source).toEqual({
      id: "default-local",
      path: layout.sourcesDir,
      mask: "**/*.md",
    });
    expect(plan.actions.map(({ id }) => id)).toContain("configure-qmd-collection");
  });

  it("stays INITIALIZED when the default Source has no Markdown", async () => {
    const layout = await preparedLayout(true);

    const result = await activateDefaultSource({ layout, runner: versionOnlyRunner });

    expect(result).toMatchObject({
      status: "source-empty",
      stableState: "INITIALIZED",
      nextAction: "add-markdown",
      sourcePath: layout.sourcesDir,
    });
    expect((await readDurableState(layout.stateFile))?.stableState).toBe("INITIALIZED");
  });

  it("uses QMD public commands with isolated paths before publishing ACTIVE", async () => {
    const layout = await preparedLayout(true);
    await writeFile(join(layout.sourcesDir, "direction.md"), "# Direction\n\nNorthstar evidence lives here.\n");
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: options.env }),
        });
        if (args[0] === "--version") return { stdout: "qmd 2.5.3\n", stderr: "" };
        if (args[0] === "collection" && args[1] === "list") {
          return { stdout: "No collections found.\n", stderr: "" };
        }
        if (args[0] === "search") {
          return {
            stdout: JSON.stringify([{ file: "qmd://openlifewiki-sources/direction.md", title: "Direction" }]),
            stderr: "",
          };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    };

    const result = await activateDefaultSource({
      layout,
      runner,
      now: () => new Date("2026-07-22T01:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "activated",
      stableState: "ACTIVE",
      indexedFiles: 1,
      mcp: { transport: "stdio", command: "openlifewiki", args: ["mcp", "--stdio"] },
    });
    expect(calls.map(({ args }) => args.join(" "))).toEqual([
      "--version",
      "collection list",
      `collection add ${layout.sourcesDir} --name openlifewiki-sources --mask **/*.md`,
      "search Direction --json -n 1 -c openlifewiki-sources",
    ]);
    expect(calls[1]?.env).toMatchObject({
      QMD_CONFIG_DIR: layout.qmdConfigDir,
      XDG_CACHE_HOME: layout.qmdCacheDir,
    });
    expect(calls.slice(1).every(({ cwd }) => cwd === layout.root)).toBe(true);
    expect((await readDurableState(layout.stateFile))?.stableState).toBe("ACTIVE");
    expect(await readConfig(layout.configFile)).toMatchObject({
      sources: [{ id: "default-local", path: layout.sourcesDir, collection: "openlifewiki-sources" }],
    });
  });

  it("verifies an existing QMD collection before an idempotent refresh", async () => {
    const layout = await preparedLayout(true);
    await writeFile(join(layout.sourcesDir, "direction.md"), "# Direction\n\nNorthstar evidence.\n");
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
    const runner: CommandRunner = {
      async run(_command, args) {
        calls.push(args.join(" "));
        if (args[0] === "--version") return { stdout: "qmd 2.5.3\n", stderr: "" };
        if (args[0] === "collection" && args[1] === "list") {
          return { stdout: "openlifewiki-sources (qmd://openlifewiki-sources/)\n", stderr: "" };
        }
        if (args[0] === "collection" && args[1] === "show") {
          return {
            stdout: `Collection: openlifewiki-sources\n  Path:     ${layout.sourcesDir}\n  Pattern:  **/*.md\n`,
            stderr: "",
          };
        }
        if (args[0] === "search") {
          return { stdout: JSON.stringify([{ file: "qmd://openlifewiki-sources/direction.md" }]), stderr: "" };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    };

    const result = await activateDefaultSource({ layout, runner });

    expect(result.status).toBe("already-active");
    expect(calls).toContain("collection show openlifewiki-sources");
    expect(calls).toContain("update");
    expect(calls.some((call) => call.startsWith("collection add"))).toBe(false);
  });

  it("uses a bounded Chinese probe for a Chinese Markdown Source", async () => {
    const layout = await preparedLayout(true);
    await writeFile(join(layout.sourcesDir, "方向.md"), "# 这是一个中文标题\n\n这里保存业务方向。\n");
    let query = "";
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return { stdout: "qmd 2.5.3\n", stderr: "" };
        if (args[0] === "collection" && args[1] === "list") return { stdout: "No collections.\n", stderr: "" };
        if (args[0] === "search") {
          query = args[1] ?? "";
          return { stdout: JSON.stringify([{ file: "qmd://openlifewiki-sources/方向.md" }]), stderr: "" };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    };

    await activateDefaultSource({ layout, runner });

    expect(query).toBe("这是一个中文");
  });
});

const versionOnlyRunner: CommandRunner = {
  async run() {
    return { stdout: "qmd 2.5.3\n", stderr: "" };
  },
};

async function preparedLayout(initialized: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "openlifewiki-activation-test-"));
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
