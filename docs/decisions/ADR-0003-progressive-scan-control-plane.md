# ADR 0003: Own The Progressive Scan Control Plane

- Status: accepted for V1; implementation pending
- Date: 2026-07-26
- Requirement: [`requirements-v1.md`](../requirements/requirements-v1.md)
- Red lines: [`core-red-lines.md`](../product/core-red-lines.md)
- Supersedes: ADR 0002's whole-directory activation/indexing decision and ADR 0001's decision to expose only the upstream QMD MCP
- Preserves: official Release installation, public-interface invocation, runtime isolation and visible/hidden data separation from ADR 0001 and ADR 0002

## Context

The P0 path authorized one local glob, handed that directory to QMD and exposed QMD's existing MCP tools after an `ACTIVE` readiness gate. That path proves retrieval, but it cannot satisfy V1:

- four platforms have different identity, hierarchy, pagination and permission semantics;
- authorization of a root does not justify reading every leaf body;
- the Owner needs explainable layer decisions and truthful dynamic progress;
- pause, restart and incremental scan need product-owned checkpoints;
- Visitor and Admin need different capabilities;
- exact Wiki proposal approval cannot be enforced by a transparent QMD pass-through.

## Decision

openLifeWiki owns a local Progressive Scan control plane and exposes its policy-aware public MCP/API contracts. External components remain behind official releases and public interfaces.

### 1. Connector Descriptor And Provider

Every Source type has two boundaries:

```text
ConnectorDescriptor = stable declared capability and configuration schema
ConnectorProvider   = public-interface implementation for one configured Source
```

The descriptor includes connector type, display name, provider project, required executable, supported node kinds, identity probe, pagination model, version strategy, scope schema and body-read capability. It contains no credential.

The provider must implement:

```text
probe() -> ConnectorStatus
enumerate(scope, parentNodeId, cursor?) -> SkeletonPage
sampleMetadata(scope, nodeId, budget) -> bounded metadata sample
readLeaf(scope, nodeId, expectedVersion) -> current body stream
```

`probe`, `enumerate` and `sampleMetadata` return metadata only. `sampleMetadata` may select titles, types, timestamps, sizes and platform descriptions; it cannot return leaf body text. `readLeaf` requires recorded authorization, budget and a persisted `descend` decision receipt for its path. Provider output is normalized to the product contracts; Source bodies are streamed to QMD and never placed in a durable normalized mirror.

V1 providers are Local Folder, GitHub through `gh`, Feishu through `lark-cli`, and Codex History through the version-pinned Codex `app-server` v2 JSON-RPC surface. Codex discovery uses `thread/list` with exact approved `cwd` filters, cursor pagination and `useStateDbOnly: true`; the adapter retains only thread ID, cwd fingerprint, source kind, timestamps and status, and discards preview, name and turns. Skeleton titles use a redacted thread ID. An approved thread leaf is read with `thread/read`. Every supported Codex release must pass a generated-schema contract test for those methods and fields. Missing or changed methods fail closed, and openLifeWiki never reads `~/.codex` session or state files directly. Feishu permission diagnosis checks configured profile, redacted identity and effective scope first.

### 2. Skeleton-First Control

The first discovery operation enumerates only direct children of the approved root. Each skeleton node carries stable identity and metadata sufficient to decide whether deeper discovery is useful. Visiting a non-leaf follows:

```text
enumerate direct children
-> create disposable Layer Summary
-> hash exact decision inputs
-> Selected Agent decides descend | skip | defer | ask-user
-> persist decision/coverage metadata
-> descend only within approved scope and budget
```

The durable record contains node metadata, `summaryHash`, `inputSetHash`, actor, decision, reason, coverage and cost observations. The Layer Summary text stays in scan scratch and is removed after the operation or crash cleanup. Its pre-decision input contains metadata only; selected leaf bodies become readable after the persisted `descend` receipt authorizes their path.

### 3. QMD As Current-Source Retrieval

QMD remains the only V1 Source-body retrieval/index component. openLifeWiki calls QMD through documented CLI/MCP surfaces and does not access its private database or duplicate retrieval algorithms.

The control plane commits only selected current leaf versions to an isolated current-source collection. Each committed generation is built completely from the current selected bodies in a temporary QMD runtime through public CLI calls. After public query/get probes pass, openLifeWiki atomically switches the active generation and deletes the entire prior derived-index directory. A partial in-place update cannot prove physical removal of historical bodies and is insufficient for this contract. At rest, a Source body may exist in its original Source and the one active QMD current index only. QMD receipts are mapped back to scan checkpoints, while QMD internals remain opaque; openLifeWiki never reads or modifies QMD private SQLite files or tables.

### 4. Product-Owned Public Surface

V1 exposes openLifeWiki's policy-aware MCP/API rather than transparently exposing only QMD's upstream MCP. The control plane may delegate retrieval calls to QMD, but its public contracts enforce Source scope, visibility, progress, proposal approval and role policy.

The Visitor MCP registers exactly one tool: `query`. Evidence retrieval, citation resolution and current-generation checks run inside that query pipeline and do not appear as separate Visitor tools. Admin MCP and the Owner GUI add Connector management, scan control, proposal creation and lifecycle operations. Admin write commands still require a matching preview/plan hash; durable Formal Wiki writes additionally require exact proposal approval.

No role can call an unrestricted provider or QMD escape hatch.

### 5. Approval-Bound Wiki Writes

A WikiProposal is an immutable candidate with:

```text
proposalHash = hash(canonical proposal manifest + diffs + evidence set)
baseWikiHash = hash(canonical current Formal Wiki manifest)
```

Review, approval actor and approval time bind to `proposalHash`. Write execution recomputes both hashes and uses compare-and-swap. A changed candidate or Wiki fails closed and requires renewed review. Reject and failed CAS leave Formal Wiki byte-identical.

### 6. Host Configuration And Agent Invocation

Host config is the only truth for Selected Agent invocation. It stores capability and credential references, never credential values. Knowledge-space files, including `WIKI.md`, can narrow scanning instructions but cannot grant access or configure secrets. Missing or failing providers surface their actual error; silent fallback is forbidden.

## State And Receipt Consequences

- `ACTIVE` continues to mean the runtime can serve an authorized retrieval path; it is not V1 completion.
- Scan receipts bind to `scanPlanHash`, `skeletonVersion`, node version/hash and QMD commit receipt.
- Open pagination or unknown child counts remain explicit coverage gaps.
- Recovery resumes from immutable logical checkpoints and repeats only invalidated discovery, summary, decision or commit work. A deleted failed QMD generation may rematerialize unchanged selected bodies after current version/hash validation; receipts count this physical I/O separately and never grant duplicate logical completion.
- Cancel stops future work and preserves completed current commits; it cannot convert incomplete coverage to success.

## Alternatives Rejected

### Keep Whole-Directory QMD Indexing

This reads too much, cannot explain selection and produces false progress when platform hierarchy is incomplete.

### Build A Persistent Normalized Source Store

This creates a second Source corpus, expands deletion and credential risk, and violates minimum-storage requirements.

### Let Every Agent Implement Its Own Scanner

This fragments authorization, progress and recovery semantics across six runtimes. The canonical Skill and control-plane contracts must be shared.

### Let Admin Write Wiki Directly

Role possession cannot prove the Owner reviewed the exact candidate. Proposal hash plus base Wiki compare-and-swap remains mandatory.

## Consequences

- openLifeWiki must own connector, scan, progress, checkpoint, policy-aware MCP and approval schemas.
- QMD remains replaceable behind current-source contract tests.
- Connector provider tests must prove metadata-only enumeration and zero unapproved body reads.
- The P0 direct upstream MCP launcher remains a current implemented capability until the V1 control plane replaces it; it cannot be represented as the V1 architecture.
- ADR 0001 and ADR 0002 remain authoritative for official releases, public interfaces, runtime isolation and visible Wiki preservation only where this ADR does not supersede them.
