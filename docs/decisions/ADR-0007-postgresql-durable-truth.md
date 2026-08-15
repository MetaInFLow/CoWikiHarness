# ADR 0007: Use PostgreSQL As The V2 Durable Truth

- Status: accepted for V2
- Date: 2026-08-15
- Requirement: [`requirements-v2.md`](../requirements/requirements-v2.md)
- Design: [`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## Context

The cloud service has concurrent users, delegated agents, grants, immutable versions,
durable tasks, append-only audits and exact proposal approval. It needs transactions,
row-level concurrency controls, restart recovery and useful text retrieval in one
operable store.

## Decision

V2 targets PostgreSQL 17 and uses `pg` with ordered SQL migrations. PostgreSQL is the
only P0 durable application database. It stores the knowledge registry, managed
Markdown versions, permissions, delegations, sessions, tasks, proposals and audit.

The deployment enables `pg_trgm`. Search combines exact fields, PostgreSQL full-text
search and trigram similarity after permission filters. Mutable records use monotonic
revisions and compare-and-swap. Task claims use PostgreSQL advisory locks.

Managed Markdown is limited to 1 MiB per immutable version. Existing external and local
bodies remain at their origin unless a separate approved store operation creates a
managed version.

## Consequences

- one transaction can bind mutation, artifact and audit outcomes;
- no Redis, vector database, object store or ORM is required for P0;
- SQL migrations and rollback procedures become release artifacts;
- backup and isolated restore are acceptance requirements;
- body growth and retrieval quality are measured against expansion triggers.

## Alternatives Rejected

### SQLite

SQLite is suitable for the V1 local process, but central multi-user task claiming,
concurrent writes and cloud operation would add avoidable coordination constraints.

### Separate Vector Or Search Service

P0 retrieval can be tested using PostgreSQL text and trigram facilities. A separate
service requires evidence that the accepted retrieval benchmark cannot be met.

### Object Storage For Markdown

The initial bounded text corpus fits the transactional database. Object storage is
introduced only when measured size or backup behavior reaches the design trigger.
