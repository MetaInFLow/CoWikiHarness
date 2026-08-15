import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface IssuedToken {
  readonly value: string;
  readonly prefix: string;
  readonly digest: Buffer;
}

export function issuePrincipalToken(secret: string): IssuedToken {
  if (Buffer.byteLength(secret) < 32) throw new Error("Token HMAC secret must be at least 32 bytes");
  const value = randomBytes(32).toString("base64url");
  return { value, prefix: value.slice(0, 8), digest: digestToken(secret, value) };
}

export function digestToken(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

export function tokenDigestMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}
