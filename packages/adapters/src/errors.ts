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
      | "INVALID_STATE_FILE"
      | "INITIALIZATION_FAILED",
    message: string,
    options?: ErrorOptions & { readonly publicDetails?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.publicDetails = options?.publicDetails;
  }
}
