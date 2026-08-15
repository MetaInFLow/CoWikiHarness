# ADR 0005: Use A2A V1 As The Public Agent Protocol

- Status: accepted for V2
- Date: 2026-08-15
- Requirement: [`requirements-v2.md`](../requirements/requirements-v2.md)
- Design: [`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## Context

External agents need one stable way to ask the cloud Knowledge Agent to query,
register, store and organize knowledge. The interaction includes natural-language
messages, structured results, streaming progress, cancellation and durable
`input-required` pauses. V1 MCP is a local tool surface and would make each caller
orchestrate knowledge operations itself.

## Decision

V2 exposes A2A v1 JSON-RPC over HTTPS with SSE streaming through `@a2a-js/sdk`
`1.0.1`. The Agent Card advertises four skills: `knowledge.query`,
`knowledge.register`, `knowledge.store` and `knowledge.organize`.

The public unit is an agent task. Authenticated requests are persisted before work,
state transitions map to A2A task states, and the final Artifact contains a versioned
openLifeWiki result contract. Natural-language and structured operation parts enter the
same typed application operations.

MCP is absent from the V2 cloud P0 surface. The existing V1 local MCP path remains
available only as compatibility behavior.

## Consequences

- callers communicate with one Knowledge Agent and never invoke Connectors directly;
- task progress, cancellation and human/local-input pauses have protocol-level states;
- domain and authorization behavior stays below the A2A transport boundary;
- future client implementations can change without changing knowledge contracts;
- A2A protocol conformance and information-leakage tests are release gates.

## Alternatives Rejected

### Public MCP

MCP exposes tools to a caller-controlled agent loop. V2 requires the cloud Knowledge
Agent to own the loop and be the single semantic entry.

### Private HTTP Endpoints

Custom endpoints would recreate task, streaming and agent-discovery contracts already
provided by A2A.

### ACP

ACP is useful for editor-to-coding-agent sessions. It does not match the required
service-to-agent task and artifact boundary as directly as A2A.
