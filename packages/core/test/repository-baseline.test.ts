import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AGENT_IO_SCHEMA_MANIFEST } from "@openlifewiki/protocol";

import { AGENT_IO_PROTOCOL_RELEASE, COMPONENT_RELEASES } from "../src/index.js";

const repositoryRoot = new URL("../../../", import.meta.url);

describe("repository baseline", () => {
  it("contains the Stage 4 governance and lifecycle truth sources", async () => {
    const requiredFiles = [
      "README.md",
      "ARCHITECTURE.md",
      "DEVELOPMENT.md",
      "BRANCHING.md",
      "AGENTS.md",
      "CONSTITUTION.md",
      ".env.example",
      "docs/requirements/requirements-v0.1.md",
      "docs/requirements/requirements-v0.2.md",
      "docs/design/active/design_doc-v0.2-default-workspace-and-mcp.md",
      "docs/design/active/design_doc-v0.3-local-management-companion.md",
      "docs/design/completed/design_doc-v0.1-lifecycle-bootstrap.md",
      "docs/decisions/ADR-0001-release-install-and-public-invocation.md",
      "docs/decisions/ADR-0002-default-local-layout-and-upstream-mcp.md",
      "docs/governance/folder-declaration-v0.md",
      "docs/governance/changelog.md",
      "docs/memory-bank/brief.md",
      "docs/memory-bank/tech-context.md",
      "docs/memory-bank/patterns.md",
      "docs/memory-bank/active-context.md",
      "docs/prompts/README.md",
      "skills/openlifewiki-install/SKILL.md",
      "scripts/bootstrap_dev_env.sh",
    ];

    await expect(Promise.all(requiredFiles.map((path) => readFile(new URL(path, repositoryRoot)))))
      .resolves.toHaveLength(requiredFiles.length);
  });

  it("keeps external executables out of the repository dependency graph", async () => {
    const lockfile = await readFile(new URL("pnpm-lock.yaml", repositoryRoot), "utf8");
    expect(lockfile).not.toContain("@tobilu/qmd");
    expect(lockfile).not.toContain("llm-wiki-compiler");
  });

  it("binds the generated Agent I/O schema manifest into the release components", () => {
    expect(AGENT_IO_PROTOCOL_RELEASE.schemaManifestHash)
      .toBe(AGENT_IO_SCHEMA_MANIFEST.manifestHash);
    expect(COMPONENT_RELEASES).toContain(AGENT_IO_PROTOCOL_RELEASE);
  });

  it("requires preview before approved initialization in the Install Skill", async () => {
    const skill = await readFile(
      new URL("skills/openlifewiki-install/SKILL.md", repositoryRoot),
      "utf8",
    );
    expect(skill.indexOf("init --dry-run --json")).toBeGreaterThan(0);
    expect(skill.indexOf("init --yes --json")).toBeGreaterThan(skill.indexOf("init --dry-run --json"));
    expect(skill.indexOf("activate --dry-run --json")).toBeGreaterThan(skill.indexOf("init --yes --json"));
    expect(skill.indexOf("activate --yes --json")).toBeGreaterThan(skill.indexOf("activate --dry-run --json"));
  });
});
