import { runClient } from "../../../apps/knowledge-server/src/client.ts";

try {
  process.exitCode = await runClient({ argv: process.argv.slice(2), env: process.env });
} catch {
  process.stderr.write(JSON.stringify({ error: { code: "COWIKIHARNESS_REQUEST_FAILED" } }));
  process.exitCode = 1;
}
