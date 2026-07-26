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
      const code = kind === "missing" ? "FEISHU_CLI_MISSING"
        : kind === "timeout" ? "FEISHU_PROVIDER_TIMEOUT" : "FEISHU_PROVIDER_FAILED";
      return base(kind === "missing" ? "missing" : "blocked", "unverified", "unverified", safeBlocking(code, "Install lark-cli and keep the approved profile"));
    }
    let auth: FeishuAuthStatus | undefined;
    try {
      const result = await runner.run("lark-cli", ["--profile", profile, "auth", "status", "--json", "--verify"], { timeoutMs: 30_000 });
      auth = parseAuthStatus(result.stdout);
    } catch (error) {
      const kind = commandFailureKind(error);
      return kind === "timeout"
        ? base("blocked", "unverified", "unverified", safeBlocking("FEISHU_AUTH_TIMEOUT", `Retry selected profile ${profile}`))
        : base("blocked", "unverified", "unverified", safeBlocking("FEISHU_AUTH_CHECK_FAILED", `Retry the selected profile ${profile} authentication check`));
    }
    if (auth === undefined) return blocked("FEISHU_IDENTITY_INVALID", "Re-authenticate the selected profile", "unverified", "unverified");
    if (auth.verified !== true || auth.user.verified !== true || auth.user.available !== true
      || auth.user.status !== "ready" || auth.user.tokenStatus !== "valid") {
      return base("auth-required", "unverified", "unverified", safeBlocking("FEISHU_AUTH_REQUIRED", `Re-authenticate selected profile ${profile}`));
    }
    const requiredScopes = requiredFeishuScopes(scope);
    if (requiredScopes.length === 0 || !requiredScopes.every((required) => auth.user.scopes.includes(required))) {
      return blocked("FEISHU_SCOPE_MISSING", `Grant the selected profile the required read scopes`, auth.user.userName, "unverified", requiredScopes);
    }
    try {
      const checked = await runner.run("lark-cli", [
        "--profile", profile, "auth", "check", "--scope", requiredScopes.join(" "), "--json",
      ], { timeoutMs: 30_000 });
      if (!scopeCheckPassed(checked.stdout, requiredScopes)) {
        return blocked("FEISHU_SCOPE_MISSING", "Grant the selected profile the required read scopes", auth.user.userName, "unverified", requiredScopes);
      }
    } catch {
      return blocked("FEISHU_SCOPE_CHECK_FAILED", "Verify the selected profile read scopes", auth.user.userName, "unverified", requiredScopes);
    }
    let user: FeishuCurrentUser | undefined;
    try {
      const result = await runner.run("lark-cli", [
        "--profile", profile, "contact", "+get-user", "--as", "user", "--json",
      ], { timeoutMs: 30_000 });
      user = parseCurrentUser(result.stdout);
    } catch {
      return blocked("FEISHU_IDENTITY_INVALID", `Verify the selected profile current user`, auth.user.userName, "unverified", requiredScopes);
    }
    if (user === undefined || user.openId !== auth.user.openId) {
      return blocked("FEISHU_IDENTITY_INVALID", `Verify the selected profile current user`, auth.user.userName, user?.tenantKey ?? "unverified", requiredScopes);
    }
    if (user.tenantKey !== expectedTenantId) {
      return blocked("FEISHU_TENANT_MISMATCH", `Use profile ${profile} for the approved tenant`, user.name, user.tenantKey, requiredScopes);
    }
    const fingerprint = sha256Canonical({
      provider: "feishu", profile, appId: auth.appId, tenantKey: user.tenantKey, openId: user.openId,
    });
    return base("connected", user.name, user.tenantKey, null, requiredScopes, fingerprint);

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

interface FeishuAuthStatus {
  readonly appId: string;
  readonly verified: boolean;
  readonly user: {
    readonly status: string;
    readonly available: boolean;
    readonly verified: boolean;
    readonly openId: string;
    readonly userName: string;
    readonly tokenStatus: string;
    readonly scopes: readonly string[];
  };
}

interface FeishuCurrentUser {
  readonly name: string;
  readonly openId: string;
  readonly tenantKey: string;
}

function parseAuthStatus(raw: string): FeishuAuthStatus | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !isRecord(value.identities) || !isRecord(value.identities.user)) return undefined;
    const user = value.identities.user;
    if (typeof value.appId !== "string" || typeof value.verified !== "boolean"
      || typeof user.status !== "string" || typeof user.available !== "boolean"
      || typeof user.verified !== "boolean" || typeof user.openId !== "string"
      || typeof user.userName !== "string" || typeof user.tokenStatus !== "string"
      || typeof user.scope !== "string") return undefined;
    return {
      appId: value.appId,
      verified: value.verified,
      user: {
        status: user.status,
        available: user.available,
        verified: user.verified,
        openId: user.openId,
        userName: user.userName,
        tokenStatus: user.tokenStatus,
        scopes: user.scope.split(/\s+/u).filter(Boolean),
      },
    };
  } catch {
    return undefined;
  }
}

function parseCurrentUser(raw: string): FeishuCurrentUser | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.user)) return undefined;
    const user = value.data.user;
    if (typeof user.name !== "string" || typeof user.open_id !== "string" || typeof user.tenant_key !== "string") return undefined;
    return { name: user.name, openId: user.open_id, tenantKey: user.tenant_key };
  } catch {
    return undefined;
  }
}

function scopeCheckPassed(raw: string, requiredScopes: readonly string[]): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.ok !== true) return false;
    const granted = value.granted;
    const missing = value.missing;
    if (!Array.isArray(granted) || (missing !== null && !Array.isArray(missing))) return false;
    return (missing === null || missing.length === 0)
      && requiredScopes.every((scope) => granted.includes(scope));
  } catch {
    return false;
  }
}

function requiredFeishuScopes(scope: Record<string, unknown>): readonly string[] {
  const required = new Set<string>();
  if (Array.isArray(scope.documentIds) && scope.documentIds.length > 0) required.add("docs:document.content:read");
  if (Array.isArray(scope.wikiNodeIds) && scope.wikiNodeIds.length > 0) required.add("wiki:node:read");
  if (Array.isArray(scope.baseIds) && scope.baseIds.length > 0) {
    required.add("base:app:read");
    required.add("base:table:read");
    required.add("base:record:read");
  }
  return [...required].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
