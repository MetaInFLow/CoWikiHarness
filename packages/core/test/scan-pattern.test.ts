import { describe, expect, it } from "vitest";

import {
  MAX_SCAN_PATTERN_COUNT,
  MAX_SCAN_PATTERN_LENGTH,
  isScanPathPermitted,
  matchesScanPattern,
  parseScanPatterns,
} from "../src/index.js";

describe("canonical progressive scan patterns", () => {
  it("bounds the aggregate pattern count and each pattern length", () => {
    expect(() => parseScanPatterns(Array.from(
      { length: MAX_SCAN_PATTERN_COUNT + 1 },
      (_, index) => `/entry-${index}`,
    ))).toThrow("Scan pattern count exceeds the supported limit");
    expect(() => parseScanPatterns([`/${"a".repeat(MAX_SCAN_PATTERN_LENGTH)}`]))
      .toThrow("Scan pattern length exceeds the supported limit");
  });

  it.each([
    "/docs/../secret.md",
    "/docs/./guide.md",
    "/docs//guide.md",
    "/docs\\guide.md",
    "/docs/[ab].md",
    "/docs/{a,b}.md",
    "/docs/**.md",
    "/docs/",
    "/docs/\ud800",
  ])("rejects ambiguous, unsupported or traversing grammar: %s", (pattern) => {
    expect(() => parseScanPatterns([pattern])).toThrow("Scan pattern grammar is invalid");
  });

  it("applies Source and ScanPlan includes as an intersection and excludes as a union", () => {
    const policy = {
      includeSets: [["/docs/**"], ["/docs/*.md"]],
      exclude: ["/docs/private*"],
    } as const;

    expect(isScanPathPermitted({ ...policy, path: "/docs/guide.md", container: false })).toBe(true);
    expect(isScanPathPermitted({ ...policy, path: "/docs/nested/guide.md", container: false })).toBe(false);
    expect(isScanPathPermitted({ ...policy, path: "/docs/private-notes.md", container: false })).toBe(false);
    expect(isScanPathPermitted({ ...policy, path: "/other/guide.md", container: false })).toBe(false);
  });

  it("keeps a container only when a matching descendant is possible by path segments", () => {
    const policy = { includeSets: [["/docs/**"]], exclude: [] } as const;

    expect(isScanPathPermitted({ ...policy, path: "/", container: true })).toBe(true);
    expect(isScanPathPermitted({ ...policy, path: "/docs", container: true })).toBe(true);
    expect(isScanPathPermitted({ ...policy, path: "/doc", container: true })).toBe(false);
    expect(isScanPathPermitted({ ...policy, path: "/docs2", container: true })).toBe(false);
    expect(matchesScanPattern("/docs2/guide.md", "/docs/**")).toBe(false);
  });

  it("uses the same relative-pattern and globstar semantics for every provider path", () => {
    const paths = {
      "local-folder": "/areas/product/guide.md",
      github: "/areas/product/guide.md",
      feishu: "/areas/product/guide.md",
      "codex-history": "/areas/product/guide.md",
    } as const;

    expect(Object.values(paths).map((path) => isScanPathPermitted({
      path,
      container: false,
      includeSets: [["areas/**"], ["**/*.md"]],
      exclude: ["**/private/**"],
    }))).toEqual([true, true, true, true]);
    expect(matchesScanPattern("/guide.md", "**/*.md")).toBe(true);
  });
});
