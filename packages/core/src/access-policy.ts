import type { McpPrincipal, McpToolName } from "@openlifewiki/protocol";

const VISITOR_TOOLS = ["query"] as const satisfies readonly McpToolName[];

const ADMIN_TOOLS = [
  "query",
  "status",
  "connectors.list",
  "connectors.authorize",
  "scan.preview",
  "scan.status",
  "scan.progress",
  "scan.start",
  "scan.pause",
  "scan.resume",
  "scan.cancel",
  "scan.retry",
  "wiki-proposal.create",
  "wiki-proposal.show",
  "wiki-proposal.approve",
  "wiki-proposal.reject",
  "wiki-proposal.publish",
] as const satisfies readonly McpToolName[];

export function listMcpTools(principal: McpPrincipal): readonly McpToolName[] {
  return principal.role === "visitor" ? VISITOR_TOOLS : ADMIN_TOOLS;
}
