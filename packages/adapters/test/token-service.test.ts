import { describe, expect, it } from "vitest";

import { digestToken, issuePrincipalToken, tokenDigestMatches } from "../src/index.js";

describe("cloud token service", () => {
  it("issues 32 random bytes as a one-time base64url token", () => {
    const issued = issuePrincipalToken("test-token-secret-with-at-least-32-bytes");
    expect(issued.value).toHaveLength(43);
    expect(issued.prefix).toBe(issued.value.slice(0, 8));
    expect(issued.digest).toHaveLength(32);
    expect(tokenDigestMatches(issued.digest, digestToken(
      "test-token-secret-with-at-least-32-bytes",
      issued.value,
    ))).toBe(true);
  });

  it("rejects a digest made with a different secret", () => {
    const issued = issuePrincipalToken("test-token-secret-with-at-least-32-bytes");
    expect(tokenDigestMatches(issued.digest, digestToken(
      "different-secret-with-at-least-32-bytes",
      issued.value,
    ))).toBe(false);
  });
});
