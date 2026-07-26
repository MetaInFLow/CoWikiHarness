import type { ConnectorProvider } from "./connector-provider.js";
import { codexHistoryConnector } from "./codex-history.js";
import { feishuConnector } from "./feishu.js";
import { githubConnector } from "./github.js";
import { localFolderConnector } from "./local-folder.js";

export const CONNECTOR_PROVIDERS = [
  localFolderConnector,
  githubConnector,
  feishuConnector,
  codexHistoryConnector,
] as const satisfies readonly ConnectorProvider[];

export type { ConnectorProbeOptions, ConnectorProvider, ProbeSource } from "./connector-provider.js";
