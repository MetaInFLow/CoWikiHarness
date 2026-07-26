import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { CommandRunner } from "../command-runner.js";
import type { ConnectorProvider } from "./connector-provider.js";
import { commandFailureKind, parseVersion, redacted, safeBlocking } from "./connector-provider.js";

export const codexHistoryConnector: ConnectorProvider = {
  connectorType: "codex-history",
  async probe({ source, runner, now, scratchRoot }) {
    const observedAt = now().toISOString();
    let version: string | undefined;
    try {
      const result = await runner.run("codex", ["--version"], { timeoutMs: 15_000 });
      version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (version === undefined) return blocked("CODEX_VERSION_INVALID", "Install a supported Codex CLI release");
    } catch (error) {
      const kind = commandFailureKind(error);
      const code = kind === "missing" ? "CODEX_CLI_MISSING"
        : kind === "timeout" ? "CODEX_PROVIDER_TIMEOUT" : "CODEX_PROVIDER_FAILED";
      return base(kind === "missing" ? "missing" : "blocked", { account: "unverified" }, safeBlocking(code, "Install Codex CLI and sign in through Codex"));
    }
    let loginMode: string;
    try {
      const login = await runner.run("codex", ["login", "status"], { timeoutMs: 20_000 });
      const combined = `${login.stdout}\n${login.stderr}`;
      if (!/(logged in|authenticated)/iu.test(combined)) return authRequired();
      loginMode = /chatgpt/iu.test(combined) ? "ChatGPT login" : "Codex login";
    } catch (error) {
      return commandFailureKind(error) === "timeout"
        ? blocked("CODEX_AUTH_TIMEOUT", "Retry the Codex login check")
        : blocked("CODEX_AUTH_CHECK_FAILED", "Retry the Codex login check");
    }
    let account: CodexAccount;
    try {
      account = await readCodexAccount(runner);
    } catch (error) {
      return commandFailureKind(error) === "timeout"
        ? blocked("CODEX_ACCOUNT_TIMEOUT", "Retry the Codex account identity check")
        : blocked("CODEX_IDENTITY_UNAVAILABLE", "Sign in with a ChatGPT account that exposes a stable public email identity");
    }
    const visibleIdentity = {
      account: redactEmail(account.email),
      profile: loginMode,
      ...(account.planType === null ? {} : { plan: account.planType }),
    };

    const approvedObservation = source.providerObservation;
    if (approvedObservation !== undefined) {
      if (approvedObservation.providerName !== "codex app-server v2"
        || approvedObservation.providerVersion !== version) {
        return blocked("CODEX_VERSION_CHANGED", "Preview and approve Codex History again for the current Codex version", loginMode);
      }
      if (approvedObservation.contractHash === null) {
        return blocked("CODEX_SCHEMA_UNVERIFIED", "Preview and approve Codex History after app-server v2 schema verification", loginMode);
      }
      const fingerprint = sha256Canonical({
        provider: "codex", accountType: account.type, email: account.email,
        version, loginMode, schema: approvedObservation.contractHash,
      });
      return {
        ...base("connected", { ...visibleIdentity, fingerprint }, null),
        providerContractHash: approvedObservation.contractHash,
      };
    }

    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(scratchRoot, "codex-schema-"));
    try {
      await runner.run("codex", ["app-server", "generate-json-schema", "--out", scratch], { timeoutMs: 60_000 });
      const schemaDocuments = await readJsonTree(scratch);
      if (!hasRequiredAppServerV2Schema(schemaDocuments)) {
        return blocked("CODEX_SCHEMA_MISMATCH", "Update Codex to a release with the required app-server v2 thread contract", loginMode);
      }
      const contractHash = sha256Canonical(schemaDocuments);
      const fingerprint = sha256Canonical({
        provider: "codex", accountType: account.type, email: account.email,
        version, loginMode, schema: contractHash,
      });
      return { ...base("connected", { ...visibleIdentity, fingerprint }, null), providerContractHash: contractHash };
    } catch (error) {
      const kind = commandFailureKind(error);
      return blocked(kind === "timeout" ? "CODEX_SCHEMA_TIMEOUT" : "CODEX_SCHEMA_UNAVAILABLE", "Verify the Codex app-server v2 schema generator", loginMode);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    function base(
      status: ConnectorStatus["status"], identity: Readonly<Record<string, string>>, blocking: ConnectorStatus["blocking"],
    ): ConnectorStatus {
      return {
        schema: "openlifewiki.connector-status/v1", sourceId: source.sourceId, connectorType: "codex-history",
        providerName: "codex app-server v2", providerProject: "openai/codex", ...(version === undefined ? {} : { providerVersion: version }),
        identity, authorizedScope: source.scope, status, lastProbe: observedAt, changedItems: 0, blocking,
      };
    }
    function blocked(code: string, remediation: string, account = "unverified"): ConnectorStatus {
      return base("blocked", { account }, safeBlocking(code, remediation));
    }
    function authRequired(): ConnectorStatus {
      return base("auth-required", { account: "unverified" }, safeBlocking("CODEX_AUTH_REQUIRED", "Sign in through the Codex CLI"));
    }
  },
};

interface CodexAccount {
  readonly type: "chatgpt";
  readonly email: string;
  readonly planType: string | null;
}

async function readCodexAccount(runner: CommandRunner): Promise<CodexAccount> {
  if (runner.runJsonLineSession === undefined) {
    throw new Error("Command runner does not support staged JSONL sessions");
  }
  const responses = await runner.runJsonLineSession("codex", ["app-server", "--stdio"], [
    {
      message: {
        method: "initialize", id: 0,
        params: { clientInfo: { name: "openlifewiki", title: "openLifeWiki", version: "0.1.0-dev.1" } },
      },
      awaitResponseId: 0,
    },
    { message: { method: "initialized", params: {} } },
    { message: { method: "account/read", id: 1, params: { refreshToken: false } }, awaitResponseId: 1 },
  ], { timeoutMs: 30_000 });
  for (const value of responses) {
    if (!isRecord(value) || value.id !== 1 || !isRecord(value.result) || !isRecord(value.result.account)) continue;
    const account = value.result.account;
    if (account.type !== "chatgpt" || typeof account.email !== "string"
      || (account.planType !== undefined && account.planType !== null && typeof account.planType !== "string")) break;
    const email = account.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/u.test(email)) break;
    return { type: "chatgpt", email, planType: typeof account.planType === "string" ? account.planType : null };
  }
  throw new Error("Codex account/read returned no stable ChatGPT identity");
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${redacted(local ?? "account")}@${domain ?? "hidden"}`;
}

interface SchemaDocument {
  readonly path: string;
  readonly value: unknown;
}

async function readJsonTree(root: string): Promise<readonly SchemaDocument[]> {
  const parts: SchemaDocument[] = [];
  await walk(root, root, parts);
  return parts;
}

async function walk(root: string, directory: string, parts: SchemaDocument[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, parts);
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      parts.push({ path: relative(root, path).replaceAll("\\", "/"), value: JSON.parse(await readFile(path, "utf8")) as unknown });
    }
  }
}

function hasRequiredAppServerV2Schema(documents: readonly SchemaDocument[]): boolean {
  const list = documents.find(({ path }) => path === "v2/ThreadListParams.json");
  const read = documents.find(({ path }) => path === "v2/ThreadReadParams.json");
  const clientRequests = documents.filter(({ path }) => path.endsWith("ClientRequest.json"));
  if (list === undefined || read === undefined || clientRequests.length === 0) return false;
  const listProperties = schemaProperties(list.value);
  const readProperties = schemaProperties(read.value);
  if (listProperties === undefined || readProperties === undefined) return false;
  return clientRequests.some(({ value }) => declaresMethod(value, "thread/list"))
    && clientRequests.some(({ value }) => declaresMethod(value, "thread/read"))
    && propertyAllowsType(listProperties.cwd, "string")
    && propertyAllowsType(listProperties.cursor, "string")
    && propertyAllowsType(listProperties.useStateDbOnly, "boolean")
    && propertyAllowsType(readProperties.threadId, "string")
    && propertyAllowsType(readProperties.includeTurns, "boolean");
}

function schemaProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.properties)) return value.properties;
  for (const child of Object.values(value)) {
    const found = schemaProperties(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function propertyAllowsType(value: unknown, expected: "string" | "boolean"): boolean {
  if (!isRecord(value)) return false;
  if (value.type === expected) return true;
  if (Array.isArray(value.type) && value.type.includes(expected)) return true;
  return Object.values(value).some((child) => Array.isArray(child)
    ? child.some((item) => propertyAllowsType(item, expected))
    : propertyAllowsType(child, expected));
}

function declaresMethod(value: unknown, method: string): boolean {
  if (Array.isArray(value)) return value.some((item) => declaresMethod(item, method));
  if (!isRecord(value)) return false;
  if (isRecord(value.properties) && isRecord(value.properties.method)) {
    const schema = value.properties.method;
    if (schema.const === method || (Array.isArray(schema.enum) && schema.enum.includes(method))) return true;
  }
  return Object.values(value).some((item) => declaresMethod(item, method));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
