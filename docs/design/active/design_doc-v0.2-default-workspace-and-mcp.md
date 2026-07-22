# Design: Default Workspace And Local MCP v0.2

- Status: implemented, awaiting owner review
- Requirement: `docs/requirements/requirements-v0.1.md`
- Decisions: ADR 0001 and ADR 0002

## Goal

Deliver the shortest usable local chain from a project-owned default folder to a standard MCP, while reusing QMD's official Release and built-in MCP.

## Scope

- visible default workspace at `~/openLifeWiki/`;
- default Markdown Source at `~/openLifeWiki/sources/`;
- isolated QMD config and cache under the platform application-data root;
- approval-gated `activate` dry-run and execution;
- real QMD search gate before publishing `ACTIVE`;
- `openlifewiki mcp --stdio` launcher for QMD's upstream MCP;
- unit contracts and a real installation, retrieval and MCP handshake test;
- README and Install Skill usage path.

## Command Contract

```text
openlifewiki init --dry-run --json
openlifewiki init --yes --json
openlifewiki activate --dry-run --json
openlifewiki activate --yes --json
openlifewiki mcp --stdio
```

All management commands emit one JSON object. The MCP command emits only protocol messages on stdout.

## State Contract

```text
INSTALLED
  -- init succeeds --> INITIALIZED
  -- init fails ----> INSTALLED

INITIALIZED
  -- Source empty --> INITIALIZED
  -- activation or retrieval fails --> INITIALIZED
  -- real retrieval passes --> ACTIVE

ACTIVE
  -- MCP launch allowed
```

## Isolation Contract

Every QMD collection, update, search and MCP command receives:

- `QMD_CONFIG_DIR=<runtime>/data/qmd/config`;
- `XDG_CACHE_HOME=<runtime>/data/qmd/cache`;
- `cwd=<runtime>`.

Only `<workspace>/sources/**/*.md` enters the P0 collection. Symlinks and hidden entries are skipped by the activation preflight. QMD retains its own documented indexing behavior after authorization.

## Upstream Contract

- release: `@tobilu/qmd@2.5.3`;
- install: official npm artifact with pinned integrity;
- management: `qmd collection list/add`, `qmd update`, `qmd search --json`;
- serving: `qmd mcp` over stdio;
- expected MCP tools: `query`, `get`, `multi_get`, `status`.

The initial user path calls `query` with a `lex` sub-query and `rerank: false`; this provides a fast MCP search without the optional QMD model downloads. Semantic and reranked queries remain available and download their model assets into the isolated cache on first use.

No QMD source, database access or MCP proxy belongs in openLifeWiki.

## Validation

- unit tests cover layout defaults, overrides, dry-runs, empty Source, activation, state publication and MCP launch isolation;
- component test installs the real QMD Release in a temporary root;
- component test indexes a real Markdown fixture and verifies a resolvable search result;
- component test completes MCP initialize, tools/list and a real lexical tools/call query;
- `pnpm verify`, Skill validation and `git diff --check` pass.

## Rollback

The visible workspace is retained. Removing the hidden runtime removes installed QMD, configuration and rebuildable indexes. No user Source content is modified during activation or MCP use.
