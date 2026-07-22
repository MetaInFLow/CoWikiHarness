# Active Context

## Current Focus

Review and stabilize the default local workspace, QMD activation and upstream MCP launcher on `dev`.

## Completed

- audited active and historical code for copied upstream source;
- selected official Release installation plus public invocation;
- established the complete software lifecycle and stable runtime states;
- implemented isolated QMD `2.5.3` installation during initialization;
- separated hidden runtime data from the visible `~/openLifeWiki/` workspace;
- implemented approval-gated default Source activation;
- implemented a stdio launcher for QMD's existing MCP;
- verified real installation, indexing, retrieval, MCP handshake and expected tool list;
- updated README, Install Skill, architecture, requirements and accepted decisions.

## Current Status

The source-checkout P0 chain is implemented on `dev`: initialize, add Markdown, activate, start MCP. It awaits owner review and a real Codex registration journey before any merge to `main`.

## Next

1. run the full repository verification and Skill validator;
2. register the source-checkout MCP in Codex and execute one owner-visible query;
3. package the openLifeWiki CLI so the MCP registration no longer depends on the repository path;
4. define maintenance and uninstall commands before a public release.

## Do Not Resume

Do not merge `phase-0-foundation`, `stash@{0}` or `stash@{1}`. They contain superseded private-QMD and overgrown product implementations.
