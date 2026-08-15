# ADR 0008：保持 V2 P0 运行时最简

- 状态：V2 已接受
- 日期：2026-08-15
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## 背景

产品首先要验证中央知识注册中心和 Agent 入口。核心使用链路尚未验证前，增加队列、存储、runtime 和管理界面会成倍增加部署成本和故障模式。

## 决策

P0 运行时只包含：

1. 一个 Node.js openLifeWiki 服务：在宿主 TLS 之后处理 HTTPS，并负责 A2A、认证、Agents SDK 执行、强类型操作、Connector 编排和进程内持久任务执行；
2. 一个 PostgreSQL 实例；
3. 可选的个人电脑出站 `openlifewiki relay` 进程。

P0 排除云端边界 MCP、Codex SDK、Pi、Redis、独立 Worker、对象存储、向量数据库、云端 QMD 和独立管理后台。V1 本地链路继续保留在同一仓库中，迁移它并非 V2 的前置条件。

每个排除组件在活动设计中都有量化触发条件。引入其中任何一个，都必须新增 ADR，说明证据、运维成本、回滚和退出路径。

## 影响

- 第一个可用云端切片只需一个进程和一个数据库即可运行；
- 任务持久性位于 PostgreSQL，初期执行留在同一进程；
- 宿主 TLS、备份和密钥注入仍是部署职责；
- 扩展决策推迟到工作负载或验收证据确实需要时；
- 实现必须保留 package 边界，但不为每项内部职责创建独立部署服务。

## 未采用方案

### 从第一天引入队列和 Worker

当前没有量化工作负载要求拆分进程。PostgreSQL 任务状态和 advisory lock 已能提供初始持久性与领取边界。

### 完整管理 Web 应用

CLI 初始化/token 流程和 A2A 审批足以验证 P0。只有 Owner 可用性验收失败时，才增加 UI。

### 云端 QMD

QMD 对 V1 本地链路仍有价值。V2 先验证 PostgreSQL 检索；只有达到检索和可运维性触发条件后，才考虑云端 QMD。
