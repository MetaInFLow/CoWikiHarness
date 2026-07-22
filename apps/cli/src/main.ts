#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  activateDefaultSource,
  AdapterError,
  initializeRuntime,
  inspectRuntime,
  launchLocalMcp,
  nodeCommandRunner,
  nodeInteractiveProcessRunner,
  previewActivation,
  previewInitialization,
  resolveRuntimeLayout,
  statusFromDoctor,
  type CommandRunner,
  type InteractiveProcessRunner,
} from "@openlifewiki/adapters";
import { COMPONENT_RELEASES, LIFECYCLE_STAGES } from "@openlifewiki/core";
import type { RuntimeLayout } from "@openlifewiki/protocol";

const VERSION = "0.1.0-dev.1";
const HELP = `Usage:
  openlifewiki lifecycle --json
  openlifewiki status --json
  openlifewiki init --dry-run --json
  openlifewiki init --yes --json
  openlifewiki activate --dry-run --json
  openlifewiki activate --yes --json
  openlifewiki mcp --stdio
  openlifewiki doctor --json
  openlifewiki --version
`;

export interface CliContext {
  readonly layout: RuntimeLayout;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly interactiveRunner?: InteractiveProcessRunner;
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
    if (matches(argv, "mcp", "--stdio")) {
      return await launchLocalMcp({
        layout: context.layout,
        runner: context.runner,
        ...(context.interactiveRunner === undefined ? {} : { interactiveRunner: context.interactiveRunner }),
      });
    }

    writeJson(io.err, { code: "INVALID_INVOCATION", usage: HELP.trim().split("\n") });
    return 2;
  } catch (error) {
    writeJson(io.err, {
      code: error instanceof AdapterError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "Unknown failure",
    });
    return 1;
  }
}

function matches(argv: readonly string[], ...expected: readonly string[]): boolean {
  return argv.length === expected.length && expected.every((value, index) => argv[index] === value);
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main();
}
