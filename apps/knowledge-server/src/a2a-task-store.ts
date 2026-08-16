import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import {
  AdapterError,
  type PostgresKnowledgeStore,
} from "@openlifewiki/adapters";

import { requireAuthenticatedUser } from "./authentication.js";

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
}

function parseTask(value: unknown): Task {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0
    || typeof value.contextId !== "string" || !isRecord(value.status)
    || !Number.isInteger(value.status.state) || !Array.isArray(value.artifacts)
    || !Array.isArray(value.history)) {
    throw new AdapterError("INVALID_OPERATION", "Persisted A2A task is invalid");
  }
  return Task.fromJSON(value);
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
