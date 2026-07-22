import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseQmdCollectionDetails,
  parseQmdCollectionNames,
  qmdEnvironment,
  resolveRuntimeLayout,
} from "../src/index.js";

describe("runtime layout", () => {
  it("separates hidden runtime data from the visible knowledge workspace", () => {
    const layout = resolveRuntimeLayout({}, "darwin");

    expect(layout.root).toMatch(/\.openlifewiki$/u);
    expect(layout.workspaceRoot).toMatch(/openLifeWiki$/u);
    expect(layout.sourcesDir).toBe(join(layout.workspaceRoot, "sources"));
    expect(layout.wikiDir).toBe(join(layout.workspaceRoot, "wiki"));
    expect(layout.qmdConfigDir).toBe(join(layout.root, "data", "qmd", "config"));
    expect(layout.qmdCacheDir).toBe(join(layout.root, "data", "qmd", "cache"));
  });

  it("allows runtime and workspace defaults to be overridden independently", () => {
    const layout = resolveRuntimeLayout({
      OPENLIFEWIKI_HOME: "/tmp/runtime",
      OPENLIFEWIKI_WORKSPACE: "/tmp/knowledge",
    }, "linux");

    expect(layout.root).toBe("/tmp/runtime");
    expect(layout.workspaceRoot).toBe("/tmp/knowledge");
  });

  it("removes a caller INDEX_PATH before invoking isolated QMD", () => {
    const layout = resolveRuntimeLayout({
      OPENLIFEWIKI_HOME: "/tmp/runtime",
      OPENLIFEWIKI_WORKSPACE: "/tmp/knowledge",
    });

    const env = qmdEnvironment(layout, { INDEX_PATH: "/tmp/global.sqlite", FORCE_COLOR: "1" });

    expect(env.INDEX_PATH).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
    expect(env.QMD_CONFIG_DIR).toBe(layout.qmdConfigDir);
    expect(env.XDG_CACHE_HOME).toBe(layout.qmdCacheDir);
  });

  it("parses the pinned QMD collection list and detail contracts", () => {
    expect(parseQmdCollectionNames([
      "Collections (2):",
      "alpha (qmd://alpha/)",
      "beta (qmd://beta/)",
    ].join("\n"))).toEqual(["alpha", "beta"]);
    expect(parseQmdCollectionDetails([
      "Collection: alpha",
      "  Path:     /tmp/knowledge/sources",
      "  Pattern:  **/*.md",
    ].join("\n"))).toEqual({ path: "/tmp/knowledge/sources", mask: "**/*.md" });
  });
});
