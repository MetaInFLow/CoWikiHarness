import { createHmac, createSecretKey, timingSafeEqual, type KeyObject } from "node:crypto";

import { canonicalJson, KnowledgeGraphError } from "@openlifewiki/core";
import { z } from "zod";

const MAX_CURSOR_LENGTH = 4_096;
const MIN_HMAC_SECRET_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const graphCursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  orgId: z.string().regex(REGISTRY_ID),
  principalId: z.string().regex(REGISTRY_ID),
  queryHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  registryRevision: z.int().nonnegative(),
  afterSeedKey: z.string().min(1).max(512),
});

export type GraphCursorPayload = z.infer<typeof graphCursorPayloadSchema>;

export class GraphCursorCodec {
  readonly #key: KeyObject;

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < MIN_HMAC_SECRET_BYTES) {
      throw new Error("Graph cursor HMAC secret must be at least 32 bytes");
    }
    this.#key = createSecretKey(Buffer.from(secret, "utf8"));
  }

  encode(payload: GraphCursorPayload): string {
    const parsed = graphCursorPayloadSchema.safeParse(payload);
    if (!parsed.success) throw invalidGraphCursor();

    const payloadBase64url = Buffer.from(canonicalJson(parsed.data), "utf8").toString("base64url");
    return `${payloadBase64url}.${this.sign(payloadBase64url).toString("base64url")}`;
  }

  decode(cursor: string): GraphCursorPayload {
    try {
      if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
        throw new Error();
      }

      const segments = cursor.split(".");
      if (segments.length !== 2) throw new Error();
      const [payloadBase64url, signatureBase64url] = segments;
      if (payloadBase64url === undefined || signatureBase64url === undefined
        || !isCanonicalBase64url(payloadBase64url)
        || !isCanonicalBase64url(signatureBase64url)) {
        throw new Error();
      }

      const expected = this.sign(payloadBase64url);
      const actual = Buffer.from(signatureBase64url, "base64url");
      if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
        throw new Error();
      }

      const decoded = Buffer.from(payloadBase64url, "base64url").toString("utf8");
      const parsed = graphCursorPayloadSchema.safeParse(JSON.parse(decoded));
      if (!parsed.success) throw new Error();

      const canonicalPayload = Buffer.from(canonicalJson(parsed.data), "utf8").toString("base64url");
      if (canonicalPayload !== payloadBase64url) throw new Error();
      return parsed.data;
    } catch {
      throw invalidGraphCursor();
    }
  }

  private sign(payloadBase64url: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(`graph-cursor\0${payloadBase64url}`, "utf8")
      .digest();
  }
}

function isCanonicalBase64url(value: string): boolean {
  if (!BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value;
}

function invalidGraphCursor(): KnowledgeGraphError {
  return new KnowledgeGraphError("GRAPH_INVALID_QUERY", "Invalid graph cursor");
}
