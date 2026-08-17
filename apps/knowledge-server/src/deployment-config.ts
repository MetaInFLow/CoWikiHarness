import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readServerConfig, type ServerConfig } from "./config.js";

const environmentKeyPattern = /^[A-Z_][A-Z0-9_]*$/u;
const tokenHmacPattern = /^[0-9A-Fa-f]{64}$/u;
const invalidCliMessage = "Invalid gateway deployment configuration.";

export function parseDeploymentConfig(contents: string): ServerConfig {
  const env = parseEnvironmentFile(contents);
  if (env.PORT === undefined || env.OPENLIFEWIKI_BIND_HOST === undefined) {
    throw new Error("Deployment profile requires explicit PORT and bind host");
  }

  const config = readServerConfig(env);
  if (config.bindHost !== "127.0.0.1") {
    throw new Error("Deployment bind host must be loopback");
  }
  if (config.port !== 8080) {
    throw new Error("Deployment port must be 8080");
  }
  if (!tokenHmacPattern.test(config.tokenHmacSecret)) {
    throw new Error("Deployment HMAC secret must be 64 hexadecimal characters");
  }

  const publicUrl = new URL(config.publicUrl);
  const publicHostname = normalizeHostname(publicUrl.hostname);
  if (publicUrl.protocol !== "https:"
    || publicUrl.username !== ""
    || publicUrl.password !== ""
    || publicUrl.pathname !== "/"
    || isNonRemoteHost(publicHostname)
    || publicHostname === "knowledge.example.com") {
    throw new Error("Deployment public URL must be a non-example remote HTTPS origin");
  }

  return config;
}

export function parseEnvironmentFile(contents: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();

  for (const line of contents.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error("Deployment environment contains a malformed assignment");
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1);
    if (!environmentKeyPattern.test(key) || rawValue !== rawValue.trim()) {
      throw new Error("Deployment environment contains an unsupported assignment");
    }
    if (rawValue.includes('"') || rawValue.includes("'")) {
      throw new Error("Deployment environment does not support quoted values");
    }
    if (rawValue.includes("\\")) {
      throw new Error("Deployment environment does not support backslash escapes");
    }
    if (seen.has(key)) {
      throw new Error("Deployment environment contains a duplicate key");
    }

    seen.add(key);
    env[key] = rawValue;
  }

  return env;
}

async function runCli(args: readonly string[]): Promise<void> {
  try {
    if (args.length !== 1) throw new Error("Expected one configuration path");
    const contents = await readFile(args[0]!, "utf8");
    parseDeploymentConfig(contents);
    process.stdout.write("Gateway deployment configuration is valid.\n");
  } catch {
    process.stderr.write(invalidCliMessage + "\n");
    process.exitCode = 1;
  }
}

function isNonRemoteHost(hostname: string): boolean {
  return hostname === "localhost"
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
    || /^\[?::ffff:/u.test(hostname)
    || hostname === "[::1]"
    || hostname === "::1"
    || hostname === "0.0.0.0"
    || hostname === "[::]"
    || hostname === "::";
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2));
}
