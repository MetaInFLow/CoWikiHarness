import { describe, expect, it } from "vitest";

import {
  AGENT_DESCRIPTORS,
  CONNECTOR_DESCRIPTORS,
  listMcpTools,
  resolveSelectedAgent,
  validateHostConfig,
} from "../src/index.js";

describe("V1 registries", () => {
  it("registers only the four V1 connector types and exposes rollout status", () => {
    expect(CONNECTOR_DESCRIPTORS.map(({ connectorType }) => connectorType)).toEqual([
      "local-folder",
      "github",
      "feishu",
      "codex-history",
    ]);
    expect(CONNECTOR_DESCRIPTORS.map(({ supportStatus }) => supportStatus)).toEqual([
      "supported",
      "supported",
      "supported",
      "supported",
    ]);
    expect(CONNECTOR_DESCRIPTORS.every(({ classification }) => classification.length > 0)).toBe(true);
  });

  it("registers the official six agents with exact execution mode, binary and project URL", () => {
    expect(AGENT_DESCRIPTORS.map(({ runtime, mode, binary, projectUrl }) => ({
      runtime,
      mode,
      binary,
      projectUrl,
    }))).toEqual([
      { runtime: "codex", mode: "native-cli", binary: "codex", projectUrl: "https://github.com/openai/codex" },
      { runtime: "claude", mode: "native-cli", binary: "claude", projectUrl: "https://github.com/anthropics/claude-code" },
      { runtime: "gemini", mode: "native-cli", binary: "gemini", projectUrl: "https://github.com/google-gemini/gemini-cli" },
      { runtime: "pi", mode: "provider-runtime", binary: "pi", projectUrl: "https://github.com/earendil-works/pi" },
      { runtime: "openclaw", mode: "provider-runtime", binary: "openclaw", projectUrl: "https://github.com/openclaw/openclaw" },
      { runtime: "hermes", mode: "provider-runtime", binary: "hermes", projectUrl: "https://github.com/NousResearch/hermes-agent" },
    ]);
  });
});

describe("Agent host rules", () => {
  it.each(["baseUrl", "credentialRef", "model", "apiToken"])(
    "rejects %s on native CLI configuration",
    (field) => {
      expect(() => validateHostConfig({
        schema: "openlifewiki.host-config/v1",
        agents: [{
          id: "native",
          runtime: "codex",
          mode: "native-cli",
          [field]: "forbidden",
        }],
      })).toThrow(/native-cli/i);
    },
  );

  it("requires a credential reference and model for provider runtimes", () => {
    expect(() => validateHostConfig({
      schema: "openlifewiki.host-config/v1",
      agents: [{
        id: "hosted",
        runtime: "openclaw",
        mode: "provider-runtime",
        provider: { credentialRef: "keychain://provider" },
      }],
    })).toThrow(/model/i);
  });

  it("rejects inline provider credentials at any nesting level", () => {
    expect(() => validateHostConfig({
      schema: "openlifewiki.host-config/v1",
      agents: [{
        id: "hosted",
        runtime: "hermes",
        mode: "provider-runtime",
        provider: {
          credentialRef: "keychain://provider",
          model: "approved-model",
          transport: { accessToken: "inline-secret" },
        },
      }],
    })).toThrow(/credential/i);
  });

  it("accepts provider references and returns the exact selected agent", () => {
    const config = validateHostConfig({
      schema: "openlifewiki.host-config/v1",
      agents: [
        { id: "native", runtime: "codex", mode: "native-cli" },
        {
          id: "hosted",
          runtime: "pi",
          mode: "provider-runtime",
          provider: {
            baseUrl: "https://provider.example/v1",
            credentialRef: "keychain://provider",
            model: "approved-model",
          },
        },
      ],
    });

    expect(resolveSelectedAgent(config, "hosted")).toMatchObject({ id: "hosted", runtime: "pi" });
    expect(() => resolveSelectedAgent(config, "missing")).toThrow(/selected agent.*missing/i);
  });
});

describe("MCP role surface", () => {
  it("gives Visitor exactly the query tool", () => {
    expect(listMcpTools({ id: "visitor-session", role: "visitor" })).toEqual(["query"]);
  });

  it("gives Admin query and management tools", () => {
    const tools = listMcpTools({ id: "admin-session", role: "admin" });

    expect(tools[0]).toBe("query");
    expect(tools).toContain("scan.start");
    expect(tools).toContain("wiki-proposal.approve");
    expect(tools.length).toBeGreaterThan(1);
  });
});
