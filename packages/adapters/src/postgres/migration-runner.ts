import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "@openlifewiki/core";

import type { Database } from "./database.js";

export async function runMigrations(
  database: Database,
  input: { readonly migrationsDir: string },
): Promise<void> {
  const names = (await readdir(input.migrationsDir))
    .filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name))
    .sort();
  await database.transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", ["openlifewiki:migrations"]);
    await client.query(`create table if not exists openlifewiki_schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    for (const name of names) {
      const sql = await readFile(join(input.migrationsDir, name), "utf8");
      const checksum = sha256Canonical(sql);
      const existing = await client.query<{ checksum: string }>(
        "select checksum from openlifewiki_schema_migrations where name = $1",
        [name],
      );
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum changed: ${name}`);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        "insert into openlifewiki_schema_migrations(name, checksum) values ($1, $2)",
        [name, checksum],
      );
    }
  });
}
