export const MCP_ROLES = ["visitor", "admin"] as const;

export type McpRole = (typeof MCP_ROLES)[number];

export interface McpPrincipal {
  readonly id: string;
  readonly role: McpRole;
}

export type McpToolName =
  | "query"
  | "status"
  | "connectors.list"
  | "connectors.authorize"
  | "scan.preview"
  | "scan.status"
  | "scan.progress"
  | "scan.start"
  | "scan.pause"
  | "scan.resume"
  | "scan.cancel"
  | "scan.retry"
  | "wiki-proposal.create"
  | "wiki-proposal.show"
  | "wiki-proposal.approve"
  | "wiki-proposal.reject"
  | "wiki-proposal.publish";
