export class AdapterError extends Error {
  readonly publicDetails: Readonly<Record<string, unknown>> | undefined;

  constructor(
    readonly code:
      | "COMMAND_FAILED"
      | "COMPONENT_VERSION_MISMATCH"
      | "ACTIVATION_FAILED"
      | "INITIALIZATION_REQUIRED"
      | "MCP_NOT_READY"
      | "CONFIG_CONFLICT"
      | "CONFIG_INVALID"
      | "CONFIG_MIGRATION_REJECTED"
      | "CONFIG_MIGRATION_REQUIRED"
      | "PLAN_CHANGED"
      | "SOURCE_AUTHORIZATION_INVALID"
      | "SOURCE_PROBE_BLOCKED"
      | "SCAN_CONFLICT"
      | "SCAN_INVALID"
      | "SCAN_SCRATCH_INVALID"
      | "QMD_GENERATION_CONFLICT"
      | "QMD_GENERATION_FAILED"
      | "QMD_GENERATION_INVALID"
      | "QMD_GENERATION_RECOVERY_REQUIRED"
      | "INVALID_STATE_FILE"
      | "INITIALIZATION_FAILED"
      | "AUTHENTICATION_REQUIRED"
      | "DELEGATION_DENIED"
      | "SOURCE_AUTHORIZATION_REQUIRED"
      | "LOCAL_SOURCE_OFFLINE"
      | "REVISION_CONFLICT"
      | "APPROVAL_REQUIRED"
      | "BODY_TOO_LARGE"
      | "CONNECTOR_UNAVAILABLE"
      | "AGENT_RUN_FAILED"
      | "TASK_INTERRUPTED"
      | "KNOWLEDGE_NOT_FOUND"
      | "KNOWLEDGE_CONFLICT"
      | "INVALID_OPERATION",
    message: string,
    options?: ErrorOptions & { readonly publicDetails?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.publicDetails = options?.publicDetails;
  }
}
