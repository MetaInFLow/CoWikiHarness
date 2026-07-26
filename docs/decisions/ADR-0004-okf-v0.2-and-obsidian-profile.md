# ADR 0004: Adopt OKF v0.2 With An Obsidian Compatibility Profile

- Status: accepted for V1; implementation pending
- Date: 2026-07-26
- Requirement: [`requirements-v1.md`](../requirements/requirements-v1.md)
- Official specification: [Google Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

## Context

The Formal Wiki must remain understandable without openLifeWiki, portable between tools and directly useful in Obsidian. It also needs provenance, trust, lifecycle, stable identity and controlled navigation. A private schema or Obsidian-only syntax would create avoidable lock-in.

Google's OKF v0.2 defines a permissive knowledge bundle using UTF-8 Markdown and YAML frontmatter. It requires only `type`, supports provenance/trust/lifecycle fields, uses standard Markdown links, preserves extensibility and defines `index.md` for progressive disclosure. Obsidian can open the same directory as a Vault and expose YAML Properties, tags, aliases, links and backlinks without a required plugin.

## Decision

Formal Wiki conforms to OKF v0.2 and the openLifeWiki Obsidian Compatibility Profile below.

### 1. OKF v0.2 Base Contract

Every Concept is a UTF-8 `.md` file with parseable YAML frontmatter and a standard Markdown body.

```yaml
---
type: Concept
title: Progressive scanning
description: Bounded discovery of authorized Source hierarchy.
sources:
  - id: source-node-01
    resource: openlifewiki://source/local/node-01
    title: Authorized design note
generated:
  by: openlifewiki/codex
  at: 2026-07-26T10:00:00Z
verified:
  - by: human:owner
    at: 2026-07-26T10:30:00Z
status: stable
stale_after: 2026-10-26
tags:
  - domain/knowledge-management
aliases:
  - Progressive Scan
page_uid: 01J...
---
```

The contract follows the official specification:

- `type` is the only always-required OKF field and accepts unknown descriptive values;
- `title` and `description` are recommended display/navigation fields;
- `sources` entries use `resource` and may add stable `id`, `title`, `author`, `usage_count` and `last_modified`;
- `generated` records producer and meaningful content-change time;
- `verified` accepts one mapping or a list of verification events;
- `status` is `draft | stable | deprecated`, with absent status interpreted as stable by OKF consumers;
- `stale_after` is an absolute `YYYY-MM-DD` date;
- producers and round-tripping consumers preserve unknown frontmatter keys;
- standard absolute bundle-relative or relative Markdown links form the knowledge graph;
- broken links are reported as quality gaps and do not make an otherwise parseable OKF document unreadable.

### 2. Progressive Disclosure

Every Formal Wiki directory has an `index.md` that lists its direct Concepts and subdirectories with titles and short descriptions. Index bodies use standard Markdown links. Non-root `index.md` files carry no frontmatter. The root `index.md` may declare:

```yaml
---
okf_version: "0.2"
---
```

Generated indexes are part of each reviewed WikiProposal. They are navigation artifacts derived from approved Concepts and folder structure.

### 3. Obsidian Compatibility Profile

The Wiki root is a directly openable Obsidian Vault with no required community plugin.

| Concern | V1 profile |
| --- | --- |
| Properties | YAML frontmatter uses scalar, list and mapping values accepted by Obsidian; OKF fields retain their OKF meaning |
| Stable identity | `page_uid` is an openLifeWiki extension, remains unchanged across approved rename/move and is never derived from the path |
| Aliases | `aliases` is a YAML list of strings |
| Primary classification | one approved folder path per Concept |
| Cross-cutting classification | controlled `tags` list; hierarchical short names such as `domain/...`, `source/...`, `status/...` |
| Links | canonical persisted links use standard Markdown relative or bundle-relative paths; link text remains human-readable |
| Backlinks and graph | derive from approved Markdown links; orphan and broken-link reports are part of review/quality evidence |
| Display configuration | `.obsidian/` is optional, removable and may contain no unique knowledge, credentials or authorization |

Obsidian-specific wiki-link syntax may be imported, but canonical output uses standard Markdown links so other consumers retain full navigation.

### 4. Round-Trip And Migration

Import, compile, move and export must preserve:

- unknown frontmatter fields and unknown `type` values;
- `page_uid` for the same logical Concept;
- valid aliases, controlled tags and standard links;
- provenance and verification events;
- UTF-8 body content not intentionally changed by the reviewed proposal.

OKF v0.1 `timestamp` may be read as a fallback only when `generated` is absent. A legacy body `# Citations` list may be read as fallback when `sources` is absent. V1 output writes the v0.2 fields.

### 5. Compiler Boundary

The Selected Agent is the only component that generates WikiProposal semantics: Concepts, taxonomy, tags, aliases, links, provenance, freshness and known gaps. All six Agent drivers return the same proposal contract.

openLifeWiki installs [`llm-wiki-compiler`](https://github.com/atomicstrata/llm-wiki-compiler) `1.1.0` from its official Release and calls only its verified public CLI/SDK for the candidate review queue, incremental state and refresh support, citation/freshness/link/lint/eval checks and OKF v0.1 exchange. A provider-dependent compiler operation is allowed only when its runtime is demonstrably bound to the same Selected Agent. V1 configures no second compiler Provider or hidden Agent fallback.

openLifeWiki owns authorized Evidence selection, Selected Agent orchestration, proposal and base Wiki hashes, compare-and-swap approval, compatibility checks and GUI orchestration. Its minimal compatibility adapter upgrades the compiler's v0.1 exchange shape to v0.2 by mapping a legacy `timestamp` only when `generated` is absent, normalizing standard Markdown links, preserving unknown frontmatter and adding no invented verification. Its validator checks the v0.2 and Obsidian Profile rules in this ADR. This is the owned gap around the compiler's verified deterministic review and quality capabilities.

## Acceptance Consequences

- a conforming Concept with only `type` remains readable, though product quality checks may request recommended metadata;
- unknown frontmatter survives a no-op compile and an approved move;
- every approved directory has a navigable `index.md`;
- Obsidian opens the Wiki root and shows Properties, tags, aliases, links, backlinks and graph relationships without a plugin;
- optional `.obsidian/` deletion changes presentation only;
- proposal rejection or stale `baseWikiHash` leaves the entire Vault unchanged.

## Alternatives Rejected

### Obsidian-Only Vault Schema

This would reduce portability and make another application the format authority.

### Custom JSON Knowledge Store With Markdown Export

This would make the visible Wiki a derived view and introduce a second durable knowledge truth.

### Path As Concept Identity

Approved taxonomy changes move files. Stable `page_uid` keeps identity while paths remain human-owned classification.
