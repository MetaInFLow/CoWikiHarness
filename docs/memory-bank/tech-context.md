# Technical Context

- Node.js `24.16.0`, pnpm `10.33.2`, TypeScript, Vitest.
- Product shape: local runtime + CLI + MCP; connected Agent mode first.
- Runtime root: `~/.openlifewiki/`, override with `OPENLIFEWIKI_HOME` for tests.
- P0 external dependency: QMD `2.5.3` installed from npm into an isolated component directory.
- `main` is stable; current integration work is on `dev`.
