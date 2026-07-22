export class AdapterError extends Error {
  constructor(
    readonly code:
      | "COMMAND_FAILED"
      | "COMPONENT_VERSION_MISMATCH"
      | "INVALID_STATE_FILE"
      | "INITIALIZATION_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterError";
  }
}
