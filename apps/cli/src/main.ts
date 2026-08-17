#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  activateDefaultSource,
  AdapterError,
  initializeRuntime,
  inspectRuntime,
  executeSourceAuthorization,
  executeSourceRevocation,
  listConnectorStatuses,
  launchLocalMcp,
  nodeCommandRunner,
  nodeInteractiveProcessRunner,
  previewActivation,
  previewInitialization,
  previewSourceAuthorization,
  previewSourceRevocation,
  probeSourceCandidate,
  readConfigSnapshot,
  resolveRuntimeLayout,
  statusFromDoctor,
  type CommandRunner,
  type InteractiveProcessRunner,
} from "@openlifewiki/adapters";
import {
  companionServerStatus,
  startCompanionServer,
  stopCompanionServer,
} from "@openlifewiki/companion";
import { COMPONENT_RELEASES, LIFECYCLE_STAGES } from "@openlifewiki/core";
import type { RuntimeLayout } from "@openlifewiki/protocol";

import { runCloudCommand } from "./cloud-command.js";

const VERSION = "0.1.0-dev.1";
const HELP = `Usage:
  openlifewiki lifecycle --json
  openlifewiki status --json
  openlifewiki init --dry-run --json
  openlifewiki init --yes --json
  openlifewiki activate --dry-run --json
  openlifewiki activate --yes --json
  openlifewiki sources list --json
  openlifewiki sources probe --json
  openlifewiki sources authorize --request-file <path> --dry-run --json
  openlifewiki sources authorize --request-file <path> --digest <sha256> --yes --json
  openlifewiki sources revoke --source-id <id> --dry-run --json
  openlifewiki sources revoke --source-id <id> --digest <sha256> --yes --json
  openlifewiki mcp --stdio
  openlifewiki companion --open --json
  openlifewiki companion --no-open --json
  openlifewiki companion status --json
  openlifewiki companion stop --json
  openlifewiki doctor --json
  openlifewiki cloud migrate --json
  openlifewiki cloud bootstrap --organization <name> --owner <name> --agent <name> --credential-file <absolute-path> --json
  openlifewiki --version
`;

export interface CliContext {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly interactiveRunner?: InteractiveProcessRunner;
  readonly repoRoot?: string;
}

export interface CliIo {
  readonly out: (value: string) => void;
  readonly err: (value: string) => void;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  context: CliContext = {
    layout: resolveRuntimeLayout(),
    runner: nodeCommandRunner,
    interactiveRunner: nodeInteractiveProcessRunner,
  },
  io: CliIo = {
    out: (value) => process.stdout.write(value),
    err: (value) => process.stderr.write(value),
  },
): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.out(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    io.out(`${VERSION}\n`);
    return 0;
  }

  try {
    const cloudExit = await runCloudCommand({
      argv,
      env: process.env,
      out: io.out,
      now: context.now ?? (() => new Date()),
    });
    if (cloudExit !== undefined) return cloudExit;

    if (matches(argv, "lifecycle", "--json")) {
      writeJson(io.out, {
        schema: "openlifewiki.lifecycle/v1",
        stages: LIFECYCLE_STAGES,
        components: COMPONENT_RELEASES,
      });
      return 0;
    }
    if (matches(argv, "status", "--json")) {
      writeJson(io.out, statusFromDoctor(await inspectRuntime(context.layout, context.runner)));
      return 0;
    }
    if (matches(argv, "doctor", "--json")) {
      writeJson(io.out, await inspectRuntime(context.layout, context.runner));
      return 0;
    }
    if (matches(argv, "init", "--dry-run", "--json")) {
      writeJson(io.out, previewInitialization(context.layout));
      return 0;
    }
    if (matches(argv, "init", "--yes", "--json")) {
      writeJson(io.out, await initializeRuntime({
        layout: context.layout,
        runner: context.runner,
        ...(context.now === undefined ? {} : { now: context.now }),
      }));
      return 0;
    }
    if (matches(argv, "activate", "--dry-run", "--json")) {
      writeJson(io.out, previewActivation(context.layout));
      return 0;
    }
    if (matches(argv, "activate", "--yes", "--json")) {
      writeJson(io.out, await activateDefaultSource({
        layout: context.layout,
        runner: context.runner,
        ...(context.now === undefined ? {} : { now: context.now }),
      }));
      return 0;
    }
    if (matches(argv, "sources", "list", "--json") || matches(argv, "sources", "probe", "--json")) {
      writeJson(io.out, await buildSourcesSnapshot(context));
      return 0;
    }
    const authorize = parseSourceMutation(argv, "authorize", "--request-file");
    if (authorize !== undefined) {
      const request = await readRequestFile(authorize.value);
      const probe = sourceProbe(context);
      if (authorize.mode === "preview") {
        writeJson(io.out, await previewSourceAuthorization({
          configPath: context.layout.configFile,
          request,
          probe,
          ...(context.now === undefined ? {} : { now: context.now }),
        }));
      } else {
        writeJson(io.out, await executeSourceAuthorization({
          configPath: context.layout.configFile,
          request,
          expectedPreviewHash: authorize.digest,
          probe,
          ...(context.now === undefined ? {} : { now: context.now }),
        }));
      }
      return 0;
    }
    const revoke = parseSourceMutation(argv, "revoke", "--source-id");
    if (revoke !== undefined) {
      if (revoke.mode === "preview") {
        writeJson(io.out, await previewSourceRevocation({
          configPath: context.layout.configFile,
          sourceId: revoke.value,
        }));
      } else {
        writeJson(io.out, await executeSourceRevocation({
          configPath: context.layout.configFile,
          sourceId: revoke.value,
          expectedPreviewHash: revoke.digest,
        }));
      }
      return 0;
    }
    if (matches(argv, "mcp", "--stdio")) {
      return await launchLocalMcp({
        layout: context.layout,
        runner: context.runner,
        ...(context.interactiveRunner === undefined ? {} : { interactiveRunner: context.interactiveRunner }),
      });
    }
    if (matches(argv, "companion", "status", "--json")) {
      writeJson(io.out, await companionServerStatus(context.layout));
      return 0;
    }
    if (matches(argv, "companion", "stop", "--json")) {
      writeJson(io.out, await stopCompanionServer(context.layout));
      return 0;
    }
    if (matches(argv, "companion", "--open", "--json")
      || matches(argv, "companion", "--no-open", "--json")) {
      const handle = await startCompanionServer({
        layout: context.layout,
        runner: context.runner,
        repoRoot: context.repoRoot ?? process.cwd(),
        openBrowser: argv[1] === "--open",
      });
      writeJson(io.out, handle.info);
      if (handle.info.status === "started") await handle.closed;
      return 0;
    }

    writeJson(io.err, { code: "INVALID_INVOCATION", usage: HELP.trim().split("\n") });
    return 2;
  } catch (error) {
    writeJson(io.err, {
      code: error instanceof AdapterError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof AdapterError ? error.message : "openLifeWiki command failed",
      ...(error instanceof AdapterError && error.publicDetails !== undefined
        ? { details: error.publicDetails }
        : {}),
    });
    return 1;
  }
}

function matches(argv: readonly string[], ...expected: readonly string[]): boolean {
  return argv.length === expected.length && expected.every((value, index) => argv[index] === value);
}

type SourceMutationArgs = {
  readonly mode: "preview";
  readonly value: string;
} | {
  readonly mode: "execute";
  readonly value: string;
  readonly digest: string;
};

function parseSourceMutation(
  argv: readonly string[],
  action: "authorize" | "revoke",
  valueFlag: "--request-file" | "--source-id",
): SourceMutationArgs | undefined {
  if (argv[0] !== "sources" || argv[1] !== action || argv[2] !== valueFlag) return undefined;
  const value = argv[3];
  if (value === undefined || value.length === 0) return undefined;
  if (argv.length === 6 && argv[4] === "--dry-run" && argv[5] === "--json") {
    return { mode: "preview", value };
  }
  if (argv.length === 8 && argv[4] === "--digest" && argv[6] === "--yes" && argv[7] === "--json") {
    const digest = argv[5];
    if (digest === undefined || digest.length === 0) return undefined;
    return { mode: "execute", value, digest };
  }
  return undefined;
}

async function readRequestFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) {
    throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", "Source authorization request is too large");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AdapterError("SOURCE_AUTHORIZATION_INVALID", "Source authorization request must be valid JSON", { cause: error });
  }
}

async function buildSourcesSnapshot(context: CliContext): Promise<unknown> {
  const snapshot = await readConfigSnapshot(context.layout.configFile);
  if (snapshot === undefined) throw new AdapterError("INITIALIZATION_REQUIRED", "Initialize openLifeWiki before listing Sources");
  if (snapshot.config.schema !== "openlifewiki.config/v2") {
    throw new AdapterError("CONFIG_MIGRATION_REQUIRED", "Approve the config/v1 migration before using V1 Sources");
  }
  const sources = await listConnectorStatuses({
    sources: snapshot.config.sources,
    runner: context.runner,
    scratchRoot: join(context.layout.runtimeDir, "connector-probes"),
    ...(context.now === undefined ? {} : { now: context.now }),
  });
  return {
    schema: "openlifewiki.sources-status/v1",
    revision: snapshot.config.revision,
    configHash: snapshot.hash,
    authorizations: snapshot.config.sources,
    sources,
  };
}

function sourceProbe(context: CliContext) {
  return async ({ source, now }: Parameters<Parameters<typeof previewSourceAuthorization>[0]["probe"]>[0]) => (
    await probeSourceCandidate({
      source,
      runner: context.runner,
      now,
      scratchRoot: join(context.layout.runtimeDir, "connector-probes"),
    })
  );
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main();
}
