# CoWikiHarness Architecture

- 状态：V2 云端主链路已实现，正在执行最终验收
- 当前实现：A2A Knowledge Agent 与权限感知 Graph REST 共存于单一 Node.js 服务；V1 本地兼容链路继续保留
- V2 需求：[`docs/requirements/requirements-v2.md`](docs/requirements/requirements-v2.md)
- V2 设计：[`docs/design/active/2026-08-15-cloud-knowledge-agent-v2-design.md`](docs/design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)
- 图谱决策：[`docs/decisions/ADR-0009-authorized-graph-projection-api.md`](docs/decisions/ADR-0009-authorized-graph-projection-api.md)
- V1 需求：[`docs/requirements/requirements-v1.md`](docs/requirements/requirements-v1.md)
- V1 设计：[`docs/design/active/design_doc-v1-progressive-scan-and-wiki.md`](docs/design/active/design_doc-v1-progressive-scan-and-wiki.md)

## V2 权威与兼容边界

V2 管理云端和多人场景。在某个 V2 Slice 明确替代现有本地行为前，本地兼容链路继续以 V1 为准。任何 V2 改动都不得静默削弱 V1 的 Source 授权、规范 hash、receipt、compare-and-swap 或 fail-closed 保证。

## V2 目标架构

CoWikiHarness 以单一 Node.js 服务运行。外部 Agent 通过基于 HTTPS 的 A2A v1 进行问答和授权写入；外部可视化应用后端通过只读 Graph REST 获取确定性知识结构。两条链路共用身份认证、访问策略和 PostgreSQL 事实源。

```mermaid
flowchart LR
    AGENTS["Codex / Pi / Claude / QM"] -->|"A2A v1 over HTTPS"| A2A
    FRONTEND["可视化前端"] -->|"应用自身认证"| VISUAL["可视化应用后端"]
    VISUAL -->|"GET /api/v1/graph + user token"| GRAPH

    subgraph SERVICE["单一 CoWikiHarness Node.js 服务"]
        A2A["A2A 问答与授权写入"]
        GRAPH["Graph REST 确定性只读"]
        AUTH["Authentication"]
        DISPATCH["按入口分流"]
        AGENT["OpenAI Agents SDK Knowledge Agent"]
        TOOLS["强类型知识工具"]
        PROJECTION["图谱投影"]
        POLICY["Access Policy"]
        APP["应用服务"]
        CONNECTORS["现有 Connector provider"]

        A2A --> AUTH
        GRAPH --> AUTH
        AUTH --> DISPATCH
        DISPATCH -->|"仅 A2A"| AGENT
        DISPATCH -->|"仅 Graph REST"| PROJECTION
        AGENT --> TOOLS
        TOOLS --> POLICY
        PROJECTION --> POLICY
        POLICY --> APP
        APP --> CONNECTORS
    end

    APP --> PG[("PostgreSQL")]
    CONNECTORS --> FEISHU["飞书"]
    CONNECTORS --> GITHUB["GitHub"]
    CONNECTORS --> RELAY["可选个人 Local Relay"]
```

### V2 职责归属

| 关注点 | 负责人 |
| --- | --- |
| A2A、身份、知识、任务、图谱和结果合同 | `packages/protocol` |
| 权限、提案/CAS 和其他纯策略 | `packages/core` |
| PostgreSQL、Connector 和云端集成 adapter | `packages/adapters` |
| 强类型 query/register/store/organize 操作和 Agent loop | `packages/knowledge-agent` |
| 带认证的 A2A、只读 Graph REST、任务恢复和进程生命周期 | `apps/knowledge-server` |
| bootstrap、token 和个人 Local Relay 命令 | `apps/cli` |
| bootstrap/refactor 语义流程 | `skills/openlifewiki-knowledge-architect` |
| 持久 Registry、托管 Markdown、grant、任务和审计 | PostgreSQL 17 |

### V2 运行时边界

P0 只包含一个 Node.js 服务、一个 PostgreSQL 实例和可选出站 Local Relay。TLS termination 由宿主提供。只有满足已接受的量化触发条件后，才可以引入 MCP、Codex SDK、Pi、Redis、独立 Worker、对象存储、向量搜索、云端 QMD 或独立管理 UI。

### V2 请求链路

| 入口 | 处理链路 | 输出与副作用 |
| --- | --- | --- |
| A2A | bearer 认证 → delegation → Agent → 强类型操作 → 权限过滤 → PostgreSQL/Connector | 返回引用或操作 Artifact；写入 task 和脱敏审计 |
| 应用后端 `GET /api/v1/graph` | user bearer 认证 → query 校验 → SQL 权限过滤 → 确定性投影 | 返回 `cowikiharness.graph/v1`；不调用模型，不创建 Agent task |

Graph REST 只提供读取。目录创建、移动和知识归档继续通过 A2A 的 `knowledge.collection.create`、`knowledge.collection.move`、`knowledge.place` 操作完成。两条链路在同一个访问策略和 PostgreSQL revision 上收敛，因此可视化结果与授权写入后的 Registry 状态保持一致。

生产可视化应用把 member token 保存在后端 secret store，由后端代理 Graph REST，前端只访问自己的后端。当前 P0 没有独立用户登录/session，生产浏览器不直接调用 Graph REST；显式 user token 文件只用于本机受控调试。精确 CORS allowlist 只约束浏览器读取跨域响应，不承担身份认证，也不能阻止 token 重放。

同一个逻辑知识可以有托管 Markdown、飞书、GitHub 和 person-local location。注册只记录身份和位置，不复制外部或本地正文。组织结构变更必须形成不可变提案，并绑定精确审批和基础 Registry revision。

## Boundary

openLifeWiki owns Source authorization, lifecycle and scan control, public product contracts, policy, component isolation, Selected Agent orchestration, exact proposal approval and atomic Formal Wiki publication. External projects own their retrieval algorithms, platform access, Agent execution, formatting capabilities and private data.

Every external executable follows one rule:

```text
official release or existing authenticated executable
-> versioned public CLI / MCP / SDK
-> openLifeWiki contract validation
-> product-owned receipt
```

The repository contains no copied upstream source, vendor patch tree, QMD private storage access, credential value or durable normalized Source mirror.

## V1 Target Architecture

This section defines the authorized destination. Its components are available only after their delivery task and applicable acceptance gates pass.

```mermaid
flowchart LR
    O["Owner"] --> GUI["Management Companion: seven pages"]
    V["Visitor"] --> MCP["Policy-aware MCP: query only"]
    A["Admin"] --> MCP
    GUI --> API["Application services and role policy"]
    MCP --> API
    API --> CONN["Four Connector providers"]
    CONN --> LF["Local Folder"]
    CONN --> GH["gh public CLI"]
    CONN --> LK["lark-cli public CLI"]
    CONN --> CH["Codex History: version-pinned app-server v2"]
    API --> SCAN["Skeleton / decisions / checkpoints"]
    SCAN --> AGENT["Selected Agent: one of six drivers"]
    SCAN --> QMD["QMD current-generation public CLI/MCP"]
    API --> PROP["WikiProposal + deterministic compiler services"]
    PROP --> CAS["Owner approval + proposal/base hash CAS"]
    CAS --> WIKI["Formal Wiki: OKF v0.2 + Obsidian profile"]
```

### V1 Ownership

| Concern | Owner |
| --- | --- |
| JSON schemas, hashes and public envelopes | `packages/protocol` |
| lifecycle, authorization, scan decisions, progress, policy and proposal/CAS rules | `packages/core` |
| filesystem, process, Connector, QMD, Agent and compiler invocation | `packages/adapters` |
| policy-aware MCP role/tool exposure | `packages/mcp` |
| Owner command surface and recovery | `apps/cli` |
| seven-page local product surface and Canvas session boundary | `packages/companion` |
| canonical Selected Agent procedure | `skills/openlifewiki-progressive-scan` |
| current-source retrieval and index internals | QMD `2.5.3` |
| proven deterministic candidate checks and OKF v0.1 exchange | llm-wiki-compiler `1.1.0` |
| platform access | Local adapter, `gh`, `lark-cli`, Codex public surface |
| semantic scan decisions, grounded answers and WikiProposal content | the one Selected Agent |
| OKF v0.1-to-v0.2 adaptation and portable Wiki validation | openLifeWiki adapter implementing OKF v0.2 plus the Obsidian Compatibility Profile |

### V1 Data Flow

```text
Owner-approved Source scope
-> metadata-only Source Skeleton
-> disposable Layer Summary
-> Selected Agent descend/skip/defer/ask-user decision
-> selected current leaf streams
-> temporary QMD generation + public current/removed probes
-> policy-aware cited query
-> Selected Agent WikiProposal
-> deterministic compiler checks and OKF v0.1 exchange
-> openLifeWiki-owned OKF v0.2/Obsidian adaptation and validation
-> exact Owner approval + compare-and-swap
-> atomic Formal Wiki publication
```

Source bodies remain at the original provider and in QMD's rebuildable current generation. Durable openLifeWiki scan state stores metadata, hashes, decisions, coverage, counters and checkpoints. Layer Summary bodies stay in disposable scratch. The Formal Wiki contains only approved synthesized Concepts.

### V1 Public Surfaces

- Visitor MCP discovery exposes only `query`.
- Admin MCP/API exposes authorized status, scan and proposal management through preview/hash gates.
- Raw provider access, arbitrary paths and QMD private access are absent for every role.
- Management Companion has Query, Sources, Wiki, Review, Agent, Canvas and Health pages.
- Canvas carries one task-bound screen/event exchange and owns no durable lifecycle, scan or proposal truth.

## Current Implemented P0

The repository currently implements a narrower chain:

```mermaid
flowchart LR
    O["Owner"] --> C["P0 local Management Companion"]
    C --> APP["CLI/core/adapters lifecycle services"]
    APP --> L["one default Local Folder glob"]
    APP --> Q["QMD 2.5.3 public CLI"]
    H["existing Agent host"] --> M["openlifewiki stdio launcher"]
    M --> U["QMD upstream MCP"]
```

Implemented P0 behavior includes initialization, approval-gated activation of one default local Markdown folder, isolated QMD installation/config/cache, a real retrieval gate, direct QMD stdio MCP launch and a loopback-only Management Companion for lifecycle, Source activation, Codex registration guidance/action and health.

The following V1 capabilities remain pending until executable acceptance proves them: four Connector descriptors/providers, skeleton-first progressive scan, truthful multidimensional progress, restart checkpoints, six normalized Agent drivers, policy-aware MCP, WikiProposal/CAS publication, deterministic llm-wiki-compiler/OKF v0.1 exchange integration, the openLifeWiki-owned OKF v0.2/Obsidian adapter and the complete seven-page GUI.

`ACTIVE` currently proves the P0 authorized retrieval path. It cannot represent V1 completion, four-Connector readiness or Formal Wiki publication.

## Runtime And Workspace

```text
<platform application-data>/openLifeWiki/
  config.json                 authorization and Agent bindings
  state.json                  completed stable state and receipts
  components/                 isolated official releases
  data/qmd/generations/       rebuildable current-source generations
  data/connectors/            skeleton metadata and cursors
  data/scans/                 decisions, hashes, counters and checkpoints
  data/proposals/             immutable review candidates and receipts
  runtime/                    locks, leases and disposable scratch
  logs/                       redacted operational logs

~/openLifeWiki/
  sources/                    visible local Source root
  wiki/                       Owner-approved Formal Wiki / Obsidian Vault
```

The host platform convention selects the runtime root. `OPENLIFEWIKI_HOME` and `OPENLIFEWIKI_WORKSPACE` override runtime and visible roots independently for isolated tests. Initialization creates directories and reads no Source content. QMD receives a fixed working directory plus isolated configuration/cache paths, and its config/index/database remain opaque.

## Delivery Order

1. Pure protocol/core contracts.
2. Four-Connector visibility and authorization.
3. Local skeleton-first scan through a real current-only QMD generation.
4. Public-contract expansion to `gh`, `lark-cli` and version-pinned Codex app-server v2.
5. Six Agent drivers, canonical Skill and policy-aware MCP.
6. Selected Agent WikiProposal, deterministic compiler reuse, OKF/Obsidian validation and CAS publication.
7. Seven-page Management Companion and task-bound Canvas.
8. Real Full Journey and all acceptance veto gates.

The V1 delivery plan must freeze the detailed file map, first failing tests, verification commands and review gates before implementation begins.
