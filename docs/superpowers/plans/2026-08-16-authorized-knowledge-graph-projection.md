# CoWikiHarness 权限感知知识资产图谱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Knowledge Server 上交付一个按用户授权过滤、可供外部可视化工具直接读取的知识资产图谱接口，并支持单一主目录层级的受控写入。

**Architecture:** 在现有模块化单体内增加 Graph Protocol、纯投影服务、PostgreSQL 图谱读取 adapter、层级写入 adapter 和 Express REST route。PostgreSQL 继续作为唯一事实源；外部图谱接口只读，目录写入通过现有 A2A 强类型操作和 `knowledge.organize` 权限完成，不调用 LLM。

**Tech Stack:** Node.js 24、TypeScript 5.9、Express 5、Zod 4、PostgreSQL 17、`pg` 8、Vitest 3、A2A JS SDK 1.0.1、pnpm 10.33.2。

---

## 0. 实施上下文

### 0.1 用户与场景（PSPS）

- Persona：CoWikiHarness Owner、普通成员、外部可视化应用开发者。
- Scenario：用户希望在 D3、ECharts、Cytoscape.js 或其他网页中看到自己有权访问的知识目录、标签、位置、版本和来源关系。
- Pain：当前 Registry 已保存关系事实，但只有 A2A Agent 查询入口；外部工具无法获得稳定、确定性的节点—边数据。
- Solution Surface：`GET /api/v1/graph`、两张层级表、三个 A2A 目录写操作、中文使用文档。

### 0.2 权威来源

- 设计真相源：`docs/superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md`
- V2 总体设计：`docs/design/active/2026-08-15-cloud-knowledge-agent-v2-design.md`
- A2A 边界：`docs/decisions/ADR-0005-a2a-v1-public-agent-protocol.md`
- PostgreSQL 真相源：`docs/decisions/ADR-0007-postgresql-durable-truth.md`
- 最简运行时：`docs/decisions/ADR-0008-minimal-v2-runtime.md`
- 产品红线：`CONSTITUTION.md`

不引入新依赖或外部 API，因此不需要新增互联网来源。Cytoscape 兼容性只使用其通用 `elements.nodes[].data` / `elements.edges[].data` 数据形状，不安装 Cytoscape。

### 0.3 Checkout 决策

当前 `dev` 是干净的集成 checkout，这是一项聚焦的后续能力，可以直接在 `dev` 实施。开始每个 Task 前运行：

```bash
git status -sb
```

预期：`## dev...origin/dev`，且没有未知改动。出现未知改动时停止，不 stash、不 reset、不覆盖。

所有 Node 命令使用：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

### 0.4 范围

P0 包含：

- `/api/v1/graph` 只读 REST API；
- 用户 token、resource grant 和草案可见性过滤；
- collection/item/tag/location/version/principal/connector 节点；
- `CONTAINS`、`TAGGED_WITH`、`HAS_LOCATION`、`CURRENT_VERSION`、`OWNED_BY`、`SHARED_WITH`、`PROVIDED_BY` 边；
- 单一主目录和三个强类型整理操作；
- CORS 精确白名单、ETag、HMAC cursor、稳定错误；
- 协议、纯逻辑、PostgreSQL 和 HTTP 集成测试；
- 中文 README、Skill 和架构记录。

P0 排除：

- 内置图谱网页；
- 正文实体抽取和语义关系；
- GraphQL、Neo4j、RDF、SPARQL、SSE、WebSocket；
- Agent/Relay token 直接读取图谱；
- 外部 REST 写入；
- Redis、物化视图、Worker 或额外服务。

## 1. 文件地图

### 新建

| 文件 | 责任 |
| --- | --- |
| `packages/protocol/src/graph.ts` | 图查询、节点、边、响应、collection 和 placement 公共 schema |
| `packages/protocol/test/graph-contracts.test.ts` | 严格合同、敏感字段、operation/result 联合类型测试 |
| `packages/core/src/knowledge-graph.ts` | Graph Read Port、Hierarchy Write Port、稳定投影和 fail-closed 检查 |
| `packages/core/test/knowledge-graph.test.ts` | 排序、去重、dangling edge、响应校验测试 |
| `packages/adapters/migrations/0002_knowledge_collections.sql` | collection 和唯一主目录持久化结构 |
| `packages/adapters/src/postgres/graph-cursor.ts` | domain-separated HMAC cursor 编解码 |
| `packages/adapters/src/postgres/knowledge-graph-store.ts` | 用户权限 SQL、层级遍历、节点—边事实读取和分页 |
| `packages/adapters/src/postgres/knowledge-hierarchy-store.ts` | collection 创建/移动、knowledge placement、CAS、审计 |
| `packages/adapters/test/graph-cursor.test.ts` | cursor 篡改、身份/query/revision 绑定测试 |
| `packages/adapters/test/postgres-knowledge-graph.integration.test.ts` | 真实 PostgreSQL 授权图谱矩阵 |
| `packages/adapters/test/postgres-knowledge-hierarchy.integration.test.ts` | 真实 PostgreSQL 层级写入和并发规则 |
| `packages/knowledge-agent/src/organization-operations.ts` | 三个强类型整理应用操作 |
| `packages/knowledge-agent/test/organization-operations.integration.test.ts` | 整理操作到 PostgreSQL adapter 的合同测试 |
| `apps/knowledge-server/src/graph-route.ts` | HTTP 参数、CORS、ETag、错误映射和响应发送 |
| `apps/knowledge-server/test/graph-route.test.ts` | 无数据库 HTTP helper 和 config 合同 |
| `apps/knowledge-server/test/graph-route.integration.test.ts` | 真实 token、权限、HTTP、304 和无模型调用验证 |
| `docs/decisions/ADR-0009-authorized-graph-projection-api.md` | 公共 REST 图谱接口架构决策 |

### 修改

| 文件 | 变化 |
| --- | --- |
| `packages/protocol/src/index.ts` | 导出 graph 合同 |
| `packages/protocol/src/operation.ts` | 增加三个整理 operation；保留通用 `knowledge.organize` 为后续提案入口 |
| `packages/protocol/src/knowledge.ts` | 把 collection/placement result 加入 Agent result 联合类型 |
| `packages/core/src/index.ts` | 导出图谱 service 和 ports |
| `packages/adapters/src/index.ts` | 导出两个 PostgreSQL store 和 cursor helper 类型 |
| `packages/adapters/test/postgres-cloud-registry.integration.test.ts` | migration 数量从 1 更新为 2 |
| `packages/adapters/src/postgres/knowledge-store.ts` | 新 operation 到 `knowledge.organize` capability 的 task authority 映射 |
| `packages/knowledge-agent/src/index.ts` | 导出 `KnowledgeOrganizationOperations` |
| `packages/knowledge-agent/src/agent.ts` | 新 operation 的结果 schema 匹配；模型工具保持只读 |
| `apps/knowledge-server/src/config.ts` | 解析 `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS` |
| `apps/knowledge-server/src/authentication.ts` | 提供经过认证的 Express request principal 读取函数 |
| `apps/knowledge-server/src/a2a-server.ts` | 装配 graph/hierarchy stores、projection service、route 和 organization operations |
| `apps/knowledge-server/src/agent-executor.ts` | 接受三个明确整理 operation，继续拒绝通用 `knowledge.organize` |
| `apps/knowledge-server/src/knowledge-task-runner.ts` | 执行和恢复三个结构化整理 operation |
| `apps/knowledge-server/src/agent-card.ts` | 发布 `knowledge.organize` 能力 |
| `apps/knowledge-server/src/client.ts` | 增加只读 graph 命令和三个目录整理终端命令 |
| `apps/knowledge-server/test/client.test.ts` | CLI 参数与强类型 operation 测试 |
| `apps/knowledge-server/test/a2a-query.integration.test.ts` | A2A 支持列表、恢复、清理顺序和回归测试 |
| `.env.example` | 图谱 CORS 白名单示例 |
| `README.md` | 外部图谱接口、token 与 curl 使用说明 |
| `ARCHITECTURE.md` | 增加只读图谱投影边界 |
| `skills/cowikiharness/SKILL.md` | 增加目录整理命令和图谱只读边界 |
| `docs/memory-bank/active-context.md` | 更新当前实现焦点与完成事实 |

## 2. Task 1：锁定公共图谱与目录操作合同

**Files:**

- Create: `packages/protocol/src/graph.ts`
- Create: `packages/protocol/test/graph-contracts.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/operation.ts`
- Modify: `packages/protocol/src/knowledge.ts`

- [ ] **Step 1：先写失败的图谱合同测试**

测试至少包含以下断言：

```ts
import {
  knowledgeGraphQuerySchema,
  knowledgeGraphResponseSchema,
  knowledgeOperationSchema,
  knowledgeCollectionResultSchema,
  knowledgePlacementResultSchema,
} from "../src/index.js";

it("accepts one strict Cytoscape-compatible graph response", () => {
  const value = knowledgeGraphResponseSchema.parse({
    schema: "cowikiharness.graph/v1",
    registryRevision: 7,
    generatedAt: "2026-08-16T00:00:00.000Z",
    elements: {
      nodes: [{ data: {
        id: "item:item_1", type: "knowledge", label: "Architecture",
        status: "stable", revision: 2, updatedAt: "2026-08-16T00:00:00.000Z",
      } }],
      edges: [],
    },
    truncated: false,
    nextCursor: null,
  });
  expect(value.schema).toBe("cowikiharness.graph/v1");
});

it("rejects graph bodies, locators and unknown properties", () => {
  expect(() => knowledgeGraphResponseSchema.parse({
    schema: "cowikiharness.graph/v1",
    registryRevision: 1,
    generatedAt: "2026-08-16T00:00:00.000Z",
    elements: { nodes: [{ data: {
      id: "item:item_1", type: "knowledge", label: "Secret",
      status: "draft", revision: 0, updatedAt: "2026-08-16T00:00:00.000Z",
      bodyMarkdown: "must never escape",
    } }], edges: [] },
    truncated: false,
    nextCursor: null,
  })).toThrow();
});

it("parses the three explicit hierarchy operations", () => {
  expect(knowledgeOperationSchema.parse({
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.collection.create",
    expectedRegistryRevision: 3,
    parentCollectionId: null,
    name: "Projects",
    description: "Project knowledge",
  }).kind).toBe("knowledge.collection.create");
  expect(knowledgeOperationSchema.parse({
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.collection.move",
    collectionId: "collection_1",
    expectedRevision: 0,
    parentCollectionId: "collection_2",
    name: "Architecture",
    description: "Architecture knowledge",
  }).kind).toBe("knowledge.collection.move");
  expect(knowledgeOperationSchema.parse({
    schema: "openlifewiki.operation/v1",
    kind: "knowledge.place",
    itemId: "item_1",
    collectionId: "collection_2",
    expectedPlacementRevision: null,
  }).kind).toBe("knowledge.place");
});
```

- [ ] **Step 2：运行测试并确认按预期失败**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/protocol exec vitest run test/graph-contracts.test.ts
```

Expected: FAIL，缺少 `graph.ts` exports 和三个 operation variants。

- [ ] **Step 3：实现严格 graph schema**

`packages/protocol/src/graph.ts` 必须导出：

```ts
export const KNOWLEDGE_GRAPH_NODE_TYPES = [
  "collection", "knowledge", "tag", "location", "version", "principal", "connector",
] as const;
export const KNOWLEDGE_GRAPH_EDGE_TYPES = [
  "CONTAINS", "TAGGED_WITH", "HAS_LOCATION", "CURRENT_VERSION",
  "OWNED_BY", "SHARED_WITH", "PROVIDED_BY",
] as const;
export const KNOWLEDGE_GRAPH_INCLUDES = [
  "tags", "locations", "versions", "principals", "connectors",
] as const;
export const KNOWLEDGE_GRAPH_ERROR_CODES = [
  "GRAPH_INVALID_QUERY",
  "GRAPH_FORBIDDEN",
  "GRAPH_PRINCIPAL_NOT_SUPPORTED",
  "GRAPH_ROOT_NOT_FOUND",
  "GRAPH_SNAPSHOT_EXPIRED",
  "GRAPH_UNAVAILABLE",
  "GRAPH_INVALID_PROJECTION",
] as const;
export type KnowledgeGraphErrorCode = (typeof KNOWLEDGE_GRAPH_ERROR_CODES)[number];

export const knowledgeGraphQuerySchema = z.strictObject({
  root: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("collection"), id }),
    z.strictObject({ type: z.literal("knowledge"), id }),
  ]).nullable(),
  depth: z.int().min(0).max(4),
  include: z.array(z.enum(KNOWLEDGE_GRAPH_INCLUDES)).max(5)
    .refine((value) => new Set(value).size === value.length, "include values must be unique"),
  limit: z.int().min(1).max(500),
  cursor: z.string().min(1).max(4_096).nullable(),
});
```

节点使用 `data.type` discriminated union，并为七种类型定义设计文档第 6.3 节中的安全字段。边只允许 `id`、`source`、`target`、`type`。所有对象使用 `z.strictObject`。另外导出：

```ts
export const knowledgeCollectionSchema = z.strictObject({
  schema: z.literal("cowikiharness.collection/v1"),
  collectionId: id,
  orgId: id,
  parentCollectionId: id.nullable(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  revision: z.int().nonnegative(),
  createdByPrincipalId: id,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const knowledgeCollectionPlacementSchema = z.strictObject({
  schema: z.literal("cowikiharness.collection-placement/v1"),
  orgId: id,
  itemId: id,
  collectionId: id,
  placedByPrincipalId: id,
  revision: z.int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
```

定义 `cowikiharness.collection-result/v1` 和 `cowikiharness.placement-result/v1`，都带 `taskId`。把它们加入 `knowledgeAgentResultSchema`。在 `operation.ts` 添加 Step 1 中三个 strict variants，保留既有通用 `knowledge.organize` variant。

从 schema 推导并导出 `KnowledgeGraphQuery`、`KnowledgeGraphNode`、`KnowledgeGraphEdge`、`KnowledgeGraphResponse`、`KnowledgeCollection`、`KnowledgeCollectionPlacement`、`KnowledgeCollectionResult` 和 `KnowledgePlacementResult`，后续 core、adapter、server 只引用这些公共类型。

- [ ] **Step 4：补齐非法边界用例**

覆盖：重复 include 被规范化前拒绝、depth 5、limit 501、非法 root、未知 node 字段、非法边类型、正文、locator、secret reference 和 dangling field 均被 schema 拒绝。合同本身不接受 `bodyMarkdown` 和 `locator` 字段。

- [ ] **Step 5：运行 protocol 测试和类型检查**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/protocol test
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/protocol typecheck
```

Expected: protocol 全部 PASS。

- [ ] **Step 6：提交合同切片**

```bash
git add packages/protocol
git commit -m "feat: define authorized knowledge graph contracts"
```

## 3. Task 2：新增层级持久化结构

**Files:**

- Create: `packages/adapters/migrations/0002_knowledge_collections.sql`
- Modify: `packages/adapters/test/postgres-cloud-registry.integration.test.ts`
- Create: `packages/adapters/test/postgres-knowledge-hierarchy.integration.test.ts`

- [ ] **Step 1：先写 migration 失败测试**

把 migration 幂等测试的期望数量改为 2，并增加：

```ts
expect(await database.query<{ name: string }>(
  `select name from openlifewiki_schema_migrations order by name`,
)).toMatchObject({ rows: [
  { name: "0001_cloud_registry.sql" },
  { name: "0002_knowledge_collections.sql" },
] });
```

在 hierarchy integration test 中先断言：同父目录重名失败、一条知识不能有两个 placement、collection 不能以自身为 parent。

- [ ] **Step 2：运行 PostgreSQL 测试并确认 migration 缺失**

Run:

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/adapters exec vitest run test/postgres-cloud-registry.integration.test.ts test/postgres-knowledge-hierarchy.integration.test.ts
```

Expected: FAIL，migration 数量和 collection 表缺失。

- [ ] **Step 3：添加完整 migration**

`0002_knowledge_collections.sql` 使用以下结构：

```sql
create table knowledge_collections (
  collection_id text primary key,
  org_id text not null references organizations(org_id),
  parent_collection_id text references knowledge_collections(collection_id),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  revision bigint not null default 0 check (revision >= 0),
  created_by_principal_id text not null references principals(principal_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_collection_id is null or parent_collection_id <> collection_id)
);

create unique index knowledge_collections_root_name_unique
  on knowledge_collections(org_id, name)
  where parent_collection_id is null;

create unique index knowledge_collections_child_name_unique
  on knowledge_collections(org_id, parent_collection_id, name)
  where parent_collection_id is not null;

create index knowledge_collections_parent_lookup
  on knowledge_collections(org_id, parent_collection_id, collection_id);

create table knowledge_collection_items (
  item_id text primary key references knowledge_items(item_id),
  org_id text not null references organizations(org_id),
  collection_id text not null references knowledge_collections(collection_id),
  placed_by_principal_id text not null references principals(principal_id),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_collection_items_collection_lookup
  on knowledge_collection_items(org_id, collection_id, item_id);
```

跨组织一致性由写入 adapter 在同一事务中验证；所有 ID 本身全局唯一。不要引入 `ltree` 或新 extension。

- [ ] **Step 4：运行 migration 与约束测试**

Run Task 2 Step 2 的命令。

Expected: PASS；`runMigrations` 连续运行两次仍只记录两条 migration。

- [ ] **Step 5：构建 adapter，确认 migration 被复制到 dist**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/adapters build
test -f packages/adapters/dist/migrations/0002_knowledge_collections.sql
```

Expected: exit 0。

- [ ] **Step 6：提交 migration 切片**

```bash
git add packages/adapters/migrations packages/adapters/test/postgres-cloud-registry.integration.test.ts packages/adapters/test/postgres-knowledge-hierarchy.integration.test.ts
git commit -m "feat: add hierarchical knowledge collections"
```

## 4. Task 3：实现纯图谱投影边界

**Files:**

- Create: `packages/core/src/knowledge-graph.ts`
- Create: `packages/core/test/knowledge-graph.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1：写失败的纯逻辑测试**

使用 fake port 返回乱序节点和边：

```ts
const service = new KnowledgeGraphProjectionService({
  async readAuthorizedGraph() {
    return {
      registryRevision: 4,
      nodes: [tagNode("tag_z"), knowledgeNode("item_a")],
      edges: [tagEdge("item_a", "tag_z")],
      truncated: false,
      nextCursor: null,
    };
  },
});

const result = await service.read({
  principal: activeUser("principal_owner", "org_1"),
  query: { root: null, depth: 2, include: ["tags"], limit: 500, cursor: null },
  now: new Date("2026-08-16T00:00:00.000Z"),
});
expect(result.elements.nodes.map(({ data }) => data.id)).toEqual(["item:item_a", "tag:tag_z"]);
expect(result.generatedAt).toBe("2026-08-16T00:00:00.000Z");
```

第二个测试让 edge 指向不存在节点，期望 reject `{ code: "GRAPH_INVALID_PROJECTION" }`。第三个测试返回重复 node ID，期望 fail closed。

- [ ] **Step 2：运行测试并确认 service 缺失**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/core exec vitest run test/knowledge-graph.test.ts
```

Expected: FAIL，缺少 graph service exports。

- [ ] **Step 3：实现 ports 和 service**

使用明确边界：

```ts
export interface KnowledgeGraphPage {
  readonly registryRevision: number;
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface KnowledgeGraphReadPort {
  readAuthorizedGraph(input: {
    readonly principal: Principal;
    readonly query: KnowledgeGraphQuery;
    readonly now: Date;
  }): Promise<KnowledgeGraphPage>;
}

export interface KnowledgeHierarchyWritePort {
  createCollection(input: CreateCollectionInput): Promise<KnowledgeCollection>;
  moveCollection(input: MoveCollectionInput): Promise<KnowledgeCollection>;
  placeKnowledge(input: PlaceKnowledgeInput): Promise<KnowledgeCollectionPlacement>;
  getCollection(orgId: string, collectionId: string): Promise<KnowledgeCollection | null>;
  getPlacement(orgId: string, itemId: string): Promise<KnowledgeCollectionPlacement | null>;
}
```

输入类型在同一文件中固定为：

```ts
export interface CreateCollectionInput {
  readonly context: AccessContext;
  readonly expectedRegistryRevision: number;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly now: Date;
}

export interface MoveCollectionInput {
  readonly context: AccessContext;
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly parentCollectionId: string | null;
  readonly name: string;
  readonly description: string;
  readonly now: Date;
}

export interface PlaceKnowledgeInput {
  readonly context: AccessContext;
  readonly itemId: string;
  readonly collectionId: string;
  readonly expectedPlacementRevision: number | null;
  readonly now: Date;
}

export class KnowledgeGraphError extends Error {
  constructor(readonly code: KnowledgeGraphErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeGraphError";
  }
}
```

`KnowledgeGraphProjectionService.read()` 必须：验证 active user、调用 port、拒绝重复节点、拒绝 dangling edge、按 node type/ID 和 edge type/ID 稳定排序，最后通过 `knowledgeGraphResponseSchema.parse` 返回。

- [ ] **Step 4：运行 core 单测和 typecheck**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/core test
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/core typecheck
```

Expected: core 全部 PASS。

- [ ] **Step 5：提交纯投影切片**

```bash
git add packages/core
git commit -m "feat: add deterministic knowledge graph projection"
```

## 5. Task 4：实现 HMAC cursor 与权限感知 PostgreSQL 图读取

**Files:**

- Create: `packages/adapters/src/postgres/graph-cursor.ts`
- Create: `packages/adapters/src/postgres/knowledge-graph-store.ts`
- Create: `packages/adapters/test/graph-cursor.test.ts`
- Create: `packages/adapters/test/postgres-knowledge-graph.integration.test.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1：写 cursor 失败测试**

```ts
const codec = new GraphCursorCodec("test-token-secret-with-at-least-32-bytes");
const cursor = codec.encode({
  version: 1,
  orgId: "org_1",
  principalId: "principal_1",
  queryHash: `sha256:${"a".repeat(64)}`,
  registryRevision: 9,
  afterSeedKey: "item:item_9",
});
expect(codec.decode(cursor)).toMatchObject({ registryRevision: 9, afterSeedKey: "item:item_9" });
expect(() => codec.decode(`${cursor}tampered`)).toThrowError(expect.objectContaining({
  code: "GRAPH_INVALID_QUERY",
}));
```

增加 principal、query hash、revision 不匹配时由 store 返回 `GRAPH_SNAPSHOT_EXPIRED` 的测试。

- [ ] **Step 2：实现 domain-separated cursor codec**

payload 使用规范 JSON 的 base64url，加 `.` 和 HMAC-SHA-256 base64url。摘要输入必须以 `graph-cursor\0` 开头。比较使用 `timingSafeEqual`；decode 先限制总长度 4,096，再严格 schema parse。禁止把 token、secret 或正文写入 payload。

- [ ] **Step 3：写 PostgreSQL 权限矩阵失败测试**

fixture 建立：

- Owner 和 organization query grant；
- Member A 和 item query grant；
- Member B 和 tag query grant；
- Member C 无 grant；
- 一个 stable item、一个 Owner private draft、一个隐藏 sibling；
- 两级 collection、tag、managed location、current version、connector 和 item share。

断言：

```ts
expect(ids(await store.readAuthorizedGraph(ownerInput))).toContain("item:item_stable");
expect(ids(await store.readAuthorizedGraph(ownerInput))).toContain("item:item_draft");
expect(ids(await store.readAuthorizedGraph(memberItemInput))).toEqual(expect.arrayContaining([
  "collection:collection_root", "collection:collection_child", "item:item_stable",
]));
expect(ids(await store.readAuthorizedGraph(memberItemInput))).not.toContain("item:item_draft");
await expect(store.readAuthorizedGraph(noGrantInput)).rejects.toMatchObject({ code: "GRAPH_FORBIDDEN" });
await expect(store.readAuthorizedGraph(hiddenRootInput)).rejects.toMatchObject({ code: "GRAPH_ROOT_NOT_FOUND" });
```

响应序列化后断言不含 `body_markdown` 内容、locator、本地路径、secret reference、隐藏 item ID/标题和其他成员的 grant。

- [ ] **Step 4：实现授权 item CTE**

`knowledge-graph-store.ts` 的 SQL 必须先构造 `authorized_items`：

```sql
with authorized_items as (
  select distinct ki.*
  from knowledge_items ki
  join resource_grants rg
    on rg.org_id = ki.org_id
   and rg.principal_id = $1
   and rg.revoked_at is null
   and (rg.expires_at is null or rg.expires_at > $2)
   and 'knowledge.query' = any(rg.capabilities)
   and (
     (rg.scope_kind = 'organization' and rg.scope_id = ki.org_id)
     or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
     or (rg.scope_kind = 'tag' and exists (
       select 1 from knowledge_tags kt join tags t on t.tag_id = kt.tag_id
       where kt.item_id = ki.item_id and t.name = rg.scope_id
     ))
     or (rg.scope_kind = 'source' and exists (
       select 1
       from knowledge_locations kl
       join source_authorizations sa on sa.source_authorization_id = kl.source_authorization_id
       where kl.item_id = ki.item_id and sa.source_id = rg.scope_id
     ))
   )
  where ki.org_id = $3
    and (
      ki.status <> 'draft'
      or ki.owner_principal_id = $1
      or (rg.scope_kind = 'item' and rg.scope_id = ki.item_id)
    )
)
```

先验证 principal 是 active user。没有任何有效 query grant 时抛 `GRAPH_FORBIDDEN`。禁止先加载组织全量数据再在 TypeScript 过滤。

- [ ] **Step 5：实现 collection/root/depth 和 bundle pagination**

使用 recursive CTE 得到授权 item 的 ancestor collections。organization query grant 可以读取组织 collection；其他 grant 只返回可见 item 所需祖先路径。无 placement 的 item 连接虚拟 `collection:unfiled`。

分页以稳定 `seedKey` 进行：collection seed 和 item seed 都按字典序排列；每个 seed 扩展成一个完整、无 dangling edge 的 bundle。按 bundle 累加到 node budget；共享祖先或 tag 可以跨页重复。cursor 保存最后完成的 seedKey。第一页至少返回一个完整 bundle；单个 bundle 超过 500 节点时返回 `GRAPH_INVALID_QUERY`，不得发送部分 item 关系。

- [ ] **Step 6：实现 include 裁剪和人员隐私**

- 默认 collection、knowledge、tag；
- location 不含 locator/metadata；
- version 只返回当前版本安全字段，不含正文/provenance；
- `SHARED_WITH` 仅对 item Owner、organization Owner 或与当前用户自身相关的 grant返回；
- edge 两端必须在当前 bundle nodes 中；
- 节点和边 ID 使用 `<type>:<registry-id>` 与稳定关系组合。

- [ ] **Step 7：运行 adapter graph 测试**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/adapters exec vitest run test/graph-cursor.test.ts
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/adapters exec vitest run test/postgres-knowledge-graph.integration.test.ts
```

Expected: 全部 PASS；无 grant、隐藏 root、篡改 cursor 和过期 cursor 使用稳定错误码。

- [ ] **Step 8：提交读投影切片**

```bash
git add packages/adapters/src/postgres/graph-cursor.ts packages/adapters/src/postgres/knowledge-graph-store.ts packages/adapters/src/index.ts packages/adapters/test/graph-cursor.test.ts packages/adapters/test/postgres-knowledge-graph.integration.test.ts
git commit -m "feat: read authorized knowledge graphs from postgres"
```

## 6. Task 5：实现受控目录写入

**Files:**

- Create: `packages/adapters/src/postgres/knowledge-hierarchy-store.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/adapters/test/postgres-knowledge-hierarchy.integration.test.ts`

- [ ] **Step 1：补写失败的权限、CAS 和循环测试**

覆盖：

- organization scope `knowledge.organize` 成功；
- item scope organize grant 失败；
- Agent delegation 缺 capability、scope 过期或 revoked 时失败；
- create 的 `expectedRegistryRevision` 不匹配返回 `REVISION_CONFLICT`；
- move 的 collection revision 不匹配返回 `REVISION_CONFLICT`；
- placement null/数值 revision 的创建、幂等 replay、移动和冲突；
- A→B→C 后把 A 移到 C 返回 `KNOWLEDGE_CONFLICT`；
- 跨组织 parent、item 或 collection 返回 `KNOWLEDGE_NOT_FOUND`；
- 失败事务不增加 registry revision，不留下审计 completed 记录；
- 成功事务 revision 加一并有 completed audit。

- [ ] **Step 2：运行 hierarchy 测试并确认 store 缺失**

Run Task 2 Step 2 中只包含 `postgres-knowledge-hierarchy.integration.test.ts` 的命令。

Expected: FAIL，缺少 `PostgresKnowledgeHierarchyStore`。

- [ ] **Step 3：实现组织级权限交集**

store 加载 user grants、Agent principal capabilities 和 delegation，调用现有 `authorizeKnowledgeOperation`：

```ts
const decision = authorizeKnowledgeOperation({
  context: input.context,
  capability: "knowledge.organize",
  resource: {
    orgId: input.context.orgId,
    itemId: null,
    sourceId: null,
    tags: [],
  },
  userGrants,
  agentCapabilities,
  delegation,
  now: input.now,
});
```

随后额外要求命中的 active grant scope 为 `{ kind: "organization", id: context.orgId }`，Agent delegation 也必须包含相同 organization scope。缺失时返回 `DELEGATION_DENIED`。

- [ ] **Step 4：实现 create/move/place 事务**

每个 mutation：

1. `select ... from organizations where org_id = $1 for update`；
2. 校验 expected revision；
3. 校验同组织 parent/item/collection；
4. move 使用 recursive CTE 检查 descendants；
5. 使用 `UPDATE ... WHERE revision = $expected` CAS；
6. 成功后 `registry_revision = registry_revision + 1`；
7. 插入 `audit_events`，action 分别为 `knowledge.collection.create`、`knowledge.collection.move`、`knowledge.place`；
8. 返回 protocol schema parse 后的 collection 或 placement。

重复 `knowledge.place` 指向相同 collection 且 expected placement revision 相同，作为幂等 replay返回，不递增任何 revision。

- [ ] **Step 5：运行 hierarchy PostgreSQL 测试和 adapter typecheck**

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/adapters exec vitest run test/postgres-knowledge-hierarchy.integration.test.ts
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/adapters typecheck
```

Expected: 全部 PASS。

- [ ] **Step 6：提交 hierarchy store**

```bash
git add packages/adapters/src/postgres/knowledge-hierarchy-store.ts packages/adapters/src/index.ts packages/adapters/test/postgres-knowledge-hierarchy.integration.test.ts
git commit -m "feat: authorize hierarchical knowledge mutations"
```

## 7. Task 6：通过 A2A 唯一写入口接入目录操作

**Files:**

- Create: `packages/knowledge-agent/src/organization-operations.ts`
- Create: `packages/knowledge-agent/test/organization-operations.integration.test.ts`
- Modify: `packages/knowledge-agent/src/index.ts`
- Modify: `packages/knowledge-agent/src/agent.ts`
- Modify: `packages/adapters/src/postgres/knowledge-store.ts`
- Modify: `apps/knowledge-server/src/agent-executor.ts`
- Modify: `apps/knowledge-server/src/knowledge-task-runner.ts`
- Modify: `apps/knowledge-server/src/agent-card.ts`
- Modify: `apps/knowledge-server/src/a2a-server.ts`
- Modify: `apps/knowledge-server/test/a2a-query.integration.test.ts`

- [ ] **Step 1：写 KnowledgeOrganizationOperations 失败测试**

使用 fake hierarchy port 验证三个 operation 被严格解析并转发 AccessContext。然后用 PostgreSQL store 验证结果分别通过 `knowledgeCollectionResultSchema` 和 `knowledgePlacementResultSchema`。

```ts
const operations = new KnowledgeOrganizationOperations(store);
const result = await operations.createCollection(context, {
  schema: "openlifewiki.operation/v1",
  kind: "knowledge.collection.create",
  expectedRegistryRevision: 0,
  parentCollectionId: null,
  name: "Projects",
  description: "Project knowledge",
});
expect(result.schema).toBe("cowikiharness.collection-result/v1");
expect(result.taskId).toBe(context.taskId);
```

- [ ] **Step 2：实现独立 organization operations**

`KnowledgeOrganizationOperations` 只依赖 `KnowledgeHierarchyWritePort`，提供 `createCollection`、`moveCollection` 和 `placeKnowledge`。捕获 `AdapterError` 时仅映射现有稳定 Knowledge error codes；未知异常映射为 `INVALID_OPERATION`。

模型 tools 保持 `knowledge_search`、`knowledge_get` 两个只读工具，不把目录写入暴露给模型自由调用。

- [ ] **Step 3：让 task authority 识别新 operation**

在 `capabilityForOperation()` 增加：

```ts
case "knowledge.collection.create":
case "knowledge.collection.move":
case "knowledge.place":
  return "knowledge.organize";
```

`SupportedKnowledgeOperation` 改为只排除通用 `knowledge.organize`；`parseA2AOperation` 接受三个具体 operation，继续拒绝通用 instruction-based organize。

- [ ] **Step 4：接入 structured runner 和崩溃恢复**

给 `KnowledgeServerTaskRunner` 注入 `KnowledgeOrganizationOperations` 和 hierarchy read port。`executeOperation()` 增加三个 case；`recoveryAction()` 增加对应 audit action。恢复时根据 completed audit 的 target ID 调用 `getCollection` 或 `getPlacement`，重建相同 result schema，再完成 task。

`createA2AServer()` 在现有 `PostgresKnowledgeStore` 旁创建一个 `PostgresKnowledgeHierarchyStore(database)`，再创建 `new KnowledgeOrganizationOperations(hierarchyStore)` 并注入 runner。不要把 hierarchy store 注入模型 tools。

在 A2A integration test 增加“事务已完成、task output 尚未持久化”的 recovery fixture，断言服务重启后 task completed 且 mutation 不重复执行。

- [ ] **Step 5：更新 Agent Card 和结果匹配**

Agent Card skills 末尾增加：

```ts
skill("knowledge.organize", "Organize knowledge", "Create and move collections or place knowledge through explicit structured operations.")
```

`assertResultMatchesOperation()` 把三个 operation 映射到对应 `cowikiharness.*-result/v1`。通用 `knowledge.organize` 继续映射 `null` 并被外部 structured parser 拒绝。

- [ ] **Step 6：更新所有测试清理顺序**

在删除 `knowledge_items` 和 `knowledge_collections` 前先删除 `knowledge_collection_items`；删除 principals/organizations 前删除 `knowledge_collections`。修改涉及的 adapters、knowledge-agent 和 server PostgreSQL fixture cleanup。

- [ ] **Step 7：运行 knowledge-agent 和 A2A 测试**

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-agent test
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/a2a-query.integration.test.ts
```

Expected: Agent tools仍为只读；三个 structured organize journeys 和恢复测试 PASS。

- [ ] **Step 8：提交 A2A 写入切片**

```bash
git add packages/knowledge-agent packages/adapters/src/postgres/knowledge-store.ts apps/knowledge-server/src apps/knowledge-server/test/a2a-query.integration.test.ts
git commit -m "feat: organize knowledge hierarchy through a2a"
```

## 8. Task 7：暴露只读 Graph REST API

**Files:**

- Create: `apps/knowledge-server/src/graph-route.ts`
- Create: `apps/knowledge-server/test/graph-route.test.ts`
- Create: `apps/knowledge-server/test/graph-route.integration.test.ts`
- Modify: `apps/knowledge-server/src/config.ts`
- Modify: `apps/knowledge-server/src/authentication.ts`
- Modify: `apps/knowledge-server/src/a2a-server.ts`
- Modify: `.env.example`

- [ ] **Step 1：写 config、query 和 CORS 失败测试**

覆盖：

```ts
expect(readServerConfig({
  ...testEnvironment(),
  OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS: "https://graph.example,http://127.0.0.1:5173",
}).graphAllowedOrigins).toEqual(["https://graph.example", "http://127.0.0.1:5173"]);

expect(parseGraphHttpQuery({ depth: "2", include: "tags,versions", limit: "100" }))
  .toEqual({ root: null, depth: 2, include: ["tags", "versions"], limit: 100, cursor: null });
expect(() => parseGraphHttpQuery({ depth: "5" })).toThrowError(expect.objectContaining({
  code: "GRAPH_INVALID_QUERY",
}));
```

CORS 测试断言允许 origin 得到精确 header；未知 origin、`*`、带 path/query 的配置失败；OPTIONS 不要求 bearer token。

- [ ] **Step 2：实现配置和 HTTP 参数解析**

`ServerConfig` 增加 `graphAllowedOrigins: readonly string[]`。空环境变量解析为 `[]`。每个 origin 使用 `new URL()`，要求 `url.origin === normalized value`；允许 HTTPS 和 loopback HTTP，拒绝 wildcard、credential、path、query、hash。

HTTP defaults 固定为：root `null`、depth `2`、include `tags`、limit `500`、cursor `null`。`collection:<id>` 映射 `{ type: "collection", id }`，`item:<id>` 映射 `{ type: "knowledge", id }`。重复 query parameter、重复 include 和未知 include 返回 400。

- [ ] **Step 3：实现 CORS middleware 和 route 顺序**

在 `a2a-server.ts` 中保持顺序：

```ts
app.get("/healthz", healthHandler);
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use("/api/v1/graph", createGraphCorsMiddleware(config.graphAllowedOrigins));
app.use(createBearerAuthentication({ store, now }));
app.get("/api/v1/graph", createGraphHandler({ service: graphService, now }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: buildAuthenticatedUser }));
```

装配时创建 `new PostgresKnowledgeGraphStore(database, config.tokenHmacSecret)`，再传给 `new KnowledgeGraphProjectionService(graphStore)`。复用同一个 Database pool 和 HMAC secret，不创建第二连接池或第二 secret。

CORS middleware 只在精确允许时设置 `Access-Control-Allow-Origin`，设置 `Vary: Origin`，并独立处理 OPTIONS。不要对整个 A2A 服务开启 CORS。

- [ ] **Step 4：实现 handler、ETag 和稳定错误**

handler 从认证 request 取得 principal；非 user 返回 403 `GRAPH_PRINCIPAL_NOT_SUPPORTED`。调用 projection service 后，以 `principalId + canonical query + registryRevision` 的 SHA-256 生成 quoted ETag。每次请求写一条脱敏结构化日志，字段固定为 `event`、`requestId`、`orgId`、principal ID 的 SHA-256、query hash、registry revision、node count、edge count、durationMs、status 和 error code。设置：

```text
Cache-Control: private, max-age=0, must-revalidate
Vary: Authorization, Origin
Content-Type: application/json
```

`If-None-Match` 精确命中返回 304。错误按设计文档第十节映射；所有响应设置随机 `X-Request-ID` header，错误 envelope 同时返回该 `requestId`。服务端日志禁止记录 token、标题、locator 和 SQL。

- [ ] **Step 5：写真实 HTTP 权限旅程**

`graph-route.integration.test.ts` 启动真实 `createA2AServer`，注入不会被调用的 model runtime。断言：

- Owner token 200；
- item-granted member 只看到共享 item 和祖先目录；
- no-grant member 403；
- Agent/Relay token 403；
- hidden root 和 unknown root 都是相同 404 body；
- 允许 origin 有 CORS header，其他 origin 无 header；
- 第二次带 ETag 返回 304；
- Registry mutation 后旧 cursor 409；
- response wire 中没有正文、locator、hidden IDs、token；
- model call count 为 0，`agent_tasks` 数量不变。

- [ ] **Step 6：运行 server tests**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/knowledge-server exec vitest run test/graph-route.test.ts
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/graph-route.integration.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 7：提交 HTTP 切片**

```bash
git add apps/knowledge-server/src apps/knowledge-server/test/graph-route.test.ts apps/knowledge-server/test/graph-route.integration.test.ts .env.example
git commit -m "feat: expose authorized graph projection api"
```

## 9. Task 8：增加终端图谱读取与目录整理命令

**Files:**

- Modify: `apps/knowledge-server/src/client.ts`
- Modify: `apps/knowledge-server/test/client.test.ts`
- Modify: `skills/cowikiharness/SKILL.md`

- [ ] **Step 1：先写只读 graph 命令失败测试**

给 `runClient` 增加可注入的 `fetchGraph`，测试 token 只通过函数参数传递且不会输出：

```ts
const fetched: ClientGraphInput[] = [];
const code = await runClient({
  argv: ["graph", "--depth", "2", "--include", "tags,locations", "--token-file", "/tmp/owner.token"],
  env: { COWIKIHARNESS_URL: "https://knowledge.example" },
  homeDir: () => "/unused",
  readTextFile: async () => "user-token-value",
  fetchGraph: async (input) => {
    fetched.push(input);
    return {
      schema: "cowikiharness.graph/v1",
      registryRevision: 1,
      generatedAt: "2026-08-16T00:00:00.000Z",
      elements: { nodes: [], edges: [] },
      truncated: false,
      nextCursor: null,
    };
  },
  stdout: (value) => output.push(value),
  stderr: (value) => errors.push(value),
});
expect(code).toBe(0);
expect(fetched).toEqual([{
  url: "https://knowledge.example/api/v1/graph?depth=2&include=tags%2Clocations",
  token: "user-token-value",
}]);
expect(JSON.stringify(output)).not.toContain("user-token-value");
```

实现的用户命令为：

```text
cowiki graph --depth <0..4> --include <comma-separated> [--root <collection:id|item:id>] [--limit <1..500>] [--cursor <cursor>] --token-file <user-token-file>
```

`graph` 使用原生 `fetch` 请求 `/api/v1/graph`；不通过 A2A，不读取数据库。新增并导出 `ClientGraphInput` 与可注入的 `fetchGraph`，成功响应通过 `knowledgeGraphResponseSchema` 校验。默认 token 文件仍是 Agent token，因此文档和错误信息必须明确 graph 需要显式用户 token 文件。401、403、404、409 和网络错误统一输出 token-safe `COWIKIHARNESS_REQUEST_FAILED`。

- [ ] **Step 2：先写 CLI organize operation 失败测试**

运行以下 argv 并捕获发送的 data operation：

```ts
const cases = [
  [
    ["collection-create", "--name", "Projects", "--description", "Project knowledge", "--expected-registry-revision", "3"],
    expect.objectContaining({ kind: "knowledge.collection.create", parentCollectionId: null }),
  ],
  [
    ["collection-move", "--collection", "collection_1", "--parent", "collection_2", "--name", "Architecture", "--description", "Architecture knowledge", "--expected-revision", "0"],
    expect.objectContaining({ kind: "knowledge.collection.move", collectionId: "collection_1" }),
  ],
  [
    ["knowledge-place", "--item", "item_1", "--collection", "collection_2"],
    expect.objectContaining({ kind: "knowledge.place", expectedPlacementRevision: null }),
  ],
] as const;
```

另测 `--parent root` 映射 null；非法 revision、漏字段、重复 flag 和未知 flag 在读取 token 前返回 `COWIKIHARNESS_INVALID_ARGUMENTS`。

- [ ] **Step 3：实现 graph 和三个 organize parseCommand 分支**

命令合同：

```text
cowiki collection-create --name <name> --description <text> --expected-registry-revision <n> [--parent <id|root>]
cowiki collection-move --collection <id> --name <name> --description <text> --expected-revision <n> [--parent <id|root>]
cowiki knowledge-place --item <id> --collection <id> [--expected-placement-revision <n>]
```

目录写命令保持默认 Agent token，通过 A2A delegation 执行。graph 命令要求显式 `--token-file` 指向用户 token。不要让 `cowiki` 直接访问数据库或 `/api/v1/graph` 写入。

- [ ] **Step 4：更新 CoWikiHarness Skill**

增加“整理目录”段，明确：

- 先通过图谱响应获得 `registryRevision`、collection revision 或 placement revision；
- 展示精确变更并获得用户批准；
- 再运行对应 `cowiki` 命令；
- revision conflict 时重新读取并重新确认；
- 可视化 REST API 始终只读；终端查看使用 `cowiki graph --token-file <user-token-file>`。

- [ ] **Step 5：运行 CLI 测试**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm --filter @openlifewiki/knowledge-server exec vitest run test/client.test.ts
```

Expected: 全部 PASS，既有 ask/register/store/replace 行为不变。

- [ ] **Step 6：提交终端切片**

```bash
git add apps/knowledge-server/src/client.ts apps/knowledge-server/test/client.test.ts skills/cowikiharness/SKILL.md
git commit -m "feat: add terminal knowledge graph commands"
```

## 10. Task 9：记录架构与外部使用路径

**Files:**

- Create: `docs/decisions/ADR-0009-authorized-graph-projection-api.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `.env.example`
- Modify: `docs/memory-bank/active-context.md`

- [ ] **Step 1：写 ADR**

ADR 记录：

- Context：Registry 有关系事实，外部工具缺稳定读取面；
- Decision：同一 Node 服务内的只读 REST projection、PostgreSQL 单一事实源、用户 token、Cytoscape-compatible JSON；
- Rejected：GraphQL、Neo4j、直连数据库、A2A/LLM 图谱查询；
- Consequences：新增公共 schema 兼容责任，保留未来图库升级触发条件；
- Rollback：回滚应用版本，保留新增表。

- [ ] **Step 2：补充 README 外部访问说明**

给出完整流程：

```bash
export COWIKIHARNESS_URL=http://127.0.0.1:8080
cowiki graph \
  --depth 2 \
  --include tags,locations \
  --token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token"
```

文档明确 URL 和命令参数中不放 token 值；生产走 HTTPS；浏览器配置精确 `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS`；Owner token 只用于本地受控验证，外部应用推荐使用专门成员 token 和最小 query grant。

- [ ] **Step 3：记录最小成员 token 创建方式**

使用现有管理命令：

```bash
pnpm openlifewiki cloud member create \
  --name graph-viewer \
  --owner-token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  --json

pnpm openlifewiki cloud grant \
  --principal <上一步返回的 principalId> \
  --scope organization:<orgId> \
  --capability knowledge.query \
  --owner-token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  --json
```

这里的尖括号是用户替换的命令输出字段，不能写入仓库配置或日志。README 同时给出 item scope 最小授权示例。

- [ ] **Step 4：更新架构和 active context**

ARCHITECTURE 增加：Agent/A2A 写入与问答、Graph REST 确定性读取共用 authentication/access policy/PostgreSQL；图谱 route 不调用模型。active context 记录真实完成状态，未通过 smoke 前不能写“已完成”。

- [ ] **Step 5：检查文档和提交**

```bash
git diff --check
rg -n "T[B]D|T[O]DO|待[定]|适当处[理]" README.md ARCHITECTURE.md docs/decisions/ADR-0009-authorized-graph-projection-api.md docs/memory-bank/active-context.md
```

Expected: 无匹配、无 whitespace 错误。

```bash
git add README.md ARCHITECTURE.md .env.example docs/decisions/ADR-0009-authorized-graph-projection-api.md docs/memory-bank/active-context.md
git commit -m "docs: document external knowledge graph access"
```

## 11. Task 10：全量验证与真实数据验收

**Files:**

- Modify after passing: `docs/superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md`
- Modify after passing: `docs/memory-bank/active-context.md`

- [ ] **Step 1：运行最小静态门禁**

```bash
git diff --check
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm schema:check
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm build
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm typecheck
```

Expected: 全部 exit 0。

- [ ] **Step 2：运行全量无 PostgreSQL测试**

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm verify
```

Expected: 所有非 opt-in 测试 PASS，原有 skipped 数量只来自既有 opt-in live tests。

- [ ] **Step 3：运行 PostgreSQL 17 云端门禁**

优先启动隔离 PostgreSQL 17，再运行：

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm verify:cloud
```

Expected: adapters、knowledge-agent、knowledge-server 的真实 PostgreSQL tests 全部 PASS。Docker daemon 不可用时，本机 PostgreSQL 15 结果只能作为中间证据；发布门禁仍记录 PostgreSQL 17 未运行，不能宣称完整云端验收。

- [ ] **Step 4：本地真实服务 smoke test**

在受控终端读取仓库外 Owner token，调用：

```bash
cowiki graph \
  --depth 2 \
  --include tags,locations,versions \
  --token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token" \
  > /tmp/cowikiharness-graph.json
```

Expected：响应通过 `cowikiharness.graph/v1` schema，至少包含当前已登记的 `CoWikiHarness 本机使用说明` 和 `product`、`local-setup` tag edges；wire 中没有该知识的 Markdown 正文。

如果 Owner token 未保存，先通过现有安全管理流程签发一个过期时间受控的 user token；不得从数据库读取 token digest 或伪造 token。

- [ ] **Step 5：验证 Cytoscape 直接消费形状**

无需安装依赖。用 Node 读取 smoke JSON 并检查：

```bash
node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(v.elements?.nodes)||!Array.isArray(v.elements?.edges)) process.exit(1)' /tmp/cowikiharness-graph.json
```

Expected: exit 0。临时响应留在 `/tmp`，不进入 Git。

- [ ] **Step 6：安全与回归检查**

```bash
rg -n "bodyMarkdown|body_markdown|token_digest|secret_reference|Authorization" apps/knowledge-server/src/graph-route.ts packages/protocol/src/graph.ts packages/adapters/src/postgres/knowledge-graph-store.ts
```

逐条确认匹配仅用于拒绝、参数名或内部 SQL 列裁剪，没有进入响应构造或日志。然后检查：

- 无权限节点无 ID、标题、边和计数泄露；
- Agent/Relay token 被拒绝；
- CORS 无 wildcard；
- cursor 使用 constant-time HMAC compare；
- A2A Agent 工具仍然只读；
- 没有新增依赖、服务或数据库。

- [ ] **Step 7：更新真实完成记录**

全部门禁通过后：

- 将 spec 状态改为“已实施并验证”；
- 在 active context 记录 commit、测试数量、PostgreSQL 版本、smoke item 和未完成的 future scope；
- 若 PostgreSQL 17 未通过，只记录“本地验证通过，PG17 门禁待完成”，不得写完整通过。

- [ ] **Step 8：提交验收记录**

```bash
git add docs/superpowers/specs/2026-08-16-authorized-knowledge-graph-projection-design.md docs/memory-bank/active-context.md
git commit -m "test: verify authorized knowledge graph journey"
```

- [ ] **Step 9：最终检查并推送 dev**

```bash
git status -sb
git log --oneline --decorate -12
git push origin dev
```

Expected：`dev` 与 `origin/dev` 同步，工作区干净。不要修改或合并 `main`。

## 12. 验收门禁

以下全部满足才算完成：

- [ ] API 使用 user bearer token 返回 `cowikiharness.graph/v1`。
- [ ] resource grant 在 SQL 阶段过滤，跨用户图谱隔离通过真实 PostgreSQL测试。
- [ ] 隐藏知识不产生节点、边、计数、错误差异或人员信息。
- [ ] 正文、locator、凭据、本地绝对路径和 secret reference 不进入响应。
- [ ] 单一主目录、循环阻止、CAS、registry revision 和审计测试通过。
- [ ] 外部 REST 保持只读；三个目录写操作只通过 A2A structured operation。
- [ ] Graph 请求不调用 LLM，不创建 Agent task。
- [ ] ETag/304、CORS allowlist、HMAC cursor 和稳定错误合同通过。
- [ ] `pnpm verify`、PostgreSQL集成测试和本地真实数据 smoke 通过。
- [ ] 没有新依赖、额外运行服务、生成文件、credential 或个人知识进入 Git。

## 13. 回滚

- 应用回滚到此功能前 commit；`0002_knowledge_collections.sql` 保留，不执行 destructive down migration。
- 新表没有被旧版本引用，不影响 A2A query/register/store/share。
- 浏览器跨域默认关闭；清空 `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS` 可立即阻止浏览器跨域访问，服务端调用仍受 bearer 权限控制。
- 如果 graph route 故障，反向代理可临时阻断 `/api/v1/graph`，Knowledge Agent 继续运行。
- 任何回滚不得撤销或重写已有 migration checksum。
