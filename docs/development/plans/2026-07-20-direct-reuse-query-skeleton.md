# Direct-Reuse Query Skeleton Plan

- Status: In progress
- Date: 2026-07-20
- Decision: ADR 0003
- User outcome: an explicitly authorized local Markdown folder can be indexed by QMD and queried through
  the installed Codex CLI, producing a structured answer whose claims cite current QMD evidence.

## Scope

This is one walking path, not the complete V1 matrix:

```text
Local Folder -> QMD public SDK -> task-scoped Evidence MCP -> Codex exec -> cited answer
```

It establishes the composition root that later CLI, public MCP, lifecycle, and GUI surfaces will call.
It does not implement GitHub, Feishu, Codex History, other Agent adapters, Wiki mutation, Companion, a
generic workflow engine, or a replacement retrieval/compiler subsystem.

## Reuse Boundary

| Capability | Owner |
| --- | --- |
| Markdown scanning, current index, lexical retrieval, bounded document reads | QMD public SDK |
| Agent reasoning and native authentication | installed Codex CLI |
| Tool protocol | official MCP TypeScript SDK |
| Input/result validation | Zod plus openLifeWiki product schemas |
| Explicit root authorization, run binding, citations, error mapping | openLifeWiki thin composition |

The production source and tests must contain no `store.internal`, `documents_fts`, or direct QMD SQLite
access. The Agent receives only a run-scoped Evidence MCP registration and a scratch working directory;
it does not receive an Admin tool or a writable Source mount.

## Contracts

### Host configuration

One JSON file selects:

- one absolute authorized Local Folder root;
- one QMD database path under product state;
- one selected Agent profile (`codex` for this path);
- one generated collection name (`current-source` for this path).

Tests use an explicit temporary config path. No test reads the Owner's knowledge or credentials.

### Evidence tool

The run-scoped MCP server exposes only:

- `search_evidence(query, limit)`;
- `read_evidence(resourceId, fromLine, maxLines)`.

Search returns product resource IDs, QMD score/path metadata, current content Hash, and bounded excerpts.
Read resolves only IDs minted for the current run and authorized root.

### Query result

Codex receives a JSON output schema and must return:

- `answer` as structured claim blocks;
- every claim with at least one resource ID;
- an explicit insufficient-evidence block when no current evidence supports a claim.

openLifeWiki rejects unknown resource IDs, missing citations, current Hash mismatches, malformed output,
and Agent failure. It never falls back to returning raw QMD search output as the answer.

## Implementation Order

1. Add one product package with exact-pinned QMD, MCP SDK, and Zod dependencies.
2. Write a QMD adapter contract against a synthetic Markdown fixture using only the public SDK.
3. Add the run-scoped Evidence MCP server and prove its discovery contains two read-only tools.
4. Add a Codex native adapter using `codex exec --ephemeral --ignore-user-config --sandbox read-only`, a
   scratch directory, per-run MCP config overrides, and an output schema.
5. Compose the real query path and validate citations against the same open QMD store.
6. Expose one controlled CLI command for the journey; then add the public Visitor MCP facade.
7. Run the controlled journey three times and inspect redacted evidence.

## Negative and Failure Checks

- root must be absolute, real, explicitly configured, and not the whole home directory;
- symlink/path escape is rejected by product authorization before QMD configuration;
- evidence IDs from another run are rejected;
- `read_evidence` cannot read an arbitrary path;
- no Admin or public recursive Query tool is registered into Codex;
- no credential, prompt, source body, Agent response, or raw tool output is written to evidence/log files;
- Codex missing/auth failure, QMD failure, timeout, cancellation, and malformed result have distinct
  product errors and no fallback;
- Query creates no Source, Wiki, or config mutation after the index has been prepared.

## Verification

The slice is not complete until all are true:

1. package typecheck and unit/contract tests pass;
2. a static boundary test rejects QMD private API/table markers in production code;
3. controlled Local Folder -> QMD -> Codex journey passes three consecutive times;
4. every returned claim citation resolves to the current fixture bytes and Hash;
5. an unsupported/missing Agent blocks explicitly without QMD-only answer fallback;
6. root `pnpm verify` runs real package tests and reports no empty workspace match.

## Stop Condition

Stop this slice after the real controlled path and Visitor facade work. Do not start GUI, additional
Source/Agent adapters, Wiki mutation, or generic recovery until the slice diff receives Product,
Architecture, Reuse, and Code review with no Critical or Important findings.

## Rollback

The slice adds only a package, synthetic fixtures, and rebuildable local test indexes. Removing the package
and generated test state returns to the direct-reuse baseline; the experimental worktree is unaffected.
