# ADR 0007：采用 PostgreSQL 作为 V2 持久事实源

- 状态：V2 已接受
- 日期：2026-08-15
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## 背景

云端服务需要处理并发用户、受托 Agent、授权、不可变版本、持久任务、追加式审计和精确提案审批。系统需要在一个可运维的数据存储中同时获得事务、行级并发控制、重启恢复和有效文本检索能力。

## 决策

V2 采用 PostgreSQL 17，通过 `pg` 和有序 SQL migration 管理数据库。PostgreSQL 是 P0 唯一的持久化应用数据库，用于保存知识注册信息、托管 Markdown 版本、权限、委托、会话、任务、提案和审计。

部署启用 `pg_trgm`。搜索先完成权限过滤，再组合精确字段匹配、PostgreSQL 全文搜索和 trigram 相似度。可变记录使用单调递增 revision 和 compare-and-swap；任务领取使用 PostgreSQL advisory lock。

每个不可变托管 Markdown 版本上限为 1 MiB。已有外部和本地正文继续留在原位置；只有单独获批的 store 操作才能创建托管版本。

## 影响

- 单一事务可以绑定变更、Artifact 和审计结果；
- P0 不需要 Redis、向量数据库、对象存储或 ORM；
- SQL migration 和回滚流程成为发布产物；
- 备份与隔离恢复是验收要求；
- 正文增长和检索质量需要对照扩展触发条件持续测量。

## 未采用方案

### SQLite

SQLite 适合 V1 本地进程，但用于中央多人任务领取、并发写入和云端运行时，会增加可以避免的协调约束。

### 独立向量或搜索服务

P0 可以先用 PostgreSQL 文本和 trigram 能力验证检索。只有证据表明既定检索基准无法达成时，才引入独立服务。

### Markdown 对象存储

初期有上限的文本语料可以放入事务数据库。只有实测容量或备份行为达到设计触发条件时，才引入对象存储。
