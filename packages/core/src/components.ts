import {
  AGENT_IO_SCHEMA_MANIFEST,
  type ComponentRelease,
} from "@openlifewiki/protocol";

export const AGENT_IO_PROTOCOL_RELEASE = {
  id: "agent-io-protocol",
  displayName: "Agent I/O Protocol",
  firstRequiredStage: "activate",
  installOwner: "build",
  delivery: "library",
  packageName: "@openlifewiki/protocol",
  version: "0.1.0-dev.1",
  integrity: AGENT_IO_SCHEMA_MANIFEST.manifestHash,
  schemaManifestHash: AGENT_IO_SCHEMA_MANIFEST.manifestHash,
  sourceUrl: "https://github.com/MetaInFLow/openLifeWiki",
  publicInterfaces: ["sdk"],
} as const satisfies ComponentRelease;

export const QMD_RELEASE = {
  id: "qmd",
  displayName: "QMD",
  firstRequiredStage: "initialize",
  installOwner: "openlifewiki",
  delivery: "npm-release",
  packageName: "@tobilu/qmd",
  version: "2.5.3",
  integrity: "sha512-wUKc4pSPDbgs7mV7JYE8/Qj1pNXXatJFV8byTT/T3yLaoAXheFtWu0BgSWwoWGhRkMmxl5Qyitt66NHgbMyeBA==",
  executable: "qmd",
  sourceUrl: "https://github.com/tobi/qmd/releases/tag/v2.5.3",
  publicInterfaces: ["cli", "mcp"],
} as const satisfies ComponentRelease;

export const DEFERRED_COMPONENTS = [
  {
    id: "codex",
    displayName: "OpenAI Codex",
    firstRequiredStage: "activate",
    installOwner: "user",
    delivery: "native-cli",
    executable: "codex",
    sourceUrl: "https://github.com/openai/codex",
    publicInterfaces: ["cli", "mcp"],
  },
  {
    id: "github-cli",
    displayName: "GitHub CLI",
    firstRequiredStage: "optional-source",
    installOwner: "user",
    delivery: "native-cli",
    executable: "gh",
    sourceUrl: "https://github.com/cli/cli",
    publicInterfaces: ["cli"],
  },
  {
    id: "lark-cli",
    displayName: "Lark CLI",
    firstRequiredStage: "optional-source",
    installOwner: "user",
    delivery: "native-cli",
    executable: "lark-cli",
    sourceUrl: "https://github.com/larksuite/cli",
    publicInterfaces: ["cli"],
  },
  {
    id: "llm-wiki-compiler",
    displayName: "llm-wiki-compiler",
    firstRequiredStage: "wiki-management",
    installOwner: "openlifewiki",
    delivery: "npm-release",
    packageName: "llm-wiki-compiler",
    version: "1.1.0",
    executable: "llmwiki",
    sourceUrl: "https://github.com/atomicstrata/llm-wiki-compiler/releases/tag/v1.1.0",
    publicInterfaces: ["cli"],
  },
] as const satisfies readonly ComponentRelease[];

export const COMPONENT_RELEASES = [
  QMD_RELEASE,
  AGENT_IO_PROTOCOL_RELEASE,
  ...DEFERRED_COMPONENTS,
] as const;
