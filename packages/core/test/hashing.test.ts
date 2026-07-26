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

  it("preserves array order", () => {
    expect(sha256Canonical(["a", "b"])).not.toBe(sha256Canonical(["b", "a"]));
  });

  it("rejects sparse arrays and undefined values", () => {
    const sparse = new Array(1);

    expect(() => sha256Canonical(sparse)).toThrow(/sparse/i);
    expect(() => sha256Canonical([undefined])).toThrow(/undefined/i);
    expect(() => sha256Canonical({ value: undefined })).toThrow(/undefined/i);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => sha256Canonical(value)).toThrow(/finite/i);
    },
  );

  it("rejects cycles and non-plain objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => sha256Canonical(cycle)).toThrow(/cycle/i);
    expect(() => sha256Canonical(new Date("2026-07-26T00:00:00Z"))).toThrow(/plain/i);
  });
});
