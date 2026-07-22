import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRuntimeLayout, type CommandRunner } from "@openlifewiki/adapters";

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
      { layout: resolveRuntimeLayout({ OPENLIFEWIKI_HOME: root }), runner: noOpRunner },
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
});

const noOpRunner: CommandRunner = {
  async run() {
    return { stdout: "", stderr: "" };
  },
};

async function context() {
  const root = join(await createTemporaryRoot(), "home");
  return {
    layout: resolveRuntimeLayout({ OPENLIFEWIKI_HOME: root }),
    runner: noOpRunner,
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
