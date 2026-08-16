import {
  RunState,
  Runner,
  ToolCallError,
  type Agent,
} from "@openai/agents";
import {
  AdapterError,
  assertSafeAgentRunState,
  type PostgresKnowledgeStore,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import { assertGroundedKnowledgeResult } from "@openlifewiki/core";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeQueryResultSchema,
  type AccessContext,
  type KnowledgeErrorCode,
  type KnowledgeQueryResult,
} from "@openlifewiki/protocol";

import type { KnowledgeAgentContext } from "./context.js";
import { KnowledgeOperationError } from "./operations.js";
import { PostgresAgentSession } from "./session.js";

export type KnowledgeTaskRunOutcome =
  | {
    readonly kind: "completed";
    readonly task: StoredAgentTask;
    readonly result: KnowledgeQueryResult;
  }
  | {
    readonly kind: "input-required";
    readonly task: StoredAgentTask;
    readonly interruptionCount: number;
  };

export class KnowledgeTaskRunner {
  private readonly runner: Runner;

  constructor(
    private readonly store: PostgresKnowledgeStore,
    private readonly agent: Agent<KnowledgeAgentContext, typeof knowledgeQueryResultSchema>,
  ) {
    this.runner = new Runner({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
  }

  async runQuery(input: {
    readonly task: StoredAgentTask;
    readonly access: AccessContext;
    readonly query: string;
    readonly signal: AbortSignal;
  }): Promise<KnowledgeTaskRunOutcome> {
    assertTaskBinding(input);
    const working = await this.store.markTaskWorkingAuthorized({
      task: input.task,
      access: input.access,
    });
    const session = new PostgresAgentSession(
      this.store,
      working.contextId,
      working.orgId,
      working.ownerPrincipalId,
    );
    const context: KnowledgeAgentContext = {
      access: input.access,
      operation: working.input,
      taskId: working.taskId,
      retrievedCitations: [],
    };

    try {
      const streamed = await this.runner.run(this.agent, input.query, {
        context,
        session,
        signal: input.signal,
        stream: true,
        maxTurns: 8,
      });
      for await (const _event of streamed) {
        // Consuming the stream drives the official SDK state machine to completion.
      }
      await streamed.completed;
      if (input.signal.aborted) throwCancellation(input.signal);

      if (streamed.interruptions.length > 0) {
        const runState = streamed.state.toString({ includeTracingApiKey: false });
        assertSafeAgentRunState(runState);
        const task = await this.store.pauseTask({
          taskId: working.taskId,
          expectedRevision: working.revision,
          runState,
          errorCode: "APPROVAL_REQUIRED",
        });
        return {
          kind: "input-required",
          task,
          interruptionCount: streamed.interruptions.length,
        };
      }

      if (streamed.finalOutput === undefined) {
        throw new KnowledgeOperationError("AGENT_RUN_FAILED");
      }
      const result = knowledgeQueryResultSchema.parse(streamed.finalOutput);
      try {
        assertGroundedKnowledgeResult({
          taskId: working.taskId,
          result,
          retrievedCitations: context.retrievedCitations,
          allowPartial: working.input.kind === "knowledge.query" && working.input.allowPartial,
        });
      } catch {
        throw new KnowledgeOperationError("AGENT_RUN_FAILED");
      }
      const task = await this.store.completeTask({
        taskId: working.taskId,
        expectedRevision: working.revision,
        output: result,
      });
      return { kind: "completed", task, result };
    } catch (error) {
      if (input.signal.aborted) throwCancellation(input.signal);
      if (error instanceof AdapterError && error.code === "REVISION_CONFLICT") throw error;
      const failure = normalizeRunFailure(error);
      await this.store.failTask({
        taskId: working.taskId,
        expectedRevision: working.revision,
        code: failure.code,
      });
      throw failure;
    }
  }

  async recoverInterruptedTask(task: StoredAgentTask): Promise<void> {
    if (!isRecoverableState(task.state)) return;
    if (task.runState === null) {
      await this.store.failInterruptedTask(task.taskId, task.revision);
      return;
    }
    try {
      assertSafeAgentRunState(task.runState);
      await RunState.fromString(this.agent, task.runState);
    } catch {
      await this.store.failInterruptedTask(task.taskId, task.revision);
    }
  }

  async recoverInterruptedTasks(): Promise<void> {
    for (const task of await this.store.listRecoverableTasks()) {
      await this.recoverInterruptedTask(task);
    }
  }
}

function assertTaskBinding(input: {
  readonly task: StoredAgentTask;
  readonly access: AccessContext;
  readonly query: string;
}): void {
  if (input.task.state !== "submitted"
    || input.task.input.kind !== "knowledge.query"
    || input.task.input.query !== input.query
    || input.access.taskId !== input.task.taskId
    || input.access.orgId !== input.task.orgId
    || input.access.onBehalfOfUserId !== input.task.ownerPrincipalId
    || input.access.actorPrincipalId !== (input.task.actorAgentId ?? input.task.ownerPrincipalId)
    || input.access.actorAgentId !== input.task.actorAgentId
    || input.access.delegationId !== input.task.delegationId) {
    throw new KnowledgeOperationError("INVALID_OPERATION");
  }
}

function normalizeRunFailure(error: unknown): KnowledgeOperationError {
  if (error instanceof ToolCallError && error.error instanceof KnowledgeOperationError) {
    return error.error;
  }
  if (error instanceof KnowledgeOperationError) return error;
  if (error instanceof AdapterError && isKnowledgeErrorCode(error.code)) {
    return new KnowledgeOperationError(error.code);
  }
  return new KnowledgeOperationError("AGENT_RUN_FAILED");
}

function isRecoverableState(state: StoredAgentTask["state"]): boolean {
  return state === "submitted" || state === "working" || state === "input-required";
}

function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(value);
}

function throwCancellation(signal: AbortSignal): never {
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}
