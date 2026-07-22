# Project Patterns

1. Preview every stateful lifecycle operation before approval.
2. Publish a stable state only after all completion probes pass.
3. Install external executables by exact release and call public CLI/MCP surfaces.
4. Keep process and filesystem behavior in adapters; keep product decisions pure in core.
5. Add a component only in the stage where a verified user journey first needs it.
6. Keep visible user knowledge separate from hidden, rebuildable runtime data.
7. Fix subprocess working directories when upstream tools perform local configuration discovery.
