# Active Context

## Current Focus

Complete and stabilize the local product Management Companion on `dev`.

## Completed

- audited active and historical code for copied upstream source;
- selected official Release installation plus public invocation;
- established the complete software lifecycle and stable runtime states;
- implemented isolated QMD `2.5.3` installation during initialization;
- separated hidden runtime data from the visible `~/openLifeWiki/` workspace;
- implemented approval-gated default Source activation;
- implemented a stdio launcher for QMD's existing MCP;
- verified real installation, indexing, retrieval, MCP handshake and expected tool list;
- implemented a responsive local Management Companion for lifecycle status, Source activation, Codex registration and health inspection;
- enforced loopback-only access, per-launch session authorization, Origin checks and preview-confirmed mutations;
- updated README, lifecycle, requirements and active design authority.

## Current Status

The source-checkout P0 chain and its product management GUI are implemented on `dev`. The owner machine has Node 24 and an `INITIALIZED` default runtime in macOS Application Support; the new default Source is intentionally empty. The Management Companion is the primary owner-facing entry, while the CLI remains the automation and recovery interface.

## Next

1. add owner-approved Markdown to the default Source and activate it from the Management Companion;
2. register the source-checkout MCP in Codex and execute one owner-visible query;
3. package the openLifeWiki CLI so the launcher no longer depends on the repository path;
4. define maintenance and uninstall operations before a public release;
5. evaluate the optional Visual Companion only after the fixed management workflow is proven.

## Do Not Resume

Do not merge `phase-0-foundation`, `stash@{0}` or `stash@{1}`. They contain superseded private-QMD and overgrown product implementations.
