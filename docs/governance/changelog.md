# Governance Changelog

## 2026-08-16

- 完成 V2 Slice 1 的云端 Registry 基础：严格身份、知识和操作合同，PostgreSQL migration，HMAC bearer token，成员/Agent/delegation/grant/token 管理，以及权限过滤的查询、获取和注册/托管存储操作；
- 增加 `openlifewiki cloud migrate/bootstrap/member/agent/grant/token` CLI 合同；cloud 管理命令只依赖 PostgreSQL 和 token HMAC secret，不依赖模型配置；
- 增加真实 PostgreSQL 集成测试、构建后 CLI smoke 验证和 Linux PostgreSQL 17 CI job；V1 本地命令继续不触发云端连接。

## 2026-08-15

- 接受 V2 作为单一云端 Knowledge Agent，并保留 V1 作为明确的本地兼容链路；
- 选择 A2A v1 作为云端 Agent 协议、OpenAI Agents SDK 作为唯一 P0 harness、PostgreSQL 17 作为唯一持久云端存储；
- 将 P0 runtime 限制为一个 Node.js 服务、PostgreSQL 和可选的个人出站 Relay；
- 在达到量化扩展触发条件前，排除云端边界 MCP、Codex SDK、Pi、Redis、独立 Worker、对象存储、向量搜索、云端 QMD 和独立管理 UI；
- 批准 V2 需求、架构、ADR 0005 至 ADR 0008、活动设计和六 Slice 实施/验收计划；
- 要求 V1 typecheck/test 恢复通过后，才能开始 V2 应用代码。

## 2026-07-26

- established the root Constitution, core red lines, V1 requirement, lifecycle, accepted ADRs, architecture/active design, executable protocol/Skill and acceptance veto gates as the ordered authority chain;
- adopted the V1 Progressive Scan to Formal Wiki contract while keeping current P0 implementation status explicit;
- marked v0.2 requirements and the v0.2/v0.3 designs as completed P0 references that no longer authorize V1 work;
- added Connect, Scan, Propose, Approve and Publish lifecycle operations with hash-bound recovery checkpoints;
- defined `ACTIVE` as retrieval-path readiness and kept V1 completion bound to acceptance evidence;
- required all 17 benchmark journeys, 35 executable contracts and 11 acceptance validations to pass in their declared automated or human mode, including Live Connector, recovery, desktop/mobile and Obsidian checks;
- made `fail`, `blocked` and `not-run` non-passing results and required Critical and Important review findings to both equal zero;
- sequenced V1 delivery through contract proof, Connector visibility, the real Local/QMD chain, remaining live Connectors, six Agents/policy MCP, Wiki proposal/publication, seven-page GUI/Canvas and real Full Journey acceptance.
- split first Owner-usable V1 acceptance from later Release Certification: Core now has the fixed `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` inventory, while external signatures, the 17/35/11 catalog, five additional live Agent drivers, fixed-scale measurement, update and uninstall remain post-Core certification;
- reordered delivery so Codex, four live Connectors, one active QMD generation, policy-aware MCP, approved Obsidian Wiki, GUI and incremental update close before release-hardening work.
- completed Task 1.5 executable contracts for exact child outcomes, root/leaf body-read authorization, receipt-derived progress and generic Owner-required Connector-to-Vault Evidence lineage.

## 2026-07-22

- established `dev` as the integration branch;
- defined the install-to-uninstall product lifecycle;
- limited initialization to QMD `2.5.3`;
- required official release installation and public-interface invocation;
- replaced the single placeholder package with CLI, protocol, core and adapter boundaries;
- archived the pre-reset architecture, ADRs, spikes and superseded plans;
- established platform application-data as the runtime default and `~/openLifeWiki/` as the visible knowledge default;
- added approval-gated activation for the default Markdown Source;
- delegated P0 MCP serving to QMD's existing stdio MCP through an isolated launcher;
- verified the real QMD install, retrieval and MCP handshake contract;
- approved requirements v0.2 and activated the Management Companion design;
- added the loopback-only product management GUI for lifecycle status, Source activation, Codex registration and health inspection;
- kept the optional Visual Companion deferred until the fixed workflow is proven.
