import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { componentCatalog, connectorCatalog, productOwnedBoundaries } from "../src/catalog.js";
import { main } from "../src/cli.js";
import { probeComponents } from "../src/doctor.js";

describe("direct-reuse skeleton", () => {
  it("declares upstream components without claiming unsupported product journeys", () => {
    expect(componentCatalog.map(({ id }) => id)).toEqual([
      "qmd",
      "llm-wiki-compiler",
      "mcp-typescript-sdk",
      "github-cli",
      "lark-cli",
      "openai-codex-cli",
      "anthropic-claude-code",
      "google-gemini-cli",
      "pi",
      "openclaw",
      "hermes-agent",
      "superpowers-visual-companion",
    ]);
    expect(componentCatalog.every(({ owner }) => owner === "upstream")).toBe(true);
    expect(componentCatalog.every(({ license }) => license.length > 0)).toBe(true);
    expect(componentCatalog.every(({ status }) => status !== ("supported" as never))).toBe(true);
    const byId = Object.fromEntries(componentCatalog.map((component) => [component.id, component]));
    expect(byId.qmd).toMatchObject({
      packageName: "@tobilu/qmd",
      pinnedVersion: "2.5.3",
      executable: "qmd",
      projectUrl: "https://github.com/tobi/qmd",
    });
    expect(byId["llm-wiki-compiler"]).toMatchObject({
      packageName: "llm-wiki-compiler",
      pinnedVersion: "1.1.0",
      executable: "llmwiki",
      projectUrl: "https://github.com/atomicstrata/llm-wiki-compiler",
    });
    expect(byId["lark-cli"]).toMatchObject({
      executable: "lark-cli",
      projectUrl: "https://github.com/larksuite/cli",
    });
    expect(byId["superpowers-visual-companion"]).toMatchObject({
      integration: ["reference"],
      status: "planned",
    });
    expect(productOwnedBoundaries).toContain("identity-and-policy");
    expect(connectorCatalog.map(({ id }) => id)).toEqual([
      "local-folder",
      "github",
      "feishu",
      "codex-history",
    ]);
    expect(componentCatalog
      .filter(({ kind }) => kind === "agent-core")
      .map((component) => "strategy" in component ? component.strategy : undefined))
      .toEqual([
        "native-cli",
        "native-cli",
        "native-cli",
        "provider-runtime",
        "provider-runtime",
        "provider-runtime",
      ]);
  });

  it("reports the real skeleton stage", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["status", "--json"])).resolves.toBe(0);
    const result = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(result.status).toBe("SKELETON_READY");
    expect(result.supportedJourneys).toEqual([]);
    write.mockRestore();
  });

  it("detects executable presence without running the candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openlifewiki-doctor-"));
    const executable = join(directory, "codex");
    const marker = join(directory, "executed");
    try {
      await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\n`, "utf8");
      await chmod(executable, 0o755);
      await mkdir(join(directory, "claude"));
      const probes = await probeComponents({ PATH: directory });
      expect(probes.find(({ id }) => id === "openai-codex-cli")?.state)
        .toBe("installed-unverified");
      await expect(access(marker)).rejects.toThrow();
      expect(probes.find(({ id }) => id === "anthropic-claude-code")?.state).toBe("missing");
      expect(probes.find(({ id }) => id === "superpowers-visual-companion")?.state)
        .toBe("reference-only");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds only the active skeleton modules", async () => {
    const entries = await readdir(new URL("../dist", import.meta.url), { recursive: true });
    expect(entries.sort()).toEqual([
      "catalog.d.ts",
      "catalog.js",
      "catalog.js.map",
      "cli.d.ts",
      "cli.js",
      "cli.js.map",
      "doctor.d.ts",
      "doctor.js",
      "doctor.js.map",
      "index.d.ts",
      "index.js",
      "index.js.map",
    ]);
  });
});
