# ADR 0001: Product and Architecture

- Status: Accepted
- Date: 2026-07-18

## Decision

openLifeWiki is a standalone local-first product with a Knowledge Core and a Skillware Spine. The implementation is a modular monolith with Hexagonal Architecture. It owns identity, provenance, permissions, workflows, configuration, and product lifecycle while external algorithms and platform clients remain registered components.

## Consequences

- The native Markdown Wiki and identity ledger are durable product state.
- QMD, llm-wiki-compiler, platform CLIs, Agent CLIs, and GUI surfaces are replaceable adapters.
- Visitor and Admin are separate MCP surfaces.
- Durable Wiki writes require human approval of an immutable Candidate Hash.
- Connector Descriptors may exist without runtime Providers so planned catalog entries remain visible without fake behavior.

## Reference

See `docs/architecture/design.md`.
