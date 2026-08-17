# Active Context

## Current Focus

CoWikiHarness 权限感知图谱 P0 与 Hermes 风格 Gateway 部署已完成 macOS 和自动化门禁验收。当前实现截至 `682dd407b3b7b3225bb3b8b1cf396cc16f0d09fb`，已经交付协议、SQL 授权投影、Graph REST、层级写入、A2A 恢复、终端命令、`cowikiharness` Skill、默认回环监听、Linux systemd 安装边界和 Caddy HTTPS 边缘示例。当前状态为“已实现并完成 macOS/自动化门禁；待首台 Linux 服务器真实 systemd 验收”；公网 `443`、公网无法直连 `8080`、异常重启及 PostgreSQL 备份恢复仍需在首台 Linux 服务器形成真实证据。V1 继续作为本地兼容链路，其完整产品验收仍受独立 Completion Veto 约束。

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
- Hermes 风格 Gateway 已将未配置监听地址的默认值收敛为 `127.0.0.1`，保持单进程承载 A2A、Agent Card、健康检查和只读 Graph REST；远程公共地址仅接受 HTTPS，Linux systemd 使用专用非 root 账户，凭据留在仓库外环境文件，Caddy 只反代 `127.0.0.1:8080`。
- 第 6 项验证在 `dev` 提交 `682dd407b3b7b3225bb3b8b1cf396cc16f0d09fb` 上使用 Node.js `24.18.0`、pnpm `10.33.2` 和 PostgreSQL 服务端 `17.2` 完成。Knowledge Server 聚焦测试为 76 项通过、0 项跳过；独立 `pnpm verify` 为 66 个文件通过、10 个文件跳过，830 项通过、96 项跳过，退出码 0。
- 独立 `pnpm verify` 分包结果为 protocol 97/0、core 183/0、adapters 260/38、companion 10/0、knowledge-agent 26/45、CLI 16/0、knowledge-server 238/13，数字顺序均为通过数/跳过数。
- PostgreSQL `17.2` 上的 `pnpm verify:cloud` 退出码 0：内部全门禁 923 项通过/3 项跳过，PostgreSQL 阶段 366/3，A2A 阶段 251/0；按脚本实际执行次数合计 1,540 项通过、6 项跳过，重复套件保留分阶段口径。
- macOS 安装脚本与健康检查退出码均为 0，LaunchAgent 仅监听 `http://127.0.0.1:8080`，`healthz` 返回 `ready`。真实 A2A 查询通过 `openlifewiki.knowledge-query-result/v1` 结构校验，结果为 `grounded`、答案非空、1 条引用；真实 Graph 请求通过 `cowikiharness.graph/v1` 结构校验，返回 5 个节点、4 条边、`truncated=false`，`owner.token` 权限为 `600`。
- 首台 Linux 服务器仍需验证 systemd 启动、异常重启和日志，公网 `443` HTTPS 与 Agent Card，公网无法直连 `8080`，以及 PostgreSQL 备份恢复和稳定标识。该组证据完成前，Hermes 部署保持“待首台 Linux 服务器真实 systemd 验收”。
- 此前图谱 P0 最终验收使用 Node.js `24.18.0`、pnpm `10.33.2` 和隔离 PostgreSQL `17.2`；静态门禁、`pnpm verify`、启用 PostgreSQL 测试的 `pnpm verify:cloud` 均以退出码 0 完成。
- 此前图谱 P0 验收中的 `pnpm verify` 记录为 754 项通过、95 个选择性集成或现场测试跳过；`verify:cloud` 主测试轮次记录为 846 项通过、3 个既有选择性现场测试跳过。包结果为 adapters 295/3、knowledge-agent 71/0、knowledge-server 174/0；后续重复运行的 `test:postgres` 和 `test:a2a` 退出码均为 0，重复测试不累加到主轮次统计。
- 配置 URL 与 A2A Agent Card endpoint 已统一限制为远程 HTTPS 或 loopback HTTP；远程 HTTP、userinfo 和非 HTTP(S) scheme 在 token 读取与 bearer transport 前 fail-closed，本次加固未新增依赖。
- 安全加固后的 `dev` 构建已通过本地安装脚本重新安装并由 LaunchAgent 运行，`healthz` 返回 `ready`。
- 仓库外 owner token 的真实 `cowiki graph` smoke 已重新执行并通过共享 `cowikiharness.graph/v1` schema 校验，返回 6 nodes、5 edges、`truncated=false`，包含“CoWikiHarness 本机使用说明”和 `product`、`local-setup` 标签边。
- 重新取得的真实响应通过敏感字段递归检查；token、配置与临时 smoke 文件均未进入 Git，token 文件权限为 `600`。远程 HTTP 与不存在的 token file 组合返回 `COWIKIHARNESS_INVALID_ARGUMENTS`，验证 URL 校验早于 token 读取。
- 真实 owner REST 请求再次返回 200，Agent token 再次返回 403 `GRAPH_PRINCIPAL_NOT_SUPPORTED`，CLI 返回脱敏的 `COWIKIHARNESS_REQUEST_FAILED`；响应和错误均未包含 token。
- 真实条件请求保留 weak ETag 与 304 空 body，并验证 strong tag 列表 weak-match 返回 304、`*` 返回 304、不匹配返回 200。空的 `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS` 继续使非白名单 Origin 不返回跨域许可。Relay token、撤销 token、多用户隔离、cursor 409、无 LLM 调用和无 A2A task 由 PostgreSQL/HTTP integration tests 覆盖。
- 真实 A2A 查询通过本地 Agent Card 与模型链路返回 `openlifewiki.knowledge-query-result/v1`，`evidenceMode=grounded`、1 citation、0 gaps、`answerPresent=true`；验收记录不保存答案正文。
- cursor 签名使用 HMAC 和 constant-time comparison；REST 业务路由仅提供 `GET /api/v1/graph`。本切片未增加第三方依赖，migration 保持 `0001`、`0002`、`0003`。

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

1. 在首台 Linux 服务器完成 systemd 启动与异常重启、公网 `443` HTTPS、Agent Card、公网无法直连 `8080`、PostgreSQL 备份恢复和精确 CORS 白名单验收；
2. 外部可视化应用通过自己的后端代理图谱请求，后端 secret store 保存专用、最小权限的 member token；内置图谱 UI 与浏览器登录 session 继续作为 future scope；
3. 按 V2 实施计划继续完成其余切片，同时保留 V1 兼容链路和独立验收门禁。

## Completion Veto

Goal completion requires exactly `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` recorded as `pass` against the same candidate/runtime. Four live Connectors, six truthful Agent registry rows, native Codex execution, core recovery, desktop/mobile and direct Obsidian checks are mandatory. A Core-required `fail`, `blocked` or `not-run` cannot satisfy the gate. Critical and Important review findings must both equal zero. The fixed 17/35/11 catalog, external signatures, five additional live Agent drivers and fixed-scale certification remain post-Core backlog.

Isolated component checks are intermediate evidence. They cannot replace acceptance or the real Owner Full Journey.

权限感知图谱 P0 切片通过，不能替代 V1 的 `CORE-AV-01..06`、`CORE-EC-01..10` 和 `Core-UAT-01` 验收，也不代表整个 V1 或整个 V2 已完成。

## Do Not Resume

Do not merge or restore the superseded phase-0 branch or archived stash work. Do not use historical artifacts to override the current authority chain.
