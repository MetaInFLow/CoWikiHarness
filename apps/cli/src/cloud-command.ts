import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  AdapterError,
  PostgresKnowledgeStore,
  runMigrations,
} from "@openlifewiki/adapters";
import {
  KNOWLEDGE_CAPABILITIES,
  resourceScopeSchema,
  type AccessContext,
  type KnowledgeCapability,
  type ResourceScope,
} from "@openlifewiki/protocol";

const DEFAULT_AGENT_CAPABILITIES = [
  "knowledge.query",
  "knowledge.register",
  "knowledge.store",
  "knowledge.organize",
] as const satisfies readonly KnowledgeCapability[];

const CLOUD_USAGE = [
  "openlifewiki cloud migrate --json",
  "openlifewiki cloud bootstrap --organization <name> --owner <name> --agent <name> --json",
  "openlifewiki cloud member create --name <name> --owner-token-file <path> --json",
  "openlifewiki cloud agent create --name <name> --for-user <principal> --owner-token-file <path> --json",
  "openlifewiki cloud grant --principal <id> --scope <kind:id> --capability <capability> --owner-token-file <path> --json",
  "openlifewiki cloud token rotate --principal <id> --owner-token-file <path> --json",
  "openlifewiki cloud token revoke --token-id <id> --owner-token-file <path> --json",
] as const;

export async function runCloudCommand(input: {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly out: (value: string) => void;
  readonly now: () => Date;
}): Promise<number | undefined> {
  const command = parseCloudCommand(input.argv);
  if (command === undefined) return undefined;
  if (command === null) {
    throw new AdapterError("CONFIG_INVALID", "Invalid cloud command invocation", {
      publicDetails: { usage: CLOUD_USAGE },
    });
  }

  const databaseUrl = requiredEnvironment(input.env, "DATABASE_URL");
  const tokenHmacSecret = requiredEnvironment(input.env, "OPENLIFEWIKI_TOKEN_HMAC_SECRET");
  if (Buffer.byteLength(tokenHmacSecret, "utf8") < 32) {
    throw new AdapterError("CONFIG_INVALID", "OPENLIFEWIKI_TOKEN_HMAC_SECRET must be at least 32 bytes");
  }

  const database = createDatabase({ connectionString: databaseUrl });
  try {
    await runMigrations(database, { migrationsDir: migrationsDirectory() });
    if (command.kind === "migrate") {
      writeJson(input.out, {
        schema: "openlifewiki.cloud-migration/v1",
        status: "migrated",
      });
      return 0;
    }

    const store = new PostgresKnowledgeStore(database, tokenHmacSecret);
    if (command.kind === "bootstrap") {
      const now = input.now();
      const result = await store.bootstrap({
        organizationName: command.organization,
        ownerDisplayName: command.owner,
        agentDisplayName: command.agent,
        delegationExpiresAt: oneYearFrom(now),
      });
      writeJson(input.out, result);
      return 0;
    }

    const ownerToken = await readOwnerToken(command.ownerTokenFile);
    const ownerContext = await resolveOwnerContext(store, ownerToken, command.kind, input.now());
    if (command.kind === "member.create") {
      writeJson(input.out, await store.createMember({
        ownerContext,
        displayName: command.name,
      }));
      return 0;
    }
    if (command.kind === "agent.create") {
      writeJson(input.out, await store.createDelegatedAgent({
        ownerContext,
        userPrincipalId: command.userPrincipalId,
        displayName: command.name,
        capabilities: [...DEFAULT_AGENT_CAPABILITIES],
        resourceScopes: [{ kind: "organization", id: ownerContext.orgId }],
        expiresAt: oneYearFrom(input.now()),
      }));
      return 0;
    }
    if (command.kind === "grant") {
      writeJson(input.out, await store.grantResource({
        ownerContext,
        principalId: command.principalId,
        scope: command.scope,
        capabilities: [command.capability],
        expiresAt: null,
      }));
      return 0;
    }
    if (command.kind === "token.rotate") {
      writeJson(input.out, await store.rotateToken({
        ownerContext,
        principalId: command.principalId,
        expiresAt: null,
      }));
      return 0;
    }

    await store.revokeToken({ ownerContext, tokenId: command.tokenId });
    writeJson(input.out, { schema: "openlifewiki.cloud-token/v1", tokenId: command.tokenId, revoked: true });
    return 0;
  } finally {
    await database.close();
  }
}

type CloudCommand =
  | { readonly kind: "migrate" }
  | { readonly kind: "bootstrap"; readonly organization: string; readonly owner: string; readonly agent: string }
  | { readonly kind: "member.create"; readonly name: string; readonly ownerTokenFile: string }
  | { readonly kind: "agent.create"; readonly name: string; readonly userPrincipalId: string; readonly ownerTokenFile: string }
  | { readonly kind: "grant"; readonly principalId: string; readonly scope: ResourceScope; readonly capability: KnowledgeCapability; readonly ownerTokenFile: string }
  | { readonly kind: "token.rotate"; readonly principalId: string; readonly ownerTokenFile: string }
  | { readonly kind: "token.revoke"; readonly tokenId: string; readonly ownerTokenFile: string };

function parseCloudCommand(argv: readonly string[]): CloudCommand | null | undefined {
  if (argv[0] !== "cloud") return undefined;
  if (argv[1] === "migrate") {
    return argv.length === 3 && argv[2] === "--json" ? { kind: "migrate" } : null;
  }
  if (argv[1] === "bootstrap") {
    const flags = parseFlags(argv.slice(2), ["organization", "owner", "agent"]);
    if (flags === null) return null;
    return {
      kind: "bootstrap",
      organization: requiredFlag(flags, "organization"),
      owner: requiredFlag(flags, "owner"),
      agent: requiredFlag(flags, "agent"),
    };
  }
  if (argv[1] === "member" && argv[2] === "create") {
    const flags = parseFlags(argv.slice(3), ["name", "owner-token-file"]);
    if (flags === null) return null;
    return {
      kind: "member.create",
      name: requiredFlag(flags, "name"),
      ownerTokenFile: requiredFlag(flags, "owner-token-file"),
    };
  }
  if (argv[1] === "agent" && argv[2] === "create") {
    const flags = parseFlags(argv.slice(3), ["name", "for-user", "owner-token-file"]);
    if (flags === null) return null;
    return {
      kind: "agent.create",
      name: requiredFlag(flags, "name"),
      userPrincipalId: requiredFlag(flags, "for-user"),
      ownerTokenFile: requiredFlag(flags, "owner-token-file"),
    };
  }
  if (argv[1] === "grant") {
    const flags = parseFlags(argv.slice(2), ["principal", "scope", "capability", "owner-token-file"]);
    if (flags === null) return null;
    return {
      kind: "grant",
      principalId: requiredFlag(flags, "principal"),
      scope: parseScope(requiredFlag(flags, "scope")),
      capability: parseCapability(requiredFlag(flags, "capability")),
      ownerTokenFile: requiredFlag(flags, "owner-token-file"),
    };
  }
  if (argv[1] === "token" && argv[2] === "rotate") {
    const flags = parseFlags(argv.slice(3), ["principal", "owner-token-file"]);
    if (flags === null) return null;
    return {
      kind: "token.rotate",
      principalId: requiredFlag(flags, "principal"),
      ownerTokenFile: requiredFlag(flags, "owner-token-file"),
    };
  }
  if (argv[1] === "token" && argv[2] === "revoke") {
    const flags = parseFlags(argv.slice(3), ["token-id", "owner-token-file"]);
    if (flags === null) return null;
    return {
      kind: "token.revoke",
      tokenId: requiredFlag(flags, "token-id"),
      ownerTokenFile: requiredFlag(flags, "owner-token-file"),
    };
  }
  return null;
}

function parseFlags(args: readonly string[], expected: readonly string[]): Record<string, string> | null {
  if (args.length === 0 || args.at(-1) !== "--json") return null;
  const values: Record<string, string> = {};
  const allowed = new Set(expected);
  const pairs = args.slice(0, -1);
  if (pairs.length !== expected.length * 2 || pairs.length % 2 !== 0) return null;
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index];
    const value = pairs[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) return null;
    const name = flag.slice(2);
    if (!allowed.has(name) || values[name] !== undefined || value.length === 0) return null;
    values[name] = value;
  }
  return expected.every((name) => values[name] !== undefined) ? values : null;
}

function requiredFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined) throw new AdapterError("CONFIG_INVALID", `Missing cloud command flag --${name}`);
  return value;
}

function parseScope(value: string): ResourceScope {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new AdapterError("CONFIG_INVALID", "Cloud grant scope must use kind:id syntax");
  }
  const result = resourceScopeSchema.safeParse({
    kind: value.slice(0, separator),
    id: value.slice(separator + 1),
  });
  if (!result.success) throw new AdapterError("CONFIG_INVALID", "Cloud grant scope is invalid");
  return result.data;
}

function parseCapability(value: string): KnowledgeCapability {
  if (!(KNOWLEDGE_CAPABILITIES as readonly string[]).includes(value)) {
    throw new AdapterError("CONFIG_INVALID", "Cloud grant capability is invalid");
  }
  return value as KnowledgeCapability;
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new AdapterError("CONFIG_INVALID", `${name} is required for cloud commands`);
  }
  return value;
}

async function readOwnerToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length === 0) throw new Error("empty token");
    return token;
  } catch (error) {
    throw new AdapterError("CONFIG_INVALID", "Owner token file is unavailable", { cause: error });
  }
}

async function resolveOwnerContext(
  store: PostgresKnowledgeStore,
  token: string,
  command: Exclude<CloudCommand["kind"], "migrate" | "bootstrap">,
  now: Date,
): Promise<AccessContext> {
  const resolved = await store.resolveAccessContext({
    token,
    taskId: `cloud_${command}_${randomUUID()}`,
    now,
  });
  return resolved.context;
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("../../../packages/adapters/migrations", import.meta.url));
}

function oneYearFrom(now: Date): string {
  return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
}

function writeJson(out: (value: string) => void, value: unknown): void {
  out(`${JSON.stringify(value)}\n`);
}
