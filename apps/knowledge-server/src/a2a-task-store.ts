import {
  TaskState,
  type Artifact,
  type ListTasksRequest,
  type ListTasksResponse,
  type Task,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import {
  AdapterError,
  type A2AProjectionProductTask,
  type PendingCompletedA2AProjection,
  type PostgresKnowledgeStore,
  type SavedA2ATask,
} from "@openlifewiki/adapters";
import {
  knowledgeAgentResultSchema,
  type KnowledgeAgentResult,
} from "@openlifewiki/protocol";

import { requireAuthenticatedUser } from "./authentication.js";

export const A2A_RECONCILIATION_PAGE_SIZE = 8;
export const A2A_RECONCILIATION_MAX_PAGES = 4;
const A2A_RECONCILIATION_CAS_ATTEMPTS = 3;

export class PostgresA2ATaskStore implements TaskStore {
  constructor(private readonly store: PostgresKnowledgeStore) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const principalId = requireAuthenticatedUser(context.user).principal.principalId;
    const expectedA2ARevision = readA2ARevision(task);
    const saved = await this.store.saveA2ATask({
      taskId: task.id,
      principalId,
      expectedA2ARevision,
      taskJson: task,
    });
    task.metadata = {
      ...(task.metadata ?? {}),
      openlifewikiA2ARevision: saved.a2aRevision,
    };
    await this.markSavedProjectionComplete(saved);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const principalId = requireAuthenticatedUser(context.user).principal.principalId;
    const value = await this.store.loadA2ATask(taskId, principalId);
    if (value === null) return undefined;
    return parseTask(value);
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const principalId = requireAuthenticatedUser(context.user).principal.principalId;
    const pageSize = params.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AdapterError("INVALID_OPERATION", "A2A page size is invalid");
    }
    const cursor = decodePageToken(params.pageToken);
    const page = await this.store.listA2ATasks({
      principalId,
      contextId: params.contextId === "" ? null : params.contextId,
      status: params.status === TaskState.TASK_STATE_UNSPECIFIED ? null : params.status,
      statusTimestampAfter: params.statusTimestampAfter ?? null,
      afterUpdatedAt: cursor?.updatedAt ?? null,
      afterTaskId: cursor?.taskId ?? null,
      limit: pageSize + 1,
    });
    const visible = page.rows.slice(0, pageSize);
    const tasks = visible.map(({ taskJson }) => projectTask(parseTask(taskJson), params));
    const last = visible.at(-1);
    return {
      tasks,
      nextPageToken: page.rows.length > pageSize && last !== undefined
        ? encodePageToken({ updatedAt: last.updatedAt, taskId: last.taskId })
        : "",
      pageSize,
      totalSize: page.totalSize,
    };
  }

  async reconcileCompletedTasks(now: () => Date = () => new Date()): Promise<void> {
    let afterCreatedAt: string | null = null;
    let afterTaskId: string | null = null;
    for (let page = 0; page < A2A_RECONCILIATION_MAX_PAGES; page += 1) {
      const records = await this.store.listPendingCompletedA2AProjections({
        afterCreatedAt,
        afterTaskId,
        limit: A2A_RECONCILIATION_PAGE_SIZE,
      });
      for (const record of records) await this.reconcileCompletedTask(record, now);
      const last = records.at(-1);
      if (last === undefined || records.length < A2A_RECONCILIATION_PAGE_SIZE) return;
      afterCreatedAt = last.createdAt;
      afterTaskId = last.task.taskId;
    }
  }

  private async reconcileCompletedTask(
    initialRecord: PendingCompletedA2AProjection,
    now: () => Date,
  ): Promise<void> {
    let record: PendingCompletedA2AProjection | null = initialRecord;
    for (let attempt = 0; attempt < A2A_RECONCILIATION_CAS_ATTEMPTS; attempt += 1) {
      if (record === null) return;
      try {
        const parsed = parseProjection(record);
        if (parsed === null) {
          await this.store.markA2AProjectionFailed({
            taskId: record.task.taskId,
            expectedTaskRevision: record.task.revision,
            expectedProjectionVersion: record.projectionVersion,
          });
          return;
        }
        const { current, currentA2ARevision, result } = parsed;
        if (current !== undefined && isCompletedProjection(current, record.task, result)) {
          await this.markProjectionComplete(record, currentA2ARevision);
          return;
        }
        const saved = await this.store.saveA2ATask({
          taskId: record.task.taskId,
          principalId: record.task.actorAgentId ?? record.task.ownerPrincipalId,
          expectedA2ARevision: currentA2ARevision,
          taskJson: completedProjection(current, record.task, result, now()),
        });
        await this.markProjectionComplete({
          task: saved.task,
          a2aTaskJson: saved.taskJson,
          projectionVersion: saved.projectionVersion,
        }, saved.a2aRevision);
        return;
      } catch (error) {
        if (!(error instanceof AdapterError) || error.code !== "REVISION_CONFLICT") throw error;
        record = await this.store.loadPendingCompletedA2AProjection(initialRecord.task.taskId);
      }
    }
    throw new AdapterError("REVISION_CONFLICT", "A2A task reconciliation did not converge");
  }

  private async markSavedProjectionComplete(initial: SavedA2ATask): Promise<void> {
    if (initial.projectionState !== "pending" || !isExactSavedProjection(initial)) return;
    let record: ProjectionRecord | null = {
      task: initial.task,
      a2aTaskJson: initial.taskJson,
      projectionVersion: initial.projectionVersion,
    };
    for (let attempt = 0; attempt < A2A_RECONCILIATION_CAS_ATTEMPTS; attempt += 1) {
      if (record === null || !isExactProjectionRecord(record)) return;
      try {
        await this.markProjectionComplete(record, readA2ARevision(parseTask(record.a2aTaskJson)));
        return;
      } catch (error) {
        if (!(error instanceof AdapterError) || error.code !== "REVISION_CONFLICT") throw error;
        record = await this.store.loadPendingCompletedA2AProjection(initial.task.taskId);
      }
    }
    throw new AdapterError("REVISION_CONFLICT", "A2A projection completion did not converge");
  }

  private async markProjectionComplete(
    record: ProjectionRecord,
    expectedA2ARevision: number | null,
  ): Promise<void> {
    if (expectedA2ARevision === null) {
      throw new AdapterError("INVALID_OPERATION", "Completed A2A projection revision is missing");
    }
    await this.store.markA2AProjectionComplete({
      taskId: record.task.taskId,
      expectedTaskRevision: record.task.revision,
      expectedProjectionVersion: record.projectionVersion,
      expectedA2ARevision,
    });
  }
}

interface ProjectionRecord {
  readonly task: A2AProjectionProductTask;
  readonly a2aTaskJson: unknown;
  readonly projectionVersion: number;
}

function parseProjection(record: PendingCompletedA2AProjection): {
  readonly current: Task | undefined;
  readonly currentA2ARevision: number | null;
  readonly result: KnowledgeAgentResult;
} | null {
  const output = knowledgeAgentResultSchema.safeParse(record.task.output);
  if (!output.success || output.data.taskId !== record.task.taskId) return null;
  if (record.a2aTaskJson === null) {
    return { current: undefined, currentA2ARevision: null, result: output.data };
  }
  try {
    const current = parseTask(record.a2aTaskJson);
    return { current, currentA2ARevision: readA2ARevision(current), result: output.data };
  } catch (error) {
    if (error instanceof AdapterError && error.code === "INVALID_OPERATION") return null;
    throw error;
  }
}

function isExactSavedProjection(saved: SavedA2ATask): boolean {
  return isExactProjectionRecord({
    task: saved.task,
    a2aTaskJson: saved.taskJson,
    projectionVersion: saved.projectionVersion,
  });
}

function isExactProjectionRecord(record: ProjectionRecord): boolean {
  if (record.task.state !== "completed") return false;
  const output = knowledgeAgentResultSchema.safeParse(record.task.output);
  if (!output.success || output.data.taskId !== record.task.taskId) return false;
  try {
    return isCompletedProjection(parseTask(record.a2aTaskJson), record.task, output.data);
  } catch (error) {
    if (error instanceof AdapterError && error.code === "INVALID_OPERATION") return false;
    throw error;
  }
}

function completedProjection(
  current: Task | undefined,
  productTask: A2AProjectionProductTask,
  result: KnowledgeAgentResult,
  now: Date,
): Task {
  const resultId = `result:${productTask.taskId}`;
  return {
    id: productTask.taskId,
    contextId: productTask.contextId,
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      message: undefined,
      timestamp: now.toISOString(),
    },
    artifacts: [
      ...(current?.artifacts ?? []).filter(({ artifactId }) => artifactId !== resultId),
      resultArtifact(result),
    ],
    history: current?.history ?? [],
    metadata: current?.metadata ?? {},
  };
}

function isCompletedProjection(
  task: Task,
  productTask: A2AProjectionProductTask,
  result: KnowledgeAgentResult,
): boolean {
  if (task.id !== productTask.taskId
    || task.contextId !== productTask.contextId
    || task.status?.state !== TaskState.TASK_STATE_COMPLETED
    || task.status.message !== undefined
    || typeof task.status.timestamp !== "string"
    || !Number.isFinite(Date.parse(task.status.timestamp))) return false;
  const artifacts = (task.artifacts ?? []).filter(({ artifactId }) => artifactId === `result:${productTask.taskId}`);
  return artifacts.length === 1 && isExactResultArtifact(artifacts[0], result);
}

function isExactResultArtifact(
  artifact: Artifact | undefined,
  result: KnowledgeAgentResult,
): boolean {
  if (artifact === undefined
    || artifact.name !== result.schema
    || artifact.description !== "Authorized knowledge operation result"
    || artifact.parts.length !== 1
    || artifact.metadata === undefined
    || Object.keys(artifact.metadata).length !== 0
    || !Array.isArray(artifact.extensions)
    || artifact.extensions.length !== 0) return false;
  const part = artifact.parts[0];
  if (part?.content?.$case !== "data"
    || part.mediaType !== "application/json"
    || part.filename !== ""
    || part.metadata === undefined
    || Object.keys(part.metadata).length !== 0) return false;
  const parsed = knowledgeAgentResultSchema.safeParse(part.content.value);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(result);
}

export function resultArtifact(result: KnowledgeAgentResult): Artifact {
  return {
    artifactId: `result:${result.taskId}`,
    name: result.schema,
    description: "Authorized knowledge operation result",
    parts: [{
      content: { $case: "data", value: result },
      mediaType: "application/json",
      filename: "",
      metadata: {},
    }],
    metadata: {},
    extensions: [],
  };
}

function parseTask(value: unknown): Task {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0
    || typeof value.contextId !== "string" || !isRecord(value.status)
    || !Number.isInteger(value.status.state) || !Array.isArray(value.artifacts)
    || !Array.isArray(value.history)) {
    throw new AdapterError("INVALID_OPERATION", "Persisted A2A task is invalid");
  }
  return structuredClone(value) as Task;
}

function readA2ARevision(task: Task): number | null {
  const value = task.metadata?.openlifewikiA2ARevision;
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterError("INVALID_OPERATION", "A2A task revision is invalid");
  }
  return Number(value);
}

function projectTask(task: Task, params: ListTasksRequest): Task {
  const projected = structuredClone(task);
  if (params.includeArtifacts !== true) projected.artifacts = [];
  if (params.historyLength !== undefined) {
    if (!Number.isInteger(params.historyLength) || params.historyLength < 0) {
      throw new AdapterError("INVALID_OPERATION", "A2A history length is invalid");
    }
    projected.history = params.historyLength === 0
      ? []
      : projected.history.slice(-params.historyLength);
  }
  return projected;
}

interface PageCursor {
  readonly updatedAt: string;
  readonly taskId: string;
}

function encodePageToken(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePageToken(value: string): PageCursor | null {
  if (value === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt))
      || typeof parsed.taskId !== "string" || parsed.taskId.length === 0) throw new Error();
    return { updatedAt: parsed.updatedAt, taskId: parsed.taskId };
  } catch {
    throw new AdapterError("INVALID_OPERATION", "A2A page token is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
