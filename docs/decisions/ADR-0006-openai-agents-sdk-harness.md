# ADR 0006：采用 OpenAI Agents SDK 作为 P0 Harness

- 状态：V2 已接受
- 日期：2026-08-15
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## 背景

Knowledge Agent 需要模型 loop、强类型工具调用、流式输出、会话续接、审批暂停和 tracing。openLifeWiki 必须继续掌握领域权限、持久任务状态和数据库写入。

## 决策

V2 P0 只使用 `@openai/agents` `0.16.0` 作为 Agent runtime。部署模型必须通过 `OPENLIFEWIKI_MODEL` 指定。SDK 只接收一组固定的精简工具；每个工具的实现都必须携带 `AccessContext`，并调用强类型 openLifeWiki 应用操作。

任何工具都不得接收 SQL、任意命令、无限制路径或原始 Connector 请求。SDK 可以决定调用哪个已授权工具；应用服务负责判断操作是否允许，并执行每次持久化变更。

## 影响

- openLifeWiki 无需自行实现重复的工具 loop 和流式处理；
- 公共 A2A 合同和知识合同保持独立于模型提供商；
- SDK 支持的续接状态与产品任务一同持久化；
- 缺少模型配置时启动失败；
- 工具 schema、prompt injection 和权限测试是发布门禁。

## 未采用方案

### Codex SDK

TypeScript Codex SDK 以编程 thread 为中心，不直接提供应用 function tool 回调。用于本场景还需要额外增加 MCP bridge 或依赖更底层的 app-server。

### 原始 OpenAI Responses API

Responses API 提供 function call，但 openLifeWiki 需要自行实现 loop、流式输出、审批和续接行为。

### Pi 或多个 Runtime

在没有量化需求之前，引入第二个 runtime 会提前增加提供商和行为选择。只有满足设计文档中的扩展触发条件后，才重新评估。
