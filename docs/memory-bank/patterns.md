# Project Patterns

1. Preview every stateful lifecycle operation before approval.
2. Publish a stable state only after all completion probes pass.
3. Install external executables by exact release and call public CLI/MCP surfaces.
4. Keep process and filesystem behavior in adapters; keep product decisions pure in core.
5. Add a component only in the stage where a verified user journey first needs it.
6. Keep visible user knowledge separate from hidden, rebuildable runtime data.
7. Fix subprocess working directories when upstream tools perform local configuration discovery.
8. Build a metadata-only Source Skeleton before any selected leaf-body read.
9. Bind authorization, progress, decisions, checkpoints and approvals to canonical hashes.
10. Keep body-bearing Layer Summaries in disposable scratch; persist metadata, hashes and receipts only.
11. Rebuild and verify a temporary full QMD generation before switching the active pointer and deleting the prior generation.
12. Normalize all six Agent drivers behind one schema and one canonical Skill; expose real failure without fallback.
13. Use the Selected Agent for semantic work and reuse external components only for their proven deterministic public contracts.
14. Treat every durable Wiki write as an immutable proposal plus Owner approval and compare-and-swap.
15. Keep Visitor tool discovery to `query`; derive Admin capabilities server-side.
16. Treat Canvas as task-bound presentation and event input; keep durable product truth in the fixed application services.
17. Count only acceptance `pass`; `blocked` and `not-run` remain visible non-passing results.
