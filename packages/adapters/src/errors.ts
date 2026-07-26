export class AdapterError extends Error {
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
      | "INVALID_STATE_FILE"
      | "INITIALIZATION_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterError";
  }
}
