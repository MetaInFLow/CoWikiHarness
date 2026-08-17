import { fileURLToPath } from "node:url";

import { createA2AServer } from "./a2a-server.js";
import { readServerConfig } from "./config.js";

interface GatewayBinding {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly internalUrl: string;
}

export function gatewayStartupMessages(binding: GatewayBinding): readonly string[] {
  return [
    `CoWikiHarness Gateway listening internally at ${binding.internalUrl}`,
    `CoWikiHarness Gateway public URL ${binding.url}`,
  ];
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = await createA2AServer(readServerConfig(env));
  const binding = await server.start();
  for (const message of gatewayStartupMessages(binding)) console.log(message);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("CoWikiHarness Gateway failed to start");
    process.exitCode = 1;
  });
}
