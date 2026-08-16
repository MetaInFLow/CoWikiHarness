# Active Context

## Current Focus

完成 CoWikiHarness 权限感知图谱切片的最终验收。当前代码已经交付协议、SQL 授权投影、Graph REST、层级写入、A2A 恢复、终端命令和 `cowikiharness` Skill；V1 继续作为本地兼容链路。

## Authority

按以下顺序阅读：

1. [`CONSTITUTION.md`](../../CONSTITUTION.md) 和 [`core-red-lines.md`](../product/core-red-lines.md)；
2. 云端工作遵循 [`requirements-v2.md`](../requirements/requirements-v2.md)，本地兼容遵循 [`requirements-v1.md`](../requirements/requirements-v1.md)；
3. [ADR 0005](../decisions/ADR-0005-a2a-v1-public-agent-protocol.md) 至 [ADR 0009](../decisions/ADR-0009-authorized-graph-projection-api.md)、[`ARCHITECTURE.md`](../../ARCHITECTURE.md)和[活动 V2 设计](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)；
4. [图谱接口设计](../superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md)、[图谱实施计划](../superpowers/plans/2026-08-16-authorized-knowledge-graph-projection.md)、[V2 实施计划](../superpowers/plans/2026-08-15-cloud-knowledge-agent-v2.md)，以及被修改的任何保留本地行为所对应的 V1 设计与验收记录。

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
- V2 completed-task A2A projection now has an additive durable pending/completed/failed state and projection revision on `agent_tasks`; normal saves and restart recovery bind completion to product/A2A revisions, startup scans at most four stable eight-row pages, and authorized `getTask` demand-reconciles one pending completed task beyond that cap. Deeply invalid or oversized historical A2A JSON is quarantined with `INVALID_A2A_PROJECTION`, projection-only markers preserve task list timestamps, and completed projections cause no reconciliation writes on later restarts or reads.
- V2 图谱协议已提供严格的 `cowikiharness.graph/v1` schema、目录/知识/标签/位置/版本/principal/Connector 节点、关系端点语义、placement revision 和稳定错误合同。
- PostgreSQL 图谱读取先在 SQL 中构造授权知识集合，再投影层级和可选关系；游标绑定 principal、查询与 Registry revision，返回不含正文、locator、凭据或个人本地绝对路径。
- Knowledge Server 已提供只读 `GET /api/v1/graph`、user token 认证、精确 CORS allowlist、ETag 和结构化安全错误；Graph route 不调用模型，不创建 Agent task。
- 目录创建、目录移动和知识归档已通过强类型 A2A 操作交付，使用 `knowledge.organize`、CAS revision、不可变审计快照和可恢复的 A2A Artifact 投影。
- `cowiki graph` 已支持显式 user token 文件、10 秒超时、拒绝重定向和响应 schema 校验；`collection-create`、`collection-move`、`knowledge-place` 已接入 A2A 写入链路。
- `cowikiharness` Skill 已用中文记录图谱读取、层级整理、三类 revision、人工批准和冲突后重新批准流程。
- PostgreSQL 17 最终门禁和本地真实数据 smoke 尚未执行；当前状态不能作为图谱切片完整验收通过的证明。

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

1. 按图谱实施计划 Task 10 运行静态门禁、全量 `pnpm verify` 和 `pnpm verify:cloud`；
2. 优先使用 PostgreSQL 17 执行真实授权矩阵，并用仓库外的真实 user token 文件完成本地 Graph REST 与 `cowiki graph` smoke；
3. 记录实际数据库版本、测试数量、真实响应 schema/Cytoscape elements 和未运行项，Critical 与 Important review finding 清零后再宣布图谱切片完成。

## Completion Veto

Goal completion requires exactly `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` recorded as `pass` against the same candidate/runtime. Four live Connectors, six truthful Agent registry rows, native Codex execution, core recovery, desktop/mobile and direct Obsidian checks are mandatory. A Core-required `fail`, `blocked` or `not-run` cannot satisfy the gate. Critical and Important review findings must both equal zero. The fixed 17/35/11 catalog, external signatures, five additional live Agent drivers and fixed-scale certification remain post-Core backlog.

Isolated component checks are intermediate evidence. They cannot replace acceptance or the real Owner Full Journey.

## Do Not Resume

Do not merge or restore the superseded phase-0 branch or archived stash work. Do not use historical artifacts to override the current authority chain.
