# CoWikiHarness 权限感知知识资产图谱投影接口设计

状态：对内已通过，待书面评审

日期：2026-08-16

目标分支：`dev`

受众：项目 Owner、实现者、安全与接口评审者

关联设计：[`2026-08-15-cloud-knowledge-agent-v2-design.md`](../../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)

关联决策：[`ADR-0005-a2a-v1-public-agent-protocol.md`](../../decisions/ADR-0005-a2a-v1-public-agent-protocol.md)、[`ADR-0007-postgresql-durable-truth.md`](../../decisions/ADR-0007-postgresql-durable-truth.md)、[`ADR-0008-minimal-v2-runtime.md`](../../decisions/ADR-0008-minimal-v2-runtime.md)

## 一、结论

在现有 Knowledge Server 内增加一个只读、权限感知的 REST 图谱投影接口。接口从 PostgreSQL Registry 实时生成知识资产节点和关系边，输出 Cytoscape 兼容 JSON，供外部网页或其他可视化工具读取。

本方案继续使用现有 Node.js 服务、PostgreSQL、Bearer Token、resource grant 和 `registry_revision`，不增加图数据库、GraphQL、消息队列、缓存服务、MCP Server 或 LLM 调用。

外部可视化接口只负责读取。知识注册、存储、目录调整和整理继续通过 Knowledge Agent 的唯一写入入口完成；Agent 通信继续使用 A2A。

## 二、真问题与成功标准

### 2.1 真问题

CoWikiHarness 已经能登记知识、位置、版本、标签、Owner 和访问授权，但外部消费者只能通过 Agent 问答使用这些数据。用户缺少一个稳定、可授权、可缓存的数据接口来观察“当前有哪些知识、放在哪里、由谁拥有、如何分类、有哪些版本和来源”。

核心矛盾是 Registry 已经保存关系事实，却没有面向可视化工具的确定性读取投影。让外部工具直连 PostgreSQL会绕过权限和领域边界；让可视化请求经过 LLM 会增加成本、延迟和不确定性。

### 2.2 目标用户与场景

- Owner：查看组织内自己有权管理的知识资产结构。
- 普通成员：只查看自己有权访问的知识节点和关系。
- 外部可视化应用：通过稳定 HTTP 合同加载节点和边，不持有数据库权限。

### 2.3 成功标准

- 同一接口对不同用户返回不同的授权图谱。
- 外部网页可直接把响应加载到 Cytoscape.js；D3、ECharts 或 Gephi 适配器可低成本转换。
- 图谱支持“目录 → 子目录 → 知识”的树形展开，并按需附加标签、位置、版本、Owner、共享对象和 Connector。
- 响应不包含 Markdown 正文、凭据、token、secret reference 或无权限节点的任何痕迹。
- 图谱读取不调用模型，不创建 A2A task，不引入新的运行服务。
- 图谱未变化时支持条件请求；大图请求具备深度、数量和游标边界。

## 三、范围与非目标

### 3.1 P0 范围

- 一个版本化的只读 REST 图谱接口。
- 现有知识资产的节点—边投影。
- 用户 Bearer Token 认证和 `knowledge.query` 权限过滤。
- 单一主目录层级和多标签交叉分类。
- Cytoscape 兼容 JSON、游标分页、ETag、CORS 白名单。
- 目录创建、移动和知识归档位置的领域操作合同。
- PostgreSQL migration、权限测试、API 契约测试和真实 PostgreSQL 集成测试。

### 3.2 P0 非目标

- 不从正文自动抽取人物、概念、事件或因果关系。
- 不增加任意类型的语义关系编辑器。
- 不提供 Neo4j、RDF、SPARQL、GraphQL 或 Cypher 接口。
- 不开发内置图谱网页；外部应用先消费 API。
- 不提供 WebSocket、SSE 或事件订阅。
- 不允许外部可视化接口修改知识或目录。
- 不让 Agent principal 或 Relay principal 直接调用图谱接口；P0 只接受用户 principal。Agent 继续通过 A2A 在 delegation 边界内工作。

## 四、方案选择

### 4.1 采用：现有服务内的 REST 图谱投影

优点：复用认证、权限、进程、数据库和部署方式；HTTP GET 易于调试和缓存；外部消费者无需理解 A2A 或数据库结构。退出成本低，未来可在相同合同后替换查询实现。

主要代价：复杂图遍历依赖 PostgreSQL recursive CTE；响应合同需要长期兼容。

### 4.2 未采用：GraphQL

GraphQL 适合多个客户端自由组合大量字段。当前只有一个图谱读取面，GraphQL 会引入 schema resolver、查询复杂度限制、字段级权限和额外运维心智。

升级信号：出现三个以上独立客户端，字段组合差异显著，REST 参数开始快速膨胀。

### 4.3 未采用：Neo4j 或其他图数据库

图库适合深层、多跳、低延迟关系遍历。当前 P0 关系来自 Registry，层级最大深度有限，PostgreSQL 足以完成查询。增加图库会产生双写、同步、备份和两套权限一致性问题。

升级信号：经过压测确认 PostgreSQL 无法满足已定义的路径查询 SLO，并且业务需要六跳以上遍历、图算法或百万级边的交互查询。

## 五、系统边界

```text
外部可视化应用
  -> HTTPS GET + Bearer Token
  -> Knowledge Server /api/v1/graph
  -> Bearer Authentication
  -> Graph Query Validation
  -> Effective Access Resolution
  -> Graph Projection Service
  -> PostgresKnowledgeStore permission-filtered query
  -> Cytoscape-compatible JSON
```

组件职责：

| 组件 | 单一职责 | 依赖 |
| --- | --- | --- |
| Graph HTTP Route | 解析 HTTP、校验参数、设置缓存与 CORS header、映射稳定错误 | Graph Projection Service、现有认证中间件 |
| Graph Projection Service | 把授权 Registry 行转换为稳定节点和边 | Graph Store Port、协议 schema |
| Graph Store Port | 定义权限感知图谱读取和目录写入所需的领域接口 | 无具体数据库依赖 |
| Postgres Graph Store | 在 SQL 阶段完成权限过滤、层级遍历、分页和 revision 读取 | 现有 Database、access policy |
| Graph Protocol | 定义 query、node、edge、response、cursor 和错误合同 | Zod |

Graph Projection Service 不直接接触 Express 或 `pg`。HTTP 层不拼 SQL。PostgreSQL adapter 不输出 HTTP 结构。

## 六、数据模型

### 6.1 复用现有表

- `knowledge_items`
- `knowledge_locations`
- `knowledge_versions`
- `tags` / `knowledge_tags`
- `principals`
- `connector_instances`
- `resource_grants`
- `organizations.registry_revision`

### 6.2 新增目录表

`knowledge_collections`：

| 字段 | 规则 |
| --- | --- |
| `collection_id` | 稳定文本 ID，主键 |
| `org_id` | 必填，引用组织 |
| `parent_collection_id` | 可空；引用同组织目录 |
| `name` | 1–200 字符 |
| `description` | 默认空字符串，最多 2,000 字符 |
| `revision` | 单调递增，默认 0 |
| `created_by_principal_id` | 必填，引用用户或被授权 Agent |
| `created_at` / `updated_at` | UTC 时间 |

同一父目录下名称唯一。根目录名称在同一组织内唯一。父目录不能指向自身。

`knowledge_collection_items`：

| 字段 | 规则 |
| --- | --- |
| `org_id` | 必填，引用组织 |
| `item_id` | 主键，引用知识条目；由此保证唯一主目录 |
| `collection_id` | 必填，引用同组织目录 |
| `placed_by_principal_id` | 必填，记录执行者 |
| `revision` | 单调递增，默认 0 |
| `created_at` / `updated_at` | UTC 时间 |

目录调整要求组织级 `knowledge.organize` 权限。P0 不新增 collection scope，避免扩大现有授权模型。写入事务锁定组织 Registry，使用 recursive CTE 检查目标父目录不在自身后代中，再执行 CAS 更新。成功写入后同一事务递增 `organizations.registry_revision` 并追加审计事件。

既有但尚未归档的知识在投影中连接到一个响应期虚拟节点 `collection:unfiled`。该节点不写入数据库；知识首次归档后消失。

### 6.3 P0 节点类型

| 类型 | 默认返回 | 安全字段 |
| --- | --- | --- |
| `collection` | 是 | ID、名称、描述、revision |
| `knowledge` | 是 | ID、标题、状态、revision、更新时间 |
| `tag` | 是 | ID、名称、描述 |
| `location` | 按 `include` | ID、类型、角色、可用状态、最后验证时间 |
| `version` | 按 `include` | ID、ordinal、body hash、provider version、创建时间 |
| `principal` | 按 `include` 且权限允许 | ID、类型、允许显示的 display name |
| `connector` | 按 `include` | ID、类型、显示名称、状态 |

图谱响应永远不包含 `body_markdown`、token、token digest、`secret_reference`、delegation 内容、授权 JSON、个人本地绝对路径或任意凭据。

### 6.4 P0 边类型

| 类型 | 来源 |
| --- | --- |
| `CONTAINS` | collection parent 和 collection item 归属 |
| `TAGGED_WITH` | `knowledge_tags` |
| `HAS_LOCATION` | `knowledge_locations` |
| `CURRENT_VERSION` | `knowledge_items.current_version_id` |
| `OWNED_BY` | item/location Owner |
| `SHARED_WITH` | 有效、item scope 的 `resource_grants` |
| `PROVIDED_BY` | location 到 connector instance |

`SHARED_WITH` 只向知识 Owner 或组织 Owner显示。普通成员只能看到与自身相关的共享边。所有边的两个端点必须同时存在于当前响应，禁止 dangling edge。

目录可见性由知识可见性推导：组织级 `knowledge.query` 用户可以看到组织目录；仅持有 item、tag 或 source grant 的用户只看到连接其可见知识所必需的祖先路径。空目录、隐藏兄弟节点和基于隐藏知识计算的数量不会返回。

## 七、HTTP 与协议合同

### 7.1 Endpoint

```http
GET /api/v1/graph
Authorization: Bearer <USER_TOKEN>
Accept: application/json
```

接口复用现有 bearer token。调用者必须是状态为 `active` 的 `user` principal，并具备目标资源上的 `knowledge.query` 能力。Agent 或 Relay token 返回 403。

### 7.2 Query 参数

| 参数 | 默认值 | 规则 |
| --- | --- | --- |
| `root` | 空 | `collection:<id>` 或 `item:<id>`；空值从可见目录森林和未归档知识开始 |
| `depth` | `2` | 0–4 的整数 |
| `include` | `tags` | 逗号分隔：`tags,locations,versions,principals,connectors` |
| `limit` | `500` | 1–500，限制节点数量 |
| `cursor` | 空 | 服务端签名或 HMAC 的不透明游标，客户端不得解析 |

cursor 使用现有部署 HMAC secret 和独立的 `graph-cursor` domain separator 生成 HMAC-SHA-256 签名，不新增 secret。它绑定 principal、组织、查询参数和 `registryRevision`。任何一个条件变化后继续翻页都返回快照过期错误，客户端从第一页重新读取。

### 7.3 Response

```json
{
  "schema": "cowikiharness.graph/v1",
  "registryRevision": 18,
  "generatedAt": "2026-08-16T12:00:00.000Z",
  "elements": {
    "nodes": [
      {
        "data": {
          "id": "item:item_123",
          "type": "knowledge",
          "label": "CoWikiHarness 本机使用说明",
          "status": "draft",
          "revision": 0
        }
      },
      {
        "data": {
          "id": "tag:tag_product",
          "type": "tag",
          "label": "product"
        }
      }
    ],
    "edges": [
      {
        "data": {
          "id": "item:item_123:tagged-with:tag_product",
          "source": "item:item_123",
          "target": "tag:tag_product",
          "type": "TAGGED_WITH"
        }
      }
    ]
  },
  "truncated": false,
  "nextCursor": null
}
```

节点 ID 与边 ID 在相同 Registry 事实未变化时保持稳定。数组排序稳定：先按类型，再按 ID。这样可生成确定性 fixture，也能减少可视化布局抖动。

### 7.4 缓存合同

- ETag 由 principal ID、查询参数规范化 hash 和 `registryRevision` 共同生成。
- `If-None-Match` 命中后返回 304，无响应正文。
- 响应设置 `Cache-Control: private, max-age=0, must-revalidate`。
- 响应设置 `Vary: Authorization, Origin`，禁止共享缓存混用不同用户结果。

### 7.5 CORS

- 新配置 `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS`，使用逗号分隔的精确 origin。
- 默认空值，表示浏览器跨域关闭；服务端调用不受影响。
- 携带 Authorization 时不允许 `Access-Control-Allow-Origin: *`。
- 只允许 `GET`、`OPTIONS` 和 `Authorization`、`Accept`、`If-None-Match` header。
- 生产部署必须通过 HTTPS 暴露接口。

浏览器应用不得把 Owner token 写进代码、URL、日志或持久化到不受保护的浏览器存储。推荐为可视化用途签发有过期时间、只具备 `knowledge.query` 的成员 token。

## 八、权限模型

### 8.1 查询顺序

1. 验证 bearer token，加载 active user principal。
2. 校验 principal 具备 `knowledge.query` capability。
3. 在 SQL 中根据组织、Owner、有效 resource grant 计算可见知识集合。
4. 仅从可见知识派生目录祖先路径、标签、位置、版本、Owner、共享对象和 Connector。
5. 先裁剪敏感字段，再转换为协议节点和边。
6. 校验响应 schema 后发送。

权限过滤必须发生在 SQL 查询阶段。应用层不能先加载整个组织图谱再删除无权限节点。

### 8.2 防侧信道规则

- 不存在的 root 与无权限 root 均返回同一个 404 `GRAPH_ROOT_NOT_FOUND`。
- 无权限的邻接节点不产生占位节点、边、计数或“隐藏内容”提示。
- 普通成员不能看到其他成员的 item grant 列表。
- 错误消息不包含 SQL、表名、内部路径、token prefix 或被隐藏的资源 ID。

## 九、目录写入机制

目录仍通过 Knowledge Agent 的强类型操作写入，不加入图谱 REST route。

P0 增加三个领域操作：

- `collection.create`：由具备组织级整理权限的操作者在父目录下新建目录。
- `collection.move`：移动或重命名目录，拒绝形成循环。
- `knowledge.place`：把知识放入唯一主目录；重复请求幂等。

这些操作映射到现有 `knowledge.organize` capability，并要求 organization scope。由 Agent 发起时，继续执行用户 grant、Agent grant 和 delegation 的三方交集。每次成功写入携带 expected revision，使用 CAS 防止覆盖并发修改，并写入 actor、on-behalf-of、动作、目标和结果审计。

整理 Skill 可以生成目录调整建议。涉及长期 Wiki 结构变化时，继续遵守项目 Constitution 的人工批准规则；批准内容必须明确列出新增目录、移动目录和知识归档变化。

## 十、错误处理

图谱业务错误使用稳定 envelope：

```json
{
  "error": {
    "code": "GRAPH_INVALID_QUERY",
    "message": "depth must be an integer between 0 and 4",
    "requestId": "request_123"
  }
}
```

| HTTP | 稳定错误码 | 语义 |
| --- | --- | --- |
| 400 | `GRAPH_INVALID_QUERY` | 参数、include 或 cursor 格式非法 |
| 401 | `unauthorized` | 沿用现有认证中间件合同 |
| 403 | `GRAPH_FORBIDDEN` | 用户缺少 `knowledge.query` |
| 403 | `GRAPH_PRINCIPAL_NOT_SUPPORTED` | P0 收到 Agent 或 Relay token |
| 404 | `GRAPH_ROOT_NOT_FOUND` | root 不存在或当前用户无权访问 |
| 409 | `GRAPH_SNAPSHOT_EXPIRED` | cursor 对应 revision 或调用身份已变化 |
| 503 | `GRAPH_UNAVAILABLE` | 数据库或投影暂时不可用 |

未知异常统一映射为 `GRAPH_UNAVAILABLE`，服务端结构化日志记录 request ID 和已脱敏原因，响应不返回 SQL 细节。

## 十一、性能与一致性

- P0 单次最多返回 500 个节点；达到限制后设置 `truncated: true` 和 `nextCursor`。
- 最大遍历深度为 4；层级查询使用 recursive CTE。
- SQL 必须先生成授权 item 集合，再连接图谱相关表。
- 为 `knowledge_collections(org_id, parent_collection_id)`、`knowledge_collection_items(collection_id)` 和授权查询路径增加索引。
- P0 不增加 Redis、物化视图或后台投影任务。
- 所有结构写入和 `registry_revision` 递增位于同一个 PostgreSQL 事务。
- cursor 固定 revision，避免分页过程中混入新旧结构。

容量升级信号：授权图谱超过 50,000 可见节点，或 P95 查询持续超过 500 ms。先依据 `EXPLAIN ANALYZE` 增加索引或只读副本；只有已证明 PostgreSQL 不满足目标时才评估物化投影或图库。

## 十二、可观测性与审计

每次图谱读取记录结构化运行日志和指标：request ID、org ID、principal ID 的不可逆摘要、query hash、registry revision、节点数、边数、耗时、HTTP 状态和错误码。日志不记录 Authorization header、正文、locator 或节点标题。

P0 不为每次成功读取写 `audit_events`，避免浏览器刷新制造高频写入。目录写入、授权拒绝和管理行为继续进入持久审计表。

建议指标：

- `graph_requests_total{status}`
- `graph_request_duration_ms`
- `graph_nodes_returned`
- `graph_snapshot_expired_total`

现阶段可先使用现有结构化日志实现，达到生产观测需求后再接入独立 metrics exporter。

## 十三、测试策略

### 13.1 协议与领域单元测试

- query 参数边界、节点/边 discriminated union 和响应 schema。
- 稳定 ID、稳定排序、无 dangling edge。
- include 裁剪和敏感字段永不进入 schema。
- 目录循环检测、唯一主目录和 CAS 冲突。

### 13.2 PostgreSQL 集成测试

- Owner、普通成员、item grant、tag grant、source grant 和组织 grant 的可见性矩阵。
- 两个用户读取同一 revision 时得到不同图谱。
- 无权限 root 与不存在 root 返回不可区分结果。
- `SHARED_WITH` 人员信息按角色裁剪。
- Registry 结构写入递增 revision；失败事务不递增。
- cursor 在 revision 变化后稳定返回 409。
- 目录移动无法形成环；并发移动不会绕过检查。

### 13.3 HTTP 集成测试

- 401、403、404、409、503 合同。
- CORS 精确白名单和预检请求。
- ETag、304、Vary 和 private cache header。
- `limit`、`depth`、`include`、`cursor`。
- 响应可直接作为 Cytoscape `elements` 输入。
- Graph 请求不调用模型 runtime，不创建 Agent task。

### 13.4 回归门禁

- 现有 A2A Agent Card、JSON-RPC、query、register、store 和 organize 行为不变。
- `pnpm verify` 全量通过。
- PostgreSQL 17 集成测试通过。
- 使用本地真实 token 读取当前 Registry，至少返回已存在的 `CoWikiHarness 本机使用说明` 条目及其标签边。

## 十四、交付切片

实现计划应拆为四个可独立验收的 vertical slice：

1. 图协议与目录数据模型：migration、schema、目录领域规则和 PostgreSQL 测试。
2. 权限感知 Graph Store：授权集合、节点/边投影、分页和 revision 一致性。
3. HTTP 接口：认证、错误、CORS、ETag 和契约测试。
4. 写入操作与真实验收：三个 organize 操作、审计、CLI/API 使用文档和本地 smoke test。

## 十五、发布、回滚与兼容性

- migration 只新增表和索引，不修改现有知识行，不阻塞现有 A2A 调用合同。
- 新 route 默认可用，但跨域默认关闭；只有配置白名单后浏览器才能直接访问。
- 回滚应用版本时新增表可以保留，不影响旧版本运行。
- 已发出的 `cowikiharness.graph/v1` 字段保持向后兼容；新增可选字段不改变现有含义，破坏性变化使用 `/api/v2/graph` 和新 schema。
- 图谱 route 出现问题时回滚到上一应用版本；新增表保留，A2A 和 CLI 知识能力继续工作。

## 十六、风险与控制

| 风险 | 控制 |
| --- | --- |
| 权限过滤后仍泄露邻接关系 | SQL 先构造授权 item 集合；无 dangling edge；跨用户集成测试 |
| 浏览器泄露高权限 token | 精确 CORS、短期只读用户 token、禁止 URL 和前端源码保存 token |
| 大图拖慢主库 | depth/limit/cursor、索引、P95 门禁、升级信号 |
| 分页混合两个版本 | cursor 绑定 principal、query 和 registry revision |
| 目录形成循环 | 组织级写锁、recursive CTE 验证、CAS、并发测试 |
| 公共 API 绑定具体前端 | 外层使用 CoWikiHarness 版本 schema，内部 `elements` 保持通用节点—边合同 |
| 过早演化为语义图谱 | P0 明确排除正文实体抽取和任意关系表 |

## 十七、验收清单

- [ ] 外部应用使用用户 Bearer Token 成功读取 `/api/v1/graph`。
- [ ] 无 token、撤销 token、Agent token 和 Relay token按合同失败。
- [ ] 两名权限不同的用户看到不同节点，隐藏节点不产生计数或边。
- [ ] 图谱能展开“目录 → 子目录 → 知识”，一条知识只有一个主目录。
- [ ] 标签、位置、版本、人员和 Connector 可按 `include` 控制。
- [ ] 响应中不存在 Markdown 正文、凭据、secret reference 和本地绝对路径。
- [ ] Cytoscape.js 无需数据重构即可加载 `elements`。
- [ ] ETag 命中返回 304，Registry 变化使旧 cursor 返回 409。
- [ ] 图谱读取不产生 LLM 请求或 A2A task。
- [ ] 全量验证、PostgreSQL 17 集成测试和本地真实数据 smoke test通过。
