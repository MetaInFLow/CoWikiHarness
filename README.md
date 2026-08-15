# CoWikiHarness

> 面向多人共享知识中心的 Agent Harness：统一登记知识，由不同 Connector 按授权访问，并通过一个 Knowledge Agent 提供查询、存储和整理入口。

项目仓库名和对外品牌为 **CoWikiHarness**。当前 V1 本地兼容链路仍使用 `openLifeWiki` 命令和 `@openlifewiki/*` package namespace；这是现有运行合同，后续如需整体改名必须单独形成迁移决策。

## 当前状态

- `main`：稳定、可发布的产品基线。
- `dev`：下一版集成分支，当前正在完成 V1 基线恢复并实施 V2 云端架构。
- V2 设计已确认：一个云端 Knowledge Agent 作为知识查询、注册、存储和整理的唯一入口。
- 公共 Agent 协议采用 A2A v1 over HTTPS。
- P0 Agent runtime 采用 OpenAI Agents SDK，持久化事实源采用 PostgreSQL 17。
- V1 本地路径继续保留，用于本地 Markdown、现有 Connector 和 QMD 兼容能力。

当前开发分支中的 V1 progressive-scan 改动仍在验证，V2 应用代码会在 V1 基线恢复后按实施计划逐个 Slice 开始。

## 目标架构

```mermaid
flowchart LR
    CLIENTS["Codex / Pi / Claude / QM"] -->|"A2A v1 over HTTPS"| AGENT

    subgraph CLOUD["CoWikiHarness 云端 Knowledge Agent"]
        AGENT["Knowledge Agent"]
        TOOLS["强类型 Knowledge Tools"]
        APP["应用服务与权限控制"]
        REGISTRY[("PostgreSQL Registry")]
        CONNECTORS["Connector Providers"]
        RELAY["可选个人 Local Relay"]

        AGENT --> TOOLS --> APP
        APP --> REGISTRY
        APP --> CONNECTORS
        CONNECTORS --> RELAY
    end

    CONNECTORS --> FEISHU["飞书"]
    CONNECTORS --> GITHUB["GitHub"]
```

核心原则：

1. 所有外部 Agent 只访问一个 Knowledge Agent，不直接访问 Connector、数据库或索引。
2. Registry 记录稳定的知识身份、多个知识位置、版本、来源、权限和可用状态。
3. 注册外部或个人本地知识时只登记位置，不自动复制正文。
4. 用户权限、Agent 权限和 delegation 权限取交集，检索前完成权限过滤。
5. 整理知识架构和覆盖稳定内容先生成不可变提案，再绑定精确审批和 revision 执行。

## P0 组件

P0 只部署以下组件：

- 一个 Node.js 云端服务，负责 A2A、认证、Agent 执行、应用操作和 Connector 编排；
- 一个 PostgreSQL 17 实例，负责 Registry、托管 Markdown、权限、任务、会话和审计；
- 一个可选的个人电脑 `openlifewiki relay` 进程，用于访问仅存在于个人本地的知识。

P0 暂不引入云端 MCP、Codex SDK、Pi、Redis、独立 Worker、对象存储、向量数据库、云端 QMD 或独立管理后台。每个新增组件都必须先满足量化触发条件并补充 ADR。

## 快速开始

### 本地 V1 兼容链路

要求 Node.js `>=24.16.0 <25` 和 pnpm `10.33.2`：

```bash
./scripts/bootstrap_dev_env.sh
pnpm openlifewiki companion --open --json
```

本地链路使用本机管理页面完成初始化、资料激活、Connector 授权和健康检查。默认知识目录为 `~/openLifeWiki/sources/`，当前 P0 读取 Markdown 并通过 QMD 提供本地检索。

### V2 云端链路

V2 正按实施计划推进。当前 Slice 1 已提供 PostgreSQL Registry、身份/delegation 权限、强类型知识操作和云端初始化 CLI；Agent server 与 A2A 入口仍在后续 Slice。

1. 恢复 V1 可信基线；
2. 建立 PostgreSQL Registry、身份、delegation 和强类型应用操作；
3. 通过 OpenAI Agents SDK 接入 A2A 查询；
4. 增加注册、存储、知识架构、Local Relay 和本地状态导入。

云端管理命令只需要 PostgreSQL 连接和 token HMAC secret，不要求模型配置：

```bash
export DATABASE_URL=postgres://openlifewiki:change-me@127.0.0.1:5432/openlifewiki
export OPENLIFEWIKI_TOKEN_HMAC_SECRET=at-least-32-random-bytes
pnpm openlifewiki cloud migrate --json
pnpm openlifewiki cloud bootstrap --organization openLifeWiki --owner Anthony --agent codex --json
```

bootstrap 输出的 Owner/Agent token 只显示一次；生产环境应立即保存到受控的 token 文件中。

## 文档

- [V2 需求说明](docs/requirements/requirements-v2.md)
- [V2 云端架构设计](docs/design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)
- [V2 实施计划](docs/superpowers/plans/2026-08-15-cloud-knowledge-agent-v2.md)
- [文档索引与权威顺序](docs/README.md)
- [架构总览](ARCHITECTURE.md)
- [开发说明](DEVELOPMENT.md)
- [分支规则](BRANCHING.md)
- [当前工程上下文](docs/memory-bank/active-context.md)

关键架构决策：

- [ADR 0005：A2A v1 公共 Agent 协议](docs/decisions/ADR-0005-a2a-v1-public-agent-protocol.md)
- [ADR 0006：OpenAI Agents SDK Harness](docs/decisions/ADR-0006-openai-agents-sdk-harness.md)
- [ADR 0007：PostgreSQL 持久事实源](docs/decisions/ADR-0007-postgresql-durable-truth.md)
- [ADR 0008：最简 V2 P0 Runtime](docs/decisions/ADR-0008-minimal-v2-runtime.md)

## 仓库结构

```text
apps/cli/                 本地与云端 CLI
apps/knowledge-server/    V2 云端 Knowledge Agent 服务（计划中）
packages/protocol/        公共合同、schema 和稳定类型
packages/core/            纯策略、权限、生命周期和扫描规则
packages/adapters/        PostgreSQL、Connector、QMD 和本地存储 adapter
packages/companion/       V1 本地管理服务和管理页面
skills/                   Knowledge Architect 与 V1 本地流程
docs/                     需求、设计、ADR、计划、治理和验收记录
```

## 分支策略

- `main`：只接收已验证、可发布的稳定基线。
- `dev`：集成下一版完整能力，所有 V2 Slice 先在这里完成验证。
- `feature/<topic>`：较大的独立功能分支。
- `fix/<topic>`：针对明确缺陷的修复分支。

禁止直接在 `main` 开发。每个 Slice 必须先通过计划中指定的测试和验收门禁，再合并到 `dev`；完整产品验收通过后，才从 `dev` 推进 `main`。

## 开发验证

```bash
pnpm schema:check
pnpm build
pnpm typecheck
pnpm test
pnpm verify
```

真实 QMD 组件验证会安装官方 Release 并访问本地测试资源：

```bash
pnpm test:component:qmd
```

云端验证将在 V2 Slice 交付后增加 PostgreSQL、A2A、容器和十二条产品验收旅程。

## 设计边界

- 不扫描没有明确 Source 授权的目录或平台。
- 不把第三方项目源码复制进仓库，只安装官方 Release 并调用公开接口。
- 不保存 Agent 凭据、provider secret 或个人知识正文到日志、配置或审计记录。
- 不在人工审批前写入长期知识架构或 Wiki 变更。
- 不把生成文件、运行时数据、日志和个人 Source 内容提交到 Git。

## License

[MIT](LICENSE)。外部组件保留各自的 License 和归属。
