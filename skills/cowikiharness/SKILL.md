---
name: cowikiharness
description: Use when Codex needs to query, register, store, replace, inspect, or organize authorized knowledge through CoWikiHarness.
---

# CoWikiHarness

`cowiki` 是知识中枢唯一入口。禁止直接访问 PostgreSQL、Connector 或绕过命令写 REST。

## 查询

```bash
cowiki ask "<question>"
```

仅把返回答案和引用作为中枢证据；引用保留 `itemId`、`locationId`、locator 和 version。若 `evidenceMode` 为 `no-evidence`，说明证据缺口；仅在用户允许后使用明确标注的外部来源。

## 登记外部位置

```bash
cowiki register --title "<title>" --kind "<kind>" --locator "<locator>" --tag "<tag>"
```

执行前确认准确的标题、位置类型和 locator。登记只记录地址与元数据，不代表获准复制正文。

## 保存托管草稿

```bash
cowiki store --title "<title>" --body-file "<absolute-markdown-path>" --tag "<tag>"
```

仅在用户明确要求持久化时执行。正文先写入临时 Markdown 文件；新条目保持私有草稿，直到用户明确要求分享。

## 替换托管知识

```bash
cowiki preview-replace --item "<item-id>" --expected-revision <revision> --title "<title>" --body-file "<absolute-markdown-path>"
```

展示返回的旧/新 hash、revision 和 `previewHash`，取得用户对这一次预览的明确批准后执行：

```bash
cowiki apply-replace --item "<item-id>" --expected-revision <revision> --title "<title>" --body-file "<absolute-markdown-path>" --preview-hash "<preview-hash>"
```

标题、正文、item、revision 或 preview hash 任一变化后，原批准失效。

## 查看图谱

```bash
cowiki graph --depth <0..4> --include <comma-separated> [--root <collection:id|item:id>] [--limit <1..500>] [--cursor <cursor>] --token-file <用户 token 文件>
```

`graph` 使用用户 token 读取只读 REST 图谱；必须显式提供用户 token 文件，默认 Agent token 不可用于图谱。可视化 REST API 始终只读。

## 整理目录

只允许以下结构化命令；它们使用默认 Agent token，经 A2A 执行：

```bash
cowiki collection-create --name <name> --description <text> --expected-registry-revision <n> [--parent <id|root>]
cowiki collection-move --collection <id> --name <name> --description <text> --expected-revision <n> [--parent <id|root>]
cowiki knowledge-place --item <id> --collection <id> [--expected-placement-revision <n>]
```

Agent 必须按顺序执行：

1. 用 `cowiki graph` 读取最新状态。创建集合取 `registryRevision`；移动集合取该 collection 的 `revision`；放置知识取当前 placement revision。三者不可混用为同一个层级 revision。
2. 向用户展示精确变更、目标 ID、父级和对应 revision，取得明确批准。
3. 使用上面的准确 `cowiki` 命令经 A2A 执行。
4. 发生 revision conflict 时重新读取图谱、重新展示并取得新批准；禁止自动重试。

禁止虚构命令或参数，包括 `cowikiharness hierarchy show`、`--token default`、`collections create/move`、`items move`。token 值不得进入 URL、命令、日志或输出；命令中只传 token 文件路径。

## 失败处理

- 认证或 delegation 失败时停止，并只报告稳定错误码。
- revision 或 preview 冲突时重新读取/预览并重新确认，禁止自动重试写入。
- 禁止打印 token 文件内容、bearer token、模型凭据或数据库密钥。
