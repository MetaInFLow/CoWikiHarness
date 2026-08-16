import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GraphCursorCodec, type GraphCursorPayload } from "../src/index.js";

const SECRET = "test-token-secret-with-at-least-32-bytes";
const PAYLOAD = {
  version: 1,
  orgId: "org_1",
  principalId: "principal_1",
  queryHash: `sha256:${"a".repeat(64)}`,
  registryRevision: 9,
  afterSeedKey: "item:item_9",
} as const satisfies GraphCursorPayload;

describe("GraphCursorCodec", () => {
  it("round-trips one strict canonical payload", () => {
    const codec = new GraphCursorCodec(SECRET);

    const cursor = codec.encode(PAYLOAD);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("=");
    expect(codec.decode(cursor)).toEqual(PAYLOAD);
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
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signJson({
      ...PAYLOAD,
      token: "must-never-enter-a-cursor",
    })));
  });

  it("rejects a signed payload with the wrong version", () => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signJson({
      ...PAYLOAD,
      version: 2,
    })));
  });

  it.each([
    ["query hash", { ...PAYLOAD, queryHash: "sha256:not-a-hash" }],
    ["negative revision", { ...PAYLOAD, registryRevision: -1 }],
    ["fractional revision", { ...PAYLOAD, registryRevision: 1.5 }],
    ["empty seed", { ...PAYLOAD, afterSeedKey: "" }],
    ["oversized seed", { ...PAYLOAD, afterSeedKey: "s".repeat(257) }],
  ])("rejects an invalid signed schema field: %s", (_name, payload) => {
    expectInvalidCursor(() => new GraphCursorCodec(SECRET).decode(signJson(payload)));
  });
});

function signJson(payload: unknown): string {
  return signRaw(JSON.stringify(payload));
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
