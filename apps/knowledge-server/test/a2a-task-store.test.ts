import { TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import {
  A2AProjectionValidationError,
  AdapterError,
  type PostgresKnowledgeStore,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import type { KnowledgeAgentResult, Principal } from "@openlifewiki/protocol";
import { describe, expect, it } from "vitest";

import {
  A2A_RECONCILIATION_MAX_PAGES,
  A2A_RECONCILIATION_PAGE_SIZE,
  PostgresA2ATaskStore,
  resultArtifact,
} from "../src/a2a-task-store.js";
import { AuthenticatedA2AUser } from "../src/authentication.js";

describe("A2A completed task reconciliation", () => {
  it("processes more than one small page while bounding total startup work", async () => {
    const adapter = new FakeProjectionStore(
      Array.from({ length: 100 }, (_, index) => candidate(index)),
    );
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await store.reconcileCompletedTasks(fixedNow);

    expect(A2A_RECONCILIATION_PAGE_SIZE).toBe(8);
    expect(A2A_RECONCILIATION_MAX_PAGES).toBe(4);
    expect(adapter.listCalls).toHaveLength(4);
    expect(adapter.listCalls.every(({ limit }) => limit === 8)).toBe(true);
    expect(adapter.completed).toHaveLength(32);
    expect(adapter.saves).toHaveLength(32);
  });

  it("quarantines one malformed output and continues with a later valid task", async () => {
    const malformed = candidate(0, { output: { privatePayload: "must-not-escape" } });
    const valid = candidate(1);
    const adapter = new FakeProjectionStore([malformed, valid]);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await expect(store.reconcileCompletedTasks(fixedNow)).resolves.toBeUndefined();

    expect(adapter.failed).toEqual([{
      taskId: malformed.task.taskId,
      expectedTaskRevision: malformed.task.revision,
      expectedProjectionVersion: malformed.projectionVersion,
    }]);
    expect(JSON.stringify(adapter.failed)).not.toContain("must-not-escape");
    expect(adapter.completed).toEqual([valid.task.taskId]);
  });

  it("quarantines a deeply invalid persisted projection even when its result artifact is exact", async () => {
    const malformed = candidate(0, { exactProjection: true, a2aTaskJsonValid: false });
    const valid = candidate(1);
    const adapter = new FakeProjectionStore([malformed, valid]);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await expect(store.reconcileCompletedTasks(fixedNow)).resolves.toBeUndefined();

    expect(adapter.failed).toEqual([{
      taskId: malformed.task.taskId,
      expectedTaskRevision: malformed.task.revision,
      expectedProjectionVersion: malformed.projectionVersion,
    }]);
    expect(adapter.completed).toEqual([valid.task.taskId]);
  });

  it("quarantines deterministic save validation and continues with a later candidate", async () => {
    const malformed = candidate(0);
    const valid = candidate(1);
    const adapter = new FakeProjectionStore([malformed, valid]);
    adapter.saveErrors.set(malformed.task.taskId, new A2AProjectionValidationError());
    adapter.conflictFailedMarkerOnceFor = malformed.task.taskId;
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await expect(store.reconcileCompletedTasks(fixedNow)).resolves.toBeUndefined();

    expect(adapter.failed).toEqual([{
      taskId: malformed.task.taskId,
      expectedTaskRevision: malformed.task.revision,
      expectedProjectionVersion: malformed.projectionVersion,
    }]);
    expect(adapter.failedMarkerAttempts).toBe(2);
    expect(adapter.loads).toEqual([malformed.task.taskId]);
    expect(adapter.completed).toEqual([valid.task.taskId]);
  });

  it("does not quarantine transient or unrelated adapter failures", async () => {
    for (const error of [
      new AdapterError("INVALID_OPERATION", "simulated unrelated adapter failure"),
      new Error("simulated database failure"),
    ]) {
      const pending = candidate(0);
      const adapter = new FakeProjectionStore([pending]);
      adapter.saveErrors.set(pending.task.taskId, error);
      const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

      await expect(store.reconcileCompletedTasks(fixedNow)).rejects.toBe(error);
      expect(adapter.failed).toEqual([]);
    }
  });

  it("marks an exact saved projection once without rewriting it on repeated startup", async () => {
    const exact = candidate(0, { exactProjection: true });
    const adapter = new FakeProjectionStore([exact]);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await store.reconcileCompletedTasks(fixedNow);
    await store.reconcileCompletedTasks(fixedNow);

    expect(adapter.saves).toHaveLength(0);
    expect(adapter.completed).toEqual([exact.task.taskId]);
    expect(adapter.listCalls).toHaveLength(2);
  });

  it("repairs artifact-saved/status-not-saved without duplicating the result artifact", async () => {
    const pending = candidate(0, { exactArtifactOnly: true });
    const adapter = new FakeProjectionStore([pending]);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await store.reconcileCompletedTasks(fixedNow);

    const projected = adapter.records[0]?.a2aTaskJson as Task;
    expect(projected.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(projected.artifacts?.filter(({ artifactId }) => artifactId === `result:${pending.task.taskId}`))
      .toHaveLength(1);
    expect(adapter.completed).toEqual([pending.task.taskId]);
  });

  it("reloads and retries a real projection marker CAS conflict within the bound", async () => {
    const exact = candidate(0, { exactProjection: true });
    const adapter = new FakeProjectionStore([exact]);
    adapter.conflictMarkerOnceFor = exact.task.taskId;
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);

    await store.reconcileCompletedTasks(fixedNow);

    expect(adapter.markerAttempts).toBe(2);
    expect(adapter.loads).toEqual([exact.task.taskId]);
    expect(adapter.completed).toEqual([exact.task.taskId]);
  });

  it("demand-reconciles one authorized task from every pending A2A crash shape", async () => {
    const records = [
      candidate(0),
      candidate(1, { staleWorking: true }),
      candidate(2, { exactArtifactOnly: true }),
      candidate(3, { exactProjection: true }),
    ];
    const adapter = new FakeProjectionStore(records);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);
    const context = authenticatedContext(projectionPrincipal());

    for (const record of records) {
      const loaded = await store.load(record.task.taskId, context);
      expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(loaded?.artifacts?.filter(({ artifactId }) => artifactId === `result:${record.task.taskId}`))
        .toHaveLength(1);
    }

    expect(adapter.authorizedLoads).toEqual(records.map(({ task }) => task.taskId));
    expect(adapter.saves).toEqual(records.slice(0, 3).map(({ task }) => task.taskId));
    expect(adapter.completed).toEqual(records.map(({ task }) => task.taskId));
  });

  it("does not observe or reconcile another principal's pending task on demand", async () => {
    const pending = candidate(0);
    const adapter = new FakeProjectionStore([pending]);
    const store = new PostgresA2ATaskStore(adapter as unknown as PostgresKnowledgeStore);
    const other = projectionPrincipal("principal_other");

    await expect(store.load(pending.task.taskId, authenticatedContext(other))).resolves.toBeUndefined();

    expect(adapter.authorizedLoads).toEqual([pending.task.taskId]);
    expect(adapter.saves).toEqual([]);
    expect(adapter.completed).toEqual([]);
  });
});

interface ProjectionCandidate {
  readonly task: StoredAgentTask;
  a2aTaskJson: unknown | null;
  readonly a2aTaskJsonValid: boolean;
  projectionVersion: number;
  readonly createdAt: string;
}

class FakeProjectionStore {
  readonly records: ProjectionCandidate[];
  readonly listCalls: Array<{
    readonly afterCreatedAt: string | null;
    readonly afterTaskId: string | null;
    readonly limit: number;
  }> = [];
  readonly saves: string[] = [];
  readonly completed: string[] = [];
  readonly failed: Array<{
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly expectedProjectionVersion: number;
  }> = [];
  readonly loads: string[] = [];
  readonly authorizedLoads: string[] = [];
  readonly saveErrors = new Map<string, Error>();
  conflictMarkerOnceFor: string | undefined;
  conflictFailedMarkerOnceFor: string | undefined;
  markerAttempts = 0;
  failedMarkerAttempts = 0;

  constructor(records: ProjectionCandidate[]) {
    this.records = records;
  }

  async listPendingCompletedA2AProjections(input: {
    readonly afterCreatedAt: string | null;
    readonly afterTaskId: string | null;
    readonly limit: number;
  }): Promise<readonly ProjectionCandidate[]> {
    this.listCalls.push(input);
    return this.pendingRecords()
      .filter((record) => input.afterCreatedAt === null
        || [record.createdAt, record.task.taskId].join("\u0000")
          > [input.afterCreatedAt, input.afterTaskId ?? ""].join("\u0000"))
      .slice(0, input.limit);
  }

  async loadPendingCompletedA2AProjection(taskId: string): Promise<ProjectionCandidate | null> {
    this.loads.push(taskId);
    return this.pendingRecords().find(({ task }) => task.taskId === taskId) ?? null;
  }

  async loadAuthorizedPendingCompletedA2AProjection(input: {
    readonly taskId: string;
    readonly principalId: string;
  }): Promise<ProjectionCandidate | null> {
    this.authorizedLoads.push(input.taskId);
    const record = this.pendingRecords().find(({ task }) => task.taskId === input.taskId);
    if (record === undefined || input.principalId !== record.task.ownerPrincipalId) return null;
    return record;
  }

  async loadA2ATask(taskId: string, principalId: string): Promise<unknown | null> {
    const record = this.records.find(({ task }) => task.taskId === taskId);
    if (record === undefined || principalId !== record.task.ownerPrincipalId) return null;
    return record.a2aTaskJson;
  }

  async saveA2ATask(input: {
    readonly taskId: string;
    readonly expectedA2ARevision: number | null;
    readonly taskJson: unknown;
  }) {
    const saveError = this.saveErrors.get(input.taskId);
    if (saveError !== undefined) {
      throw saveError;
    }
    const record = this.records.find(({ task }) => task.taskId === input.taskId);
    if (record === undefined) throw new Error("Unknown fake task");
    const a2aRevision = (input.expectedA2ARevision ?? -1) + 1;
    const taskJson = {
      ...(input.taskJson as Task),
      metadata: {
        ...((input.taskJson as Task).metadata ?? {}),
        openlifewikiA2ARevision: a2aRevision,
      },
    };
    record.a2aTaskJson = taskJson;
    record.projectionVersion += 1;
    this.saves.push(input.taskId);
    return {
      taskJson,
      a2aRevision,
      task: record.task,
      projectionState: "pending" as const,
      projectionVersion: record.projectionVersion,
    };
  }

  async markA2AProjectionComplete(input: {
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly expectedProjectionVersion: number;
    readonly expectedA2ARevision: number;
  }): Promise<void> {
    this.markerAttempts += 1;
    if (this.conflictMarkerOnceFor === input.taskId) {
      this.conflictMarkerOnceFor = undefined;
      throw new AdapterError("REVISION_CONFLICT", "simulated conflict");
    }
    this.completed.push(input.taskId);
  }

  async markA2AProjectionFailed(input: {
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly expectedProjectionVersion: number;
  }): Promise<void> {
    this.failedMarkerAttempts += 1;
    if (this.conflictFailedMarkerOnceFor === input.taskId) {
      this.conflictFailedMarkerOnceFor = undefined;
      throw new AdapterError("REVISION_CONFLICT", "simulated conflict");
    }
    this.failed.push(input);
  }

  private pendingRecords(): ProjectionCandidate[] {
    const terminal = new Set([...this.completed, ...this.failed.map(({ taskId }) => taskId)]);
    return this.records.filter(({ task }) => !terminal.has(task.taskId));
  }
}

function candidate(index: number, options: {
  readonly output?: unknown;
  readonly exactProjection?: boolean;
  readonly exactArtifactOnly?: boolean;
  readonly staleWorking?: boolean;
  readonly a2aTaskJsonValid?: boolean;
} = {}): ProjectionCandidate {
  const taskId = `task_projection_${String(index).padStart(3, "0")}`;
  const contextId = `context_projection_${String(index).padStart(3, "0")}`;
  const result = queryResult(taskId);
  const task: StoredAgentTask = {
    taskId,
    contextId,
    orgId: "org_projection",
    ownerPrincipalId: "principal_projection",
    actorAgentId: null,
    delegationId: null,
    state: "completed",
    input: {
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.query",
      query: `query ${index}`,
      limit: 10,
      allowPartial: true,
    },
    output: options.output ?? result,
    runState: null,
    errorCode: null,
    cancelRequested: false,
    revision: 2,
  };
  const exactArtifact = resultArtifact(result);
  const a2aTaskJson = options.exactProjection === true
    || options.exactArtifactOnly === true
    || options.staleWorking === true
    ? {
        id: taskId,
        contextId,
        status: {
          state: options.exactProjection === true
            ? TaskState.TASK_STATE_COMPLETED
            : TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: "2026-08-17T00:00:00.000Z",
        },
        artifacts: options.exactArtifactOnly === true || options.exactProjection === true
          ? [exactArtifact]
          : [],
        history: [],
        metadata: { openlifewikiA2ARevision: 0 },
      } satisfies Task
    : null;
  return {
    task,
    a2aTaskJson,
    a2aTaskJsonValid: options.a2aTaskJsonValid ?? true,
    projectionVersion: 1,
    createdAt: new Date(Date.UTC(2026, 7, 17, 0, 0, index)).toISOString(),
  };
}

function queryResult(taskId: string): KnowledgeAgentResult {
  return {
    schema: "openlifewiki.knowledge-query-result/v1",
    taskId,
    evidenceMode: "no-evidence",
    answer: "No authorized evidence was found.",
    citations: [],
    gaps: [{ code: "NO_AUTHORIZED_EVIDENCE", description: "No authorized evidence was found." }],
  };
}

function fixedNow(): Date {
  return new Date("2026-08-17T00:00:00.000Z");
}

function projectionPrincipal(principalId = "principal_projection"): Principal {
  return {
    schema: "openlifewiki.principal/v1",
    principalId,
    orgId: "org_projection",
    type: "user",
    displayName: principalId,
    organizationRole: "owner",
    capabilities: ["knowledge.query"],
    status: "active",
  };
}

function authenticatedContext(principal: Principal): ServerCallContext {
  return new ServerCallContext({
    user: new AuthenticatedA2AUser(principal),
    requestedVersion: "1.0",
  });
}
