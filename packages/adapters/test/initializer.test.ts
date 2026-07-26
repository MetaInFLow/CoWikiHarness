import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { QMD_RELEASE } from "@openlifewiki/core";

import type { CommandRunner } from "../src/command-runner.js";
import {
  initializeRuntime,
  inspectRuntime,
  previewInitialization,
  readDurableState,
  resolveRuntimeLayout,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("initializer adapter", () => {
  it("previews initialization without touching the state root", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);

    const plan = previewInitialization(layout);

    expect(plan.approvalRequired).toBe(true);
    expect(plan.components.map(({ id }) => id)).toEqual(["qmd"]);
    await expect(access(root)).rejects.toThrow();
  });

  it("installs QMD before atomically publishing INITIALIZED", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    const calls: string[] = [];
    const runner = fakeRunner(calls);

    const result = await initializeRuntime({
      layout,
      runner,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(result.status).toBe("initialized");
    expect(result.stableState).toBe("INITIALIZED");
    expect(calls[0]).toBe("npm install --omit=dev --no-audit --no-fund");
    expect(calls[1]).toBe(`${layout.qmdExecutable} --version`);
    expect(await readDurableState(layout.stateFile)).toMatchObject({
      stableState: "INITIALIZED",
      components: [{ id: "qmd", version: "2.5.3" }],
    });
    expect(JSON.parse(await readFile(layout.configFile, "utf8"))).toEqual({
      schema: "openlifewiki.config/v2",
      revision: 0,
      sources: [],
      hostConfig: null,
      compatibility: { p0Sources: [], agentBindings: [] },
    });
    expect((await stat(layout.root)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(layout.sourcesDir)).isDirectory()).toBe(true);
    expect((await stat(layout.wikiDir)).isDirectory()).toBe(true);
  });

  it("is idempotent when the initialized QMD contract still passes", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await initializeRuntime({ layout, runner: fakeRunner([]) });
    await rm(layout.workspaceRoot, { recursive: true, force: true });
    const calls: string[] = [];

    const result = await initializeRuntime({ layout, runner: fakeRunner(calls) });

    expect(result.status).toBe("already-initialized");
    expect(calls).toEqual([`${layout.qmdExecutable} --version`]);
    expect((await stat(layout.sourcesDir)).isDirectory()).toBe(true);
  });

  it("does not publish INITIALIZED when dependency installation fails", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    const runner: CommandRunner = {
      async run(command) {
        if (command === "npm") throw new Error("registry unavailable");
        return { stdout: "qmd 2.5.3\n", stderr: "" };
      },
    };

    await expect(initializeRuntime({ layout, runner })).rejects.toThrow("Initialization did not complete");
    expect(await readDurableState(layout.stateFile)).toBeUndefined();
    expect((await inspectRuntime(layout, runner)).stableState).toBe("INSTALLED");
  });

  it("rejects an invalid existing configuration", async () => {
    const root = join(await createTemporaryRoot(), "home");
    const layout = testLayout(root);
    await writeFileAfterParents(layout.configFile, "{}\n");
    await chmod(layout.configFile, 0o644);

    await expect(initializeRuntime({ layout, runner: fakeRunner([]) }))
      .rejects.toThrow("Existing configuration is invalid");
    expect(await readDurableState(layout.stateFile)).toBeUndefined();
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-init-test-"));
  temporaryRoots.push(root);
  return root;
}

function fakeRunner(calls: string[]): CommandRunner {
  return {
    async run(command, args, options) {
      calls.push([command, ...args].join(" "));
      if (command === "npm") {
        await writeFile(join(options!.cwd!, "package-lock.json"), JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/@tobilu/qmd": {
              version: QMD_RELEASE.version,
              integrity: QMD_RELEASE.integrity,
            },
          },
        }));
      }
      return command === "npm"
        ? { stdout: "installed\n", stderr: "" }
        : { stdout: "qmd 2.5.3\n", stderr: "" };
    },
  };
}

function testLayout(root: string) {
  return resolveRuntimeLayout({
    OPENLIFEWIKI_HOME: root,
    OPENLIFEWIKI_WORKSPACE: join(root, "workspace"),
  });
}

async function writeFileAfterParents(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
