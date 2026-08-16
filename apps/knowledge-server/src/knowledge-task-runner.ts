import {
  RunState,
  Runner,
  ToolCallError,
  type Agent,
} from "@openai/agents";
import {
  AdapterError,
  assertSafeAgentRunState,
  type Database,
  type PostgresKnowledgeStore,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import {
  KnowledgeOperationError,
  PostgresAgentSession,
  type AgentMessageOperation,
  type KnowledgeAgentContext,
  type KnowledgeOperations,
} from "@openlifewiki/knowledge-agent";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeAgentResultSchema,
  type AccessContext,
  type KnowledgeAgentResult,
  type KnowledgeErrorCode,
  type KnowledgeOperation,
} from "@openlifewiki/protocol";

export type KnowledgeServerTaskRunOutcome =
  | {
    readonly kind: "completed";
    readonly task: StoredAgentTask;
    readonly result: KnowledgeAgentResult;
  }
  | {
    readonly kind: "input-required";
    readonly task: StoredAgentTask;
    readonly interruptionCount: number;
  };

export class KnowledgeServerTaskRunner {
  private readonly runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });

  constructor(
    private readonly store: PostgresKnowledgeStore,
    private readonly operations: KnowledgeOperations,
    private readonly agent: Agent<KnowledgeAgentContext, any>,
    private readonly database: Database,
  ) {}

  async runAgent(input: {
    readonly task: StoredAgentTask;
    readonly access: AccessContext;
    readonly operation: KnowledgeOperation | AgentMessageOperation;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly onWorking?: (task: StoredAgentTask) => void | Promise<void>;
  }): Promise<KnowledgeServerTaskRunOutcome> {
    assertTaskAccess(input.task, input.access);
    const working = await this.markWorking(input);
    const session = new PostgresAgentSession(
      this.store,
      working.contextId,
      working.orgId,
      working.ownerPrincipalId,
    );
    const context: KnowledgeAgentContext = {
      access: input.access,
      operation: input.operation,
      taskId: working.taskId,
      retrievedCitations: [],
    };

    try {
      const result = await this.runner.run(this.agent, input.prompt, {
        context,
        session,
        signal: input.signal,
        maxTurns: 8,
      });
      if (input.signal.aborted) throwCancellation(input.signal);
      if (result.interruptions.length > 0) {
        const runState = result.state.toString({ includeTracingApiKey: false });
        assertSafeAgentRunState(runState);
        const task = await this.store.pauseTask({
          taskId: working.taskId,
          expectedRevision: working.revision,
          runState,
          errorCode: "APPROVAL_REQUIRED",
        });
        return { kind: "input-required", task, interruptionCount: result.interruptions.length };
      }
      const output = knowledgeAgentResultSchema.safeParse(result.finalOutput);
      if (!output.success) throw new KnowledgeOperationError("AGENT_RUN_FAILED");
      const task = await this.store.completeTask({
        taskId: working.taskId,
        expectedRevision: working.revision,
        output: output.data,
      });
      return { kind: "completed", task, result: output.data };
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

  async runStructured(input: {
    readonly task: StoredAgentTask;
    readonly access: AccessContext;
    readonly operation: Exclude<KnowledgeOperation, { kind: "knowledge.query" | "knowledge.organize" }>;
    readonly signal: AbortSignal;
    readonly onWorking?: (task: StoredAgentTask) => void | Promise<void>;
  }): Promise<KnowledgeServerTaskRunOutcome> {
    assertTaskAccess(input.task, input.access);
    if (input.signal.aborted) throwCancellation(input.signal);
    const working = await this.markWorking(input);
    const operationAccess = input.operation.kind === "knowledge.store.apply-replace"
      ? await this.resolvePreviewAccess(input.access, input.operation)
      : input.access;
    const operationResult = await executeOperation(this.operations, operationAccess, input.operation);
    const result = operationAccess.taskId === input.access.taskId
      ? operationResult
      : knowledgeAgentResultSchema.parse({ ...operationResult, taskId: input.task.taskId });
    if (input.signal.aborted) throwCancellation(input.signal);
    const task = await this.store.completeTask({
      taskId: working.taskId,
      expectedRevision: working.revision,
      output: result,
    });
    return { kind: "completed", task, result };
  }

  async recoverInterruptedTasks(): Promise<void> {
    for (const task of await this.store.listRecoverableTasks()) {
      if (task.runState === null) {
        await this.store.failInterruptedTask(task.taskId, task.revision);
        continue;
      }
      try {
        assertSafeAgentRunState(task.runState);
        await RunState.fromString(this.agent, task.runState);
      } catch {
        await this.store.failInterruptedTask(task.taskId, task.revision);
      }
    }
  }

  private async markWorking(input: {
    readonly task: StoredAgentTask;
    readonly access: AccessContext;
    readonly onWorking?: (task: StoredAgentTask) => void | Promise<void>;
  }): Promise<StoredAgentTask> {
    const working = await this.store.markTaskWorkingAuthorized({
      task: input.task,
      access: input.access,
    });
    await input.onWorking?.(working);
    return working;
  }

  private async resolvePreviewAccess(
    access: AccessContext,
    operation: Extract<KnowledgeOperation, { kind: "knowledge.store.apply-replace" }>,
  ): Promise<AccessContext> {
    const result = await this.database.query<{ task_id: string }>(
      `select task_id from agent_tasks
       where org_id = $1 and owner_principal_id = $2
         and actor_agent_id is not distinct from $3 and state = 'completed'
         and input_json->>'kind' = 'knowledge.store.preview-replace'
         and output_json->>'schema' = 'openlifewiki.store-preview/v1'
         and output_json->>'previewHash' = $4
         and output_json->>'itemId' = $5
         and (output_json->>'expectedRevision')::integer = $6
       order by updated_at desc limit 1`,
      [access.orgId, access.onBehalfOfUserId, access.actorAgentId, operation.previewHash,
        operation.itemId, operation.expectedRevision],
    );
    const previewTaskId = result.rows[0]?.task_id;
    return previewTaskId === undefined ? access : { ...access, taskId: previewTaskId };
  }
}

async function executeOperation(
  operations: KnowledgeOperations,
  context: AccessContext,
  operation: Exclude<KnowledgeOperation, { kind: "knowledge.query" | "knowledge.organize" }>,
): Promise<KnowledgeAgentResult> {
  switch (operation.kind) {
    case "knowledge.register": return await operations.register(context, operation);
    case "knowledge.store": return await operations.storeManaged(context, operation);
    case "knowledge.store.preview-replace": return await operations.previewManagedReplacement(context, operation);
    case "knowledge.store.apply-replace": return await operations.applyManagedReplacement(context, operation);
    case "knowledge.share": return await operations.share(context, operation);
  }
}

function assertTaskAccess(task: StoredAgentTask, access: AccessContext): void {
  if (task.state !== "submitted"
    || access.taskId !== task.taskId
    || access.orgId !== task.orgId
    || access.onBehalfOfUserId !== task.ownerPrincipalId
    || access.actorPrincipalId !== (task.actorAgentId ?? task.ownerPrincipalId)
    || access.actorAgentId !== task.actorAgentId
    || access.delegationId !== task.delegationId) {
    throw new KnowledgeOperationError("INVALID_OPERATION");
  }
}

function normalizeRunFailure(error: unknown): KnowledgeOperationError {
  if (error instanceof ToolCallError && error.error instanceof KnowledgeOperationError) return error.error;
  if (error instanceof KnowledgeOperationError) return error;
  if (error instanceof AdapterError && isKnowledgeErrorCode(error.code)) {
    return new KnowledgeOperationError(error.code);
  }
  return new KnowledgeOperationError("AGENT_RUN_FAILED");
}

function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(value);
}

function throwCancellation(signal: AbortSignal): never {
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}
