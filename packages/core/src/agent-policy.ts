import type {
  AgentHostConfig,
  HostConfigV1,
  NativeAgentRuntime,
  ProviderAgentRuntime,
} from "@openlifewiki/protocol";

const NATIVE_RUNTIMES = new Set<NativeAgentRuntime>(["codex", "claude", "gemini"]);
const PROVIDER_RUNTIMES = new Set<ProviderAgentRuntime>(["pi", "openclaw", "hermes"]);
const CREDENTIAL_REFERENCE_PROTOCOLS = new Set(["env:", "keychain:", "host:", "file:"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedFieldName(field: string): string {
  return field.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function findInlineCredentialField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const field = findInlineCredentialField(item);
      if (field !== null) return field;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    if (
      normalized !== "credentialref"
      && /(token|apikey|secret|password|credential|authorization)/i.test(normalized)
    ) {
      return key;
    }
    const nested = findInlineCredentialField(child);
    if (nested !== null) return nested;
  }

  return null;
}

function findUnexpectedField(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): string | null {
  return Object.keys(value).find((field) => !allowedFields.has(field)) ?? null;
}

function parseUrl(value: string, field: "baseUrl" | "credentialRef"): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`provider-runtime ${field} must be a valid URL`);
  }
}

function validateCredentialRef(value: string, agentId: string): void {
  const reference = parseUrl(value, "credentialRef");
  if (!CREDENTIAL_REFERENCE_PROTOCOLS.has(reference.protocol)) {
    throw new Error(`provider-runtime Agent ${agentId} credentialRef uses an unsafe scheme`);
  }
  if (
    reference.username.length > 0
    || reference.password.length > 0
    || reference.search.length > 0
    || reference.hash.length > 0
  ) {
    throw new Error(`provider-runtime Agent ${agentId} credentialRef cannot contain secrets`);
  }
  if (reference.hostname.length === 0 && ["", "/"].includes(reference.pathname)) {
    throw new Error(`provider-runtime Agent ${agentId} credentialRef must identify a reference`);
  }
}

function validateBaseUrl(value: string, agentId: string): void {
  const baseUrl = parseUrl(value, "baseUrl");
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error(`provider-runtime Agent ${agentId} baseUrl must use HTTP or HTTPS`);
  }
  if (baseUrl.username.length > 0 || baseUrl.password.length > 0) {
    throw new Error(`provider-runtime Agent ${agentId} baseUrl cannot contain userinfo`);
  }
  if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
    throw new Error(`provider-runtime Agent ${agentId} baseUrl cannot contain query or fragment`);
  }
}

function validateAgent(value: unknown): asserts value is AgentHostConfig {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    throw new Error("Agent config requires a non-empty id");
  }

  if (value.mode === "native-cli") {
    if (!isNonEmptyString(value.runtime) || !NATIVE_RUNTIMES.has(value.runtime as NativeAgentRuntime)) {
      throw new Error(`native-cli runtime is invalid for Agent ${value.id}`);
    }
    const unexpected = findUnexpectedField(value, new Set(["id", "runtime", "mode"]));
    if (unexpected !== null) {
      throw new Error(`native-cli Agent ${value.id} cannot configure field ${unexpected}`);
    }
    return;
  }

  if (value.mode !== "provider-runtime") {
    throw new Error(`Agent ${value.id} has an invalid execution mode`);
  }
  if (!isNonEmptyString(value.runtime) || !PROVIDER_RUNTIMES.has(value.runtime as ProviderAgentRuntime)) {
    throw new Error(`provider-runtime is invalid for Agent ${value.id}`);
  }
  if (!isRecord(value.provider)) {
    throw new Error(`provider-runtime Agent ${value.id} requires provider configuration`);
  }
  const inlineCredential = findInlineCredentialField(value);
  if (inlineCredential !== null) {
    throw new Error(`provider-runtime Agent ${value.id} contains inline credential field ${inlineCredential}`);
  }
  const unexpectedAgentField = findUnexpectedField(
    value,
    new Set(["id", "runtime", "mode", "provider"]),
  );
  if (unexpectedAgentField !== null) {
    throw new Error(`provider-runtime Agent ${value.id} cannot configure field ${unexpectedAgentField}`);
  }
  const unexpectedProviderField = findUnexpectedField(
    value.provider,
    new Set(["baseUrl", "credentialRef", "model"]),
  );
  if (unexpectedProviderField !== null) {
    throw new Error(`provider-runtime Agent ${value.id} provider cannot configure field ${unexpectedProviderField}`);
  }
  if (!isNonEmptyString(value.provider.credentialRef)) {
    throw new Error(`provider-runtime Agent ${value.id} requires credentialRef`);
  }
  validateCredentialRef(value.provider.credentialRef, value.id);
  if (!isNonEmptyString(value.provider.model)) {
    throw new Error(`provider-runtime Agent ${value.id} requires model`);
  }
  if (value.provider.baseUrl !== undefined && !isNonEmptyString(value.provider.baseUrl)) {
    throw new Error(`provider-runtime Agent ${value.id} baseUrl must be non-empty`);
  }
  if (value.provider.baseUrl !== undefined) validateBaseUrl(value.provider.baseUrl, value.id);
}

export function validateHostConfig(value: unknown): HostConfigV1 {
  if (!isRecord(value) || value.schema !== "openlifewiki.host-config/v1") {
    throw new Error("Host config schema must be openlifewiki.host-config/v1");
  }
  if (!Array.isArray(value.agents)) {
    throw new Error("Host config agents must be an array");
  }
  if (!isNonEmptyString(value.selectedAgentId)) {
    throw new Error("Host config requires selectedAgentId");
  }

  const ids = new Set<string>();
  for (const agent of value.agents) {
    validateAgent(agent);
    if (ids.has(agent.id)) throw new Error(`Duplicate Agent id ${agent.id}`);
    ids.add(agent.id);
  }

  const inlineCredential = findInlineCredentialField(value);
  if (inlineCredential !== null) {
    throw new Error(`Host config contains inline credential field ${inlineCredential}`);
  }
  if (!ids.has(value.selectedAgentId)) {
    throw new Error(`Selected Agent ${value.selectedAgentId} is missing; fallback is forbidden`);
  }

  return value as unknown as HostConfigV1;
}

export function resolveSelectedAgent(
  config: HostConfigV1,
): AgentHostConfig {
  const selected = config.agents.find(({ id }) => id === config.selectedAgentId);
  if (selected === undefined) {
    throw new Error(`Selected Agent ${config.selectedAgentId} is missing; fallback is forbidden`);
  }
  return selected;
}
