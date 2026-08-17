import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseDeploymentConfig } from "../src/deployment-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Linux gateway deployment configuration", () => {
  it("parses a complete valid systemd environment profile", () => {
    expect(parseDeploymentConfig(validEnvironment())).toMatchObject({
      bindHost: "127.0.0.1",
      port: 8080,
      publicUrl: "https://knowledge.acme.com",
      model: "gpt-5.5",
      disableResponseStorage: true,
    });
  });

  it.each([
    ["a missing model", { OPENLIFEWIKI_MODEL: undefined }],
    ["a non-numeric port", { PORT: "abc" }],
    ["a non-deployment port", { PORT: "8081" }],
    ["a malformed public HTTPS URL", { OPENLIFEWIKI_PUBLIC_URL: "https://[broken" }],
    ["a loopback public URL", { OPENLIFEWIKI_PUBLIC_URL: "https://127.0.0.1:8080" }],
    ["another loopback public URL", { OPENLIFEWIKI_PUBLIC_URL: "https://127.0.0.2:8080" }],
    [
      "an IPv4-mapped IPv6 loopback URL",
      { OPENLIFEWIKI_PUBLIC_URL: "https://[::ffff:127.0.0.1]" },
    ],
    [
      "an equivalent IPv4-mapped IPv6 loopback URL",
      { OPENLIFEWIKI_PUBLIC_URL: "https://[::ffff:7f00:1]" },
    ],
    ["the example public URL", { OPENLIFEWIKI_PUBLIC_URL: "https://knowledge.example.com" }],
    [
      "the equivalent dotted example URL",
      { OPENLIFEWIKI_PUBLIC_URL: "https://knowledge.example.com." },
    ],
    ["an insecure OpenAI base URL", { OPENAI_BASE_URL: "http://api.openai.com/v1" }],
    ["response storage enabled", { OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "false" }],
    ["invalid graph origins", { OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "https://*.acme.com" }],
    ["a weak HMAC secret", { OPENLIFEWIKI_TOKEN_HMAC_SECRET: "too-short" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseDeploymentConfig(validEnvironment(overrides))).toThrow();
  });

  it.each([
    [
      "username and password",
      "https://sensitive-user:sensitive-password@knowledge.acme.com",
    ],
    ["username only", "https://sensitive-user@knowledge.acme.com"],
    [
      "encoded userinfo",
      "https://sensitive%40user:sensitive%3Apassword@knowledge.acme.com",
    ],
  ])("rejects public URL %s without echoing credentials", (_name, publicUrl) => {
    expect(() => parseDeploymentConfig(
      validEnvironment({ OPENLIFEWIKI_PUBLIC_URL: publicUrl }),
    )).toThrowError(/^Deployment public URL must be a non-example remote HTTPS URL$/u);
  });

  it.each([
    ["a remote IPv4 URL", "https://203.0.113.10"],
    ["a remote IPv6 URL", "https://[2001:db8::1]"],
  ])("accepts %s", (_name, publicUrl) => {
    expect(parseDeploymentConfig(
      validEnvironment({ OPENLIFEWIKI_PUBLIC_URL: publicUrl }),
    ).publicUrl).toBe(publicUrl);
  });

  it.each([
    ["a duplicate API key", " OPENAI_API_KEY =duplicate-provider-key\n"],
    ["a duplicate port", "PORT=8080\n"],
  ])("rejects %s", (_name, duplicateLine) => {
    expect(() => parseDeploymentConfig(
      validEnvironment() + duplicateLine,
    )).toThrow();
  });

  it.each([
    ["a malformed assignment", "BROKEN LINE"],
    ["a quoted value", 'OPENAI_API_KEY="quoted-provider-key"'],
    ["a backslash value", "OPENAI_API_KEY=provider\\key"],
    ["a continued line", "OPENAI_API_KEY=provider\\\nCONTINUED=value"],
  ])("fails closed for %s", (_name, invalidLine) => {
    expect(() => parseDeploymentConfig(
      validEnvironment({ OPENAI_API_KEY: undefined }) + invalidLine + "\n",
    )).toThrow();
  });

  it("treats a shell payload as inert data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cowikiharness-deployment-config-"));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, "executed");
    const payload = "$(touch$" + "{IFS}" + markerPath + ")";

    const config = parseDeploymentConfig(validEnvironment({ OPENAI_API_KEY: payload }));

    expect(config.openAIApiKey).toBe(payload);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function validEnvironment(overrides: Record<string, string | undefined> = {}): string {
  const environment: Record<string, string | undefined> = {
    DATABASE_URL:
      "postgres://cowikiharness:strong-database-password@127.0.0.1:5432/cowikiharness",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPENAI_API_KEY: "test-provider-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENLIFEWIKI_MODEL: "gpt-5.5",
    OPENLIFEWIKI_MODEL_REASONING_EFFORT: "xhigh",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    OPENLIFEWIKI_BIND_HOST: "127.0.0.1",
    PORT: "8080",
    OPENLIFEWIKI_PUBLIC_URL: "https://knowledge.acme.com",
    OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "",
    ...overrides,
  };

  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => key + "=" + value)
    .join("\n") + "\n";
}
