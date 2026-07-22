# openLifeWiki

> 让一个人的所有 AI Agent 使用同一份本地知识，并能核对来源、控制更新。

openLifeWiki 是本地优先的个人知识中枢。它连接本人明确授权的资料，通过现有 Agent 提供带引用的回答，并把长期知识保存为可迁移的 Markdown。

## 当前开发基线

- 稳定分支：`main`
- 集成分支：`dev`
- 当前工程阶段：生命周期与安装骨架
- 当前可用状态：尚未开放个人知识问答
- P0 唯一闭环：`本地文件夹 → QMD → MCP → Codex 引用回答`

当前分支只建立生命周期、组件边界和可验证入口。QMD 由初始化流程安装并通过公开 CLI/MCP 调用；仓库不保存 QMD、llm-wiki-compiler 或 Agent 的源码。

## 产品生命周期

| 阶段 | 用户看到的结果 | 阶段完成条件 |
| --- | --- | --- |
| 发现 | Agent 能读取安装 Skill，并解释权限与变更范围 | 未发生本机写入 |
| 安装 | `openlifewiki` 命令和安装 Skill 已就位 | `openlifewiki --help`、版本检查通过 |
| 初始化 | 建立本地运行目录并安装 P0 依赖 QMD | 状态为 `INITIALIZED`，QMD 版本合同通过 |
| 激活 | 授权一个资料目录，并把只读 MCP 接入 Codex | 状态为 `ACTIVE`，引用问答 smoke 通过 |
| 使用 | Agent 可以查询当前资料并返回原文依据 | 每个答案均包含可解析引用 |
| 维护 | 检查健康、预览更新、修复或回滚组件 | `doctor` 无阻塞项，更新可恢复 |
| 卸载 | 移除运行时与 Agent 注册 | 默认保留正式 Wiki 和卸载记录 |

生命周期的完整输入、产物、验收和失败恢复见 [产品生命周期](docs/product-lifecycle.md)。

## 运行状态

生命周期描述用户正在做什么，运行状态回答软件现在能否使用：

```text
INSTALLED → INITIALIZED → ACTIVE
                  ↘ DEGRADED
```

- `INSTALLED`：产品命令存在，初始化尚未完成。
- `INITIALIZED`：运行目录和 P0 依赖已准备好，尚未授权资料或接入 Agent。
- `ACTIVE`：至少一个资料来源和一个 Agent 接入通过真实 smoke。
- `DEGRADED`：已经初始化或激活，但依赖、来源或 Agent 合同失败。

## 安装与初始化

安装由 [`openlifewiki-install`](skills/openlifewiki-install/SKILL.md) Skill 引导。它先生成变更预览，经本人确认后再执行初始化。

开发分支当前入口：

```bash
pnpm install --frozen-lockfile
pnpm verify

pnpm openlifewiki lifecycle --json
pnpm openlifewiki status --json
pnpm openlifewiki init --dry-run --json
```

确认预览后，初始化命令为：

```bash
pnpm openlifewiki init --yes --json
pnpm openlifewiki doctor --json
```

初始化会创建 `~/.openlifewiki/`，并把 QMD `2.5.3` 安装到隔离的组件目录。它不会扫描资料、读取 Agent 历史、修改 Agent 配置或安装后续阶段组件。

## 每个阶段安装什么

| 阶段 | 外部组件 | 使用方式 |
| --- | --- | --- |
| 初始化 | QMD `2.5.3` | 安装官方 npm Release，调用 CLI/MCP |
| 激活 P0 | 用户已有的 Codex | 检查原生登录，注册任务级 MCP |
| GitHub Source | `gh` | 检查或引导安装官方 CLI，再调用命令 |
| 飞书 Source | `lark-cli` | 安装官方 Release，再调用命令 |
| Wiki 管理 | llm-wiki-compiler | 到该阶段才安装，调用公开 CLI |
| 其他 Agent | 对应 Agent CLI | 用户选择后检查并调用，不随初始化批量安装 |

MCP SDK 属于 openLifeWiki 的开发依赖，用于实现标准服务接口。它不会作为独立软件安装到用户组件目录。

## 仓库结构

```text
apps/cli/                 生命周期和管理命令
packages/protocol/        对外 JSON 合同与稳定类型
packages/core/            生命周期规则和组件发布清单
packages/adapters/        文件系统、进程和安装适配
skills/openlifewiki-install/
                          Agent 可执行的安装与初始化流程
docs/requirements/        Owner 确认的产品需求
docs/design/              当前、待办和已完成设计
docs/governance/          目录、术语和变更记录
docs/memory-bank/         当前工程上下文
docs/archive/             历史方案，只读参考
```

## 开发入口

先阅读：

1. [需求基线](docs/requirements/requirements-v0.1.md)
2. [产品生命周期](docs/product-lifecycle.md)
3. [架构](ARCHITECTURE.md)
4. [项目红线](CONSTITUTION.md)
5. [当前上下文](docs/memory-bank/active-context.md)

本地验证：

```bash
./scripts/bootstrap_dev_env.sh
pnpm verify
```

详细规则见 [DEVELOPMENT.md](DEVELOPMENT.md) 和 [BRANCHING.md](BRANCHING.md)。

## License

[MIT](LICENSE)。外部组件保留各自的 License 和归属。
