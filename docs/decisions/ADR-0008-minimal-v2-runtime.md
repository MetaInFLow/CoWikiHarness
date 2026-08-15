# ADR 0008: Keep The V2 P0 Runtime Minimal

- Status: accepted for V2
- Date: 2026-08-15
- Requirement: [`requirements-v2.md`](../requirements/requirements-v2.md)
- Design: [`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## Context

The product must prove a central knowledge registry and agent entry. Additional queues,
stores, runtimes and administration surfaces would multiply deployment and failure
modes before the core usage path is validated.

## Decision

The P0 runtime contains:

1. one Node.js openLifeWiki service owning HTTPS handling behind host TLS, A2A,
   authentication, Agents SDK execution, typed operations, Connector orchestration and
   in-process durable task execution;
2. one PostgreSQL instance;
3. an optional outbound `openlifewiki relay` process on a person's computer.

P0 excludes MCP on the cloud boundary, Codex SDK, Pi, Redis, a separate Worker, object
storage, a vector database, cloud QMD and a separate administration UI. The V1 local
path remains in the same repository and is not migrated as a prerequisite.

Each excluded component has a measurable trigger in the active design. Introducing one
requires a new ADR containing evidence, operating cost, rollback and exit path.

## Consequences

- the first useful cloud slice can run as one process and one database;
- task durability lives in PostgreSQL and execution initially stays in-process;
- host TLS, backups and secret injection remain deployment responsibilities;
- scaling decisions are deferred until workload or acceptance evidence requires them;
- implementation must preserve package boundaries without creating deployable services
  for every internal responsibility.

## Alternatives Rejected

### Queue And Worker From The Start

No measured workload currently requires process separation. PostgreSQL task state and
advisory locks provide the initial durability and claim boundary.

### Full Administration Web Application

CLI bootstrap/token flows and A2A approvals are sufficient to validate P0. A UI follows
only if Owner usability acceptance fails.

### Cloud QMD

QMD remains valuable in the V1 local path. V2 first validates PostgreSQL retrieval and
keeps cloud QMD behind a measured retrieval and operability trigger.
