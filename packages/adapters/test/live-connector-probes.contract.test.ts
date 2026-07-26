import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseOpenLifeWikiConfigV2 } from "@openlifewiki/protocol";

import { listConnectorStatuses, nodeCommandRunner } from "../src/index.js";

const enabled = process.env.OPENLIFEWIKI_LIVE_CONNECTOR_TEST === "1";

describe("live metadata-only Connector probes", () => {
  it.skipIf(!enabled)("uses an Owner-supplied zero-credential config/v2 and returns four truthful rows", async () => {
    const path = process.env.OPENLIFEWIKI_LIVE_CONNECTOR_CONFIG;
    if (path === undefined) throw new Error("Set OPENLIFEWIKI_LIVE_CONNECTOR_CONFIG to an approved config/v2 path");
    const config = parseOpenLifeWikiConfigV2(JSON.parse(await readFile(path, "utf8")) as unknown);
    const statuses = await listConnectorStatuses({
      sources: config.sources,
      runner: nodeCommandRunner,
      scratchRoot: join(process.env.TMPDIR ?? "/tmp", "openlifewiki-live-connector-probes"),
    });

    expect(statuses.map(({ connectorType }) => connectorType)).toEqual([
      "local-folder", "github", "feishu", "codex-history",
    ]);
    expect(statuses.every(({ changedItems, lastScan }) => changedItems === 0 && lastScan === undefined)).toBe(true);
    expect(JSON.stringify(statuses)).not.toMatch(/token|secret|password/iu);
  });
});
