import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "cowiki");
const packageManifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const outputPath = join(packageRoot, "bin", "cowiki.js");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageManifest.version)) {
  throw new Error("cowiki package version must be semantic");
}

await mkdir(dirname(outputPath), { recursive: true });
await build({
  entryPoints: [join(packageRoot, "src", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  outfile: outputPath,
  banner: { js: "#!/usr/bin/env node" },
  define: {
    "process.env.COWIKI_CLIENT_VERSION": JSON.stringify(packageManifest.version),
  },
  legalComments: "eof",
  sourcemap: false,
});
await chmod(outputPath, 0o755);
process.stdout.write(`Built ${outputPath}\n`);
