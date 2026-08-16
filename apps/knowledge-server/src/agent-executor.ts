import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  AdapterError,
  type PostgresKnowledgeStore,
  type StoredAgentTask,
} from "@openlifewiki/adapters";
import {
  KnowledgeOperationError,
  type AgentMessageOperation,
} from "@openlifewiki/knowledge-agent";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeOperationSchema,
  type KnowledgeAgentResult,
  type KnowledgeErrorCode,
  type KnowledgeOperation,
} from "@openlifewiki/protocol";

import { requireAuthenticatedUser } from "./authentication.js";
import {
  type ExecutableStructuredKnowledgeOperation,
  type KnowledgeServerTaskRunOutcome,
  type KnowledgeServerTaskRunner,
} from "./knowledge-task-runner.js";

const MAX_OPERATION_BYTES = 65_536;
type SupportedKnowledgeOperation =
  | Extract<KnowledgeOperation, { kind: "knowledge.query" }>
  | ExecutableStructuredKnowledgeOperation;

interface ActiveExecution {
  readonly controller: AbortController;
  readonly principalId: string;
  cancellation?: Promise<StoredAgentTask>;
}

export class KnowledgeAgentExecutor implements AgentExecutor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly cancellationPrincipal = new AsyncLocalStorage<string>();

  constructor(
    private readonly store: PostgresKnowledgeStore,
    private readonly runner: KnowledgeServerTaskRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly beforeCancellationSettlement: () => Promise<void> = async () => {},
  ) {}

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const user = requireAuthenticatedUser(request.context.user);
    const requestInput = bindAuthenticatedOwner(
      parseA2AOperation(request.userMessage),
      user.principal.principalId,
    );
    const taskInput = isAgentMessage(requestInput) ? textTaskInput(requestInput.text) : requestInput;
    let productTask: StoredAgentTask | undefined;
    const controller = new AbortController();
    try {
      const existing = await this.store.loadTask(request.taskId, user.principal.principalId);
      if (existing !== null) {
        bus.publish(AgentEvent.message(failureMessage(existing, "INVALID_OPERATION")));
        return;
      }
      productTask = await this.store.createTaskForAuthenticatedPrincipal({
        taskId: request.taskId,
        contextId: request.contextId,
        principal: user.principal,
        input: taskInput,
      });
      bus.publish(AgentEvent.task(toSubmittedTask(productTask, request.userMessage, this.now())));
      const access = await this.store.resolveTaskAccessContext({
        taskId: productTask.taskId,
        principalId: user.principal.principalId,
      });
      this.active.set(productTask.taskId, {
        controller,
        principalId: user.principal.principalId,
      });
      const onWorking = async (working: StoredAgentTask) => {
        productTask = working;
        bus.publish(AgentEvent.statusUpdate(statusEvent(working, TaskState.TASK_STATE_WORKING, this.now())));
      };
      const outcome = isAgentMessage(requestInput)
        ? await this.runner.runAgent({
          task: productTask,
          access,
          operation: requestInput,
          prompt: requestInput.text,
          signal: controller.signal,
          onWorking,
        })
        : requestInput.kind === "knowledge.query"
          ? await this.runner.runAgent({
            task: productTask,
            access,
            operation: requestInput,
            prompt: requestInput.query,
            signal: controller.signal,
            onWorking,
          })
          : await this.runner.runStructured({
            task: productTask,
            access,
            operation: requestInput,
            signal: controller.signal,
            onWorking,
          });
      productTask = outcome.task;
      publishOutcome(bus, outcome, this.now());
    } catch (error) {
      if (productTask === undefined) throw new Error(errorCode(error));
      const current = await this.store.loadTask(productTask.taskId, user.principal.principalId);
      if (current?.state === "canceled" || current?.cancelRequested === true) {
        await this.active.get(productTask.taskId)?.cancellation?.catch(() => undefined);
        return;
      }
      const code = errorCode(error);
      const failed = current === null || current.state === "failed"
        ? current
        : await this.store.failTask({
          taskId: current.taskId,
          expectedRevision: current.revision,
          code,
        });
      if (failed !== null) {
        bus.publish(AgentEvent.statusUpdate(statusEvent(failed, TaskState.TASK_STATE_FAILED, this.now(), code)));
      }
    } finally {
      if (productTask !== undefined) this.active.delete(productTask.taskId);
      bus.finished();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    try {
      const principalId = this.cancellationPrincipal.getStore();
      if (principalId === undefined) throw new Error("Authenticated cancellation context is required");
      const active = this.active.get(taskId);
      if (active !== undefined && active.principalId !== principalId) {
        throw new Error("Task cancellation is not authorized");
      }
      const task = await this.store.loadTask(taskId, principalId);
      if (task === null) throw new Error("Task cancellation is not authorized");
      const cancellation = (async () => {
        const requested = await this.store.requestTaskCancellation({
          taskId,
          expectedRevision: task.revision,
          principalId,
        });
        active?.controller.abort(new DOMException("Task canceled", "AbortError"));
        await this.beforeCancellationSettlement();
        return await this.store.settleCanceledTask({
          taskId,
          expectedRevision: requested.revision,
          principalId,
        });
      })();
      if (active !== undefined) active.cancellation = cancellation;
      const canceled = await cancellation;
      bus.publish(AgentEvent.statusUpdate(statusEvent(canceled, TaskState.TASK_STATE_CANCELED, this.now())));
    } finally {
      bus.finished();
    }
  }

  async withCancellationPrincipal<T>(principalId: string, work: () => Promise<T>): Promise<T> {
    return await this.cancellationPrincipal.run(principalId, work);
  }
}

export function parseA2AOperation(message: Message): SupportedKnowledgeOperation | AgentMessageOperation {
  const operationParts = message.parts.filter(({ content }) => content?.$case === "data");
  const textParts = message.parts.filter(({ content }) => content?.$case === "text");
  if (operationParts.length === 1 && textParts.length === 0 && message.parts.length === 1) {
    const part = operationParts[0];
    if (part?.mediaType !== "application/json") throwInvalidOperation();
    const value = part.content?.$case === "data" ? part.content.value : undefined;
    assertByteLimit(JSON.stringify(value));
    const operation = knowledgeOperationSchema.safeParse(value);
    if (!operation.success || !isSupportedKnowledgeOperation(operation.data)) throwInvalidOperation();
    return operation.data;
  }
  if (textParts.length === 1 && operationParts.length === 0 && message.parts.length === 1) {
    const rawValue = textParts[0]?.content?.$case === "text" ? textParts[0].content.value : "";
    assertByteLimit(rawValue);
    const value = rawValue.trim();
    if (value.length === 0 || value.length > 8_000) throwInvalidOperation();
    return { schema: "openlifewiki.agent-message/v1", text: value };
  }
  throwInvalidOperation();
}

export function bindAuthenticatedOwner<T extends SupportedKnowledgeOperation | AgentMessageOperation>(
  input: T,
  principalId: string,
): T {
  if (!("kind" in input) || input.kind !== "knowledge.register") return input;
  return {
    ...input,
    locations: input.locations.map((location) => ({
      ...location,
      ownerPrincipalId: location.ownerPrincipalId === "self"
        ? principalId
        : location.ownerPrincipalId,
    })),
  } as T;
}

function toSubmittedTask(task: StoredAgentTask, userMessage: Message, now: Date): Task {
  return {
    id: task.taskId,
    contextId: task.contextId,
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: now.toISOString(),
    },
    artifacts: [],
    history: [userMessage],
    metadata: {},
  };
}

function statusEvent(
  task: StoredAgentTask,
  state: TaskState,
  now: Date,
  code?: KnowledgeErrorCode,
): TaskStatusUpdateEvent {
  return {
    taskId: task.taskId,
    contextId: task.contextId,
    status: {
      state,
      message: code === undefined ? undefined : failureMessage(task, code),
      timestamp: now.toISOString(),
    },
    metadata: code === undefined ? {} : { code },
  };
}

function failureMessage(task: StoredAgentTask, code: KnowledgeErrorCode): Message {
  return {
    messageId: randomUUID(),
    contextId: task.contextId,
    taskId: task.taskId,
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: "text", value: code },
      mediaType: "text/plain",
      filename: "",
      metadata: {},
    }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function publishOutcome(bus: ExecutionEventBus, outcome: KnowledgeServerTaskRunOutcome, now: Date): void {
  if (outcome.kind === "input-required") {
    bus.publish(AgentEvent.statusUpdate(statusEvent(
      outcome.task,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      now,
      "APPROVAL_REQUIRED",
    )));
    return;
  }
  bus.publish(AgentEvent.artifactUpdate({
    taskId: outcome.task.taskId,
    contextId: outcome.task.contextId,
    artifact: resultArtifact(outcome.result),
    append: false,
    lastChunk: true,
    metadata: {},
  }));
  bus.publish(AgentEvent.statusUpdate(statusEvent(
    outcome.task,
    TaskState.TASK_STATE_COMPLETED,
    now,
  )));
}

function resultArtifact(result: KnowledgeAgentResult): Artifact {
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

function isAgentMessage(
  input: KnowledgeOperation | AgentMessageOperation,
): input is AgentMessageOperation {
  return input.schema === "openlifewiki.agent-message/v1";
}

function textTaskInput(text: string): Extract<KnowledgeOperation, { kind: "knowledge.query" }> {
  return {
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.query",
    query: text,
    limit: 10,
    allowPartial: true,
  };
}

function errorCode(error: unknown): KnowledgeErrorCode {
  if ((error instanceof KnowledgeOperationError || error instanceof AdapterError)
    && (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(error.code)) {
    return error.code as KnowledgeErrorCode;
  }
  return "AGENT_RUN_FAILED";
}

function assertByteLimit(value: string | undefined): void {
  if (value === undefined || Buffer.byteLength(value, "utf8") > MAX_OPERATION_BYTES) throwInvalidOperation();
}

function isSupportedKnowledgeOperation(operation: KnowledgeOperation): operation is SupportedKnowledgeOperation {
  switch (operation.kind) {
    case "knowledge.query":
    case "knowledge.register":
    case "knowledge.store":
    case "knowledge.store.preview-replace":
    case "knowledge.store.apply-replace":
    case "knowledge.share":
      return true;
    case "knowledge.organize":
    case "knowledge.collection.create":
    case "knowledge.collection.move":
    case "knowledge.place":
      return false;
  }
}

function throwInvalidOperation(): never {
  throw new KnowledgeOperationError("INVALID_OPERATION");
}
