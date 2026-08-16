import { randomUUID } from "node:crypto";

import type { AccessContext } from "@openlifewiki/protocol";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  createDatabase,
  PostgresKnowledgeHierarchyStore,
  PostgresKnowledgeStore,
  runMigrations,
  type Database,
} from "../src/index.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;
const NOW = new Date("2026-08-17T08:30:00.000Z");

describePostgres("PostgresKnowledgeHierarchyStore", () => {
  it("authorizes an active human through an exact organization grant and reads stored rows", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const created = await store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Projects",
        description: "Project knowledge",
        now: NOW,
      });

      expect(created).toMatchObject({
        schema: "cowikiharness.collection/v1",
        orgId: ids.org,
        parentCollectionId: null,
        name: "Projects",
        description: "Project knowledge",
        revision: 0,
        createdByPrincipalId: ids.user,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      expect(created.collectionId).toMatch(/^collection_[0-9a-f-]{36}$/u);
      await expect(store.getCollection(ids.org, created.collectionId)).resolves.toEqual(created);
      await expect(store.getCollection(ids.otherOrg, created.collectionId)).resolves.toBeNull();
      await expect(store.getCollection(ids.org, ids.missing)).resolves.toBeNull();
      await expect(store.getPlacement(ids.org, ids.item)).resolves.toBeNull();

      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 1 });
      expect(await completedAudits(database, ids.org)).toEqual([{
        org_id: ids.org,
        task_id: humanContext.taskId,
        actor_principal_id: ids.user,
        on_behalf_of_user_id: ids.user,
        action: "knowledge.collection.create",
        target_kind: "collection",
        target_id: created.collectionId,
        decision: "completed",
      }]);
    });
  });

  it("rejects item-scoped grants, inactive users, and forged human actor bindings atomically", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      await database.query(
        "update resource_grants set scope_kind = 'item', scope_id = $1 where grant_id = $2",
        [ids.item, ids.userGrant],
      );
      await expectAdapterError(store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Denied by item scope",
        description: "",
        now: NOW,
      }), "DELEGATION_DENIED");

      await database.query(
        "update resource_grants set scope_kind = 'organization', scope_id = $1 where grant_id = $2",
        [ids.org, ids.userGrant],
      );
      await database.query("update principals set status = 'revoked' where principal_id = $1", [ids.user]);
      await expectAdapterError(store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Denied inactive user",
        description: "",
        now: NOW,
      }), "DELEGATION_DENIED");

      await database.query("update principals set status = 'active' where principal_id = $1", [ids.user]);
      const forgedContext = {
        ...humanContext,
        actorPrincipalId: ids.otherUser,
      } as AccessContext;
      await expectAdapterError(store.createCollection({
        context: forgedContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Denied forged actor",
        description: "",
        now: NOW,
      }), "DELEGATION_DENIED");

      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 0, audits: 0 });
    });
  });

  it("requires the complete active agent, delegation, and organization-scope intersection", async () => {
    await withStoreFixture(async ({ database, store, ids, agentContext }) => {
      const attempt = (name: string) => store.createCollection({
        context: agentContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name,
        description: "",
        now: NOW,
      });

      await database.query("update principals set capabilities = '{}' where principal_id = $1", [ids.agent]);
      await expectAdapterError(attempt("Missing agent capability"), "DELEGATION_DENIED");

      await database.query(
        "update principals set capabilities = '{knowledge.organize}' where principal_id = $1",
        [ids.agent],
      );
      await database.query(
        "update delegations set capabilities = '{knowledge.query}' where delegation_id = $1",
        [ids.delegation],
      );
      await expectAdapterError(attempt("Missing delegation capability"), "DELEGATION_DENIED");

      await database.query(
        `update delegations
         set capabilities = '{knowledge.organize}', resource_scopes = $1::jsonb
         where delegation_id = $2`,
        [JSON.stringify([{ kind: "item", id: ids.item }]), ids.delegation],
      );
      await expectAdapterError(attempt("Wrong delegation scope"), "DELEGATION_DENIED");

      await database.query(
        "update delegations set resource_scopes = $1::jsonb, expires_at = $2 where delegation_id = $3",
        [JSON.stringify([{ kind: "organization", id: ids.org }]), NOW.toISOString(), ids.delegation],
      );
      await expectAdapterError(attempt("Expired delegation"), "DELEGATION_DENIED");

      await database.query(
        "update delegations set expires_at = $1, revoked_at = $2 where delegation_id = $3",
        ["2099-08-17T08:30:00.000Z", "2026-08-17T08:00:00.000Z", ids.delegation],
      );
      await expectAdapterError(attempt("Revoked delegation"), "DELEGATION_DENIED");

      await database.query("update delegations set revoked_at = null where delegation_id = $1", [ids.delegation]);
      await database.query("update principals set status = 'revoked' where principal_id = $1", [ids.agent]);
      await expectAdapterError(attempt("Inactive agent"), "DELEGATION_DENIED");

      await database.query("update principals set status = 'active' where principal_id = $1", [ids.agent]);
      const created = await attempt("Authorized agent collection");
      expect(created.createdByPrincipalId).toBe(ids.agent);
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 1 });
      expect(await completedAudits(database, ids.org)).toEqual([{
        org_id: ids.org,
        task_id: agentContext.taskId,
        actor_principal_id: ids.agent,
        on_behalf_of_user_id: ids.user,
        action: "knowledge.collection.create",
        target_kind: "collection",
        target_id: created.collectionId,
        decision: "completed",
      }]);
    });
  });

  it("enforces create registry CAS, parent organization boundaries, and sibling uniqueness", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      await expectAdapterError(store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 1,
        parentCollectionId: null,
        name: "Stale",
        description: "",
        now: NOW,
      }), "REVISION_CONFLICT");
      await expectAdapterError(store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 0,
        parentCollectionId: ids.otherCollection,
        name: "Cross organization child",
        description: "",
        now: NOW,
      }), "KNOWLEDGE_NOT_FOUND");
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 0, audits: 0 });

      const root = await store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Unique root",
        description: "",
        now: NOW,
      });
      await expectAdapterError(store.createCollection({
        context: humanContext,
        expectedRegistryRevision: 1,
        parentCollectionId: null,
        name: root.name,
        description: "Duplicate",
        now: NOW,
      }), "KNOWLEDGE_CONFLICT");
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 1 });
    });
  });

  it("moves collections with revision CAS while rejecting cycles, cross-org resources, and name conflicts", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const tree = await seedCollectionTree(database, ids);
      await expectAdapterError(store.moveCollection({
        context: humanContext,
        collectionId: tree.root,
        expectedRevision: 1,
        parentCollectionId: null,
        name: "Root",
        description: "",
        now: NOW,
      }), "REVISION_CONFLICT");
      await expectAdapterError(store.moveCollection({
        context: humanContext,
        collectionId: tree.root,
        expectedRevision: 0,
        parentCollectionId: tree.grandchild,
        name: "Root",
        description: "",
        now: NOW,
      }), "KNOWLEDGE_CONFLICT");
      await expectAdapterError(store.moveCollection({
        context: humanContext,
        collectionId: tree.root,
        expectedRevision: 0,
        parentCollectionId: ids.otherCollection,
        name: "Root",
        description: "",
        now: NOW,
      }), "KNOWLEDGE_NOT_FOUND");
      await expectAdapterError(store.moveCollection({
        context: humanContext,
        collectionId: ids.otherCollection,
        expectedRevision: 0,
        parentCollectionId: null,
        name: "Other",
        description: "",
        now: NOW,
      }), "KNOWLEDGE_NOT_FOUND");
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 0, audits: 0 });

      const moved = await store.moveCollection({
        context: humanContext,
        collectionId: tree.grandchild,
        expectedRevision: 0,
        parentCollectionId: null,
        name: "Moved grandchild",
        description: "Moved description",
        now: NOW,
      });
      expect(moved).toMatchObject({
        collectionId: tree.grandchild,
        parentCollectionId: null,
        name: "Moved grandchild",
        description: "Moved description",
        revision: 1,
        updatedAt: NOW.toISOString(),
      });

      await expectAdapterError(store.moveCollection({
        context: humanContext,
        collectionId: tree.child,
        expectedRevision: 0,
        parentCollectionId: null,
        name: "Root",
        description: "Sibling conflict",
        now: NOW,
      }), "KNOWLEDGE_CONFLICT");
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 1 });
      expect(await completedAudits(database, ids.org)).toEqual([{
        org_id: ids.org,
        task_id: humanContext.taskId,
        actor_principal_id: ids.user,
        on_behalf_of_user_id: ids.user,
        action: "knowledge.collection.move",
        target_kind: "collection",
        target_id: tree.grandchild,
        decision: "completed",
      }]);
    });
  });

  it("permits at most one concurrent inverse collection move and leaves the hierarchy acyclic", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const collectionA = await insertCollection(database, ids, "concurrent_a", "Concurrent A");
      const collectionB = await insertCollection(database, ids, "concurrent_b", "Concurrent B");

      const outcomes = await Promise.allSettled([
        store.moveCollection({
          context: contextForTask(humanContext, `task_move_a_${ids.suffix}`),
          collectionId: collectionA,
          expectedRevision: 0,
          parentCollectionId: collectionB,
          name: "Concurrent A",
          description: "",
          now: NOW,
        }),
        store.moveCollection({
          context: contextForTask(humanContext, `task_move_b_${ids.suffix}`),
          collectionId: collectionB,
          expectedRevision: 0,
          parentCollectionId: collectionA,
          name: "Concurrent B",
          description: "",
          now: NOW,
        }),
      ]);

      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(await hierarchyHasCycle(database, ids.org)).toBe(false);
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 1 });
    });
  });

  it("creates, replays, moves, and no-ops placements without duplicate registry or audit effects", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const firstCollection = await insertCollection(database, ids, "placement_first", "First");
      const secondCollection = await insertCollection(database, ids, "placement_second", "Second");
      const createContext = contextForTask(humanContext, `task_place_create_${ids.suffix}`);
      const firstNoopContext = contextForTask(humanContext, `task_place_noop_first_${ids.suffix}`);
      const moveContext = contextForTask(humanContext, `task_place_move_${ids.suffix}`);
      const secondNoopContext = contextForTask(humanContext, `task_place_noop_second_${ids.suffix}`);

      const created = await store.placeKnowledge({
        context: createContext,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: null,
        now: NOW,
      });
      expect(created).toMatchObject({
        schema: "cowikiharness.collection-placement/v1",
        orgId: ids.org,
        itemId: ids.item,
        collectionId: firstCollection,
        placedByPrincipalId: ids.user,
        revision: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      await expect(store.placeKnowledge({
        context: createContext,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: null,
        now: NOW,
      })).resolves.toEqual(created);
      await expect(store.placeKnowledge({
        context: firstNoopContext,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:30:30.000Z"),
      })).resolves.toEqual(created);
      await expect(store.placeKnowledge({
        context: firstNoopContext,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:30:45.000Z"),
      })).resolves.toEqual(created);
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 2 });

      const moved = await store.placeKnowledge({
        context: moveContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:31:00.000Z"),
      });
      expect(moved).toMatchObject({
        collectionId: secondCollection,
        revision: 1,
        placedByPrincipalId: ids.user,
        createdAt: NOW.toISOString(),
        updatedAt: "2026-08-17T08:31:00.000Z",
      });
      await expect(store.placeKnowledge({
        context: moveContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:32:00.000Z"),
      })).resolves.toEqual(moved);
      await expect(store.placeKnowledge({
        context: secondNoopContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 1,
        now: new Date("2026-08-17T08:33:00.000Z"),
      })).resolves.toEqual(moved);
      await expect(store.placeKnowledge({
        context: secondNoopContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 1,
        now: new Date("2026-08-17T08:34:00.000Z"),
      })).resolves.toEqual(moved);
      await expectAdapterError(store.placeKnowledge({
        context: contextForTask(humanContext, `task_place_conflict_first_${ids.suffix}`),
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: 0,
        now: NOW,
      }), "REVISION_CONFLICT");
      await expectAdapterError(store.placeKnowledge({
        context: contextForTask(humanContext, `task_place_conflict_second_${ids.suffix}`),
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 3,
        now: NOW,
      }), "REVISION_CONFLICT");

      await expect(store.getPlacement(ids.org, ids.item)).resolves.toEqual(moved);
      await expect(store.getPlacement(ids.otherOrg, ids.item)).resolves.toBeNull();
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 2, audits: 4 });
      expect(await completedPlacementAudits(database, ids.org, ids.item)).toEqual([
        {
          task_id: createContext.taskId,
          receipt_metadata: {
            collectionId: firstCollection,
            expectedPlacementRevision: null,
            resultRevision: 0,
          },
        },
        {
          task_id: firstNoopContext.taskId,
          receipt_metadata: {
            collectionId: firstCollection,
            expectedPlacementRevision: 0,
            resultRevision: 0,
          },
        },
        {
          task_id: moveContext.taskId,
          receipt_metadata: {
            collectionId: secondCollection,
            expectedPlacementRevision: 0,
            resultRevision: 1,
          },
        },
        {
          task_id: secondNoopContext.taskId,
          receipt_metadata: {
            collectionId: secondCollection,
            expectedPlacementRevision: 1,
            resultRevision: 1,
          },
        },
      ]);
    });
  });

  it("rejects stale placement replay shapes from another task or mismatched receipt", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const firstCollection = await insertCollection(database, ids, "stale_first", "Stale first");
      const secondCollection = await insertCollection(database, ids, "stale_second", "Stale second");
      const createContext = contextForTask(humanContext, `task_stale_create_${ids.suffix}`);
      const moveContext = contextForTask(humanContext, `task_stale_move_${ids.suffix}`);
      const otherCreateRetry = contextForTask(humanContext, `task_stale_other_create_${ids.suffix}`);
      const otherMoveRetry = contextForTask(humanContext, `task_stale_other_move_${ids.suffix}`);

      await store.placeKnowledge({
        context: createContext,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: null,
        now: NOW,
      });
      await expectAdapterError(store.placeKnowledge({
        context: otherCreateRetry,
        itemId: ids.item,
        collectionId: firstCollection,
        expectedPlacementRevision: null,
        now: NOW,
      }), "REVISION_CONFLICT");

      await store.placeKnowledge({
        context: moveContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:31:00.000Z"),
      });
      await expectAdapterError(store.placeKnowledge({
        context: otherMoveRetry,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:32:00.000Z"),
      }), "REVISION_CONFLICT");
      await expectAdapterError(store.placeKnowledge({
        context: createContext,
        itemId: ids.item,
        collectionId: secondCollection,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:33:00.000Z"),
      }), "REVISION_CONFLICT");

      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 2, audits: 2 });
      expect(await completedAuditCountForTask(database, otherCreateRetry.taskId)).toBe(0);
      expect(await completedAuditCountForTask(database, otherMoveRetry.taskId)).toBe(0);
    });
  });

  it("records one completed no-op audit for a new task at the current placement revision", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const collectionId = await insertCollection(database, ids, "noop_current", "No-op current");
      const createContext = contextForTask(humanContext, `task_noop_create_${ids.suffix}`);
      const noopContext = contextForTask(humanContext, `task_noop_current_${ids.suffix}`);
      const created = await store.placeKnowledge({
        context: createContext,
        itemId: ids.item,
        collectionId,
        expectedPlacementRevision: null,
        now: NOW,
      });

      await expect(store.placeKnowledge({
        context: noopContext,
        itemId: ids.item,
        collectionId,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:31:00.000Z"),
      })).resolves.toEqual(created);
      await expect(store.placeKnowledge({
        context: noopContext,
        itemId: ids.item,
        collectionId,
        expectedPlacementRevision: 0,
        now: new Date("2026-08-17T08:32:00.000Z"),
      })).resolves.toEqual(created);

      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 1, audits: 2 });
      expect(await completedAuditCountForTask(database, noopContext.taskId)).toBe(1);
      expect(await completedPlacementAudits(database, ids.org, ids.item)).toContainEqual({
        task_id: noopContext.taskId,
        receipt_metadata: {
          collectionId,
          expectedPlacementRevision: 0,
          resultRevision: 0,
        },
      });
    });
  });

  it("waits on authorization revocation and fails closed after the revocation commits", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const collectionId = await insertCollection(database, ids, "revoked_race", "Revoked race");
      const revocationStarted = deferred<number>();
      const releaseRevocation = deferred<void>();
      const revocation = database.transaction(async (client) => {
        const pid = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
        await client.query(
          "update resource_grants set revoked_at = $1 where grant_id = $2",
          [NOW.toISOString(), ids.userGrant],
        );
        revocationStarted.resolve(requiredValue(pid.rows[0]?.pid));
        await releaseRevocation.promise;
      });

      try {
        const blockerPid = await revocationStarted.promise;
        const mutation = store.placeKnowledge({
          context: contextForTask(humanContext, `task_revoked_race_${ids.suffix}`),
          itemId: ids.item,
          collectionId,
          expectedPlacementRevision: null,
          now: new Date("2026-08-17T08:31:00.000Z"),
        });
        const mutationAssertion = expectAdapterError(mutation, "DELEGATION_DENIED");

        await expect(waitForBlockedQuery(database, blockerPid, "resource_grants")).resolves.toEqual(
          expect.any(Number),
        );
        releaseRevocation.resolve(undefined);
        await Promise.all([revocation, mutationAssertion]);

        await expect(store.getPlacement(ids.org, ids.item)).resolves.toBeNull();
        expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 0, audits: 0 });
      } finally {
        releaseRevocation.resolve(undefined);
        await revocation;
      }
    });
  });

  it("avoids deadlock between placement and managed replacement on the same item", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const collectionId = await insertCollection(database, ids, "replacement_race", "Replacement race");
      await seedManagedKnowledge(database, ids);
      const knowledgeStore = new PostgresKnowledgeStore(
        database,
        "test-token-secret-with-at-least-32-bytes",
      );
      const replacementContext = contextForTask(
        humanContext,
        `task_managed_replacement_${ids.suffix}`,
      );
      const replacementContent = {
        title: "Hierarchy item replaced",
        bodyMarkdown: "# Replaced hierarchy item",
        aliases: [],
        tags: [],
      };
      const preview = await knowledgeStore.previewManagedKnowledge({
        context: replacementContext,
        itemId: ids.item,
        expectedRevision: 0,
        content: replacementContent,
      });
      await installManagedReplacementBarrier(database);

      const barrierStarted = deferred<number>();
      const releaseBarrier = deferred<void>();
      const barrier = database.transaction(async (client) => {
        const pid = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [ids.item]);
        barrierStarted.resolve(requiredValue(pid.rows[0]?.pid));
        await releaseBarrier.promise;
      });
      const operations: Promise<unknown>[] = [];

      try {
        const barrierPid = await barrierStarted.promise;
        const replacement = knowledgeStore.replaceManagedKnowledge({
          context: replacementContext,
          itemId: ids.item,
          expectedRevision: 0,
          previewHash: preview.previewHash,
          content: replacementContent,
        });
        operations.push(replacement);
        const replacementPid = await waitForBlockedQuery(
          database,
          barrierPid,
          "insert into knowledge_versions",
        );

        const placement = store.placeKnowledge({
          context: contextForTask(humanContext, `task_placement_replacement_${ids.suffix}`),
          itemId: ids.item,
          collectionId,
          expectedPlacementRevision: null,
          now: new Date("2026-08-17T08:31:00.000Z"),
        });
        operations.push(placement);
        const outcomes = Promise.allSettled([replacement, placement]);
        const placementPid = await waitForBlockedQuery(database, replacementPid, "knowledge_items");
        expect(new Set([barrierPid, replacementPid, placementPid]).size).toBe(3);

        releaseBarrier.resolve(undefined);
        await barrier;
        expect(await outcomes).toEqual([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
        ]);

        expect(await store.getPlacement(ids.org, ids.item)).toMatchObject({
          collectionId,
          revision: 0,
        });
        const item = await database.query<{ revision: string }>(
          "select revision from knowledge_items where item_id = $1",
          [ids.item],
        );
        expect(Number(item.rows[0]?.revision)).toBe(1);
        expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 2, audits: 2 });
      } finally {
        releaseBarrier.resolve(undefined);
        await barrier;
        await Promise.allSettled(operations);
      }
    });
  }, 15_000);

  it("returns not found for cross-organization placement resources without side effects", async () => {
    await withStoreFixture(async ({ database, store, ids, humanContext }) => {
      const collectionId = await insertCollection(database, ids, "same_org", "Same org");
      await expectAdapterError(store.placeKnowledge({
        context: humanContext,
        itemId: ids.otherItem,
        collectionId,
        expectedPlacementRevision: null,
        now: NOW,
      }), "KNOWLEDGE_NOT_FOUND");
      await expectAdapterError(store.placeKnowledge({
        context: humanContext,
        itemId: ids.item,
        collectionId: ids.otherCollection,
        expectedPlacementRevision: null,
        now: NOW,
      }), "KNOWLEDGE_NOT_FOUND");
      expect(await mutationState(database, ids.org)).toEqual({ registryRevision: 0, audits: 0 });
    });
  });
});

describePostgres("PostgreSQL knowledge hierarchy constraints", () => {
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

interface FixtureIds {
  readonly suffix: string;
  readonly org: string;
  readonly otherOrg: string;
  readonly user: string;
  readonly otherUser: string;
  readonly agent: string;
  readonly delegation: string;
  readonly userGrant: string;
  readonly item: string;
  readonly otherItem: string;
  readonly otherCollection: string;
  readonly missing: string;
}

interface StoreFixture {
  readonly database: Database;
  readonly store: PostgresKnowledgeHierarchyStore;
  readonly ids: FixtureIds;
  readonly humanContext: AccessContext;
  readonly agentContext: AccessContext;
}

async function withStoreFixture(work: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  const isolated = await createIsolatedTestDatabase();
  try {
    await runMigrations(isolated.database, { migrationsDir: "migrations" });
    await work(await seedStoreFixture(isolated.database));
  } finally {
    await isolated.cleanup();
  }
}

async function seedStoreFixture(database: Database): Promise<StoreFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const ids: FixtureIds = {
    suffix,
    org: `org_${suffix}`,
    otherOrg: `other_org_${suffix}`,
    user: `user_${suffix}`,
    otherUser: `other_user_${suffix}`,
    agent: `agent_${suffix}`,
    delegation: `delegation_${suffix}`,
    userGrant: `grant_${suffix}`,
    item: `item_${suffix}`,
    otherItem: `other_item_${suffix}`,
    otherCollection: `other_collection_${suffix}`,
    missing: `missing_${suffix}`,
  };

  await database.query(
    `insert into organizations(org_id, name) values
       ($1, 'Hierarchy organization'), ($2, 'Other organization')`,
    [ids.org, ids.otherOrg],
  );
  await database.query(
    `insert into principals(
       principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
     ) values
       ($1, $4, 'user', 'Hierarchy user', 'owner', '{}', 'active'),
       ($2, $4, 'user', 'Other hierarchy user', 'member', '{}', 'active'),
       ($3, $4, 'agent', 'Hierarchy agent', null, '{knowledge.organize}', 'active')`,
    [ids.user, ids.otherUser, ids.agent, ids.org],
  );
  const otherOwner = `other_owner_${suffix}`;
  await database.query(
    `insert into principals(
       principal_id, org_id, principal_type, display_name, organization_role, capabilities, status
     ) values ($1, $2, 'user', 'Other owner', 'owner', '{}', 'active')`,
    [otherOwner, ids.otherOrg],
  );
  await database.query(
    `insert into resource_grants(
       grant_id, org_id, principal_id, scope_kind, scope_id, capabilities
     ) values ($1, $2, $3, 'organization', $2, '{knowledge.organize}')`,
    [ids.userGrant, ids.org, ids.user],
  );
  await database.query(
    `insert into delegations(
       delegation_id, org_id, agent_principal_id, user_principal_id,
       capabilities, resource_scopes, expires_at
     ) values ($1, $2, $3, $4, '{knowledge.organize}', $5::jsonb, $6)`,
    [ids.delegation, ids.org, ids.agent, ids.user,
      JSON.stringify([{ kind: "organization", id: ids.org }]), "2099-08-17T08:30:00.000Z"],
  );
  await database.query(
    `insert into knowledge_items(item_id, org_id, owner_principal_id, title, status) values
       ($1, $2, $3, 'Hierarchy item', 'stable'),
       ($4, $5, $6, 'Other hierarchy item', 'stable')`,
    [ids.item, ids.org, ids.user, ids.otherItem, ids.otherOrg, otherOwner],
  );
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, name, created_by_principal_id
     ) values ($1, $2, 'Other collection', $3)`,
    [ids.otherCollection, ids.otherOrg, otherOwner],
  );

  return {
    database,
    store: new PostgresKnowledgeHierarchyStore(database),
    ids,
    humanContext: accessContext({
      orgId: ids.org,
      actorPrincipalId: ids.user,
      actorAgentId: null,
      onBehalfOfUserId: ids.user,
      delegationId: null,
      taskId: `task_human_${suffix}`,
    }),
    agentContext: accessContext({
      orgId: ids.org,
      actorPrincipalId: ids.agent,
      actorAgentId: ids.agent,
      onBehalfOfUserId: ids.user,
      delegationId: ids.delegation,
      taskId: `task_agent_${suffix}`,
    }),
  };
}

function accessContext(input: Omit<AccessContext, "schema">): AccessContext {
  return { schema: "openlifewiki.access-context/v1", ...input };
}

function contextForTask(context: AccessContext, taskId: string): AccessContext {
  return { ...context, taskId };
}

async function seedCollectionTree(
  database: Database,
  ids: FixtureIds,
): Promise<{ readonly root: string; readonly child: string; readonly grandchild: string }> {
  const root = `root_${ids.suffix}`;
  const child = `child_${ids.suffix}`;
  const grandchild = `grandchild_${ids.suffix}`;
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, parent_collection_id, name, created_by_principal_id
     ) values
       ($1, $4, null, 'Root', $5),
       ($2, $4, $1, 'Child', $5),
       ($3, $4, $2, 'Grandchild', $5)`,
    [root, child, grandchild, ids.org, ids.user],
  );
  return { root, child, grandchild };
}

async function insertCollection(
  database: Database,
  ids: FixtureIds,
  prefix: string,
  name: string,
): Promise<string> {
  const collectionId = `${prefix}_${ids.suffix}`;
  await database.query(
    `insert into knowledge_collections(
       collection_id, org_id, name, created_by_principal_id
     ) values ($1, $2, $3, $4)`,
    [collectionId, ids.org, name, ids.user],
  );
  return collectionId;
}

async function mutationState(
  database: Database,
  orgId: string,
): Promise<{ readonly registryRevision: number; readonly audits: number }> {
  const revision = await database.query<{ registry_revision: string }>(
    "select registry_revision from organizations where org_id = $1",
    [orgId],
  );
  const audits = await database.query<{ count: number }>(
    "select count(*)::integer as count from audit_events where org_id = $1 and decision = 'completed'",
    [orgId],
  );
  return {
    registryRevision: Number(revision.rows[0]?.registry_revision),
    audits: audits.rows[0]?.count ?? 0,
  };
}

interface AuditRow {
  readonly org_id: string;
  readonly task_id: string;
  readonly actor_principal_id: string;
  readonly on_behalf_of_user_id: string;
  readonly action: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly decision: string;
}

async function completedAudits(database: Database, orgId: string): Promise<readonly AuditRow[]> {
  const result = await database.query<AuditRow>(
    `select org_id, task_id, actor_principal_id, on_behalf_of_user_id,
            action, target_kind, target_id, decision
     from audit_events
     where org_id = $1 and decision = 'completed'
     order by created_at, audit_event_id`,
    [orgId],
  );
  return result.rows;
}

interface PlacementAuditRow {
  readonly task_id: string;
  readonly receipt_metadata: {
    readonly collectionId: string;
    readonly expectedPlacementRevision: number | null;
    readonly resultRevision: number;
  };
}

async function completedPlacementAudits(
  database: Database,
  orgId: string,
  itemId: string,
): Promise<readonly PlacementAuditRow[]> {
  const result = await database.query<PlacementAuditRow>(
    `select task_id, receipt_metadata
     from audit_events
     where org_id = $1 and action = 'knowledge.place' and target_id = $2 and decision = 'completed'
     order by created_at, audit_event_id`,
    [orgId, itemId],
  );
  return result.rows;
}

async function completedAuditCountForTask(database: Database, taskId: string): Promise<number> {
  const result = await database.query<{ count: number }>(
    "select count(*)::integer as count from audit_events where task_id = $1 and decision = 'completed'",
    [taskId],
  );
  return result.rows[0]?.count ?? 0;
}

async function hierarchyHasCycle(database: Database, orgId: string): Promise<boolean> {
  const result = await database.query<{ has_cycle: boolean }>(
    `with recursive ancestors(collection_id, parent_collection_id, path, has_cycle) as (
       select collection_id, parent_collection_id, array[collection_id], false
       from knowledge_collections
       where org_id = $1
       union all
       select parent.collection_id, parent.parent_collection_id,
              child.path || parent.collection_id,
              parent.collection_id = any(child.path)
       from ancestors child
       join knowledge_collections parent
         on parent.org_id = $1 and parent.collection_id = child.parent_collection_id
       where not child.has_cycle
     )
     select exists(select 1 from ancestors where has_cycle) as has_cycle`,
    [orgId],
  );
  return result.rows[0]?.has_cycle ?? false;
}

async function seedManagedKnowledge(
  database: Database,
  ids: FixtureIds,
): Promise<void> {
  const locationId = `managed_location_${ids.suffix}`;
  const versionId = `managed_version_${ids.suffix}`;
  await database.query(
    "update resource_grants set capabilities = '{knowledge.organize,knowledge.store}' where grant_id = $1",
    [ids.userGrant],
  );
  await database.query(
    `insert into knowledge_locations(
       location_id, org_id, item_id, location_kind, location_role, locator,
       owner_principal_id, availability
     ) values ($1, $2, $3, 'managed-markdown', 'canonical', $4, $5, 'available')`,
    [locationId, ids.org, ids.item, `openlifewiki-managed://${ids.item}`, ids.user],
  );
  await database.query(
    `insert into knowledge_versions(
       version_id, org_id, item_id, location_id, ordinal, body_hash, body_markdown,
       provenance, created_by_principal_id
     ) values ($1, $2, $3, $4, 1, $5, '# Original hierarchy item', '{}'::jsonb, $6)`,
    [versionId, ids.org, ids.item, locationId, `sha256:${"a".repeat(64)}`, ids.user],
  );
  await database.query(
    "update knowledge_items set current_version_id = $1 where item_id = $2",
    [versionId, ids.item],
  );
}

async function installManagedReplacementBarrier(database: Database): Promise<void> {
  await database.query(
    `create function pause_managed_replacement() returns trigger
     language plpgsql as $function$
     begin
       perform pg_advisory_xact_lock(hashtext(new.item_id));
       return new;
     end
     $function$`,
  );
  await database.query(
    `create trigger pause_managed_replacement_before_version
     before insert on knowledge_versions
     for each row execute function pause_managed_replacement()`,
  );
}

async function waitForBlockedQuery(
  database: Database,
  blockerPid: number,
  queryFragment: string,
): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await database.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where $1::integer = any(pg_blocking_pids(pid))
         and strpos(lower(query), lower($2)) > 0
       order by pid
       limit 1`,
      [blockerPid, queryFragment],
    );
    if (result.rows[0] !== undefined) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a blocked PostgreSQL query containing ${queryFragment}`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected PostgreSQL query result");
  return value;
}

async function expectAdapterError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AdapterError", code });
}

interface HierarchyFixture {
  readonly client: PoolClient;
  readonly orgId: string;
  readonly principalId: string;
  readonly itemId: string;
  readonly uniqueId: (prefix: string) => string;
}

async function withHierarchyFixture(
  work: (fixture: HierarchyFixture) => Promise<void>,
): Promise<void> {
  const isolated = await createIsolatedTestDatabase();
  const suffix = randomUUID();
  const uniqueId = (prefix: string): string => `${prefix}_${suffix}`;
  const orgId = uniqueId("org");
  const principalId = uniqueId("principal");
  const itemId = uniqueId("item");

  try {
    await runMigrations(isolated.database, { migrationsDir: "migrations" });
    await isolated.database.transaction(async (client) => {
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
    });
  } finally {
    await isolated.cleanup();
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

async function createIsolatedTestDatabase(): Promise<{
  readonly database: Database;
  readonly cleanup: () => Promise<void>;
}> {
  const connectionString = requiredTestDatabaseUrl();
  const adminDatabase = createDatabase({ connectionString });
  const schema = `openlifewiki_hierarchy_${randomUUID().replaceAll("-", "")}`;
  try {
    await adminDatabase.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", ["openlifewiki:migrations"]);
      await client.query("create extension if not exists pg_trgm with schema public");
    });
    await adminDatabase.query(`create schema ${schema}`);
  } catch (error) {
    await adminDatabase.close();
    throw error;
  }

  const isolatedUrl = new URL(connectionString);
  isolatedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
  const database = createDatabase({ connectionString: isolatedUrl.toString() });
  return {
    database,
    async cleanup(): Promise<void> {
      await database.close();
      try {
        await adminDatabase.query(`drop schema ${schema} cascade`);
      } finally {
        await adminDatabase.close();
      }
    },
  };
}

function requiredTestDatabaseUrl(): string {
  const value = process.env.OPENLIFEWIKI_TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENLIFEWIKI_TEST_DATABASE_URL is required for PostgreSQL tests");
  }
  return value;
}
