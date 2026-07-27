# Active Context

## Current Focus

Deliver the canonical V1 Progressive Scan to Formal Wiki goal on `goal-v1-progressive-scan` through the ordered vertical plan.

## Authority

Read in order:

1. [`CONSTITUTION.md`](../../CONSTITUTION.md) and [`core-red-lines.md`](../product/core-red-lines.md);
2. [`requirements-v1.md`](../requirements/requirements-v1.md) and [`product-lifecycle.md`](../product-lifecycle.md);
3. [ADR 0003](../decisions/ADR-0003-progressive-scan-control-plane.md), [ADR 0004](../decisions/ADR-0004-okf-v0.2-and-obsidian-profile.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and the [active V1 design](../design/active/design_doc-v1-progressive-scan-and-wiki.md);
4. `docs/development/plans/2026-07-26-v1-progressive-scan-delivery.md` and `docs/acceptance/v1-journeys-and-oracles.md` once those executable gates are present.

The v0.2 requirement and v0.2/v0.3 designs are completed P0 references. They grant no V1 implementation authority.

## Implemented Baseline

- source-checkout CLI, protocol, core and adapter packages;
- QMD `2.5.3` official-release installation with isolated runtime/config/cache;
- approval-gated default Local Folder activation;
- real Markdown indexing, retrieval and direct upstream QMD stdio MCP handshake;
- loopback-only Management Companion for lifecycle, Source activation, Codex registration and health;
- P0 unit, component and Management Companion server coverage.
- V1 durable Connector/role/Agent/scan/progress/body-read/Wiki approval contracts;
- four canonical Agent I/O schemas with mandatory trusted-context validation, deterministic artifacts and release-manifest integrity.
- one revision-CAS `config/v2` truth with Owner-approved v1 migration, zero-authority initialization and isolated P0 compatibility;
- four exact Source authorization flows plus metadata-only Local, GitHub, selected-profile Feishu and staged Codex app-server v2 probes;
- functional CLI and Companion Sources management surfaces for migration, preview, Owner approval, narrowing and revocation, retaining all four rows from the same authorization/status services;
- real metadata-only probes verified for Local, GitHub, Feishu profile `metainflow-feishu` and the logged-in Codex app-server account, with zero Task 1 Critical/Important findings.

## V1 Status

Tasks 1 and 1.5 are complete through `13c5ab5`: one revisioned `config.json`, four exact Source authorization flows and real metadata-only probes now feed contracts that bind every direct child, target/root leaf body authorization, receipt-derived per-Connector/global progress and the Owner-approved required Source set through active QMD Evidence, proposal and Vault.

Task 2 is complete through `fa3af06`: the production Codex native driver uses the existing logged-in CLI with isolated user config, rules, tools, environment and scratch; accepts one hash-bound complete metadata-only Layer Summary using the shared Skeleton/MetadataSample validator; returns exact validated Agent decisions or structured failures; and exposes binary/version/runtime/input/Skill/schema invocation evidence. Node `24.16.0` verification passed with 244 tests and three opt-in skips, the real logged-in Codex contract passed, and final specification and quality reviews reported zero Critical/Important/Minor findings.

Task 3A Core foundations are complete through `0454c98`: the append-only scan ledger atomically binds trusted Agent invocation/results and exact per-child outcomes; the pure state machine controls forward progress, pause/resume/cancel/retry; checkpoint reuse binds phase, indexing, selection, body observation and generation; and QMD recovery uses trusted failure/deletion/current-version receipts plus replay-safe physical I/O accounting. Node `24.16.0` verification passed with 257 tests and three opt-in skips; final specification and quality reviews reported zero Critical/Important/Minor findings.

Task 3B1 is complete through `dbfb438`: Local Folder implements the shared five-action progressive Connector contract with full Scan Plan and trusted intent/page-chain binding, one fixed Skeleton generation, Source-and-Plan effective scope, current-page-only metadata work, unique logical node IDs, root identity checks, symlink/path fail-closed behavior and receipt-gated streaming under a trusted body-budget reservation. Node `24.16.0` verification passed with 267 tests and three opt-in skips; final specification and quality reviews reported zero Critical/Important findings.

Task 3B2 storage and current-index foundations are complete through `c239618`: ScanStore owns exact typed receipt persistence, Source-and-Plan body budgets, one serialized JIT body-read lease, full lazy-stream consumption under the scan lock, fatal UTF-8 and byte accounting, durable body-read commits, epoch invalidation across pause/fail/cancel and replay bounds against the durable state. The isolated QMD generation path is complete through `0e3a07e`: it publishes only a verified current generation, removes prior bodies, recovers after full or partial prior-generation deletion without depending on old bodies, and retains only body-free recovery evidence. Final independent reviews reported zero Critical/Important/Minor findings.

Task 4 progressive Provider actions are implemented and independently reviewed through `f21ed8b` for GitHub, selected-profile Feishu and bounded Codex History. All four Providers share the five-action contract, exact Scope-and-Plan checks, metadata-only paginated Skeleton discovery, version validation and the same active body lease. GitHub uses the logged-in `gh` identity, Feishu uses the explicitly approved `lark-cli` profile, and Codex History uses approved project roots and explicit thread IDs through app-server v2. Unsupported Feishu Base child traversal fails closed. Final Connector reviews reported zero Critical/Important/Minor findings.

Canonical progressive receipt construction is complete through `cc9d106`: complete prior-page metadata chains, strict Skeleton estimates and provider kind mapping, complete-layer summary/system bindings, trusted leaf/body checkpoints and active-publication-finalized QMD checkpoints are validated before persistence. Protocol verification passed with 49 tests.

`ACTIVE`, a successful Agent call or four individual probes still do not prove `CORE-AV-01`, progressive scan, Wiki publication or V1 completion.

## Next

1. complete the typed durable Skeleton/frontier transactions, then compose the proven Providers, selected Codex driver, body staging and QMD publisher in one recoverable ScanService;
2. expose the same receipt-derived global and per-Connector progress, Skeleton, Layer Summary and decision truth in Sources;
3. deliver the four-Connector same-generation gate, policy-aware MCP and proposal/Obsidian publication;
4. package the Core candidate and execute `Core-UAT-01` on the Owner machine;
5. after Core acceptance, add remaining Agent drivers and Release Certification hardening.

## Completion Veto

Goal completion requires exactly `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` recorded as `pass` against the same candidate/runtime. Four live Connectors, six truthful Agent registry rows, native Codex execution, core recovery, desktop/mobile and direct Obsidian checks are mandatory. A Core-required `fail`, `blocked` or `not-run` cannot satisfy the gate. Critical and Important review findings must both equal zero. The fixed 17/35/11 catalog, external signatures, five additional live Agent drivers and fixed-scale certification remain post-Core backlog.

Isolated component checks are intermediate evidence. They cannot replace acceptance or the real Owner Full Journey.

## Do Not Resume

Do not merge or restore the superseded phase-0 branch or archived stash work. Do not use historical artifacts to override the current authority chain.
