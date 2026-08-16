import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentSkill,
} from "@a2a-js/sdk";

export function buildKnowledgeAgentCard(publicUrl: string): AgentCard {
  const securityRequirements = [{ schemes: { Bearer: { list: [] } } }];
  return {
    name: "CoWikiHarness Knowledge Agent",
    description: "Central authorized knowledge registry and retrieval agent.",
    supportedInterfaces: [{
      url: publicUrl,
      protocolBinding: "JSONRPC",
      // Single-tenant A2A interface. Principal + organization authorization is the tenancy boundary.
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: { organization: "CoWikiHarness", url: publicUrl },
    version: "0.1.0-dev.1",
    documentationUrl: "",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      Bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "CoWikiHarness opaque bearer token",
            scheme: "bearer",
            bearerFormat: "opaque",
          },
        },
      },
    },
    securityRequirements,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      skill("knowledge.query", "Query knowledge", "Return authorized grounded answers with citations."),
      skill("knowledge.register", "Register knowledge", "Register authorized external knowledge locations."),
      skill("knowledge.store-draft", "Store managed draft", "Create private managed Markdown knowledge."),
      skill("knowledge.store-replace", "Replace managed knowledge", "Preview, then apply an explicitly confirmed replacement."),
      skill("knowledge.share", "Share knowledge", "Grant explicit knowledge access to another principal."),
    ],
    signatures: [],
  };
}

function skill(id: string, name: string, description: string): AgentSkill {
  return {
    id,
    name,
    description,
    tags: ["knowledge"],
    examples: [],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["text/plain", "application/json"],
    securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
  };
}
