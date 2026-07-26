import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { CommandRunner, InteractiveProcessRunner } from "../src/index.js";
import {
  emptyConfig,
  launchLocalMcp,
  resolveRuntimeLayout,
  updateP0Compatibility,
  writeConfig,
  writeJsonAtomic,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("launches the unchanged P0 MCP from config/v2 compatibility state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-mcp-config-v2-"));
  roots.push(root);
  const layout = resolveRuntimeLayout({
    OPENLIFEWIKI_HOME: join(root, "runtime"),
    OPENLIFEWIKI_WORKSPACE: join(root, "workspace"),
  });
  await mkdir(layout.sourcesDir, { recursive: true });
  await writeConfig(layout.configFile, emptyConfig());
  await updateP0Compatibility(layout.configFile, 0, (compatibility) => ({
    ...compatibility,
    p0Sources: [{
      id: "default-local",
      kind: "local-folder",
      path: layout.sourcesDir,
      collection: "openlifewiki-sources",
      mask: "**/*.md",
      authorizedAt: "2026-07-26T00:00:00.000Z",
    }],
  }));
  await writeJsonAtomic(layout.stateFile, {
    schema: "openlifewiki.state/v1",
    stableState: "ACTIVE",
    completedAt: "2026-07-26T00:00:00.000Z",
    components: [],
  });
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
      return { stdout: "ok\n", stderr: "" };
    },
  };
  const interactive: InteractiveProcessRunner = { async run() { return 0; } };

  await expect(launchLocalMcp({ layout, runner, interactiveRunner: interactive })).resolves.toBe(0);
  expect(calls).toEqual([
    "--version",
    "collection list",
    "collection show openlifewiki-sources",
    "update",
  ]);
});
