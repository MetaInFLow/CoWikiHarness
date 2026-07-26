import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseOpenLifeWikiConfigV2 } from "@openlifewiki/protocol";

import { listConnectorStatuses, nodeCommandRunner, type CommandRunner } from "../src/index.js";

const enabled = process.env.OPENLIFEWIKI_LIVE_CONNECTOR_TEST === "1";

describe("live metadata-only Connector probes", () => {
  it.skipIf(!enabled)("uses an Owner-supplied zero-credential config/v2 and returns four truthful rows", async () => {
    const path = process.env.OPENLIFEWIKI_LIVE_CONNECTOR_CONFIG;
    if (path === undefined) throw new Error("Set OPENLIFEWIKI_LIVE_CONNECTOR_CONFIG to an approved config/v2 path");
    const config = parseOpenLifeWikiConfigV2(JSON.parse(await readFile(path, "utf8")) as unknown);
    expect(config.sources.map(({ connectorType }) => connectorType).sort()).toEqual([
      "codex-history", "feishu", "github", "local-folder",
    ]);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push([command, ...args].join(" "));
        return await nodeCommandRunner.run(command, args, options);
      },
      async runJsonLineSession(command, args, steps, options) {
        calls.push([command, ...args].join(" "), ...steps.map(({ message }) => JSON.stringify(message)));
        return await nodeCommandRunner.runJsonLineSession!(command, args, steps, options);
      },
    };
    const statuses = await listConnectorStatuses({
      sources: config.sources,
      runner,
      scratchRoot: join(process.env.TMPDIR ?? "/tmp", "openlifewiki-live-connector-probes"),
    });

    expect(statuses.map(({ connectorType }) => connectorType)).toEqual([
      "local-folder", "github", "feishu", "codex-history",
    ]);
    expect(statuses.every(({ status }) => status === "connected")).toBe(true);
    expect(statuses.every(({ connectorType, providerVersion, identity, authorizedScope, changedItems, lastScan }) => (
      typeof providerVersion === "string"
      && providerVersion !== "unverified"
      && typeof identity?.fingerprint === "string"
      && JSON.stringify(authorizedScope) === JSON.stringify(
        config.sources.find((source) => source.connectorType === connectorType)?.scope,
      )
      && changedItems === 0
      && lastScan === undefined
    ))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/\bcontents\b|thread\/list|thread\/read|\bget\s+content\b/iu);
    expect(JSON.stringify(statuses)).not.toMatch(/token|secret|password/iu);
  });
});
