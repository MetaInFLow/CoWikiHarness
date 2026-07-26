# openLifeWiki

> 让本地 AI Agent 使用同一份本人授权资料，并能返回可核对的来源。

openLifeWiki 是本地优先的个人知识入口。当前版本提供产品管理 GUI，用来完成初始化、资料激活、Agent 接入和运行检查；底层复用 QMD 建立索引，并通过 QMD 已有的 MCP 提供 `query`、`get`、`multi_get` 和 `status` 工具。

## 当前状态

- 开发分支：`goal-v1-progressive-scan`
- 可用方式：从源码运行
- 已打通：`本地 Markdown → QMD 2.5.3 → 本地 stdio MCP`
- 已提供：本地产品管理 GUI、初始化与激活预览、四类 Source 授权/连接检查、Codex MCP 接入、健康检查
- 已完成的 V1 地基：Local Folder、GitHub `gh`、指定 profile 的 `lark-cli`、Codex app-server 四类 metadata-only 连接；单一 Host config；授权预览、确认、缩小和撤销
- 尚未提供：分层 Source Skeleton、Agent 渐进扫描、扫描进度工作区、自动整理 Wiki、Obsidian 发布、正式安装包
- `main` 仍为旧基线；当前 V1 实现以 `goal-v1-progressive-scan` 为准

这版已经通过真实组件测试：安装官方 QMD Release、建立隔离索引、完成一次带路径的检索，并完成 MCP 握手和工具清单校验。

## 本地打开产品管理 GUI

准备一次开发环境后启动：

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
git switch goal-v1-progressive-scan
./scripts/bootstrap_dev_env.sh
pnpm openlifewiki companion --open --json
```

浏览器会打开只监听本机的管理页面。启动命令保持运行，关闭终端或在 GUI 的“运行健康”页停止服务即可退出。

| 页面 | 能完成的事情 |
| --- | --- |
| 总览 | 看当前阶段、下一步、默认目录和依赖健康情况 |
| 知识来源 | 管理四类 Connector 的精确范围、身份、连接状态；保留 P0 Markdown 激活入口 |
| Agent 接入 | 查看 MCP 能力、复制启动命令、把 openLifeWiki 注册到 Codex |
| 运行健康 | 检查本地服务与 QMD 状态，停止本次管理服务 |

当前本机状态为 `INITIALIZED`。把 Markdown 放进 `~/openLifeWiki/sources/` 后，在“知识来源”页确认激活；状态进入 `ACTIVE` 后再到“Agent 接入”页注册 Codex。

## 有什么用

1. 给多个本地 Agent 一个稳定的个人资料入口。
2. 分别授权本地目录、GitHub、飞书和 Codex 历史的精确范围。
3. 通过当前 P0 QMD 链路返回可继续读取的本地 Markdown 路径和内容。
4. 把程序状态、索引和个人资料分开，便于备份、迁移和清理。
5. 明确区分初始化、激活和使用，失败时不会提前标记为可用。

## 默认地址

| 内容 | 默认地址 | 说明 |
| --- | --- | --- |
| 程序运行数据（macOS） | `~/Library/Application Support/openLifeWiki/` | 组件、配置、状态、索引和日志；可重建 |
| 个人知识目录 | `~/openLifeWiki/` | 用户可见、可备份、可迁移 |
| 默认资料入口 | `~/openLifeWiki/sources/` | P0 只读取其中的 Markdown |
| 正式知识目录 | `~/openLifeWiki/wiki/` | 为后续确认后的长期知识预留 |
| QMD 配置（macOS） | `~/Library/Application Support/openLifeWiki/data/qmd/config/` | 与用户全局 QMD 配置隔离 |
| QMD 缓存和索引（macOS） | `~/Library/Application Support/openLifeWiki/data/qmd/cache/` | 可删除并重建 |

Linux 使用 `${XDG_DATA_HOME:-~/.local/share}/openlifewiki/`，Windows 使用 `%LOCALAPPDATA%\openLifeWiki\`。工程原则：用户资产放在可见目录，程序资产放在系统应用数据目录；MCP 默认使用 stdio，不占用固定端口；QMD 启动目录固定在 openLifeWiki 运行目录，避免误用其他项目的 `.qmd` 配置。

需要改地址时，可在初始化前设置：

```bash
export OPENLIFEWIKI_HOME="$HOME/Library/Application Support/openLifeWiki"
export OPENLIFEWIKI_WORKSPACE="$HOME/openLifeWiki"
```

两个变量互相独立。没有特殊情况时，建议保留默认值。

## 命令行使用

### 1. 准备开发环境

要求 Node.js `>=24.16.0 <25`、pnpm `10.33.2`，并可访问 npm registry。

Homebrew 的 `node@24` 为独立版本时，先让当前终端使用它：

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version
```

```bash
git switch goal-v1-progressive-scan
./scripts/bootstrap_dev_env.sh
```

### 2. 初始化

先看将要创建和下载的内容：

```bash
pnpm openlifewiki init --dry-run --json
```

确认后执行：

```bash
pnpm openlifewiki init --yes --json
pnpm openlifewiki doctor --json
```

初始化会创建默认目录，并从官方 npm Release 安装 QMD `2.5.3`。它不会读取 `sources/`，也不会修改 Codex 配置。完成状态为 `INITIALIZED`。

### 3. 放入资料

把需要查询的 `.md` 文件放入：

```text
~/openLifeWiki/sources/
```

P0 不会扫描 Home、AF-wiki、Codex 历史或其他目录。

### 4. 激活默认资料

先看授权范围和写入内容：

```bash
pnpm openlifewiki activate --dry-run --json
```

确认后建立索引并做真实检索检查：

```bash
pnpm openlifewiki activate --yes --json
pnpm openlifewiki status --json
```

资料为空时返回 `source-empty`，状态保持 `INITIALIZED`。只有检索返回可解析文件路径后，状态才进入 `ACTIVE`。

### 5. 启动本地 MCP

直接运行：

```bash
pnpm openlifewiki mcp --stdio
```

stdio 模式由 Agent 按需启动，不需要端口或常驻服务。标准输出只承载 MCP 协议，错误信息进入标准错误。

### 6. 接入 Codex

在仓库根目录执行：

```bash
codex mcp add --env PATH="/opt/homebrew/opt/node@24/bin:$PATH" openlifewiki -- pnpm --dir "$PWD" openlifewiki mcp --stdio
codex mcp get openlifewiki
```

之后可让 Codex 使用 `openlifewiki` 的 `query` 查找资料，再用 `get` 读取完整内容。P0 建议先用 `type: lex`、`rerank: false`，它无需下载本地模型；语义检索会在首次使用时由 QMD 下载约 2 GB 模型到隔离缓存。Codex 保留原有登录状态，openLifeWiki 不复制凭证。

## 软件阶段

| 阶段 | 需要具备 | 完成证明 |
| --- | --- | --- |
| 发现 | README、Install Skill、权限说明 | 未写入本机 |
| 安装 | CLI、Skill、版本信息 | `--version` 和 `status` 可运行 |
| 初始化 | 默认目录、配置、QMD 2.5.3 | `INITIALIZED`，QMD 版本和完整性通过 |
| 激活 | 至少一份 Markdown、QMD collection、检索 smoke | `ACTIVE`，返回可解析资料路径 |
| 使用 | 本地 stdio MCP、Agent 注册 | MCP 可列出并调用四个上游工具 |
| 维护 | `doctor`、重建和更新预览 | 现有使用链路继续通过 |
| 卸载 | 移除注册、组件和索引 | 默认保留 `~/openLifeWiki/` |

完整阶段合同见 [产品生命周期](docs/product-lifecycle.md)。

## 实现边界

- 仓库不保存 QMD 或其他开源项目源码。
- QMD 由初始化流程安装官方 npm Release，并通过公开 CLI/MCP 调用。
- openLifeWiki 当前没有再实现一套 MCP Server；`openlifewiki mcp --stdio` 负责状态校验、目录隔离和启动 QMD MCP。
- 每次 MCP 启动都会核对仅存在默认 collection、路径和 glob 与授权记录一致，并先刷新索引。
- 激活前不读取资料；MCP 仅在 `ACTIVE` 后启动。
- P0 只支持默认目录内的 Markdown。

## 仓库结构

```text
apps/cli/                 生命周期和管理命令
packages/protocol/        对外 JSON 合同与稳定类型
packages/core/            生命周期、默认阶段和组件规则
packages/adapters/        文件系统、QMD 安装、激活和 MCP 启动
packages/companion/       本地产品管理服务和响应式 GUI
skills/openlifewiki-install/
                          安装、初始化和激活操作流程
docs/requirements/        已确认的产品需求
docs/design/              当前和历史设计
docs/governance/          目录、术语和变更记录
docs/memory-bank/         当前工程上下文
docs/archive/             已废弃方案，只读参考
```

## 开发验证

```bash
pnpm verify
pnpm test:component:qmd
```

第二条命令会联网安装真实 QMD Release，并验证真实 Source、检索和 MCP 握手。详细规则见 [DEVELOPMENT.md](DEVELOPMENT.md) 和 [BRANCHING.md](BRANCHING.md)。

## License

[MIT](LICENSE)。外部组件保留各自的 License 和归属。
