import { createHash } from "node:crypto";

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
  KnowledgeOrganizationOperations,
  PostgresAgentSession,
  type AgentMessageOperation,
  type KnowledgeAgentContext,
  type KnowledgeOperations,
} from "@openlifewiki/knowledge-agent";
import {
  KNOWLEDGE_ERROR_CODES,
  knowledgeAgentResultSchema,
  knowledgeCollectionResultSchema,
  knowledgeItemSchema,
  knowledgeLocationSchema,
  knowledgeRegistrationResultSchema,
  knowledgePlacementResultSchema,
  knowledgeVersionSchema,
  managedKnowledgeResultSchema,
  type AccessContext,
  type KnowledgeAgentResult,
  type KnowledgeCollection,
  type KnowledgeCollectionPlacement,
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

export type ExecutableStructuredKnowledgeOperation =
  | Extract<KnowledgeOperation, { kind: "knowledge.register" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.store" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.store.preview-replace" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.store.apply-replace" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.share" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.collection.create" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.collection.move" }>
  | Extract<KnowledgeOperation, { kind: "knowledge.place" }>;

interface KnowledgeHierarchyReadPort {
  getCollection(orgId: string, collectionId: string): Promise<KnowledgeCollection | null>;
  getPlacement(orgId: string, itemId: string): Promise<KnowledgeCollectionPlacement | null>;
}

export class KnowledgeServerTaskRunner {
  private readonly runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });

  constructor(
    private readonly store: PostgresKnowledgeStore,
    private readonly operations: KnowledgeOperations,
    private readonly organizationOperations: KnowledgeOrganizationOperations,
    private readonly hierarchyReadPort: KnowledgeHierarchyReadPort,
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
    readonly operation: ExecutableStructuredKnowledgeOperation;
    readonly signal: AbortSignal;
    readonly onWorking?: (task: StoredAgentTask) => void | Promise<void>;
  }): Promise<KnowledgeServerTaskRunOutcome> {
    assertTaskAccess(input.task, input.access);
    if (input.signal.aborted) throwCancellation(input.signal);
    const working = await this.markWorking(input);
    const approvalTaskId = input.operation.kind === "knowledge.store.apply-replace"
      ? await this.resolvePreviewTaskId(input.access, input.operation)
      : undefined;
    const result = await executeOperation(
      this.operations,
      this.organizationOperations,
      input.access,
      input.operation,
      approvalTaskId,
    );
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
        const recovered = await this.recoverStructuredResult(task);
        if (recovered !== null) {
          await this.store.completeTask({ taskId: task.taskId, expectedRevision: task.revision, output: recovered });
          continue;
        }
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

  private async resolvePreviewTaskId(
    access: AccessContext,
    operation: Extract<KnowledgeOperation, { kind: "knowledge.store.apply-replace" }>,
  ): Promise<string | undefined> {
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
    return result.rows[0]?.task_id;
  }

  private async recoverStructuredResult(task: StoredAgentTask): Promise<KnowledgeAgentResult | null> {
    if (task.state !== "working") return null;
    const action = recoveryAction(task.input);
    if (action === null) return null;
    const audit = await this.database.query<{ target_id: string }>(
      `select target_id from audit_events
       where org_id = $1 and task_id = $2 and action = $3 and decision = 'completed'
       order by created_at desc limit 1`,
      [task.orgId, task.taskId, action],
    );
    const targetId = audit.rows[0]?.target_id;
    if (targetId === undefined) return null;
    if (task.input.kind === "knowledge.store" || task.input.kind === "knowledge.store.apply-replace") {
      return await this.loadManagedRecoveryResult(task, targetId);
    }
    if (task.input.kind === "knowledge.collection.create"
      || task.input.kind === "knowledge.collection.move") {
      const collection = await this.hierarchyReadPort.getCollection(task.orgId, targetId);
      if (collection === null) return null;
      return knowledgeCollectionResultSchema.parse({
        schema: "cowikiharness.collection-result/v1",
        taskId: task.taskId,
        collection,
      });
    }
    if (task.input.kind === "knowledge.place") {
      const placement = await this.hierarchyReadPort.getPlacement(task.orgId, targetId);
      if (placement === null) return null;
      return knowledgePlacementResultSchema.parse({
        schema: "cowikiharness.placement-result/v1",
        taskId: task.taskId,
        placement,
      });
    }
    return await this.loadRegistrationRecoveryResult(task, targetId);
  }

  private async loadRegistrationRecoveryResult(
    task: StoredAgentTask,
    itemId: string,
  ): Promise<KnowledgeAgentResult | null> {
    const item = await this.loadItem(task.orgId, itemId);
    if (item === null) return null;
    const locations = await this.loadLocations(task.orgId, itemId);
    return knowledgeRegistrationResultSchema.parse({
      schema: "openlifewiki.knowledge-registration-result/v1",
      taskId: task.taskId,
      item,
      locations,
    });
  }

  private async loadManagedRecoveryResult(
    task: StoredAgentTask,
    itemId: string,
  ): Promise<KnowledgeAgentResult | null> {
    const item = await this.loadItem(task.orgId, itemId);
    if (item?.currentVersionId === null || item === null) return null;
    const versionRows = await this.database.query<Record<string, unknown>>(
      "select * from knowledge_versions where org_id = $1 and item_id = $2 and version_id = $3",
      [task.orgId, itemId, item.currentVersionId],
    );
    const version = mapVersion(versionRows.rows[0]);
    if (version === null) return null;
    const locations = await this.loadLocations(task.orgId, itemId);
    const location = locations.find(({ locationId }) => locationId === version.locationId);
    if (location === undefined) return null;
    const input = task.input;
    if ((input.kind !== "knowledge.store" && input.kind !== "knowledge.store.apply-replace")
      || item.title !== input.content.title
      || version.bodyHash !== bodyHash(input.content.bodyMarkdown)
      || (input.kind === "knowledge.store.apply-replace" && item.revision !== input.expectedRevision + 1)) {
      return null;
    }
    return managedKnowledgeResultSchema.parse({
      schema: "openlifewiki.managed-knowledge-result/v1",
      taskId: task.taskId,
      item,
      location,
      version,
    });
  }

  private async loadItem(orgId: string, itemId: string) {
    const rows = await this.database.query<Record<string, unknown>>(
      "select * from knowledge_items where org_id = $1 and item_id = $2",
      [orgId, itemId],
    );
    return mapItem(rows.rows[0]);
  }

  private async loadLocations(orgId: string, itemId: string) {
    const rows = await this.database.query<Record<string, unknown>>(
      "select * from knowledge_locations where org_id = $1 and item_id = $2 order by location_id",
      [orgId, itemId],
    );
    return rows.rows.map(mapLocation);
  }
}

async function executeOperation(
  operations: KnowledgeOperations,
  organizationOperations: KnowledgeOrganizationOperations,
  context: AccessContext,
  operation: ExecutableStructuredKnowledgeOperation,
  approvalTaskId?: string,
): Promise<KnowledgeAgentResult> {
  switch (operation.kind) {
    case "knowledge.register": return await operations.register(context, operation);
    case "knowledge.store": return await operations.storeManaged(context, operation);
    case "knowledge.store.preview-replace": return await operations.previewManagedReplacement(context, operation);
    case "knowledge.store.apply-replace": return await operations.applyManagedReplacement(
      context,
      operation,
      approvalTaskId,
    );
    case "knowledge.share": return await operations.share(context, operation);
    case "knowledge.collection.create": return await organizationOperations.createCollection(context, operation);
    case "knowledge.collection.move": return await organizationOperations.moveCollection(context, operation);
    case "knowledge.place": return await organizationOperations.placeKnowledge(context, operation);
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

function recoveryAction(operation: KnowledgeOperation): string | null {
  switch (operation.kind) {
    case "knowledge.register": return "knowledge.register";
    case "knowledge.store": return "knowledge.store";
    case "knowledge.store.apply-replace": return "knowledge.store.replace";
    case "knowledge.share": return "knowledge.share";
    case "knowledge.collection.create": return "knowledge.collection.create";
    case "knowledge.collection.move": return "knowledge.collection.move";
    case "knowledge.place": return "knowledge.place";
    default: return null;
  }
}

function mapItem(row: Record<string, unknown> | undefined) {
  if (row === undefined) return null;
  return knowledgeItemSchema.parse({
    schema: "openlifewiki.knowledge-item/v1",
    itemId: row.item_id,
    orgId: row.org_id,
    ownerPrincipalId: row.owner_principal_id,
    title: row.title,
    aliases: row.aliases,
    status: row.status,
    currentVersionId: row.current_version_id,
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapLocation(row: Record<string, unknown>) {
  return knowledgeLocationSchema.parse({
    schema: "openlifewiki.knowledge-location/v1",
    locationId: row.location_id,
    itemId: row.item_id,
    kind: row.location_kind,
    role: row.location_role,
    locator: row.locator,
    connectorInstanceId: row.connector_instance_id,
    ownerPrincipalId: row.owner_principal_id,
    metadata: row.metadata,
    observedProviderVersion: row.observed_provider_version,
    availability: row.availability,
    revision: Number(row.revision),
    lastVerifiedAt: row.last_verified_at === null ? null : timestamp(row.last_verified_at),
  });
}

function mapVersion(row: Record<string, unknown> | undefined) {
  if (row === undefined) return null;
  return knowledgeVersionSchema.parse({
    schema: "openlifewiki.knowledge-version/v1",
    versionId: row.version_id,
    itemId: row.item_id,
    locationId: row.location_id,
    ordinal: Number(row.ordinal),
    bodyHash: row.body_hash,
    bodyMarkdown: row.body_markdown,
    providerVersion: row.provider_version,
    provenance: row.provenance,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: timestamp(row.created_at),
  });
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function bodyHash(bodyMarkdown: string): string {
  return `sha256:${createHash("sha256").update(bodyMarkdown).digest("hex")}`;
}
