import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { ConnectorProvider } from "./connector-provider.js";
import { commandFailureKind, parseVersion, safeBlocking } from "./connector-provider.js";

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
      return base(kind === "missing" ? "missing" : "blocked", { account: "unverified" }, safeBlocking(kind === "missing" ? "CODEX_CLI_MISSING" : "CODEX_PROVIDER_FAILED", "Install Codex CLI and sign in through Codex"));
    }
    let loginMode: string;
    try {
      const login = await runner.run("codex", ["login", "status"], { timeoutMs: 20_000 });
      const combined = `${login.stdout}\n${login.stderr}`;
      if (!/(logged in|authenticated)/iu.test(combined)) return authRequired();
      loginMode = /chatgpt/iu.test(combined) ? "ChatGPT login" : "Codex login";
    } catch {
      return authRequired();
    }

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
        provider: "codex", version, loginMode, schema: approvedObservation.contractHash,
      });
      return {
        ...base("connected", { account: loginMode, fingerprint }, null),
        providerContractHash: approvedObservation.contractHash,
      };
    }

    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(scratchRoot, "codex-schema-"));
    try {
      await runner.run("codex", ["app-server", "generate-json-schema", "--out", scratch], { timeoutMs: 60_000 });
      const schemaText = await readJsonTree(scratch);
      if (!hasRequiredAppServerV2Schema(schemaText)) {
        return blocked("CODEX_SCHEMA_MISMATCH", "Update Codex to a release with the required app-server v2 thread contract", loginMode);
      }
      const contractHash = sha256Canonical(schemaText);
      const fingerprint = sha256Canonical({ provider: "codex", version, loginMode, schema: contractHash });
      return { ...base("connected", { account: loginMode, fingerprint }, null), providerContractHash: contractHash };
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

async function readJsonTree(root: string): Promise<string> {
  const parts: string[] = [];
  await walk(root, parts);
  return parts.join("\n");
}

async function walk(directory: string, parts: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, parts);
    else if (entry.isFile() && entry.name.endsWith(".json")) parts.push(await readFile(path, "utf8"));
  }
}

function hasRequiredAppServerV2Schema(value: string): boolean {
  return value.includes("thread/list")
    && value.includes("thread/read")
    && value.includes('"cwd"')
    && value.includes('"cursor"')
    && value.includes('"useStateDbOnly"')
    && value.includes('"threadId"')
    && value.includes('"includeTurns"');
}
