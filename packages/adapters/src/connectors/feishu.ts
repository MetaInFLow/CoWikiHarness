import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { ConnectorProvider } from "./connector-provider.js";
import { commandFailureKind, parseVersion, redacted, safeBlocking } from "./connector-provider.js";

export const feishuConnector: ConnectorProvider = {
  connectorType: "feishu",
  async probe({ source, runner, now }) {
    const observedAt = now().toISOString();
    const scope = source.scope as Record<string, unknown>;
    const profile = String(scope.profile ?? "");
    const expectedTenantId = String(scope.expectedTenantId ?? "");
    let version: string | undefined;
    try {
      const result = await runner.run("lark-cli", ["--profile", profile, "--version"], { timeoutMs: 15_000 });
      version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (version === undefined) return blocked("FEISHU_VERSION_INVALID", "Install a supported lark-cli release", "unverified", "unverified");
    } catch (error) {
      const kind = commandFailureKind(error);
      return base(kind === "missing" ? "missing" : "blocked", "unverified", "unverified", safeBlocking(kind === "missing" ? "FEISHU_CLI_MISSING" : "FEISHU_PROVIDER_FAILED", "Install lark-cli and keep the approved profile"));
    }
    let auth: Record<string, unknown> | undefined;
    try {
      const result = await runner.run("lark-cli", ["--profile", profile, "auth", "status", "--json", "--verify"], { timeoutMs: 30_000 });
      auth = parseObject(result.stdout);
    } catch {
      return base("auth-required", "unverified", "unverified", safeBlocking("FEISHU_AUTH_REQUIRED", `Sign in with the selected profile ${profile}`));
    }
    if (auth === undefined) return blocked("FEISHU_IDENTITY_INVALID", "Re-authenticate the selected profile", "unverified", "unverified");
    if (auth.verified !== true) {
      return base("auth-required", "unverified", "unverified", safeBlocking("FEISHU_AUTH_REQUIRED", `Re-authenticate selected profile ${profile}`));
    }
    const tenantId = firstString(auth, ["tenant_id", "tenantId", "tenant_key", "tenantKey", "appId", "app_id", "brand"]);
    const account = firstString(auth, ["name", "user_name", "userName", "email", "open_id", "openId"]) ?? "unverified";
    const effectiveScope = collectStringArray(auth, ["scopes", "scope", "permissions"]);
    if (tenantId === undefined || tenantId !== expectedTenantId) {
      return blocked("FEISHU_TENANT_MISMATCH", `Use profile ${profile} for the approved tenant`, account, tenantId ?? "unverified", effectiveScope);
    }
    const fingerprint = sha256Canonical({ provider: "feishu", profile, tenantId, account });
    return base("connected", account, tenantId, null, effectiveScope, fingerprint);

    function base(
      status: ConnectorStatus["status"], account: string, tenant: string,
      blocking: ConnectorStatus["blocking"], effectiveScope: readonly string[] = [], fingerprint?: string,
    ): ConnectorStatus {
      return {
        schema: "openlifewiki.connector-status/v1", sourceId: source.sourceId, connectorType: "feishu",
        providerName: "lark-cli", providerProject: "larksuite/cli", ...(version === undefined ? {} : { providerVersion: version }),
        identity: {
          profile,
          account: account === "unverified" ? account : redacted(account),
          tenant: tenant === "unverified" ? tenant : redacted(tenant),
          effectiveScope: effectiveScope.join(",") || "unverified",
          ...(fingerprint === undefined ? {} : { fingerprint }),
        },
        authorizedScope: source.scope, status, lastProbe: observedAt, changedItems: 0, blocking,
      };
    }
    function blocked(
      code: string, remediation: string, account: string, tenant: string,
      effectiveScope: readonly string[] = [],
    ): ConnectorStatus {
      return base("blocked", account, tenant, safeBlocking(code, remediation), effectiveScope);
    }
  },
};

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function firstString(value: unknown, keys: readonly string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string" && record[key].length > 0) return record[key];
  for (const child of Object.values(record)) {
    const found = firstString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectStringArray(value: unknown, keys: readonly string[]): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) return [...new Set(candidate)].sort();
    if (typeof candidate === "string") return candidate.split(/[ ,]+/u).filter(Boolean).sort();
  }
  for (const child of Object.values(record)) {
    const found = collectStringArray(child, keys);
    if (found.length > 0) return found;
  }
  return [];
}
