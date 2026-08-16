import { createHmac } from "node:crypto";

import { canonicalJson } from "@openlifewiki/core";
import { describe, expect, it } from "vitest";

import { GraphCursorCodec, type GraphCursorPayload } from "../src/index.js";

const SECRET = "test-token-secret-with-at-least-32-bytes";
const PAYLOAD = {
  version: 1,
  orgId: "org_1",
  principalId: "principal_1",
  queryHash: `sha256:${"a".repeat(64)}`,
  snapshotHash: `sha256:${"b".repeat(64)}`,
  registryRevision: 9,
  afterSeedKey: "item:item_9",
} as const satisfies GraphCursorPayload;
const FIXED_PAYLOAD_BASE64URL = "eyJhZnRlclNlZWRLZXkiOiJpdGVtOml0ZW1fOSIsIm9yZ0lkIjoib3JnXzEiLCJwcmluY2lwYWxJZCI6InByaW5jaXBhbF8xIiwicXVlcnlIYXNoIjoic2hhMjU2OmFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJyZWdpc3RyeVJldmlzaW9uIjo5LCJzbmFwc2hvdEhhc2giOiJzaGEyNTY6YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInZlcnNpb24iOjF9";
const FIXED_SIGNATURE_BASE64URL = "KoR3WRXq9lVAdn__jb12Wu-T6rYFkz0HpzFOIjiYWFE";
const FIXED_CURSOR = `${FIXED_PAYLOAD_BASE64URL}.${FIXED_SIGNATURE_BASE64URL}`;

describe("GraphCursorCodec", () => {
  it("matches the fixed canonical wire vector and decodes an independently signed cursor", () => {
    const codec = new GraphCursorCodec(SECRET);
    const independentlySigned = signCanonical(PAYLOAD);

    expect(independentlySigned).toBe(FIXED_CURSOR);
    expect(codec.encode(PAYLOAD)).toBe(FIXED_CURSOR);
    expect(codec.decode(independentlySigned)).toEqual(PAYLOAD);
  });

  it("keeps signing material out of enumerable and JSON object state", () => {
    const codec = new GraphCursorCodec(SECRET);

    expect(Object.keys(codec)).toEqual([]);
    expect(JSON.stringify(codec)).toBe("{}");
    expect(JSON.stringify(codec)).not.toContain(SECRET);
  });

  it("enforces the existing 32-byte HMAC secret floor", () => {
    expect(() => new GraphCursorCodec("too-short")).toThrow(/at least 32 bytes/i);
  });

  it("rejects a canonical same-length signature through the HMAC mismatch path", () => {
    const codec = new GraphCursorCodec(SECRET);
    const cursor = codec.encode(PAYLOAD);
    const [payload, signature] = cursor.split(".");
    if (payload === undefined || signature === undefined) throw new Error("Invalid cursor fixture");
    const mutationIndex = 10;
    const original = signature[mutationIndex];
    const replacement = original === "A" ? "B" : "A";
    const tamperedSignature = `${signature.slice(0, mutationIndex)}${replacement}${signature.slice(mutationIndex + 1)}`;
    const tampered = `${payload}.${tamperedSignature}`;

    expect(tamperedSignature).toHaveLength(signature.length);
    expect(tamperedSignature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(tamperedSignature, "base64url")).toHaveLength(32);
    expect(Buffer.from(tamperedSignature, "base64url").toString("base64url")).toBe(tamperedSignature);
    expect(tamperedSignature).not.toBe(signature);

    expectInvalidCursor(() => codec.decode(tampered));
  });

  it("rejects canonical payload tampering when the original signature is reused", () => {
    const codec = new GraphCursorCodec(SECRET);
    const cursor = codec.encode(PAYLOAD);
    const [, signature] = cursor.split(".");
    if (signature === undefined) throw new Error("Invalid cursor fixture");
    const tamperedPayload = Buffer.from(canonicalJson({
      ...PAYLOAD,
      afterSeedKey: "item:item_8",
    }), "utf8").toString("base64url");

    expectInvalidCursor(() => codec.decode(`${tamperedPayload}.${signature}`));
  });

  it("rejects cursors outside the total length boundary", () => {
    const codec = new GraphCursorCodec(SECRET);

    expectInvalidCursor(() => codec.decode(""));
    expectInvalidCursor(() => codec.decode("a".repeat(4_097)));
  });

  it.each([
    ["one segment", "abc"],
    ["empty payload", ".abc"],
    ["empty signature", "abc."],
    ["three segments", "abc.def.ghi"],
    ["padded base64url", "e30=.abc"],
    ["non-base64url payload", "***.abc"],
    ["non-canonical payload", "A.abc"],
  ])("rejects malformed segments: %s", (_name, cursor) => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(cursor));
  });

  it("rejects signed non-JSON and non-canonical JSON payloads", () => {
    const codec = new GraphCursorCodec(SECRET);

    expectInvalidCursor(() => codec.decode(signRaw("not-json")));
    expectInvalidCursor(() => codec.decode(signRaw(JSON.stringify(PAYLOAD, null, 2))));
  });

  it("rejects a signed payload with an unknown field", () => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signCanonical({
      ...PAYLOAD,
      token: "must-never-enter-a-cursor",
    })));
  });

  it("rejects a signed payload with the wrong version", () => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signCanonical({
      ...PAYLOAD,
      version: 2,
    })));
  });

  it("accepts a 512-character seed key", () => {
    const codec = new GraphCursorCodec(SECRET);
    const payload = { ...PAYLOAD, afterSeedKey: `item:${"a".repeat(507)}` };

    expect(codec.decode(codec.encode(payload))).toEqual(payload);
  });

  it.each([
    ["query hash", { ...PAYLOAD, queryHash: "sha256:not-a-hash" }],
    ["snapshot hash", { ...PAYLOAD, snapshotHash: "sha256:not-a-hash" }],
    ["missing snapshot hash", withoutSnapshotHash(PAYLOAD)],
    ["negative revision", { ...PAYLOAD, registryRevision: -1 }],
    ["fractional revision", { ...PAYLOAD, registryRevision: 1.5 }],
    ["empty seed", { ...PAYLOAD, afterSeedKey: "" }],
    ["oversized seed", { ...PAYLOAD, afterSeedKey: "s".repeat(513) }],
  ])("rejects an invalid signed schema field: %s", (_name, payload) => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signCanonical(payload)));
  });
});

function signCanonical(payload: unknown): string {
  return signRaw(canonicalJson(payload));
}

function signRaw(json: string): string {
  const payload = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(`graph-cursor\0${payload}`, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

function expectInvalidCursor(work: () => unknown): void {
  expect(work).toThrowError(expect.objectContaining({
    name: "KnowledgeGraphError",
    code: "GRAPH_INVALID_QUERY",
    message: "Invalid graph cursor",
  }));
}

function withoutSnapshotHash(payload: typeof PAYLOAD): Omit<typeof PAYLOAD, "snapshotHash"> {
  const { snapshotHash: _snapshotHash, ...rest } = payload;
  return rest;
}
