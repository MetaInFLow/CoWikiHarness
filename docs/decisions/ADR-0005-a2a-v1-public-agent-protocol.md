# ADR 0005：采用 A2A v1 作为公共 Agent 协议

- 状态：V2 已接受
- 日期：2026-08-15
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## 背景

外部 Agent 需要一种稳定方式，请求云端 Knowledge Agent 查询、注册、存储和整理知识。交互范围包括自然语言消息、结构化结果、流式进度、取消，以及可持久恢复的 `input-required` 暂停。V1 MCP 是本地工具接口，会让每个调用方自行编排知识操作。

## 决策

V2 通过 `@a2a-js/sdk` `1.0.1`，在 HTTPS 上提供 A2A v1 JSON-RPC 和 SSE 流式传输。Agent Card 声明四项能力：`knowledge.query`、`knowledge.register`、`knowledge.store` 和 `knowledge.organize`。

公共交互单元是 Agent task。已认证请求必须先持久化再执行；状态变化映射为 A2A task state；最终 Artifact 携带带版本的 openLifeWiki 结果合同。自然语言输入和结构化 operation part 最终进入同一组强类型应用操作。

V2 云端 P0 不提供 MCP。现有 V1 本地 MCP 链路仅作为兼容能力保留。

## 影响

- 调用方只与一个 Knowledge Agent 通信，不能直接调用 Connector；
- 任务进度、取消、人工输入暂停和本地输入暂停都有协议级状态；
- 领域逻辑与权限控制位于 A2A 传输边界之下；
- 后续可替换客户端实现，无需改变知识合同；
- A2A 协议一致性和信息泄漏测试是发布门禁。

## 未采用方案

### 公共 MCP

MCP 向调用方控制的 Agent loop 暴露工具。V2 要求云端 Knowledge Agent 自己控制 loop，并作为唯一语义入口。

### 私有 HTTP 接口

自定义接口会重复实现 A2A 已经提供的任务、流式传输和 Agent discovery 合同。

### ACP

ACP 适合编辑器与编程 Agent 之间的会话。对于本项目所需的服务到 Agent 的任务与 Artifact 边界，A2A 更直接。
