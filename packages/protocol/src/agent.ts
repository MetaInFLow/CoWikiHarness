export const AGENT_RUNTIMES = [
  "codex",
  "claude",
  "gemini",
  "pi",
  "openclaw",
  "hermes",
] as const;

export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
export type NativeAgentRuntime = "codex" | "claude" | "gemini";
export type ProviderAgentRuntime = "pi" | "openclaw" | "hermes";
export type AgentExecutionMode = "native-cli" | "provider-runtime";

export interface AgentDescriptor {
  readonly runtime: AgentRuntime;
  readonly displayName: string;
  readonly mode: AgentExecutionMode;
  readonly binary: string;
  readonly projectUrl: string;
}

export interface NativeAgentHostConfig {
  readonly id: string;
  readonly runtime: NativeAgentRuntime;
  readonly mode: "native-cli";
  readonly baseUrl?: never;
  readonly credentialRef?: never;
  readonly model?: never;
}

export interface ProviderRuntimeHostConfig {
  readonly id: string;
  readonly runtime: ProviderAgentRuntime;
  readonly mode: "provider-runtime";
  readonly provider: {
    readonly baseUrl?: string;
    readonly credentialRef: string;
    readonly model: string;
  };
}

export type AgentHostConfig = NativeAgentHostConfig | ProviderRuntimeHostConfig;

export interface HostConfigV1 {
  readonly schema: "openlifewiki.host-config/v1";
  readonly agents: readonly AgentHostConfig[];
}

export interface SelectedAgent {
  readonly id: string;
  readonly runtime: AgentRuntime;
  readonly mode: AgentExecutionMode;
}
