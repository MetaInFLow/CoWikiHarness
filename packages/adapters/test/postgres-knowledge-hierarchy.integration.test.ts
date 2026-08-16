import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { createDatabase, runMigrations } from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("PostgreSQL knowledge hierarchy", () => {
  it("rejects duplicate root collection names in one organization", async () => {
    await withHierarchyFixture(async ({ client, orgId, principalId, uniqueId }) => {
      await client.query(
        `insert into knowledge_collections(
          collection_id, org_id, name, created_by_principal_id
        ) values ($1, $2, 'Shared name', $3)`,
        [uniqueId("collection_root_one"), orgId, principalId],
      );

      await expectConstraintViolation(client, "23505", async () => {
        await client.query(
          `insert into knowledge_collections(
            collection_id, org_id, name, created_by_principal_id
          ) values ($1, $2, 'Shared name', $3)`,
          [uniqueId("collection_root_two"), orgId, principalId],
        );
      });
    });
  });

  it("rejects duplicate collection names under one parent", async () => {
    await withHierarchyFixture(async ({ client, orgId, principalId, uniqueId }) => {
      const parentCollectionId = uniqueId("collection_parent");
      await client.query(
        `insert into knowledge_collections(
          collection_id, org_id, name, created_by_principal_id
        ) values ($1, $2, 'Parent', $3)`,
        [parentCollectionId, orgId, principalId],
      );
      await client.query(
        `insert into knowledge_collections(
          collection_id, org_id, parent_collection_id, name, created_by_principal_id
        ) values ($1, $2, $3, 'Shared child name', $4)`,
        [uniqueId("collection_child_one"), orgId, parentCollectionId, principalId],
      );

      await expectConstraintViolation(client, "23505", async () => {
        await client.query(
          `insert into knowledge_collections(
            collection_id, org_id, parent_collection_id, name, created_by_principal_id
          ) values ($1, $2, $3, 'Shared child name', $4)`,
          [uniqueId("collection_child_two"), orgId, parentCollectionId, principalId],
        );
      });
    });
  });

  it("rejects placing one knowledge item in two collections", async () => {
    await withHierarchyFixture(async ({ client, orgId, principalId, itemId, uniqueId }) => {
      const firstCollectionId = uniqueId("collection_first");
      const secondCollectionId = uniqueId("collection_second");
      await client.query(
        `insert into knowledge_collections(
          collection_id, org_id, name, created_by_principal_id
        ) values ($1, $2, 'First', $3), ($4, $2, 'Second', $3)`,
        [firstCollectionId, orgId, principalId, secondCollectionId],
      );
      await client.query(
        `insert into knowledge_collection_items(
          item_id, org_id, collection_id, placed_by_principal_id
        ) values ($1, $2, $3, $4)`,
        [itemId, orgId, firstCollectionId, principalId],
      );

      await expectConstraintViolation(client, "23505", async () => {
        await client.query(
          `insert into knowledge_collection_items(
            item_id, org_id, collection_id, placed_by_principal_id
          ) values ($1, $2, $3, $4)`,
          [itemId, orgId, secondCollectionId, principalId],
        );
      });
    });
  });

  it("rejects a collection as its own parent", async () => {
    await withHierarchyFixture(async ({ client, orgId, principalId, uniqueId }) => {
      const collectionId = uniqueId("collection_self_parent");
      await expectConstraintViolation(client, "23514", async () => {
        await client.query(
          `insert into knowledge_collections(
            collection_id, org_id, parent_collection_id, name, created_by_principal_id
          ) values ($1, $2, $1, 'Self parent', $3)`,
          [collectionId, orgId, principalId],
        );
      });
    });
  });
});

interface HierarchyFixture {
  readonly client: PoolClient;
  readonly orgId: string;
  readonly principalId: string;
  readonly itemId: string;
  readonly uniqueId: (prefix: string) => string;
}

class RollbackTestTransaction extends Error {}

async function withHierarchyFixture(
  work: (fixture: HierarchyFixture) => Promise<void>,
): Promise<void> {
  const database = createDatabase({ connectionString: requiredTestDatabaseUrl() });
  await runMigrations(database, { migrationsDir: "migrations" });
  const suffix = randomUUID();
  const uniqueId = (prefix: string): string => `${prefix}_${suffix}`;
  const orgId = uniqueId("org");
  const principalId = uniqueId("principal");
  const itemId = uniqueId("item");

  try {
    await expect(database.transaction(async (client) => {
      await client.query(
        "insert into organizations(org_id, name) values ($1, $2)",
        [orgId, `Hierarchy test ${suffix}`],
      );
      await client.query(
        `insert into principals(
          principal_id, org_id, principal_type, display_name, organization_role, status
        ) values ($1, $2, 'user', 'Hierarchy test owner', 'owner', 'active')`,
        [principalId, orgId],
      );
      await client.query(
        `insert into knowledge_items(
          item_id, org_id, owner_principal_id, title, status
        ) values ($1, $2, $3, 'Hierarchy test item', 'draft')`,
        [itemId, orgId, principalId],
      );
      await work({ client, orgId, principalId, itemId, uniqueId });
      throw new RollbackTestTransaction();
    })).rejects.toBeInstanceOf(RollbackTestTransaction);
  } finally {
    await database.close();
  }
}

async function expectConstraintViolation(
  client: PoolClient,
  code: "23505" | "23514",
  work: () => Promise<void>,
): Promise<void> {
  await client.query("savepoint expect_constraint_violation");
  let error: unknown;
  try {
    await work();
  } catch (caught) {
    error = caught;
  }
  await client.query("rollback to savepoint expect_constraint_violation");
  await client.query("release savepoint expect_constraint_violation");
  expect(error).toMatchObject({ code });
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  return value;
}
