import type {
  AgentHostConfig,
  HostConfigV1,
  NativeAgentRuntime,
  ProviderAgentRuntime,
} from "@openlifewiki/protocol";

const NATIVE_RUNTIMES = new Set<NativeAgentRuntime>(["codex", "claude", "gemini"]);
const PROVIDER_RUNTIMES = new Set<ProviderAgentRuntime>(["pi", "openclaw", "hermes"]);

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

function findNativeOnlyForbiddenField(value: Record<string, unknown>): string | null {
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    if (["baseurl", "credentialref", "model"].includes(normalized)) return key;
    if (/(token|apikey|secret|password|credential|authorization)/i.test(normalized)) return key;
    if (isRecord(child)) {
      const nested = findNativeOnlyForbiddenField(child);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function validateAgent(value: unknown): asserts value is AgentHostConfig {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    throw new Error("Agent config requires a non-empty id");
  }

  if (value.mode === "native-cli") {
    if (!isNonEmptyString(value.runtime) || !NATIVE_RUNTIMES.has(value.runtime as NativeAgentRuntime)) {
      throw new Error(`native-cli runtime is invalid for Agent ${value.id}`);
    }
    const forbidden = findNativeOnlyForbiddenField(value);
    if (forbidden !== null) {
      throw new Error(`native-cli Agent ${value.id} cannot configure ${forbidden}`);
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
  if (!isNonEmptyString(value.provider.credentialRef)) {
    throw new Error(`provider-runtime Agent ${value.id} requires credentialRef`);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value.provider.credentialRef)) {
    throw new Error(`provider-runtime Agent ${value.id} credentialRef must be a reference`);
  }
  if (!isNonEmptyString(value.provider.model)) {
    throw new Error(`provider-runtime Agent ${value.id} requires model`);
  }
  if (value.provider.baseUrl !== undefined && !isNonEmptyString(value.provider.baseUrl)) {
    throw new Error(`provider-runtime Agent ${value.id} baseUrl must be non-empty`);
  }
}

export function validateHostConfig(value: unknown): HostConfigV1 {
  if (!isRecord(value) || value.schema !== "openlifewiki.host-config/v1") {
    throw new Error("Host config schema must be openlifewiki.host-config/v1");
  }
  if (!Array.isArray(value.agents)) {
    throw new Error("Host config agents must be an array");
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

  return value as unknown as HostConfigV1;
}

export function resolveSelectedAgent(
  config: HostConfigV1,
  selectedAgentId: string,
): AgentHostConfig {
  const selected = config.agents.find(({ id }) => id === selectedAgentId);
  if (selected === undefined) {
    throw new Error(`Selected Agent ${selectedAgentId} is missing; fallback is forbidden`);
  }
  return selected;
}
