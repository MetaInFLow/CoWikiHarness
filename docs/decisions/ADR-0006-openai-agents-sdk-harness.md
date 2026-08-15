# ADR 0006: Use OpenAI Agents SDK As The P0 Harness

- Status: accepted for V2
- Date: 2026-08-15
- Requirement: [`requirements-v2.md`](../requirements/requirements-v2.md)
- Design: [`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## Context

The Knowledge Agent needs a model loop, typed tool calls, streaming, session
continuation, approval pauses and tracing. openLifeWiki must retain ownership of domain
authorization, durable task state and database writes.

## Decision

V2 P0 uses `@openai/agents` `0.16.0` as its only agent runtime. The deployed model is
required through `OPENLIFEWIKI_MODEL`. The SDK receives a small fixed tool set whose
implementations call typed openLifeWiki operations with a mandatory `AccessContext`.

No tool accepts SQL, arbitrary commands, unrestricted paths or raw Connector requests.
The SDK may decide which authorized tool to call; application services decide whether
the operation is permitted and perform every durable mutation.

## Consequences

- openLifeWiki avoids implementing its own repeated tool loop and stream handling;
- public A2A and knowledge contracts remain independent of the model provider;
- SDK continuation state is persisted with the product task where supported;
- startup fails when the model configuration is absent;
- tool-schema, prompt-injection and authorization tests are release gates.

## Alternatives Rejected

### Codex SDK

The TypeScript Codex SDK centers coding threads and does not provide direct application
function-tool callbacks. Using it here would require an additional MCP bridge or a
lower-level app-server dependency.

### Raw OpenAI Responses API

It supplies function calls, but openLifeWiki would need to implement the loop,
streaming, approval and continuation behavior itself.

### Pi Or Multiple Runtimes

A second runtime adds provider and behavior choices before there is a measured
requirement. It may be reconsidered only through the expansion trigger in the design.
