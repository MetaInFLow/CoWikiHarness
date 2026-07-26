import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { ConnectorProvider } from "./connector-provider.js";
import { commandFailureKind, parseVersion, redacted, safeBlocking } from "./connector-provider.js";

export const githubConnector: ConnectorProvider = {
  connectorType: "github",
  async probe({ source, runner, now }) {
    const observedAt = now().toISOString();
    const scope = source.scope as Record<string, unknown>;
    const hostname = String(scope.hostname ?? "");
    const repository = String(scope.repository ?? "");
    let version: string | undefined;
    try {
      const result = await runner.run("gh", ["--version"], { timeoutMs: 15_000 });
      version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (version === undefined) return blocked("GITHUB_VERSION_INVALID", "Install a supported GitHub CLI release");
    } catch (error) {
      return unavailable(error, "Install the GitHub CLI and sign in");
    }
    let login: string | undefined;
    try {
      const auth = await runner.run("gh", ["auth", "status", "--active", "--hostname", hostname, "--json", "hosts"], {
        timeoutMs: 20_000,
      });
      login = activeGithubLogin(auth.stdout, hostname);
      if (login === undefined) return authRequired("GITHUB_AUTH_REQUIRED", "Sign in to the approved GitHub host");
    } catch {
      return authRequired("GITHUB_AUTH_REQUIRED", "Sign in to the approved GitHub host");
    }
    try {
      const repo = await runner.run("gh", ["repo", "view", repository, "--json", "nameWithOwner,url,defaultBranchRef"], {
        env: { ...process.env, GH_HOST: hostname },
        timeoutMs: 20_000,
      });
      const value = parseObject(repo.stdout);
      if (value?.nameWithOwner !== repository) return blocked("GITHUB_SCOPE_MISMATCH", "Review the approved repository and authenticated account");
    } catch {
      return blocked("GITHUB_REPOSITORY_BLOCKED", "Grant metadata access to the approved repository or narrow its scope");
    }
    const fingerprint = sha256Canonical({ provider: "github", hostname, login });
    return base("connected", { account: redacted(login), host: hostname, fingerprint }, null);

    function base(
      status: ConnectorStatus["status"], identity: Readonly<Record<string, string>>, blocking: ConnectorStatus["blocking"],
    ): ConnectorStatus {
      return {
        schema: "openlifewiki.connector-status/v1", sourceId: source.sourceId, connectorType: "github",
        providerName: "gh", providerProject: "cli/cli", ...(version === undefined ? {} : { providerVersion: version }),
        identity, authorizedScope: source.scope, status, lastProbe: observedAt, changedItems: 0, blocking,
      };
    }
    function blocked(code: string, remediation: string): ConnectorStatus {
      return base("blocked", { account: login === undefined ? "unverified" : redacted(login), host: hostname }, safeBlocking(code, remediation));
    }
    function authRequired(code: string, remediation: string): ConnectorStatus {
      return base("auth-required", { account: "unverified", host: hostname }, safeBlocking(code, remediation));
    }
    function unavailable(error: unknown, remediation: string): ConnectorStatus {
      const kind = commandFailureKind(error);
      return base(kind === "missing" ? "missing" : "blocked", { account: "unverified", host: hostname }, safeBlocking(kind === "missing" ? "GITHUB_CLI_MISSING" : "GITHUB_PROVIDER_FAILED", remediation));
    }
  },
};

function activeGithubLogin(raw: string, hostname: string): string | undefined {
  const value = parseObject(raw);
  const hosts = value?.hosts;
  if (typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) return undefined;
  const entries = (hosts as Record<string, unknown>)[hostname];
  if (!Array.isArray(entries)) return undefined;
  const active = entries.find((entry) => typeof entry === "object" && entry !== null
    && (entry as Record<string, unknown>).active === true);
  return active !== undefined && typeof (active as Record<string, unknown>).login === "string"
    ? (active as Record<string, string>).login : undefined;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
