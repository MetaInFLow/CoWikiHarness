# Active Context

## Current Focus

先把当前 V1 progressive-scan 工作区恢复到测试通过的基线，再按有序垂直计划交付已接受的 V2 云端 Knowledge Agent。V1 继续作为本地兼容链路。

## Authority

按以下顺序阅读：

1. [`CONSTITUTION.md`](../../CONSTITUTION.md) 和 [`core-red-lines.md`](../product/core-red-lines.md)；
2. 云端工作遵循 [`requirements-v2.md`](../requirements/requirements-v2.md)，本地兼容遵循 [`requirements-v1.md`](../requirements/requirements-v1.md)；
3. [ADR 0005](../decisions/ADR-0005-a2a-v1-public-agent-protocol.md) 至 [ADR 0008](../decisions/ADR-0008-minimal-v2-runtime.md)、[`ARCHITECTURE.md`](../../ARCHITECTURE.md)和[活动 V2 设计](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)；
4. [V2 实施计划](../superpowers/plans/2026-08-15-cloud-knowledge-agent-v2.md)，以及被修改的任何保留本地行为所对应的 V1 设计与验收记录。

v0.2 需求和 v0.2/v0.3 设计是已完成的 P0 参考，不授予新的实施权威。

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
- V2 Slice 1 cloud registry contracts: strict identity/knowledge/operation schemas, PostgreSQL migrations, token hashing, member/Agent/delegation/grant/token CLI management, authorization-filtered Registry operations and PostgreSQL CI coverage.
- V2 hierarchy mutations bind placement replays to task, actor and receipt metadata; preserve registry and placement revisions for current-state no-ops; use item-to-organization placement lock order; and cover inverse moves, authorization revocation and managed replacement races with real PostgreSQL connections.
- V2 A2A hierarchy recovery now uses immutable collection/placement snapshots in completed audit receipts, strictly binds and disambiguates receipts, reconciles completed product tasks to exact client-visible A2A artifacts through revision CAS, and makes a committed hierarchy mutation win over late cancellation without duplicate writes.
- V2 completed-task A2A projection now has an additive durable pending/completed/failed state and projection revision on `agent_tasks`; normal saves and restart recovery bind completion to product/A2A revisions, startup scans at most four stable eight-row pages, malformed historical rows are quarantined with `INVALID_A2A_PROJECTION`, and completed projections cause no reconciliation writes on later restarts.

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

1. 通过 OpenAI Agents SDK 构建唯一 Knowledge Agent，并接入 A2A v1 HTTPS 入口；
2. 在强类型 Registry 操作之上增加 query/register/store 的 Agent tool 编排；
3. 依次实现知识架构提案、Local Relay 和本地状态导入，每个 Slice 通过具名验收门禁后再推进。

## Completion Veto

Goal completion requires exactly `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` recorded as `pass` against the same candidate/runtime. Four live Connectors, six truthful Agent registry rows, native Codex execution, core recovery, desktop/mobile and direct Obsidian checks are mandatory. A Core-required `fail`, `blocked` or `not-run` cannot satisfy the gate. Critical and Important review findings must both equal zero. The fixed 17/35/11 catalog, external signatures, five additional live Agent drivers and fixed-scale certification remain post-Core backlog.

Isolated component checks are intermediate evidence. They cannot replace acceptance or the real Owner Full Journey.

## Do Not Resume

Do not merge or restore the superseded phase-0 branch or archived stash work. Do not use historical artifacts to override the current authority chain.
