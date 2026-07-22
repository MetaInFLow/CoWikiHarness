#!/usr/bin/env node

import { componentCatalog, connectorCatalog, productOwnedBoundaries } from "./catalog.js";
import { probeComponents } from "./doctor.js";

const HELP = `Usage:
  openlifewiki features --json
  openlifewiki capabilities --json
  openlifewiki doctor --json
  openlifewiki status --json
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length !== 2 || argv[1] !== "--json") {
    process.stderr.write(`${JSON.stringify({ code: "INVALID_INVOCATION" })}\n`);
    return 2;
  }

  const command = argv[0];
  if (command === "features") {
    writeJson({
      schema: "openlifewiki.features/v1",
      stage: "skeleton-first",
      productShape: ["Source Gateway", "Policy Facade", "Knowledge Workspace"],
      implemented: ["component catalog", "read-only capability probe", "product inspection shell"],
      deferred: ["query", "sync", "proposal", "approval", "GUI"],
    });
    return 0;
  }
  if (command === "capabilities") {
    writeJson({
      schema: "openlifewiki.capabilities/v1",
      components: componentCatalog,
      connectors: connectorCatalog,
      productOwnedBoundaries,
    });
    return 0;
  }
  if (command === "doctor") {
    const components = await probeComponents();
    writeJson({
      schema: "openlifewiki.doctor/v1",
      status: "SKELETON_READY",
      components,
    });
    return 0;
  }
  if (command === "status") {
    writeJson({
      schema: "openlifewiki.status/v1",
      status: "SKELETON_READY",
      supportedJourneys: [],
      nextSlice: "identity-kernel-mcp-contracts",
    });
    return 0;
  }

  process.stderr.write(`${JSON.stringify({ code: "UNKNOWN_COMMAND", command })}\n`);
  return 2;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
