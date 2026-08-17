import { describe, expect, it } from "vitest";

import { readServerConfig } from "../src/config.js";

describe("gateway configuration", () => {
  it("defaults the bind host to loopback without changing the local port or public URL", () => {
    const env = testEnvironment();
    delete env.OPENLIFEWIKI_BIND_HOST;

    expect(readServerConfig(env)).toMatchObject({
      bindHost: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
    });
  });

  it.each(["127.0.0.1", "::1", "0.0.0.0", "::", "10.20.30.40", "localhost"])(
    "preserves the explicit bind host %s",
    (bindHost) => {
      expect(readServerConfig({
        ...testEnvironment(),
        OPENLIFEWIKI_BIND_HOST: bindHost,
      }).bindHost).toBe(bindHost);
    },
  );

  it.each(["", "https://127.0.0.1", "127.0.0.1:8080", "knowledge.example", "[::1]"])(
    "rejects the invalid bind host %j",
    (bindHost) => {
      expect(() => readServerConfig({
        ...testEnvironment(),
        OPENLIFEWIKI_BIND_HOST: bindHost,
      })).toThrow(/OPENLIFEWIKI_BIND_HOST/u);
    },
  );

  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://knowledge.example.com",
  ])("accepts the public URL %s", (publicUrl) => {
    expect(readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: publicUrl,
    }).publicUrl).toBe(publicUrl);
  });

  it("rejects a remote HTTP public URL", () => {
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: "http://knowledge.example.com",
    })).toThrow(/OPENLIFEWIKI_PUBLIC_URL/u);
  });

  it("rejects a malformed public URL with configuration context", () => {
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: "not-a-url",
    })).toThrow(/OPENLIFEWIKI_PUBLIC_URL/u);
  });
});

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://test.invalid/openlifewiki_test",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET: "unit-test-token-secret-with-at-least-32-bytes",
    OPENLIFEWIKI_MODEL: "gpt-5.5",
    OPENLIFEWIKI_BIND_HOST: "127.0.0.1",
    OPENLIFEWIKI_PUBLIC_URL: "http://127.0.0.1:0",
    OPENAI_API_KEY: "unit-test-api-key",
    OPENAI_BASE_URL: "https://agent108.work/",
    OPENLIFEWIKI_MODEL_REASONING_EFFORT: "xhigh",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "",
    PORT: "0",
  };
}
