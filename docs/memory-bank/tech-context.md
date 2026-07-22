# Technical Context

- Node.js `24.16.0`, pnpm `10.33.2`, TypeScript, Vitest.
- Product shape: local runtime + CLI + MCP; connected Agent mode first.
- Runtime root: `~/.openlifewiki/`, override with `OPENLIFEWIKI_HOME`.
- Visible workspace: `~/openLifeWiki/`, override with `OPENLIFEWIKI_WORKSPACE`.
- P0 external dependency: QMD `2.5.3` installed from npm into an isolated component directory.
- P0 MCP: QMD's upstream stdio MCP behind the openLifeWiki readiness and isolation launcher.
- `main` is stable; current integration work is on `dev`.
