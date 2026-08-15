# openLifeWiki Requirements V2

- Status: accepted for implementation
- Date: 2026-08-15
- Audience: product owner, implementation team and acceptance reviewers
- Scope: single-organization, multi-user cloud knowledge center
- Supersedes: V1 for cloud and multi-user work
- Preserves: the V1 local path as a compatibility path
- Design: [`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## Product Decision

openLifeWiki V2 is one cloud-hosted Knowledge Agent that provides the only product
entry for querying, registering, storing and organizing knowledge. People and their
delegated agents use it through A2A v1. PostgreSQL records the central knowledge
registry and managed Markdown; knowledge may remain in Feishu, GitHub or a person's
computer and be retrieved through an approved Connector when needed.

## Required Outcome

One organization registers a logical knowledge item once, records all known locations,
controls who and which delegated agents may use it, and retrieves exact authorized
versions with provenance and citations. The system remains truthful when a provider or
person-local source is unavailable.

## Actors

| Actor | Required authority |
| --- | --- |
| Organization Owner | bootstrap deployment, manage principals and grants, approve high-impact changes |
| Member | query, register and manage only knowledge covered by explicit grants |
| External Agent | act on behalf of one Member within an active bounded delegation |
| Knowledge Agent | expose the only query/register/store/organize product entry |
| Local Relay | advertise one user's device and retrieve exact approved local knowledge |

## Functional Requirements

### R-V2-01 One Agent Entry

The cloud service exposes A2A v1 over HTTPS with streaming task updates. Its Agent Card
advertises `knowledge.query`, `knowledge.register`, `knowledge.store` and
`knowledge.organize`. No public caller reaches a Connector, database or index directly.

### R-V2-02 Identity And Delegation

Every operation identifies the organization, calling agent, represented human,
delegation and task. Effective authority is the intersection of the human resource
grant, agent operation grant and active delegation bounds. Missing, expired or revoked
authority denies the operation without revealing hidden resource metadata.

### R-V2-03 Knowledge Registry

The registry separates stable logical items from locations and immutable versions. One
item may have multiple locations with explicit roles. It records owner, visibility,
tags, aliases, provenance, freshness, provider version and current availability.

### R-V2-04 Register Without Copy

Registration creates or links item and location metadata. Registration alone never
copies a Feishu, GitHub or person-local body. An existing locator is idempotent. A
possible duplicate logical item requires an explicit user choice before identity merge.

### R-V2-05 Managed Markdown

An authorized writer can store UTF-8 Markdown in PostgreSQL. Each immutable version has
a SHA-256 body hash and provenance. One version is limited to 1 MiB. Replacing current
content requires an exact preview and expected revision.

### R-V2-06 Query And Citation

Search filters permission in PostgreSQL before returning candidates. It supports exact
identity, locator, tag and alias matching plus PostgreSQL full-text and trigram search.
Every answer cites exact item, location and version identifiers. No evidence yields an
explicit no-evidence result.

### R-V2-07 External Locations

Feishu and GitHub reads reuse approved existing Connector contracts and exact Source
authorization. Credentials remain deployment secret references. Returned evidence is
bound to Source, node, provider version and authorization.

### R-V2-08 Person-Local Knowledge

A local Relay initiates outbound HTTPS, renews a short presence lease and handles only
task-bound requests for its owner and approved Source scope. Offline knowledge puts the
task in `input-required` with `LOCAL_SOURCE_OFFLINE`; a valid returning Relay can resume
the same durable task.

### R-V2-09 Knowledge Architecture

The Knowledge Architect Skill has `bootstrap` and `refactor` modes. Both produce an
immutable versioned proposal. Durable organization changes require human approval bound
to the exact proposal hash and base Registry revision, followed by one transactional
compare-and-swap apply.

### R-V2-10 Durable Tasks And Recovery

Task state is persisted before execution. Completion is reported only after the final
artifact and audit event commit atomically. Restart resumes supported sessions; a task
without valid resumable state fails explicitly with `TASK_INTERRUPTED`. Cancellation
settles in a terminal canceled state.

### R-V2-11 Audit

Every mutation and denied operation writes an append-only audit event containing actor,
action, target, decision and receipt metadata. Events contain no token, credential or
unredacted body.

### R-V2-12 V1 Compatibility

The source-checkout local path remains usable through P0. Cloud implementation cannot
silently replace or weaken its Source authorization, receipt, hashing, body-read,
proposal approval or fail-closed behavior.

## Operational Requirements

| ID | Requirement | Acceptance |
| --- | --- | --- |
| O-V2-01 | Minimal runtime | one Node.js service, PostgreSQL and optional Relay only |
| O-V2-02 | Required model | startup fails clearly when `OPENLIFEWIKI_MODEL` is absent |
| O-V2-03 | Concurrency | mutable writes use expected revision; task claims use PostgreSQL advisory locks |
| O-V2-04 | Backup | an isolated PostgreSQL restore preserves item/version citation identity |
| O-V2-05 | Security | bearer tokens are random 256-bit values shown once; only keyed digests are stored |
| O-V2-06 | Search | private rows are filtered before ranking or Agent context construction |
| O-V2-07 | Verification | schema, build, typecheck, unit, integration and A2A contract suites pass |

## P0 Component Boundary

P0 uses `@openai/agents`, `@a2a-js/sdk`, `pg`, PostgreSQL 17 and `pg_trgm` in the
existing TypeScript workspace. MCP, Codex SDK, Pi, Redis, a separate worker, object
storage, vector search, cloud QMD and a separate administration UI are out of scope.
Any addition requires an ADR backed by a measured trigger from the active V2 design.

## Acceptance Journeys

| ID | Journey and pass condition |
| --- | --- |
| V2-AC-01 | two users and two delegated agents authenticate independently |
| V2-AC-02 | private knowledge remains invisible to the other user and agent |
| V2-AC-03 | explicitly shared managed Markdown is queryable through A2A with resolvable citations |
| V2-AC-04 | managed Markdown, Feishu, GitHub and person-local locations register successfully |
| V2-AC-05 | registration copies no external or local body |
| V2-AC-06 | an offline local query pauses truthfully and resumes after Relay return |
| V2-AC-07 | bootstrap and refactor proposals require exact approval and current revision |
| V2-AC-08 | restart creates no false completion or duplicate durable write |
| V2-AC-09 | every mutation and denial has a redacted audit event |
| V2-AC-10 | the V1 local path remains usable |
| V2-AC-11 | all repository verification gates pass |
| V2-AC-12 | isolated PostgreSQL restore resolves the same item/version citation |

## Completion Standard

V2 P0 is complete only when `V2-AC-01` through `V2-AC-12` pass against one deployed
candidate, all declared error states are observable and no excluded component has been
introduced without an accepted trigger ADR.
