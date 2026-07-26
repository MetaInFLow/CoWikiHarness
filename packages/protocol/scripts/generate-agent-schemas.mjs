import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  AGENT_IO_SCHEMA_MANIFEST,
  canonicalJson,
  getAgentIoJsonSchema,
} from "../dist/index.js";

const schemaDirectory = new URL("../schemas/", import.meta.url);
const check = process.argv.includes("--check");

await mkdir(schemaDirectory, { recursive: true });

const artifacts = [
  ...AGENT_IO_SCHEMA_MANIFEST.schemas.map(({ schemaId, file }) => ({
    file,
    contents: canonicalJson(getAgentIoJsonSchema(schemaId)),
  })),
  {
    file: "manifest.json",
    contents: canonicalJson(AGENT_IO_SCHEMA_MANIFEST),
  },
];

for (const artifact of artifacts) {
  const target = new URL(artifact.file, schemaDirectory);
  if (check) {
    let checkedIn;
    try {
      checkedIn = await readFile(target, "utf8");
    } catch {
      throw new Error(`Missing generated Agent I/O schema artifact: ${artifact.file}`);
    }
    if (checkedIn !== artifact.contents) {
      throw new Error(`Generated Agent I/O schema artifact is stale: ${artifact.file}`);
    }
    continue;
  }
  await writeFile(target, artifact.contents, "utf8");
}

console.log(check ? "Agent I/O schema artifacts are current." : "Generated Agent I/O schema artifacts.");
