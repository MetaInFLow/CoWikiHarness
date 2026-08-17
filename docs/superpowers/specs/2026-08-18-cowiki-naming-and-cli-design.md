# CoWikiHarness `cowiki` 统一命名与 CLI 设计

**状态：已获用户批准，待用户审阅落盘版本**  
**日期：2026-08-18**  
**范围：CLI 入口、用户可见命名、配置迁移、协议兼容、文档口径**

## 1. 目标与成功标准

### 1.1 背景

仓库和部署已经使用 CoWikiHarness 品牌，但当前代码同时存在以下命名：

- `openlifewiki` 管理 CLI；
- `cowiki` 知识客户端脚本；
- `@openlifewiki/*` workspace package namespace；
- `OPENLIFEWIKI_*` 环境变量；
- `COWIKIHARNESS_*` 本地部署变量；
- `openlifewiki.*`、`cowikiharness.*` 和其他历史 wire schema；
- `openLifeWiki` 运行目录、技能路径和文档示例。

这会造成一个直接问题：用户无法判断哪个命令是唯一入口，也无法从 CLI 名称推断云端知识中心、本地管理和图谱访问之间的关系。

### 1.2 目标

本次重构将形成一条稳定的用户路径：

```text
CoWikiHarness 项目
        ↓
      cowiki CLI
        ↓
Profile / A2A / Graph REST / Local Management
        ↓
知识查询、登记、存储、整理、身份与本地生命周期
```

必须满足：

1. 新用户只需要记住 `cowiki` 一个命令。
2. `cowiki` 同时覆盖云端 Knowledge Agent 和本地管理能力。
3. 旧命令、旧环境变量和现有凭据在一个发布周期内继续可用，并输出迁移提示。
4. 现有 PostgreSQL 数据、token 文件、知识正文、外部 locator 和 Connector 授权不因改名丢失或失效。
5. `cowiki` 仍然是知识中枢的唯一入口；用户 CLI 不直接访问 PostgreSQL、Connector 私有接口或索引私有存储。
6. 不增加 CLI 框架、云端 MCP、独立管理后台或其他运行时组件。

### 1.3 完成标准

以下条件全部满足才算完成：

- `cowiki --help` 展示完整命令树，默认输出适合人读，`--json` 输出稳定机器合同；
- `cowiki ask`、`cowiki graph`、知识写入、身份管理、本地管理和云端管理均从同一入口分派；
- `openlifewiki` 作为兼容入口可以执行原有命令，并明确显示 deprecation 提示；
- `COWIKI_*` 成为新环境变量前缀，`COWIKIHARNESS_*` 与 `OPENLIFEWIKI_*` 按优先级作为兼容别名；
- 新输出使用 `cowiki.*` 和 `COWIKI_*` 标识，旧输入合同在兼容期内可解析；
- 新安装的默认入口、配置示例和文档路径只使用 `cowiki` / `CoWikiHarness`；`openlifewiki` 仅作为隐藏兼容入口保留；
- 旧安装可在原 token 文件、原数据库和原知识目录上继续工作；
- `pnpm verify`、云端 PostgreSQL/A2A 验证、本地安装 smoke 和兼容迁移测试全部通过。

## 2. 命名决策

### 2.1 三层命名

| 层级 | canonical 名称 | 用途 |
| --- | --- | --- |
| 项目与部署品牌 | `CoWikiHarness` | GitHub 仓库、README、服务名称、部署目录、LaunchAgent/systemd |
| 用户产品与 CLI | `cowiki` | 用户每天调用的命令、配置前缀和协议短名 |
| 内部 workspace 包 | `@cowiki/*` | 仓库内部 TypeScript package namespace |

`CoWikiHarness` 和 `cowiki` 是同一个产品的两种使用层级：前者用于项目和部署识别，后者用于操作知识中心。

### 2.2 Canonical 名称映射

| 当前名称 | 新 canonical 名称 | 兼容策略 |
| --- | --- | --- |
| `openlifewiki` CLI | `cowiki` | 保留一个发布周期的兼容 wrapper |
| `@openlifewiki/*` | `@cowiki/*` | workspace 内一次性迁移；当前 package 均为 private，不维护外部 import 兼容 |
| `OPENLIFEWIKI_*` | `COWIKI_*` | 读取兼容，冲突时 fail-closed |
| `COWIKIHARNESS_*` | `COWIKI_*` | 读取兼容；部署资产可继续保留品牌变量别名 |
| `openlifewiki.*` | `cowiki.*` | 新输出 canonical，旧输入兼容 |
| `cowikiharness.*` | `cowiki.*` | 新输出 canonical，旧输入兼容 |
| `openLifeWiki` 文档产品名 | `CoWikiHarness` / `cowiki` | 历史记录和迁移说明保留原名 |
| `skills/openlifewiki-knowledge-architect` | `skills/cowiki-knowledge-architect` | 旧路径保留兼容入口 |
| `cowikiharness` Codex skill | `cowikiharness` | 保留，避免破坏当前 Codex 安装；skill 内命令全部改为 `cowiki` |

### 2.3 配置与路径原则

改名不会强制搬迁持久数据。路径迁移必须保持可回滚，并且不得复制或打印 token。

- CoWikiHarness 应用数据目录继续使用现有品牌路径，例如 macOS 的 `~/Library/Application Support/CoWikiHarness` 和 Linux 的 `/opt/cowikiharness`。
- 新配置变量使用 `COWIKI_HOME`、`COWIKI_CONFIG`、`COWIKI_WORKSPACE`、`COWIKI_CREDENTIALS_DIR`、`COWIKI_URL`、`COWIKI_TOKEN_FILE` 等前缀。
- 已有 `COWIKIHARNESS_*` 和 `OPENLIFEWIKI_*` 变量按兼容优先级读取。
- 已有 `~/openLifeWiki` 工作区、旧 config.env 和 token 文件继续被发现和使用；迁移命令只生成 canonical 配置引用，不删除原目录、不重发 token、不复制正文。
- 用户显式指定的路径始终优先于默认路径。
- 发现多个别名同时设置且值不一致时停止执行，返回 `COWIKI_CONFIG_CONFLICT`，错误信息只列变量名，不列变量值。

## 3. 统一 CLI 命令面

### 3.1 调用约定

```text
cowiki [global options] <domain> [subcommand] [arguments] [options]
```

全局选项：

| 选项 | 作用 |
| --- | --- |
| `--profile <name>` | 选择知识中心配置；默认使用 current profile |
| `--url <url>` | 临时覆盖 Knowledge Agent 地址 |
| `--token-file <path>` | 临时指定 token 文件路径；只传路径，不传 token 值 |
| `--json` | 输出稳定 JSON 合同 |
| `--quiet` | 只保留必要结果和错误码 |
| `--timeout <ms>` | 覆盖本次请求超时 |
| `-h`, `--help` | 展示当前层级帮助 |
| `-v`, `--version` | 展示版本 |

默认规则：

- 人类输出为默认格式，适合终端直接阅读；
- 自动化脚本使用 `--json`，不依赖展示文本；
- stdout 只输出成功结果，stderr 输出错误和兼容迁移提示；
- token、数据库密钥、模型密钥和完整 locator 凭据永不进入输出、URL、日志或错误详情；
- 写操作沿用现有 preview/approval/revision/CAS 约束，不允许 CLI 绕过审批语义。

### 3.2 顶层与配置

```text
cowiki help [command]
cowiki version
cowiki completion bash|zsh|fish

cowiki status
cowiki doctor

cowiki profile list
cowiki profile current
cowiki profile show <name>
cowiki profile add <name> --url <url> --token-file <path>
cowiki profile use <name>
cowiki profile remove <name>
cowiki profile doctor [<name>]

cowiki config path
cowiki config show
cowiki config validate
cowiki config migrate [--dry-run|--yes]
```

Profile 解决“一个人访问多个知识中心”的配置隔离问题。Profile 文件只保存 URL、token 文件路径、默认输出和超时等元数据，不保存明文 token。

### 3.3 Gateway 与日常查询

```text
cowiki gateway health
cowiki gateway card

cowiki ask <question>
cowiki graph
  [--depth <0..4>]
  [--include <tags,locations,versions,...>]
  [--root <collection:id|item:id>]
  [--limit <1..500>]
  [--cursor <cursor>]
```

`ask` 通过 A2A Knowledge Agent 执行；`graph` 通过只读 Graph REST 获取授权投影，不调用模型、不创建 Agent task。`graph` 必须显式使用 user token，继续保持现有权限边界。

### 3.4 知识管理

```text
cowiki knowledge search <query> [--tag <tag>] [--kind <kind>] [--limit <n>]
cowiki knowledge list [--tag <tag>] [--kind <kind>] [--status <status>]
cowiki knowledge show <item-id>

cowiki knowledge register \
  --title <title> \
  --kind <kind> \
  --locator <locator> \
  [--tag <tag>]

cowiki knowledge store \
  --title <title> \
  --body-file <absolute-path> \
  [--tag <tag>]

cowiki knowledge replace preview \
  --item <item-id> \
  --expected-revision <n> \
  --title <title> \
  --body-file <absolute-path>

cowiki knowledge replace apply \
  --item <item-id> \
  --expected-revision <n> \
  --title <title> \
  --body-file <absolute-path> \
  --preview-hash <hash> \
  --yes

cowiki knowledge share --item <item-id> --principal <id> [--scope <scope>]
cowiki knowledge place --item <item-id> --collection <collection-id> [--expected-placement-revision <n>]
cowiki knowledge archive --item <item-id> --expected-revision <n> --yes

cowiki knowledge location list --item <item-id>
cowiki knowledge location add --item <item-id> --kind <kind> --locator <locator>
cowiki knowledge location remove --item <item-id> --location <location-id> --yes

cowiki knowledge version list --item <item-id>
cowiki knowledge version show --item <item-id> --version <version-id>
```

`register` 只登记外部位置和元数据；`store` 才写入托管 Markdown。外部 locator 的凭据不会被写入注册记录。涉及正文替换的命令必须遵循 preview hash 和 expected revision 绑定。

### 3.5 集合与层级

```text
cowiki collection tree
cowiki collection list [--parent <id|root>]
cowiki collection show <collection-id>
cowiki collection create \
  --name <name> \
  --description <description> \
  --expected-registry-revision <n> \
  [--parent <id|root>]
cowiki collection move \
  --collection <collection-id> \
  --name <name> \
  --description <description> \
  --expected-revision <n> \
  [--parent <id|root>]
cowiki collection archive --collection <collection-id> --expected-revision <n> --yes
```

目录写入必须先读取最新授权图谱，使用准确的 registry/collection/placement revision，并在发生冲突时重新展示变更、重新取得用户确认。CLI 不自动重试冲突写入。

### 3.6 身份与任务

```text
cowiki identity whoami
cowiki identity list [--kind member|agent]
cowiki identity show <principal-id>
cowiki identity delegation list [--principal <id>]
cowiki identity delegation show <delegation-id>
cowiki identity grant list [--principal <id>]
cowiki identity token status

cowiki task list [--status <status>]
cowiki task show <task-id>
cowiki task watch <task-id>
cowiki task cancel <task-id> --yes
cowiki task retry <task-id> --yes
```

身份读取命令遵循当前调用者的授权范围。管理写入使用 `admin` 域，普通用户不因拥有 CLI 就获得成员、Agent、delegation 或 grant 管理权限。

### 3.7 Connector 与 Source

```text
cowiki source list
cowiki source show <source-id>
cowiki source probe [--source <source-id>]

cowiki source authorize preview --request-file <path>
cowiki source authorize apply \
  --request-file <path> \
  --digest <sha256> \
  --yes

cowiki source revoke preview --source-id <source-id>
cowiki source revoke apply \
  --source-id <source-id> \
  --digest <sha256> \
  --yes

cowiki source scan [--source <source-id>]
cowiki source status [--source <source-id>]
```

`source` 表示 Connector 的授权、探测和扫描控制面。知识中心记录 Source 与知识位置的关系；读取正文仍必须通过已授权 Connector 或受控 Local Relay。

### 3.8 管理员域

```text
cowiki admin migrate
cowiki admin bootstrap \
  --organization <name> \
  --owner <name> \
  --agent <name> \
  --credential-file <absolute-path>

cowiki admin member list
cowiki admin member show <principal-id>
cowiki admin member create --name <name>
cowiki admin member enable <principal-id> --yes
cowiki admin member disable <principal-id> --yes

cowiki admin agent list
cowiki admin agent show <principal-id>
cowiki admin agent create --name <name> --for-user <principal-id>
cowiki admin agent enable <principal-id> --yes
cowiki admin agent disable <principal-id> --yes

cowiki admin delegation list
cowiki admin delegation show <delegation-id>
cowiki admin delegation renew <delegation-id> --yes
cowiki admin delegation revoke <delegation-id> --yes

cowiki admin grant list [--principal <id>]
cowiki admin grant add --principal <id> --scope <kind:id> --capability <capability>
cowiki admin grant revoke <grant-id> --yes

cowiki admin token list [--principal <id>]
cowiki admin token rotate --principal <id>
cowiki admin token revoke --token-id <id> --yes

cowiki admin audit list [--principal <id>] [--operation <kind>] [--limit <n>]
cowiki admin audit show <event-id>
```

管理员命令可以使用本地管理员 token 或 profile 中配置的管理员身份。bootstrap 的一次性凭据只写入用户指定的权限受限文件，并在成功持久化后从 stdout 结构中移除 token 字段；CLI 永不打印 token 值。

### 3.9 本地运行时与 Relay

```text
cowiki local lifecycle
cowiki local status
cowiki local doctor
cowiki local init [--dry-run|--yes]
cowiki local activate [--dry-run|--yes]

cowiki local companion open [--no-open]
cowiki local companion status
cowiki local companion stop
cowiki local mcp --stdio

cowiki relay status
cowiki relay register --source <source-id> --endpoint <endpoint>
cowiki relay run
cowiki relay stop
```

本地 `mcp --stdio` 继续管理 QMD 的公开 MCP 进程，只在本地 Source 已达到允许状态时启动。云端知识访问路径使用 `ask`、结构化知识命令和 `graph`，不新增云端 MCP 代理。

## 4. 兼容与迁移设计

### 4.1 命令兼容

兼容入口覆盖当前已经存在的用户命令：

| 旧调用 | canonical 调用 |
| --- | --- |
| `openlifewiki lifecycle` | `cowiki local lifecycle` |
| `openlifewiki status` | `cowiki status` |
| `openlifewiki doctor` | `cowiki doctor` |
| `openlifewiki init` | `cowiki local init` |
| `openlifewiki activate` | `cowiki local activate` |
| `openlifewiki sources ...` | `cowiki source ...` |
| `openlifewiki companion ...` | `cowiki local companion ...` |
| `openlifewiki mcp --stdio` | `cowiki local mcp --stdio` |
| `openlifewiki cloud ...` | `cowiki admin ...` |
| `cowiki collection-create` | `cowiki collection create` |
| `cowiki collection-move` | `cowiki collection move` |
| `cowiki knowledge-place` | `cowiki knowledge place` |
| `cowiki register` | `cowiki knowledge register` |
| `cowiki store` | `cowiki knowledge store` |
| `cowiki preview-replace` | `cowiki knowledge replace preview` |
| `cowiki apply-replace` | `cowiki knowledge replace apply` |

旧入口执行时：

1. stderr 输出一次 deprecation 提示；
2. 实际分派到同一套 canonical handler；
3. 成功结果使用新 schema；
4. 兼容期结束前，`cowiki doctor` 报告仍在使用旧入口的配置或脚本；
5. 兼容 wrapper 不维护第二套业务逻辑。

### 4.2 环境变量兼容优先级

读取顺序如下：

```text
COWIKI_* > COWIKIHARNESS_* > OPENLIFEWIKI_*
```

同一语义的多个变量同时存在且值不一致时，命令失败并提示配置冲突。变量值不进入错误消息。

兼容期结束后只保留 `COWIKI_*`。部署文件中的服务名和品牌路径可以继续使用 `CoWikiHarness`，这属于品牌层，不属于旧产品命名。

### 4.3 协议与错误兼容

- 新生成的 operation、query result、cloud result、local result 和 graph result 使用 `cowiki.*` schema。
- A2A 结构化输入和本地读取器接受当前 `openlifewiki.*`、`cowikiharness.*` schema，并在进入应用层时规范化为 canonical schema。
- 新稳定错误码使用 `COWIKI_*`。
- 兼容调用的错误响应保留 machine-readable canonical code，并可以附带 `deprecatedCode`，禁止把 token、SQL、内部 stack 或外部凭据放入详情。
- protocol schema 的版本号保持 `/v1`；改名是标识迁移，不改变字段语义。字段语义变化另开设计和版本。

### 4.4 本地安装与数据迁移

迁移过程分为“发现、预览、确认、应用”四步：

```text
cowiki config migrate --dry-run
cowiki config migrate --yes
```

应用规则：

1. 扫描 canonical、CoWikiHarness 和 legacy 配置位置；
2. 只记录解析到的路径、profile、变量来源和冲突，不读取正文用于命名迁移；
3. 生成 canonical 配置引用，沿用现有 token 文件和 workspace 路径；
4. 保留原配置和旧目录，写入可回滚的迁移标记；
5. 不复制 token、不重发 token、不移动或删除知识正文；
6. 迁移后的 `cowiki doctor` 必须能验证 URL、token 文件权限和服务健康状态；
7. 若迁移中断，旧命令和旧配置仍可工作。

数据库只做必要的 schema/元数据迁移。历史审计事件和知识 locator 保持原值；协议标识在读入时兼容，在新写入时使用 canonical 标识。

## 5. 实现边界与模块设计

### 5.1 单一 CLI facade

沿用现有 TypeScript CLI，不引入 commander、yargs 或其他解析依赖。新增一个薄的命令解析与分派层：

```text
apps/cli/src/
  main.ts              # 进程入口、全局选项、输出与退出码
  command-parser.ts    # canonical 与 legacy argv 规范化
  command-help.ts      # 分层帮助和命令清单
  profile-command.ts   # profile/config 解析与迁移
  knowledge-command.ts # A2A/Graph 知识操作
  identity-command.ts  # 身份读取与管理操作
  local-command.ts     # 本地生命周期、Companion、MCP
  cloud-command.ts     # admin 云端初始化与管理员操作
```

各 handler 只负责输入校验、调用现有 adapter/client 和格式化结果。数据库访问继续封装在 adapter；CLI 不导入 PostgreSQL client。

### 5.2 认证与入口分流

| 命令类型 | 入口 | 身份 |
| --- | --- | --- |
| `ask`、知识读写、身份读取、任务 | A2A | profile token；按操作判断 delegation |
| `graph` | Graph REST | 显式 user token |
| `admin` | A2A 管理操作或现有 cloud local adapter | owner/admin token |
| `local` | 本地 runtime/Companion | 当前本机管理权限 |
| `source` | 本地 V1 Source 控制面或未来受控 A2A | 由现有授权策略决定 |
| `relay` | 本地 Relay 控制面 | Relay 所属用户权限 |

所有入口都在应用层收敛到同一 Access Policy；CLI 不自行判断“看起来可以访问”的资源。

### 5.3 输出、退出码和安全

统一退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 合同、认证、权限、网络或服务错误 |
| `2` | CLI 参数或调用方式错误 |
| `3` | 用户确认、preview hash、revision 或 CAS 不匹配 |
| `4` | 本地迁移冲突或需要人工恢复 |

JSON 错误合同至少包含：

```json
{
  "schema": "cowiki.error/v1",
  "code": "COWIKI_PERMISSION_DENIED",
  "message": "Permission denied",
  "details": {}
}
```

`details` 只允许脱敏、稳定、可行动的信息。token、SQL、绝对内部路径和第三方凭据不允许出现。

## 6. 测试与验收

### 6.1 单元测试

- canonical 命令树、参数校验和帮助输出；
- 当前 flat command 到 nested command 的规范化映射；
- `openlifewiki` wrapper 的 deprecation 提示和相同 handler 分派；
- `COWIKI_*`、`COWIKIHARNESS_*`、`OPENLIFEWIKI_*` 优先级和冲突 fail-closed；
- profile 增删改用只保存路径元数据，不保存 token 值；
- schema alias 读入与 canonical 输出；
- 退出码、stderr/stdout 分离和错误脱敏；
- `--json` 不要求模型变量，管理员和图谱命令可在无模型配置环境中运行。

### 6.2 集成测试

- 本地安装后 `cowiki status`、`cowiki doctor`、`cowiki ask` 和 `cowiki graph` smoke；
- PostgreSQL migration 幂等、bootstrap、member/Agent/grant/token、审计和任务命令；
- A2A query/register/store/replace/organize 通过统一 CLI；
- 旧 token 文件、旧 workspace、旧 env 和旧命令继续工作；
- token revoke 后所有相关入口立即拒绝；
- revision conflict 和 preview conflict 不自动重试；
- Graph REST 仍只读，不能通过 CLI 变成写入口；
- Local Relay 注册和离线/在线状态通过稳定错误码反馈。

### 6.3 仓库级验收

使用 Node 24 环境执行：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm verify
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm verify:cloud
```

并补充一组命名迁移检查：

- 用户可见入口、README、`.env.example`、安装脚本和 Codex skill 默认示例只使用 `cowiki` / `CoWikiHarness`；
- 允许保留旧名的范围必须限定在兼容代码、迁移文档、历史归档和测试 fixture；
- 不得因为批量替换破坏 `openlifewiki.*` schema 的兼容解析或现有数据读取。

## 7. 分阶段交付边界

### P0：入口统一与兼容基线

1. 新 `cowiki` binary 和完整 help；
2. 统一 global flags、profile、status、doctor、gateway health；
3. 映射当前 ask/graph/register/store/replace/collection/source/local/admin 命令；
4. 旧 binary、旧 flat command 和旧 env alias；
5. README、`.env.example`、安装脚本、Codex skill 和部署文档更新。

### P1：补齐管理闭环

1. identity 读取、delegation/grant/token 查询；
2. task list/show/watch/cancel/retry；
3. audit list/show；
4. location/version/archive；
5. completion 和 Relay CLI；
6. 兼容迁移 doctor 和配置迁移命令。

### 7.1 明确不纳入本次实现

- 独立 Web 管理后台；
- 云端 MCP 服务；
- 新的 Agent runtime 或模型 SDK；
- Redis、独立 Worker、对象存储、向量数据库；
- CLI 直连 PostgreSQL 或 Connector 私有 API；
- 在没有明确数据迁移审批时自动移动或删除旧知识目录；
- 为历史归档文档做无条件的全量改名。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `cowiki` 当前已是知识客户端，切换为统一入口会影响脚本 | 保留原 flat command 解析；将客户端能力纳入同一 handler，不删除行为 |
| 旧 env 和新 env 同时设置造成连接到错误知识中心 | 检测冲突并 fail-closed，错误只显示变量名 |
| schema 改名导致外部 Agent 无法解析 | 读入 alias、canonical 输出；保留 `/v1` 字段语义不变 |
| token 文件迁移时权限或内容泄露 | 只迁移路径引用，token 不复制、不进入日志和 JSON |
| 全局替换破坏历史合同 | 分层迁移；历史、兼容和 wire schema 使用明确 allowlist |
| 命令树过大导致帮助难用 | 顶层只保留稳定领域；每层提供独立 `--help`，默认 human output，机器脚本使用 `--json` |

## 9. 设计结论

统一后的用户心智模型只有一句话：

> `CoWikiHarness` 是项目，`cowiki` 是访问知识中枢的唯一命令。

所有知识查询、存储、登记、整理、图谱读取、身份管理和本地运行时操作都从 `cowiki` 分派；服务内部继续保持 A2A、Graph REST、Connector、PostgreSQL 和本地管理服务的职责边界。改名只改变入口和标识，不改变知识数据、授权模型和唯一入口原则。
