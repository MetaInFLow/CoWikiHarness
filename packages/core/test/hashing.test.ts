import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../src/index.js";

describe("canonical JSON SHA-256", () => {
  it("sorts object keys before hashing and prefixes the digest", () => {
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256Canonical({ nested: { z: 2, a: 1 } })).toBe(
      sha256Canonical({ nested: { a: 1, z: 2 } }),
    );
  });
});
