import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Canonical, type ConnectorStatus } from "@openlifewiki/protocol";

import type { ConnectorProvider } from "./connector-provider.js";
import { redacted, safeBlocking } from "./connector-provider.js";

export const localFolderConnector: ConnectorProvider = {
  connectorType: "local-folder",
  async probe({ source, now }) {
    const observedAt = now().toISOString();
    const scope = source.scope as Record<string, unknown>;
    const root = typeof scope.root === "string" ? scope.root : "";
    try {
      const actual = await realpath(root);
      const details = await stat(actual);
      if (!details.isDirectory()) {
        return status("blocked", "LOCAL_NOT_DIRECTORY", "Choose an authorized directory", observedAt);
      }
      if (scope.symlinkPolicy === "deny" && resolve(root) !== actual) {
        return status("blocked", "LOCAL_SYMLINK_BLOCKED", "Choose the real directory path or narrow the symlink policy", observedAt);
      }
      const fingerprint = sha256Canonical({ provider: "filesystem", actual, device: details.dev, inode: details.ino });
      return {
        schema: "openlifewiki.connector-status/v1",
        sourceId: source.sourceId,
        connectorType: "local-folder",
        providerName: "filesystem-adapter",
        providerProject: "openLifeWiki",
        providerVersion: "0.1.0-dev.1",
        identity: { profile: "local", account: redacted(actual.split("/").filter(Boolean).at(-1) ?? "root"), fingerprint },
        authorizedScope: source.scope,
        status: "connected",
        lastProbe: observedAt,
        changedItems: 0,
        blocking: null,
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      return status(code === "ENOENT" ? "blocked" : "blocked", code === "EACCES" ? "LOCAL_PERMISSION_DENIED" : "LOCAL_UNAVAILABLE", "Check the approved local path and read permission", observedAt);
    }

    function status(
      connection: ConnectorStatus["status"], code: string, remediation: string, lastProbe: string,
    ): ConnectorStatus {
      return {
        schema: "openlifewiki.connector-status/v1",
        sourceId: source.sourceId,
        connectorType: "local-folder",
        providerName: "filesystem-adapter",
        providerProject: "openLifeWiki",
        providerVersion: "0.1.0-dev.1",
        identity: { profile: "local", account: "unverified" },
        authorizedScope: source.scope,
        status: connection,
        lastProbe,
        changedItems: 0,
        blocking: safeBlocking(code, remediation),
      };
    }
  },
};
