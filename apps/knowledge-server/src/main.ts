import { fileURLToPath } from "node:url";

import { createA2AServer } from "./a2a-server.js";
import { readServerConfig } from "./config.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = await createA2AServer(readServerConfig(env));
  const binding = await server.start();
  console.log(`CoWikiHarness Knowledge Server listening at ${binding.url}`);
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
    console.error("CoWikiHarness Knowledge Server failed to start");
    process.exitCode = 1;
  });
}
