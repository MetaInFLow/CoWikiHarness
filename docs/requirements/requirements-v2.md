# openLifeWiki V2 需求说明

- 状态：已批准实施
- 日期：2026-08-15
- 读者：产品负责人、实施团队、验收人员
- 范围：单组织、多人使用的云端知识中心
- 替代关系：云端及多人场景由 V2 接管
- 兼容关系：V1 本地模式继续保留
- 设计文档：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

## 一、产品决策

openLifeWiki V2 是部署在云端的单一知识 Agent，统一负责知识查询、注册、存储和整理。用户及其授权的外部 Agent 通过 A2A v1 使用它。PostgreSQL 保存中央知识注册信息和托管 Markdown；知识正文也可以继续留在飞书、GitHub 或个人电脑中，需要时再通过已授权的 Connector 获取。

## 二、目标结果

一个组织只需注册一次知识，即可记录同一知识的多个位置，控制哪些人和哪些受托 Agent 可以使用，并基于准确版本、来源和引用进行检索。外部平台或个人电脑暂时不可访问时，系统必须如实反馈，不得伪造成功或无依据回答。

## 三、参与角色

| 角色 | 权限与职责 |
| --- | --- |
| 组织 Owner | 初始化部署、管理成员和授权、批准高影响变更 |
| 成员 | 在明确授权范围内查询、注册和管理知识 |
| 外部 Agent | 代表某一成员，在有效委托范围内执行操作 |
| Knowledge Agent | 提供唯一的查询、注册、存储和整理入口 |
| Local Relay | 表示某位用户的设备在线，并获取精确授权的本地知识 |

## 四、功能需求

### R-V2-01 单一 Agent 入口

云端服务通过 HTTPS 暴露 A2A v1，并支持任务状态流式更新。Agent Card 最终提供 `knowledge.query`、`knowledge.register`、`knowledge.store` 和 `knowledge.organize` 四项能力。外部调用方不得直接访问 Connector、数据库或索引。

### R-V2-02 身份与委托

每次操作必须识别组织、调用者、被代表的人、委托和任务。实际权限取以下三者交集：人的资源授权、Agent 的操作能力、有效委托的操作与资源边界。缺失、过期或撤销的权限必须拒绝，且不得泄露隐藏资源的元数据。

### R-V2-03 知识注册中心

注册中心必须分离稳定的逻辑知识、知识位置和不可变版本。同一知识可以有多个位置，并明确记录位置角色、Owner、可见范围、标签、别名、来源、时效、平台版本和当前可用状态。

### R-V2-04 注册不复制正文

注册只创建或关联知识与位置元数据。注册飞书、GitHub 或个人本地位置时，不得自动复制正文。相同 locator 的重复注册必须幂等。疑似重复的逻辑知识必须由用户确认后才能合并身份。

### R-V2-05 托管 Markdown

有写权限的用户可以把 UTF-8 Markdown 存入 PostgreSQL。每个不可变版本必须记录 SHA-256 正文哈希和来源。单版本上限为 1 MiB。替换当前稳定内容前，必须生成精确预览并校验预期 revision。

### R-V2-06 查询与引用

搜索必须先在 PostgreSQL 中过滤权限，再生成候选结果。P0 支持知识 ID、locator、标签和别名精确匹配，以及 PostgreSQL 全文和 trigram 搜索。每个回答必须引用精确的 item、location 和 version ID。没有证据时必须返回明确的无证据结果。

### R-V2-07 外部知识位置

飞书和 GitHub 的读取必须复用已有 Connector 合同和精确 Source 授权。凭据只能以部署密钥引用存在，不得写入 Registry。返回证据必须绑定 Source、节点、平台版本和授权记录。

### R-V2-08 个人本地知识

Local Relay 只发起出站 HTTPS 连接，维护短期在线租约，并且只处理其 Owner 与精确 Source 范围内的任务请求。设备离线时，任务进入 `input-required`，原因是 `LOCAL_SOURCE_OFFLINE`；有效 Relay 恢复在线后，可以继续同一个持久任务。

### R-V2-09 知识架构整理

Knowledge Architect Skill 提供 `bootstrap` 和 `refactor` 两种模式。两种模式都只产生不可变、可审阅的提案。持久化整理操作必须绑定精确 proposal hash 和基础 Registry revision，经人工批准后再通过单一事务执行 compare-and-swap。

### R-V2-10 持久任务与恢复

任务必须先持久化再执行。只有最终产物和审计记录成功提交后才能报告完成。进程重启后，有有效续跑状态的任务继续执行；无法安全恢复的任务必须明确失败并返回 `TASK_INTERRUPTED`。取消操作必须进入终态 `canceled`。

### R-V2-11 审计

每次变更和拒绝都必须写入追加式审计事件，至少记录 actor、action、target、decision 和 receipt 元数据。审计中不得出现 token、凭据或未脱敏正文。

### R-V2-12 V1 兼容

P0 期间，源码运行的 V1 本地链路必须继续可用。V2 不得静默替换或削弱 V1 的 Source 授权、receipt、hash、正文读取、提案审批和 fail-closed 行为。

## 五、运行要求

| 编号 | 要求 | 验收口径 |
| --- | --- | --- |
| O-V2-01 | 最小运行时 | 只有一个 Node.js 服务、PostgreSQL 和可选 Relay |
| O-V2-02 | 必填模型 | 缺少 `OPENLIFEWIKI_MODEL` 时启动必须明确失败 |
| O-V2-03 | 并发 | 可变记录使用 expected revision；任务领取使用 PostgreSQL advisory lock |
| O-V2-04 | 备份 | 隔离恢复 PostgreSQL 后，知识引用身份保持不变 |
| O-V2-05 | 安全 | bearer token 为随机 256 bit、只显示一次，数据库只保存带密钥摘要 |
| O-V2-06 | 搜索 | 私有记录在排序和进入 Agent 上下文前完成过滤 |
| O-V2-07 | 验证 | schema、build、typecheck、单元、集成和 A2A 合同测试全部通过 |

## 六、P0 组件边界

P0 在现有 TypeScript workspace 中只增加 `@openai/agents`、`@a2a-js/sdk`、`pg`、PostgreSQL 17 和 `pg_trgm`。云端 MCP、Codex SDK、Pi、Redis、独立 Worker、对象存储、向量搜索、云端 QMD 和独立管理后台均不在 P0 范围内。增加任何组件前，必须满足活动设计文档中的量化触发条件，并新增 ADR。

## 七、验收旅程

| 编号 | 通过条件 |
| --- | --- |
| V2-AC-01 | 两位用户和两个受托 Agent 可以独立认证 |
| V2-AC-02 | 私有知识对另一位用户及其 Agent 完全不可见 |
| V2-AC-03 | 明确共享的托管 Markdown 可通过 A2A 查询，并返回可解析引用 |
| V2-AC-04 | 托管 Markdown、飞书、GitHub 和个人本地位置均可注册 |
| V2-AC-05 | 注册过程不复制外部或本地正文 |
| V2-AC-06 | 本地设备离线时任务如实暂停，Relay 恢复后继续 |
| V2-AC-07 | bootstrap/refactor 提案都需要精确审批和当前 revision |
| V2-AC-08 | 重启不会产生虚假完成或重复持久化写入 |
| V2-AC-09 | 每次变更和拒绝都有脱敏审计事件 |
| V2-AC-10 | V1 本地链路继续可用 |
| V2-AC-11 | 仓库全部验证门禁通过 |
| V2-AC-12 | 隔离恢复 PostgreSQL 后仍能得到相同 item/location/version 引用 |

## 八、完成标准

只有同一个部署候选通过 `V2-AC-01` 至 `V2-AC-12`，所有声明的异常状态均可观察，并且没有未经触发条件和 ADR 引入的额外组件，V2 P0 才能判定完成。
