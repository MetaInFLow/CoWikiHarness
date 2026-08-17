import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

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
    "http://localhost.:8080",
    "http://127.0.0.0:8080",
    "http://127.0.0.1:8080",
    "http://127.42.3.4:8080",
    "http://127.255.255.255:8080",
    "http://[::1]:8080",
    "https://knowledge.example.com",
    "https://knowledge.example.com/gateway",
  ])("accepts the public URL %s", (publicUrl) => {
    expect(readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: publicUrl,
    }).publicUrl).toBe(publicUrl);
  });

  it("rejects a remote HTTP public URL", () => {
    const error = readPublicUrlError("http://knowledge.example.com");

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "custom",
        path: ["publicUrl"],
        message: expect.stringContaining("OPENLIFEWIKI_PUBLIC_URL"),
      }),
    ]));
  });

  it("rejects a malformed public URL with configuration context", () => {
    const error = readPublicUrlError("not-a-url");

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "custom",
        path: ["publicUrl"],
        message: expect.stringContaining("OPENLIFEWIKI_PUBLIC_URL"),
      }),
    ]));
  });

  it.each([
    [
      "username and password",
      "https://sensitive-user:sensitive-password@knowledge.example.com",
      "sensitive-password",
    ],
    ["username only", "https://sensitive-user@knowledge.example.com", "sensitive-user"],
    [
      "encoded userinfo",
      "https://sensitive%40user:sensitive%3Apassword@knowledge.example.com",
      "sensitive%3Apassword",
    ],
    [
      "query",
      "https://knowledge.example.com/gateway?access_token=sensitive-query",
      "sensitive-query",
    ],
    [
      "fragment",
      "https://knowledge.example.com/gateway#sensitive-fragment",
      "sensitive-fragment",
    ],
  ])("rejects public URL %s with a structured sanitized issue", (
    _name,
    publicUrl,
    sensitiveValue,
  ) => {
    const error = readPublicUrlError(publicUrl);

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "custom",
        path: ["publicUrl"],
        message: expect.stringContaining("OPENLIFEWIKI_PUBLIC_URL"),
      }),
    ]));
    expect(renderError(error)).not.toContain(sensitiveValue);
  });

  it.each([
    ["username and password", "https://sensitive-user:sensitive-password@api.openai.com/v1"],
    ["username only", "https://sensitive-user@api.openai.com/v1"],
    [
      "encoded userinfo",
      "https://sensitive%40user:sensitive%3Apassword@api.openai.com/v1",
    ],
  ])("rejects OpenAI base URL %s with configuration context", (_name, baseUrl) => {
    expect(() => readServerConfig({
      ...testEnvironment(),
      OPENAI_BASE_URL: baseUrl,
    })).toThrow(/OPENAI_BASE_URL/u);
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

function readPublicUrlError(publicUrl: string): ZodError {
  let error: unknown;
  try {
    readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: publicUrl,
    });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(ZodError);
  expect(renderError(error)).not.toContain(publicUrl);
  return error as ZodError;
}

function renderError(error: unknown): string {
  return String(error) + JSON.stringify(error);
}
