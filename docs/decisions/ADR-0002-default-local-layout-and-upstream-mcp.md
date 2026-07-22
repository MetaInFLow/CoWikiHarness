# ADR 0002: Separate User Knowledge From Runtime And Launch QMD MCP

- Status: accepted
- Date: 2026-07-22

## Context

P0 needs a default folder that works without configuration, remains understandable to the owner and cannot be confused with rebuildable application data. QMD can discover project-local `.qmd` configuration from its process working directory, so environment isolation alone is insufficient.

## Decision

Use two independent default roots:

- `~/.openlifewiki/` for program state, installed components, QMD configuration, indexes and logs;
- `~/openLifeWiki/` for user-visible `sources/` and `wiki/` content.

`OPENLIFEWIKI_HOME` overrides the runtime root. `OPENLIFEWIKI_WORKSPACE` overrides the visible workspace. Initialization creates both roots and reads no Source content.

Activation authorizes only `sources/**/*.md`, configures one QMD collection through the public CLI and publishes `ACTIVE` only after a real search returns a resolvable path.

The P0 MCP transport is stdio. `openlifewiki mcp --stdio` launches QMD's existing `qmd mcp` process after checking `ACTIVE`. It sets `QMD_CONFIG_DIR`, `XDG_CACHE_HOME` and the process working directory to the isolated runtime layout.

The launcher blocks startup unless the openLifeWiki authorization record and QMD public collection details describe exactly one matching default Source. It refreshes the collection before serving queries so removed or changed files are reconciled.

P0 uses QMD's lexical query mode with reranking disabled. Optional semantic and reranking models stay out of initialization and are downloaded by QMD into the isolated cache only when the user selects those capabilities.

## Consequences

- users can see and back up their knowledge without entering a hidden application directory;
- runtime cleanup cannot remove the visible workspace by default;
- no port allocation, daemon lifecycle or duplicate MCP implementation is required;
- QMD configuration and indexes do not collide with a user's standalone QMD setup;
- custom paths must be supplied consistently when initializing, activating and registering the MCP process.
