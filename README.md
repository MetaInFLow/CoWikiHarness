# openLifeWiki

> 一份由你掌控、供所有 AI Agent 共同使用的本地知识中枢。

当你长期使用 Codex、Claude Code、Gemini CLI、OpenClaw 等 Agent，真正有价值的背景、判断和经验会散落在文件、项目、聊天与不同平台里。每次换 Agent、换项目或开启新对话，都要重新解释自己。

openLifeWiki 希望把这些经过授权的资料连接起来，让任何 Agent 都能查到同一份当前知识、给出可核对的原文依据，并在你确认后持续更新长期 Wiki。

```text
连接资料 → 向任意 Agent 提问 → 核对引用 → 确认知识更新 → 继续复用
```

> **开发状态：Pre-alpha。** 当前仓库已经完成可验证的产品骨架，尚未提供面向个人用户的安装包，也还不能接入真实资料或完成知识问答。首个可用版本将以“本地文件夹 → Codex 引用回答 → 人工确认写入 Wiki”为验收闭环。

## 它解决什么问题

- **背景四处分散**：文件、GitHub、飞书和 Agent 历史分别保存一部分信息。
- **每次重新解释**：新 Agent 和新会话不了解过去的项目、偏好与判断。
- **回答难以核对**：结论看似合理，却找不到对应的原文与版本。
- **长期知识失控**：自动生成内容越积越多，错误、重复和过期判断持续混入上下文。

openLifeWiki 的目标是让个人知识具备四个特征：**同一入口、原文可查、更新可控、长期可迁移**。

## 你会怎么用

### 1. 连接自己的资料

你明确选择允许读取的文件夹或平台范围。openLifeWiki 只处理已授权内容，不扫描整台电脑。

V1 计划支持本地文件夹、GitHub、飞书和 Codex 历史。

### 2. 在当前 Agent 中直接提问

例如：

```text
我过去对“自演化 Skill”形成过哪些判断？
请区分事实、历史判断和当前建议，并给出原文位置。
```

你继续使用已经熟悉的 Agent 及其账号、模型和工具，无需迁移到新的聊天产品。

### 3. 核对回答依据

回答中的事实会指向原始资料及具体位置。资料不足、彼此冲突或已经过期时，结果会明确显示缺口。

### 4. 决定哪些内容值得长期保留

Agent 可以提交 Wiki 更新建议。你会看到修改内容、修改原因、证据和差异；只有你确认的精确版本才能写入正式 Wiki。

### 5. 在其他工具里继续使用

正式 Wiki 使用本地 Markdown 保存，可由 Git、Obsidian 和其他文本工具直接读取。即使 openLifeWiki 停止运行，知识文件仍然属于你并可继续迁移。

## V1 能力范围

| 能力 | 带来的结果 |
| --- | --- |
| 资料连接 | 接入明确授权的本地文件夹、GitHub、飞书和 Codex 历史 |
| 引用问答 | Agent 根据当前资料回答，并提供可打开的原文依据 |
| 知识提案 | Agent 把值得沉淀的结论整理成可审阅的修改建议 |
| 人工确认 | 长期知识发生变化前，由本人检查证据与差异 |
| 多 Agent 复用 | Codex、Claude Code、Gemini CLI、Pi、OpenClaw 和 Hermes 使用同一知识入口 |
| 本地管理 | 管理资料来源、正式 Wiki、待审提案、Agent 和运行状态 |
| 开放存储 | 正式知识保存在 Markdown 中，并支持 Git 版本记录与开放格式导出 |

团队共享、多人权限和远程协作不在 V1 范围内。openLifeWiki 首先把单人、多 Agent 的完整闭环做通。

## 当前仓库有什么

当前代码提供一套最小产品骨架，用于锁定产品边界并验证外部组件的组合方式：

- 一份外部组件与资料来源目录；
- 对本机依赖和 Agent 命令的只读检查；
- 产品能力、组件能力和开发阶段的机器可读状态；
- 已通过评审的 V1 架构与直接复用决策；
- 自动构建、类型检查和测试。

当前尚未支持任何真实用户旅程。开发状态命令会如实返回：

```json
{
  "status": "SKELETON_READY",
  "supportedJourneys": [],
  "nextSlice": "identity-kernel-mcp-contracts"
}
```

## 开发者运行方式

> 下面的命令用于检查仓库骨架，暂时无法安装出可供日常使用的个人知识中枢。

环境要求：Node.js `24.16.0`、pnpm `10.33.2`。

```bash
pnpm install --frozen-lockfile
pnpm verify

pnpm openlifewiki features --json
pnpm openlifewiki capabilities --json
pnpm openlifewiki doctor --json
pnpm openlifewiki status --json
```

`doctor` 只检查所需组件是否存在，不启动第三方 Agent，也不读取或复制登录信息。

## 实现原则

openLifeWiki 只负责个人知识产品必须拥有的控制层：身份与授权、稳定知识标识、来源关系、引用校验、知识提案、人工确认、安全写入和本地管理。

成熟能力直接使用现有开源项目和原生工具：

- [QMD](https://github.com/tobi/qmd)：索引、检索和原文读取；
- [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler)：Wiki 检查、浏览、上下文生成和开放格式导出；
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：Agent 与知识服务之间的标准协议；
- Codex、Claude Code、Gemini CLI、Pi、OpenClaw、Hermes：保留各自已有的 Agent 能力；
- `gh` 与 `lark-cli`：复用 GitHub 和飞书的原生登录与访问能力；
- Git 与 Markdown：保留版本、差异、回滚和迁移能力。

项目不会重复开发检索引擎、通用模型网关、Agent 运行循环、平台登录客户端或插件市场。

## 数据边界

- 原始资料保留在原位置；
- 系统只读取明确授权的资料范围；
- 检索索引属于可删除、可重建的本地数据；
- 系统不长期保存历史资料正文副本；
- Agent 凭证继续由原生工具或系统安全存储管理；
- Token、隐藏推理和私密正文不会写入 Wiki 或运行报告；
- Agent 提案必须经过人工确认，才能改变正式知识。

## 交付顺序

1. 身份、授权、知识内核和只读/管理接口；
2. 本地文件夹 → QMD → Codex → 带引用回答；
3. 知识提案 → 人工确认 → Markdown Wiki 安全写入；
4. 补齐其他 Agent 与资料来源；
5. 本地管理界面；
6. 安装、更新、卸载和发布验收。

每一步都需要通过真实使用闭环、安全检查和恢复测试，才会标记为可用。

## 项目文档

- [V1 架构设计](docs/architecture/design.md)
- [直接复用与骨架重置决策](docs/adr/0003-direct-reuse-skeleton-reset.md)
- [当前开发基线](docs/development/plans/2026-07-20-skeleton-first-component-composition.md)

## License

[MIT](LICENSE)。外部组件保留各自的 License 和归属说明。
