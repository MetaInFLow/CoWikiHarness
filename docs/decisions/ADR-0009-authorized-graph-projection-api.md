# ADR 0009：提供权限感知的只读图谱投影接口

- 状态：V2 已接受并实现
- 日期：2026-08-17
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-16-authorized-knowledge-graph-projection-design.md`](../superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md)
- 相关决策：[`ADR-0007-postgresql-durable-truth.md`](ADR-0007-postgresql-durable-truth.md)、[`ADR-0008-minimal-v2-runtime.md`](ADR-0008-minimal-v2-runtime.md)

## 背景

PostgreSQL Registry 已经保存知识、目录、标签、位置、版本、Owner、共享对象和 Connector 之间的关系事实。Owner、团队成员和外部可视化应用仍缺少一个稳定、按用户授权过滤、可直接缓存的读取面。

外部工具直连 PostgreSQL 会绕过认证、权限策略和公共合同。通过 A2A 或模型生成图谱会增加任务写入、延迟、成本和结果波动，也不适合作为可视化应用的确定性数据源。

## 决策

在现有 Node.js Knowledge Server 内提供只读 REST 图谱投影接口 `GET /api/v1/graph`：

1. PostgreSQL 继续作为唯一持久事实源；
2. 图谱查询在 SQL 阶段按 `knowledge.query` 和资源授权过滤；
3. 接口只接受有效的 user token，Agent 和 Relay 继续使用各自的既有边界；
4. 响应使用 `cowikiharness.graph/v1` 公共 schema，并提供 Cytoscape-compatible `elements.nodes` 与 `elements.edges`；
5. Graph route 复用现有认证、权限策略、连接池和部署进程，不调用模型，不创建 Agent task；
6. 生产可视化应用由后端代理 Graph REST，member token 只保存在后端 secret store，前端只访问自己的后端；
7. 当前 P0 未提供独立用户登录/session，生产浏览器直连等待该机制；显式 user token 文件只用于本机受控调试；
8. 浏览器访问使用精确 CORS origin allowlist，跨域默认关闭；CORS 不提供身份认证，也不能阻止已提取 token 的重放；
9. 目录和知识层级写入继续走 A2A 强类型操作。

## 影响

- 外部可视化应用后端获得稳定、权限感知、可分页和可缓存的数据入口；
- A2A 问答与写入、Graph REST 读取共享同一套身份、授权和 PostgreSQL 事实；
- `cowikiharness.graph/v1` 成为公共兼容合同，现有字段语义需要保持向后兼容；
- 图谱响应排除正文、locator、凭据、token、授权明细和个人本地绝对路径；
- resource grant 采用追加授权；外部应用创建 member principal 时应在 organization scope 与 item scope 之间选择其一，追加 item grant 不会收窄已有 organization grant；
- 当前 CLI 没有 grant revoke 命令；误授 organization scope 时停止使用并撤销旧 token，重新创建 member principal，并只授所需 item scope；
- PostgreSQL recursive CTE 和索引承担 P0 的层级查询；
- 只有授权图谱超过 50,000 个可见节点，或 P95 查询持续超过 500 ms，并且 PostgreSQL 优化仍无法达标时，才评估物化投影或图数据库。

## 未采用方案

### GraphQL

当前只有一个边界清晰的读取面。GraphQL 会增加 resolver、查询复杂度限制、字段级权限和额外运维成本。

### Neo4j 或其他图数据库

当前关系事实已经位于 PostgreSQL，层级深度和查询上限均受控。引入第二个事实存储会增加同步、备份、权限一致性和故障恢复成本。

### 外部工具直连数据库

直连会暴露内部表结构和数据库凭据，并绕过应用层身份、授权、字段裁剪与公共 schema。

### A2A 或 LLM 图谱查询

可视化读取需要确定性、低开销和 HTTP 缓存语义。A2A 与模型保留给问答、知识操作和授权写入。

## 回滚

图谱 route 发生发布问题时回滚到上一应用版本。已新增的目录、归档和投影支持表继续保留，A2A、Registry 和既有知识能力保持可用。回滚不执行 destructive migration；后续版本可以继续读取这些表并恢复图谱接口。
