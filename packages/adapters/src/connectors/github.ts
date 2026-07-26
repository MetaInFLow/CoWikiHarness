import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { ConnectorProvider } from "./connector-provider.js";
import { commandFailureKind, parseVersion, redacted, safeBlocking } from "./connector-provider.js";

const GITHUB_SCOPE_QUERY = "query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){nameWithOwner object(expression:$expression){__typename oid}}}";

export const githubConnector: ConnectorProvider = {
  connectorType: "github",
  async probe({ source, runner, now }) {
    const observedAt = now().toISOString();
    const scope = source.scope as Record<string, unknown>;
    const hostname = String(scope.hostname ?? "");
    const repository = String(scope.repository ?? "");
    const [owner, name] = repository.split("/");
    const ref = String(scope.ref ?? "");
    const path = scope.path === null ? null : String(scope.path ?? "");
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
    } catch (error) {
      const kind = commandFailureKind(error);
      return kind === "timeout"
        ? blocked("GITHUB_AUTH_TIMEOUT", "Retry the GitHub authentication check")
        : blocked("GITHUB_AUTH_CHECK_FAILED", "Retry the GitHub authentication check");
    }
    try {
      const expression = path === null ? ref : `${ref}:${path}`;
      const repo = await runner.run("gh", [
        "api", "graphql", "-f", `query=${GITHUB_SCOPE_QUERY}`,
        "-F", `owner=${owner ?? ""}`, "-F", `name=${name ?? ""}`, "-F", `expression=${expression}`,
      ], {
        env: { ...process.env, GH_HOST: hostname },
        timeoutMs: 20_000,
      });
      if (!githubScopeExists(repo.stdout, repository)) {
        return blocked("GITHUB_SCOPE_MISMATCH", "Review the approved repository, path and ref");
      }
    } catch {
      return blocked("GITHUB_SCOPE_CHECK_FAILED", "Retry the approved repository, path and ref metadata check");
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
      const code = kind === "missing" ? "GITHUB_CLI_MISSING"
        : kind === "timeout" ? "GITHUB_PROVIDER_TIMEOUT" : "GITHUB_PROVIDER_FAILED";
      return base(kind === "missing" ? "missing" : "blocked", { account: "unverified", host: hostname }, safeBlocking(code, remediation));
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

function githubScopeExists(raw: string, repository: string): boolean {
  const value = parseObject(raw);
  if (!isRecord(value?.data) || !isRecord(value.data.repository)) return false;
  const repo = value.data.repository;
  return repo.nameWithOwner === repository && isRecord(repo.object)
    && typeof repo.object.__typename === "string"
    && typeof repo.object.oid === "string"
    && repo.object.oid.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
