export type ComponentKind =
  | "retriever"
  | "wiki-utility"
  | "protocol"
  | "connector-client"
  | "agent-core"
  | "surface";

export type ComponentStatus = "declared" | "planned";

export interface ComponentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ComponentKind;
  readonly owner: "upstream";
  readonly integration: readonly ("cli" | "mcp" | "sdk" | "reference")[];
  readonly packageName?: string;
  readonly executable?: string;
  readonly pinnedVersion?: string;
  readonly strategy?: "native-cli" | "provider-runtime";
  readonly projectUrl: string;
  readonly license: string;
  readonly productUse: readonly string[];
  readonly excludedUse: readonly string[];
  readonly status: ComponentStatus;
}

export interface ConnectorDescriptor {
  readonly id: "local-folder" | "github" | "feishu" | "codex-history";
  readonly displayName: string;
  readonly provider: "built-in" | "gh" | "lark-cli" | "codex-host";
  readonly access: "read-only";
  readonly status: "planned";
}

const agentCoreDescriptors = [
  agent("openai-codex-cli", "OpenAI Codex CLI", "codex", "https://github.com/openai/codex", "Apache-2.0", "native-cli"),
  agent("anthropic-claude-code", "Claude Code", "claude", "https://github.com/anthropics/claude-code", "Anthropic Commercial Terms", "native-cli"),
  agent("google-gemini-cli", "Gemini CLI", "gemini", "https://github.com/google-gemini/gemini-cli", "Apache-2.0", "native-cli"),
  agent("pi", "Pi Agent Harness", "pi", "https://github.com/earendil-works/pi", "MIT", "provider-runtime"),
  agent("openclaw", "OpenClaw", "openclaw", "https://github.com/openclaw/openclaw", "MIT", "provider-runtime"),
  agent("hermes-agent", "Hermes Agent", "hermes", "https://github.com/NousResearch/hermes-agent", "MIT", "provider-runtime"),
] as const;

export const componentCatalog = [
  {
    id: "qmd",
    displayName: "QMD",
    kind: "retriever",
    owner: "upstream",
    integration: ["cli", "mcp", "sdk"],
    packageName: "@tobilu/qmd",
    executable: "qmd",
    pinnedVersion: "2.5.3",
    projectUrl: "https://github.com/tobi/qmd",
    license: "MIT",
    productUse: ["index.update", "knowledge.search", "document.read"],
    excludedUse: ["private SQLite schema", "copied retrieval algorithms"],
    status: "declared",
  },
  {
    id: "llm-wiki-compiler",
    displayName: "llm-wiki-compiler",
    kind: "wiki-utility",
    owner: "upstream",
    integration: ["cli", "sdk"],
    packageName: "llm-wiki-compiler",
    executable: "llmwiki",
    pinnedVersion: "1.1.0",
    projectUrl: "https://github.com/atomicstrata/llm-wiki-compiler",
    license: "MIT",
    productUse: ["status", "lint", "viewer", "context", "OKF export"],
    excludedUse: ["provider compile", "provider search/query", "Candidate approval", "typed writer"],
    status: "declared",
  },
  {
    id: "mcp-typescript-sdk",
    displayName: "Model Context Protocol TypeScript SDK",
    kind: "protocol",
    owner: "upstream",
    integration: ["sdk"],
    packageName: "@modelcontextprotocol/sdk",
    pinnedVersion: "1.29.0",
    projectUrl: "https://github.com/modelcontextprotocol/typescript-sdk",
    license: "MIT",
    productUse: ["Visitor MCP", "Admin MCP", "task-scoped Agent tools"],
    excludedUse: ["custom MCP transport"],
    status: "declared",
  },
  {
    id: "github-cli",
    displayName: "GitHub CLI",
    kind: "connector-client",
    owner: "upstream",
    integration: ["cli"],
    executable: "gh",
    projectUrl: "https://github.com/cli/cli",
    license: "MIT",
    productUse: ["GitHub authentication", "GitHub source reads"],
    excludedUse: ["custom GitHub login client"],
    status: "planned",
  },
  {
    id: "lark-cli",
    displayName: "Lark CLI",
    kind: "connector-client",
    owner: "upstream",
    integration: ["cli"],
    executable: "lark-cli",
    projectUrl: "https://github.com/larksuite/cli",
    license: "MIT",
    productUse: ["Feishu authentication", "Feishu source reads"],
    excludedUse: ["custom Feishu login client"],
    status: "planned",
  },
  ...agentCoreDescriptors,
  {
    id: "superpowers-visual-companion",
    displayName: "Superpowers Visual Companion",
    kind: "surface",
    owner: "upstream",
    integration: ["reference"],
    projectUrl: "https://github.com/obra/superpowers",
    license: "MIT",
    productUse: ["session pattern", "typed screen/event bridge", "sandboxed Canvas pattern"],
    excludedUse: ["brainstorming workflow", "copied product logic"],
    status: "planned",
  },
] as const satisfies readonly ComponentDescriptor[];

function agent(
  id: string,
  displayName: string,
  executable: string,
  projectUrl: string,
  license: string,
  strategy: "native-cli" | "provider-runtime",
): ComponentDescriptor {
  return {
    id,
    displayName,
    kind: "agent-core",
    owner: "upstream",
    integration: ["cli"],
    executable,
    projectUrl,
    license,
    strategy,
    productUse: ["upstream Agent loop", strategy],
    excludedUse: ["replacement Agent loop"],
    status: "planned",
  };
}

export const connectorCatalog = [
  {
    id: "local-folder",
    displayName: "Local Folder",
    provider: "built-in",
    access: "read-only",
    status: "planned",
  },
  {
    id: "github",
    displayName: "GitHub",
    provider: "gh",
    access: "read-only",
    status: "planned",
  },
  {
    id: "feishu",
    displayName: "Feishu",
    provider: "lark-cli",
    access: "read-only",
    status: "planned",
  },
  {
    id: "codex-history",
    displayName: "Codex History",
    provider: "codex-host",
    access: "read-only",
    status: "planned",
  },
] as const satisfies readonly ConnectorDescriptor[];

export const productOwnedBoundaries = [
  "identity-and-policy",
  "knowledge-kernel",
  "agent-dispatcher",
  "connector-contract",
  "evidence-proposal-approval-cas",
  "lossless-markdown",
  "companion-security",
  "skillware-lifecycle",
  "conformance-testkit",
] as const;
