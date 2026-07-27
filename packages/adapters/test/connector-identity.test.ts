import { describe, expect, it } from "vitest";

import {
  assertSafeConnectorIdentityValues,
  CODEX_PUBLIC_ACCOUNT,
  safeCodexPlanLabel,
} from "../src/connectors/connector-identity.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

describe("Connector public identity projection", () => {
  it.each([
    ["local-folder" as const, { profile: "local", account: "w***i", fingerprint: FINGERPRINT }],
    ["github" as const, { account: "H***n", host: "github.com", fingerprint: FINGERPRINT }],
    ["feishu" as const, {
      profile: "metainflow-feishu", account: "A***F", tenant: "t***t",
      effectiveScope: "drive:drive.metadata:readonly", fingerprint: FINGERPRINT,
    }],
    ["codex-history" as const, {
      profile: "ChatGPT login", account: CODEX_PUBLIC_ACCOUNT, plan: "plus", fingerprint: FINGERPRINT,
    }],
  ])("accepts the canonical redacted %s identity", (connectorType, identity) => {
    expect(() => assertSafeConnectorIdentityValues(connectorType, identity)).not.toThrow();
  });

  it.each([
    ["local-folder" as const, { profile: "local", account: "t***n", fingerprint: FINGERPRINT }],
    ["github" as const, { account: "H***n", host: "Bearer abcdefghijklmnopqrstuvwxyz", fingerprint: FINGERPRINT }],
    ["feishu" as const, {
      profile: "metainflow-feishu", account: "A***F", tenant: "s***t",
      effectiveScope: "drive:drive.metadata:readonly", fingerprint: FINGERPRINT,
    }],
    ["codex-history" as const, {
      profile: "ChatGPT login", account: CODEX_PUBLIC_ACCOUNT,
      plan: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345", fingerprint: FINGERPRINT,
    }],
    ["codex-history" as const, {
      profile: "ChatGPT login", account: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678",
      plan: "plus", fingerprint: FINGERPRINT,
    }],
    ["github" as const, {
      account: "H***n", host: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0", fingerprint: FINGERPRINT,
    }],
  ])("rejects secret-shaped %s identity values", (connectorType, identity) => {
    expect(() => assertSafeConnectorIdentityValues(connectorType, identity))
      .toThrow(/secret-shaped|canonical public projection/i);
  });

  it("maps arbitrary Codex plan output to a fixed safe label", () => {
    expect(safeCodexPlanLabel("PLUS")).toBe("plus");
    expect(safeCodexPlanLabel("sk-proj-sensitive-provider-output")).toBe("other");
    expect(safeCodexPlanLabel(null)).toBeNull();
  });

  it.each([
    { profile: "ChatGPT login", account: "o***r@example.com", plan: "plus", fingerprint: FINGERPRINT },
    { profile: "ChatGPT login", account: CODEX_PUBLIC_ACCOUNT, plan: "custom-safe-text", fingerprint: FINGERPRINT },
  ])("rejects non-canonical Codex public identity projections", (identity) => {
    expect(() => assertSafeConnectorIdentityValues("codex-history", identity)).toThrow(/canonical public projection/i);
  });
});
