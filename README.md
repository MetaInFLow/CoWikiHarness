# CoWikiHarness

> 面向多人共享知识中心的 Agent Harness：统一登记知识，由不同 Connector 按授权访问，并通过一个 Knowledge Agent 提供查询、存储和整理入口。

项目仓库名和对外品牌为 **CoWikiHarness**。当前 V1 本地兼容链路仍使用 `openLifeWiki` 命令和 `@openlifewiki/*` package namespace；这是现有运行合同，后续如需整体改名必须单独形成迁移决策。

## 当前状态

- `main`：稳定、可发布的产品基线。
- `dev`：下一版集成分支，V2 Knowledge Agent 正在这里集成和验收。
- V2 设计已确认：一个云端 Knowledge Agent 作为知识查询、注册、存储和整理的唯一入口。
- 公共 Agent 协议采用 A2A v1 over HTTPS。
- P0 Agent runtime 采用 OpenAI Agents SDK，持久化事实源采用 PostgreSQL 17。
- V1 本地路径继续保留，用于本地 Markdown、现有 Connector 和 QMD 兼容能力。

当前 V2 已具备 PostgreSQL Registry、多人身份与 delegation、A2A 服务、OpenAI Agents SDK 查询、知识注册、托管 Markdown 存储、审批后替换，以及权限感知的只读知识图谱投影。

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

### V2 Knowledge Agent

当前可用闭环：

1. PostgreSQL 保存知识身份、位置、版本、权限、任务、会话和审计；
2. Knowledge Agent 通过 A2A 接收自然语言查询和强类型写入操作；
3. Codex 通过 `cowikiharness` Skill 和 `cowiki` 客户端访问唯一入口；
4. 外部知识可以只登记 Feishu、GitHub 或个人本地 locator，不复制正文；
5. 托管 Markdown 默认以私有草案创建，替换采用精确 preview hash 和 revision 确认。

云端管理命令只需要 PostgreSQL 连接和 token HMAC secret，不要求模型配置：

```bash
export DATABASE_URL=postgres://openlifewiki:change-me@127.0.0.1:5432/openlifewiki
export OPENLIFEWIKI_TOKEN_HMAC_SECRET=at-least-32-random-bytes
pnpm openlifewiki cloud migrate --json
pnpm openlifewiki cloud bootstrap --organization openLifeWiki --owner Anthony --agent codex --json
```

bootstrap 输出的 Owner/Agent token 只显示一次；生产环境应立即保存到受控的 token 文件中。

#### macOS 本地安装

将模型和数据库配置保存到：

```text
~/Library/Application Support/CoWikiHarness/config.env
```

将 bootstrap 产生的 Agent token 保存到：

```text
~/Library/Application Support/CoWikiHarness/credentials/agent.token
```

然后运行：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" ./scripts/install_local_macos.sh
curl http://127.0.0.1:8080/healthz
```

安装器完成四件事：构建 Knowledge Server、注册 macOS 常驻服务、安装 `cowiki` 命令、把 `cowikiharness` Skill 链接到 Codex。配置和 token 始终保留在仓库外。

#### 直接使用

查询中央知识：

```bash
cowiki ask "CoWikiHarness 的架构是什么？"
```

登记一个外部知识地址，不复制正文：

```bash
cowiki register \
  --title "项目知识库" \
  --kind feishu \
  --locator "https://example.feishu.cn/wiki/example" \
  --tag architecture
```

保存一份托管 Markdown 私有草案：

```bash
cowiki store --title "CoWikiHarness 使用说明" --body-file /absolute/path/guide.md --tag product
```

在 Codex 中可以直接说：

```text
查一下知识中枢里 CoWikiHarness 的架构。
把这份 Markdown 作为私有草案存进知识中枢。
```

替换已有知识必须先运行 `preview-replace`，展示返回的 `previewHash` 并得到用户确认，再运行 `apply-replace`。完整参数由已安装的 `cowikiharness` Skill 约束。

#### 外部图谱快速路径

`cowiki graph` 从 Knowledge Server 的 `GET /api/v1/graph` 读取当前用户有权查看的知识结构。响应采用 `cowikiharness.graph/v1`，其中 `elements.nodes` 和 `elements.edges` 可以直接交给 Cytoscape.js；其他可视化工具可以在这一公共结构上做轻量转换。

本机受控验证可以使用 Owner token：

```bash
export COWIKIHARNESS_URL=http://127.0.0.1:8080
cowiki graph \
  --depth 2 \
  --include tags,locations \
  --token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token"
```

推荐在本机受控调试中通过 `cowiki` 使用图谱接口，它会校验参数和返回 schema。生产环境由外部可视化应用的后端向 `${COWIKIHARNESS_URL}/api/v1/graph` 发起带 Bearer user token 的 GET 请求，member token 只保存在该后端的 secret store，前端只访问自己的后端。token 值不得放入 URL、命令参数、前端源码或日志；生产环境必须使用 HTTPS。

当前 P0 未提供独立用户登录/session 机制，因此生产浏览器直连暂不开放。本机受控调试可以继续使用显式 user token 文件。`OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS` 只控制哪些浏览器来源可以读取跨域响应，不提供身份认证，也无法阻止已提取 token 的重放；配置只接受精确 origin，通配符不受支持。

Owner token 只用于本机受控验证。给外部可视化应用后端创建专用 member principal：

```bash
pnpm openlifewiki cloud member create \
  --name graph-viewer \
  --owner-token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  --json
```

创建后必须在以下授权方案中二选一，不能同时执行。

方案 A：应用需要查看组织内全部知识时，只授予 organization scope：

```bash
pnpm openlifewiki cloud grant \
  --principal "<principalId>" \
  --scope "organization:<orgId>" \
  --capability knowledge.query \
  --owner-token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  --json
```

方案 B：应用只需要查看单条知识时，跳过方案 A，只授予 item scope：

```bash
pnpm openlifewiki cloud grant \
  --principal "<principalId>" \
  --scope "item:<itemId>" \
  --capability knowledge.query \
  --owner-token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  --json
```

resource grant 采用追加授权。给已有 organization grant 再追加 item grant，不会缩小原有访问范围。若误授 organization scope，应立即停止使用并撤销旧 token，创建新的 member principal，并只执行方案 B。当前 CLI 没有 grant revoke 命令。

`<principalId>`、`<orgId>` 和 `<itemId>` 需要替换为真实返回值。member token 只显示一次：本机受控调试保存到仓库外的 token 文件，生产应用保存到后端 secret store。不要把返回 token 写入仓库、前端、终端历史采集或日志。

Graph REST 保持只读。目录创建、目录移动和知识归档分别通过 `cowiki collection-create`、`cowiki collection-move`、`cowiki knowledge-place` 进入 A2A 授权写入链路，并遵守 revision 与人工批准规则。图谱响应不包含知识正文、locator、凭据或个人本地绝对路径。完整合同和取舍见 [ADR 0009](docs/decisions/ADR-0009-authorized-graph-projection-api.md) 与[图谱接口设计](docs/superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md)。

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
- [ADR 0009：权限感知只读图谱投影](docs/decisions/ADR-0009-authorized-graph-projection-api.md)

## 仓库结构

```text
apps/cli/                 本地与云端 CLI
apps/knowledge-server/    V2 A2A Knowledge Agent 服务与最小客户端
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

云端验证使用 PostgreSQL 17 运行 Registry、Agent、A2A 和写入审批集成测试：

```bash
pnpm verify:cloud
```

## 设计边界

- 不扫描没有明确 Source 授权的目录或平台。
- 不把第三方项目源码复制进仓库，只安装官方 Release 并调用公开接口。
- 不保存 Agent 凭据、provider secret 或个人知识正文到日志、配置或审计记录。
- 不在人工审批前写入长期知识架构或 Wiki 变更。
- 不把生成文件、运行时数据、日志和个人 Source 内容提交到 Git。

## License

[MIT](LICENSE)。外部组件保留各自的 License 和归属。
