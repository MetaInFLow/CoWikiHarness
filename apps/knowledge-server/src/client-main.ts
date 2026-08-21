import { runClient } from "./client.js";

runClient({ argv: process.argv.slice(2), env: process.env }).then((code) => {
  process.exitCode = code;
}).catch(() => {
  console.error(JSON.stringify({ error: { code: "COWIKIHARNESS_REQUEST_FAILED" } }));
  process.exitCode = 1;
});
