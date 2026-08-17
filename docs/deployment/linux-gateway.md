# CoWikiHarness Linux Gateway 部署手册

## 适用范围

本手册用于单台 Linux 云服务器的试运行部署：一个 CoWikiHarness Gateway、一个 PostgreSQL 17 数据库和一个现有 HTTPS 边缘。`apps/knowledge-server` 作为 Gateway 常驻运行，内部固定监听 `127.0.0.1:8080`，公网只通过远程 HTTPS 地址访问。

本手册采用停机安装与停机升级。安装器会构建当前检出的 commit、校验配置与服务身份、安装 systemd 单元、启动 Gateway，并检查真实服务的回环健康状态。只有安装器返回成功且 `/healthz` 响应为 `{"status":"ready"}`，本次安装才完成。

角色边界固定如下：非 root SSH 部署用户拥有 `/opt/cowikiharness`，负责 Git、按需执行已编译管理 CLI 和维护仓库外 token 文件；root 权限只用于主机目录、`/etc` 配置、systemd、数据库管理和 Linux installer。installer 以 root 构建 Gateway、管理 CLI 及其传递依赖，systemd 只常驻 Gateway，管理 CLI 不注册常驻服务。Linux installer 不安装 `cowiki` 客户端。`cowiki ask` 与 `cowiki graph` 由已完成 README 本地安装的外部管理工作站通过公网 HTTPS 执行。根命令 `pnpm openlifewiki` 保留给本地开发和 fresh source，服务器管理流程不调用它。

## 部署前准备

- 64 位 Linux 云服务器使用 systemd；
- 一个可使用 sudo 的非 root SSH 部署用户；
- Node.js `>=24.16.0 <25`、pnpm `10.33.2` 和 OpenSSL 命令行；
- PostgreSQL 17 已创建独立数据库和最小权限登录用户；
- 生产域名的 A/AAAA 记录已指向 HTTPS 边缘；
- 防火墙入站只开放运维所需的 SSH 端口和 TCP `443`，PostgreSQL 与 TCP `8080` 均不对公网开放；
- 已准备模型 API key、远程 HTTPS 模型地址和模型名称；
- 已选定并批准一个 40 位 Git commit SHA，部署过程不持续跟随 `dev`。

### PostgreSQL 17 最小权限库

自管 PostgreSQL 可以由集群管理员执行以下一次性命令。`cowikiharness` 只拥有自己的数据库，无集群超级用户、建库或创建角色权限。命令会交互式读取数据库密码，密码不会进入命令参数。

```bash
sudo -u postgres createuser --pwprompt --no-superuser --no-createdb --no-createrole cowikiharness
sudo -u postgres createdb --owner=cowikiharness cowikiharness
```

Gateway 启动时会运行有序 migration，并在该数据库中启用 `pg_trgm`。托管 PostgreSQL 需要提前确认应用用户可以在自己的数据库内创建受信任扩展；无需授予集群管理员权限。

## 1. 放置固定版本源码

首先确认当前 SSH 会话使用非 root 部署用户。由 sudo 创建目标目录并把 owner 设置为 `$USER`、group 设置为 `id -gn` 的结果、mode 设置为 `0755`；随后所有 Git 命令都由部署用户直接执行：

```bash
test "$(id -u)" -ne 0
sudo install -d -o "$USER" -g "$(id -gn)" -m 0755 /opt/cowikiharness
git clone --branch dev https://github.com/MetaInFLow/CoWikiHarness.git /opt/cowikiharness
cd /opt/cowikiharness
test -O /opt/cowikiharness
git fetch origin dev
export COWIKIHARNESS_RELEASE_COMMIT="$(git rev-parse origin/dev)"
printf 'Candidate commit %s\n' "$COWIKIHARNESS_RELEASE_COMMIT"
```

记录输出的完整 SHA，并在审批通过后继续。后续命令把工作区固定为该 SHA；服务不会随 `dev` 变化。

```bash
git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
test "$(git rev-parse HEAD)" = "$COWIKIHARNESS_RELEASE_COMMIT"
```

若批准的是另一个已获取的 commit，先把 `COWIKIHARNESS_RELEASE_COMMIT` 设为那个完整 SHA，再执行 checkout 与一致性检查。

## 2. 创建 Gateway 配置

```bash
cd /opt/cowikiharness
sudo install -d -m 0750 /etc/cowikiharness
sudo cp deploy/linux/gateway.env.example /etc/cowikiharness/gateway.env
sudo chmod 0600 /etc/cowikiharness/gateway.env
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/cowikiharness/hmac-secret.pending'
sudo editor /etc/cowikiharness/gateway.env /etc/cowikiharness/hmac-secret.pending
sudo rm /etc/cowikiharness/hmac-secret.pending
```

`openssl rand -hex 32` 生成 32 个随机字节，输出恰好 64 个十六进制字符。把该值写入 `OPENLIFEWIKI_TOKEN_HMAC_SECRET`，并把同一值单独保存到受控 secret 管理系统。禁止直接使用模板启动服务；必须替换数据库密码、HMAC secret、模型 key、模型地址、模型名称和公共域名。

部署环境文件采用严格的单行 `KEY=value` 格式：

- 支持空行和以 `#` 开头的整行注释；
- 每个 key 只能出现一次，value 前后不能有空白；
- 不支持引号、反斜杠转义、跨行续写或行内注释；
- 不支持变量或命令插值；`$VAR`、`${VAR}` 等内容会保留为字面值并可能导致配置或调用失败；
- 远程 `OPENLIFEWIKI_PUBLIC_URL` 与 `OPENAI_BASE_URL` 使用 HTTPS，两个 URL 均不得包含 username/password userinfo；
- `OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS` 留空会关闭跨域许可，启用时只填写逗号分隔的精确 HTTPS Origin。

生产配置固定保留以下边界，并把示例域名替换为真实域名：

```dotenv
OPENLIFEWIKI_BIND_HOST=127.0.0.1
PORT=8080
OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com
```

安装器最终会把 `/etc/cowikiharness/gateway.env` 设置为 `root:cowikiharness`、权限 `0640`。

## 3. 安装并启动

安装或升级前，现有 Gateway 必须已经停止。首次安装没有已有 unit 时可以直接继续；已有安装先执行：

```bash
sudo systemctl stop cowikiharness-gateway.service
```

然后由部署用户解析 Node.js 与 pnpm 的绝对路径，再用 sudo 运行无参数安装器。安装器通过一个依赖感知命令构建 Gateway、管理 CLI 及共享依赖，安装 systemd unit 并启动 Gateway；管理 CLI 只按需运行，Linux 主机不安装 `cowiki` 客户端：

```bash
cd /opt/cowikiharness
test -O /opt/cowikiharness
NODE_BIN="$(readlink -f "$(command -v node)")"
PNPM_BIN="$(readlink -f "$(command -v pnpm)")"
sudo COWIKIHARNESS_NODE="$NODE_BIN" COWIKIHARNESS_PNPM="$PNPM_BIN" \
  ./scripts/install_server_linux.sh
sudo systemctl status cowikiharness-gateway.service
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

安装器检测到活动中、正在启动或状态不明确的服务时会停止执行。启动失败或健康检查失败时，安装器会停止 Gateway 并返回失败；它不会把失败状态标记为成功。

## 4. 配置 HTTPS 边缘

仓库中的 `deploy/caddy/Caddyfile.example` 把公共域名反向代理到 `127.0.0.1:8080`。把 `knowledge.example.com` 替换为真实域名，合并到已有 Caddy 配置，完成配置校验后再 reload。

已有云负载均衡器时，让公网流量在 `443` 进入受控 HTTPS 边缘，再由同机反向代理连接回环 Gateway。使用 Tailscale Serve 时同样把上游指向 `127.0.0.1:8080`。三种方案均保持 Gateway 配置不变，并满足以下边界：

- 公网只开放 SSH 和 `443`；
- `8080` 不绑定服务器公网地址，安全组和主机防火墙也不放行该端口；
- PostgreSQL 只接受受控本机或私网连接；
- Agent Card 对外发布 `OPENLIFEWIKI_PUBLIC_URL` 中的远程 HTTPS 地址。

## 5. 一次性初始化知识中心

只对全新空数据库执行一次 bootstrap。该命令在 Linux Gateway 主机的服务器仓库中由非 root 部署用户运行已编译管理 CLI。执行前由 secret manager 安全注入与 `gateway.env` 相同的 `DATABASE_URL` 和 `OPENLIFEWIKI_TOKEN_HMAC_SECRET`；禁止 source `gateway.env`，也不得把 secret 写入命令参数。代码块从 installer 写入的 systemd unit 读取同一个绝对 `NODE_BIN`，不会触发 pnpm 或修改 root 所有的 `dist`。

先确认部署用户、仓库 ownership 和 secret 基本格式。以下流程只允许一个部署用户在权限 `0700` 的凭据目录中串行执行；签发前会检查原始 JSON、全部 final 和 `.pending` 目标：

```bash
set -euo pipefail
test "$(id -u)" -ne 0
cd /opt/cowikiharness
test -O /opt/cowikiharness
NODE_BIN="$(sed -n 's|^ExecStart=\([^[:space:]]*\)[[:space:]].*|\1|p' \
  /etc/systemd/system/cowikiharness-gateway.service)"
case "$NODE_BIN" in /*) ;; *) exit 1;; esac
test -x "$NODE_BIN"
test -n "${DATABASE_URL:-}"
test "${#OPENLIFEWIKI_TOKEN_HMAC_SECRET}" -eq 64
case "$OPENLIFEWIKI_TOKEN_HMAC_SECRET" in *[!0-9A-Fa-f]*) exit 1;; esac
COWIKI_CREDENTIALS_DIR="$HOME/.config/cowikiharness/credentials"
BOOTSTRAP_JSON="$COWIKI_CREDENTIALS_DIR/bootstrap.json"
BOOTSTRAP_IDS="$COWIKI_CREDENTIALS_DIR/bootstrap-ids.json"
OWNER_TOKEN="$COWIKI_CREDENTIALS_DIR/owner.token"
AGENT_TOKEN="$COWIKI_CREDENTIALS_DIR/agent.token"
install -d -m 0700 "$COWIKI_CREDENTIALS_DIR"
umask 077
for target in \
  "$BOOTSTRAP_JSON" \
  "$OWNER_TOKEN" "$AGENT_TOKEN" "$BOOTSTRAP_IDS" \
  "$OWNER_TOKEN.pending" "$AGENT_TOKEN.pending" "$BOOTSTRAP_IDS.pending"; do
  test ! -e "$target"
done
set -o noclobber
"$NODE_BIN" apps/cli/dist/main.js cloud bootstrap \
  --organization openLifeWiki \
  --owner Owner \
  --agent codex \
  --json > "$BOOTSTRAP_JSON"
chmod 0600 "$BOOTSTRAP_JSON"

COWIKI_CREDENTIALS_DIR="$COWIKI_CREDENTIALS_DIR" \
BOOTSTRAP_JSON="$BOOTSTRAP_JSON" \
"$NODE_BIN" --input-type=module <<'NODE'
import { access, chmod, link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const credentialsDir = process.env.COWIKI_CREDENTIALS_DIR;
const inputPath = process.env.BOOTSTRAP_JSON;
if (!credentialsDir || !inputPath) throw new Error("Bootstrap paths are required");
const finalPaths = ["owner.token", "agent.token", "bootstrap-ids.json"].map((name) => join(credentialsDir, name));
const pendingPaths = finalPaths.map((path) => `${path}.pending`);

for (const path of [...finalPaths, ...pendingPaths]) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Credential target already exists: ${path}`);
}

try {
  const result = JSON.parse(await readFile(inputPath, "utf8"));
  const ids = {
    orgId: result.orgId,
    ownerPrincipalId: result.ownerPrincipalId,
    agentPrincipalId: result.agentPrincipalId,
    delegationId: result.delegationId,
  };
  if ([result.ownerToken, result.agentToken].some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Bootstrap token is missing");
  }
  if (Object.values(ids).some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Bootstrap identifiers are missing");
  }

  const files = [
    { final: finalPaths[0], pending: pendingPaths[0], content: result.ownerToken + "\n" },
    { final: finalPaths[1], pending: pendingPaths[1], content: result.agentToken + "\n" },
    { final: finalPaths[2], pending: pendingPaths[2], content: JSON.stringify(ids) + "\n" },
  ];
  for (const file of files) {
    await writeFile(file.pending, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(file.pending, 0o600);
  }
  for (const file of files) await link(file.pending, file.final);
  for (const file of files) await unlink(file.pending);
  process.stdout.write(JSON.stringify(ids) + "\n");
} catch (error) {
  await Promise.all(pendingPaths.map(async (path) => {
    try {
      await unlink(path);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
  }));
  throw error;
}
NODE
for target in "$OWNER_TOKEN" "$AGENT_TOKEN" "$BOOTSTRAP_IDS"; do
  test -s "$target"
  test "$(stat -c '%a' "$target")" = 600
done
rm -- "$BOOTSTRAP_JSON"
```

raw token 只存在于受控中间 JSON、权限 `0600` 的 token 文件和目标 secret manager。它不得进入命令参数、Git、终端输出、日志、终端历史采集或前端。Node.js 会先校验全部字段，再写入同目录 `.pending` 文件，通过硬链接无覆盖提交为 final；所有 final 均非空且权限为 `0600` 后才删除中间 JSON。

任一步失败都会立即停止，含 raw token 的 `bootstrap.json` 会保留，grant 等后续操作不得继续。脚本会清理可安全清理的 `.pending` 文件；若存储故障留下部分 final 文件，先依据原始 JSON 核对并完成恢复，处理完成前禁止再次运行 bootstrap。

重复 bootstrap 会返回配置冲突。安装脚本不会自动创建组织、成员、授权或 token。

## 6. 部署验收

### 6.1 服务器回环与 member 授权

先在 Linux Gateway 主机执行回环检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

预期响应为 `{"status":"ready"}`。随后在 `/opt/cowikiharness` 中由非 root 部署用户按需运行 installer 已构建的管理 CLI。执行前再次由 secret manager 注入 `DATABASE_URL` 与 `OPENLIFEWIKI_TOKEN_HMAC_SECRET`，禁止 source `gateway.env`。

创建验收 member 时，只允许同一部署用户在权限 `0700` 的凭据目录中串行执行以下流程。cloud 命令签发前会检查原始 JSON、全部 final 和 `.pending` 目标，raw token JSON 重定向到仓库外权限 `0600` 的文件：

```bash
set -euo pipefail
test "$(id -u)" -ne 0
cd /opt/cowikiharness
test -O /opt/cowikiharness
NODE_BIN="$(sed -n 's|^ExecStart=\([^[:space:]]*\)[[:space:]].*|\1|p' \
  /etc/systemd/system/cowikiharness-gateway.service)"
case "$NODE_BIN" in /*) ;; *) exit 1;; esac
test -x "$NODE_BIN"
test -n "${DATABASE_URL:-}"
test "${#OPENLIFEWIKI_TOKEN_HMAC_SECRET}" -eq 64
case "$OPENLIFEWIKI_TOKEN_HMAC_SECRET" in *[!0-9A-Fa-f]*) exit 1;; esac
COWIKI_CREDENTIALS_DIR="$HOME/.config/cowikiharness/credentials"
MEMBER_CREATE_JSON="$COWIKI_CREDENTIALS_DIR/member-create.json"
MEMBER_TOKEN="$COWIKI_CREDENTIALS_DIR/member.token"
MEMBER_IDS="$COWIKI_CREDENTIALS_DIR/member-ids.json"
install -d -m 0700 "$COWIKI_CREDENTIALS_DIR"
umask 077
for target in \
  "$MEMBER_CREATE_JSON" \
  "$MEMBER_TOKEN" "$MEMBER_IDS" \
  "$MEMBER_TOKEN.pending" "$MEMBER_IDS.pending"; do
  test ! -e "$target"
done
set -o noclobber
"$NODE_BIN" apps/cli/dist/main.js cloud member create \
  --name deployment-acceptance \
  --owner-token-file "$COWIKI_CREDENTIALS_DIR/owner.token" \
  --json > "$MEMBER_CREATE_JSON"
chmod 0600 "$MEMBER_CREATE_JSON"

COWIKI_CREDENTIALS_DIR="$COWIKI_CREDENTIALS_DIR" \
MEMBER_CREATE_JSON="$MEMBER_CREATE_JSON" \
"$NODE_BIN" --input-type=module <<'NODE'
import { access, chmod, link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const credentialsDir = process.env.COWIKI_CREDENTIALS_DIR;
const inputPath = process.env.MEMBER_CREATE_JSON;
if (!credentialsDir || !inputPath) throw new Error("Member paths are required");
const finalPaths = ["member.token", "member-ids.json"].map((name) => join(credentialsDir, name));
const pendingPaths = finalPaths.map((path) => `${path}.pending`);

for (const path of [...finalPaths, ...pendingPaths]) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Credential target already exists: ${path}`);
}

try {
  const result = JSON.parse(await readFile(inputPath, "utf8"));
  const ids = {
    orgId: result.principal?.orgId,
    principalId: result.principal?.principalId,
    tokenId: result.tokenId,
  };
  if (typeof result.token !== "string" || result.token.length === 0) {
    throw new Error("Member token is missing");
  }
  if (Object.values(ids).some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Member identifiers are missing");
  }

  const files = [
    { final: finalPaths[0], pending: pendingPaths[0], content: result.token + "\n" },
    { final: finalPaths[1], pending: pendingPaths[1], content: JSON.stringify(ids) + "\n" },
  ];
  for (const file of files) {
    await writeFile(file.pending, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(file.pending, 0o600);
  }
  for (const file of files) await link(file.pending, file.final);
  for (const file of files) await unlink(file.pending);
  process.stdout.write(JSON.stringify(ids) + "\n");
} catch (error) {
  await Promise.all(pendingPaths.map(async (path) => {
    try {
      await unlink(path);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
  }));
  throw error;
}
NODE
for target in "$MEMBER_TOKEN" "$MEMBER_IDS"; do
  test -s "$target"
  test "$(stat -c '%a' "$target")" = 600
done
rm -- "$MEMBER_CREATE_JSON"
```

Node.js 会先校验 token 与全部 ID，再写同目录 `.pending` 文件，通过硬链接无覆盖提交为 final。任一步失败都会立即停止，`member-create.json` 会保留，grant 与 token 交付不得继续。脚本会清理可安全清理的 `.pending` 文件；若存储故障留下部分 final 文件，先依据原始 JSON 核对并完成恢复，处理完成前禁止再次运行 `member create`。member token 不输出到终端。

默认验收范围为当前 organization 的 `knowledge.query` capability。ID 从仓库外 JSON 读取，命令参数中没有 raw token，grant 输出也写入仓库外文件：

```bash
set -euo pipefail
cd /opt/cowikiharness
NODE_BIN="$(sed -n 's|^ExecStart=\([^[:space:]]*\)[[:space:]].*|\1|p' \
  /etc/systemd/system/cowikiharness-gateway.service)"
case "$NODE_BIN" in /*) ;; *) exit 1;; esac
test -x "$NODE_BIN"
COWIKI_CREDENTIALS_DIR="$HOME/.config/cowikiharness/credentials"
ORG_ID="$("$NODE_BIN" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).orgId)' "$COWIKI_CREDENTIALS_DIR/bootstrap-ids.json")"
MEMBER_PRINCIPAL_ID="$("$NODE_BIN" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).principalId)' "$COWIKI_CREDENTIALS_DIR/member-ids.json")"
"$NODE_BIN" apps/cli/dist/main.js cloud grant \
  --principal "$MEMBER_PRINCIPAL_ID" \
  --scope "organization:$ORG_ID" \
  --capability knowledge.query \
  --owner-token-file "$COWIKI_CREDENTIALS_DIR/owner.token" \
  --json > "$COWIKI_CREDENTIALS_DIR/member-grant.json"
chmod 0600 "$COWIKI_CREDENTIALS_DIR/member-grant.json"
```

只需验证单条知识时，可以跳过 organization scope，把 `--scope` 改为 `item:<itemId>`。resource grant 采用追加授权，两个范围不能同时用于最小权限验收。

### 6.2 外部管理工作站验收

Linux Gateway 主机不执行 `cowiki`。外部管理工作站必须先完成 README 的本地安装，确认 `cowiki` 可用，再通过批准的 secret manager 接收 Agent token 与 member token；Owner token 保留在服务器管理边界内。工作站将两个 token 保存到仓库外权限 `0600` 的文件。

从外部管理工作站执行公共入口、端口边界、查询和授权图谱验收：

```bash
set -euo pipefail
export COWIKIHARNESS_URL=https://knowledge.example.com
chmod 0600 "$HOME/.config/cowikiharness/credentials/agent.token"
chmod 0600 "$HOME/.config/cowikiharness/credentials/member.token"

curl --fail --silent --show-error https://knowledge.example.com/healthz
curl --fail --silent --show-error https://knowledge.example.com/.well-known/agent-card.json
curl --connect-timeout 5 http://server-public-ip:8080/healthz

export COWIKIHARNESS_TOKEN_FILE="$HOME/.config/cowikiharness/credentials/agent.token"
cowiki ask "CoWikiHarness Gateway 是否可用？"

cowiki graph \
  --depth 2 \
  --include tags,locations \
  --token-file "$HOME/.config/cowikiharness/credentials/member.token"
```

公共 health 与 Agent Card 必须成功，Agent Card 中的远程接口 URL 必须使用 HTTPS；外部 `8080` 连接必须失败；`cowiki ask` 与首次 `cowiki graph` 必须成功，图谱只包含该 member 获准查看的内容。

### 6.3 撤销 token

回到 Linux Gateway 主机，由部署用户从 `member-ids.json` 读取非 secret `tokenId` 并撤销。新 SSH 会话需要由 secret manager 重新注入数据库与 HMAC 环境变量，仍然禁止 source `gateway.env`。revoke 输出重定向到仓库外文件：

```bash
set -euo pipefail
cd /opt/cowikiharness
NODE_BIN="$(sed -n 's|^ExecStart=\([^[:space:]]*\)[[:space:]].*|\1|p' \
  /etc/systemd/system/cowikiharness-gateway.service)"
case "$NODE_BIN" in /*) ;; *) exit 1;; esac
test -x "$NODE_BIN"
COWIKI_CREDENTIALS_DIR="$HOME/.config/cowikiharness/credentials"
MEMBER_TOKEN_ID="$("$NODE_BIN" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).tokenId)' "$COWIKI_CREDENTIALS_DIR/member-ids.json")"
"$NODE_BIN" apps/cli/dist/main.js cloud token revoke \
  --token-id "$MEMBER_TOKEN_ID" \
  --owner-token-file "$COWIKI_CREDENTIALS_DIR/owner.token" \
  --json > "$COWIKI_CREDENTIALS_DIR/member-revoke.json"
chmod 0600 "$COWIKI_CREDENTIALS_DIR/member-revoke.json"
```

最后在外部管理工作站重复同一条 `cowiki graph` 命令，必须返回稳定拒绝。整个 cloud 管理流程中，raw token 不进入终端输出、命令参数、Git、日志或前端。

## 日常运维

```bash
sudo systemctl status cowikiharness-gateway.service
sudo systemctl restart cowikiharness-gateway.service
sudo journalctl -u cowikiharness-gateway.service -n 200 --no-pager
```

状态异常时先保留 journal 与当前 commit SHA，再进行变更。日志、工单和截图中不得包含 token、数据库密码、HMAC secret 或模型 key。

## 升级

升级会产生停机窗口。先完成 PostgreSQL 备份，再取得新的候选 commit 并记录 `origin/dev` SHA：

```bash
test "$(id -u)" -ne 0
cd /opt/cowikiharness
test -O /opt/cowikiharness
git fetch origin dev
export COWIKIHARNESS_RELEASE_COMMIT="$(git rev-parse origin/dev)"
printf 'Candidate commit %s\n' "$COWIKIHARNESS_RELEASE_COMMIT"
```

批准该完整 SHA 后，停止服务、checkout、重跑安装器并完成健康验收：

```bash
sudo systemctl stop cowikiharness-gateway.service
git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
test "$(git rev-parse HEAD)" = "$COWIKIHARNESS_RELEASE_COMMIT"
NODE_BIN="$(readlink -f "$(command -v node)")"
PNPM_BIN="$(readlink -f "$(command -v pnpm)")"
sudo COWIKIHARNESS_NODE="$NODE_BIN" COWIKIHARNESS_PNPM="$PNPM_BIN" \
  ./scripts/install_server_linux.sh
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

每次升级都固定到批准 commit；禁止让生产工作区持续跟随浮动 `dev` HEAD。恢复外部流量前，由外部管理工作站重新完成公共 health、Agent Card、`cowiki ask`、授权图谱和外部 `8080` 不可达检查。

## 回滚

回滚同样是停机操作。把 `COWIKIHARNESS_RELEASE_COMMIT` 设为上一批准 commit，停止服务、checkout 并重新运行安装器：

```bash
test "$(id -u)" -ne 0
cd /opt/cowikiharness
test -O /opt/cowikiharness
export COWIKIHARNESS_RELEASE_COMMIT="<上一批准commit的40位SHA>"
sudo systemctl stop cowikiharness-gateway.service
git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
test "$(git rev-parse HEAD)" = "$COWIKIHARNESS_RELEASE_COMMIT"
NODE_BIN="$(readlink -f "$(command -v node)")"
PNPM_BIN="$(readlink -f "$(command -v pnpm)")"
sudo COWIKIHARNESS_NODE="$NODE_BIN" COWIKIHARNESS_PNPM="$PNPM_BIN" \
  ./scripts/install_server_linux.sh
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

安装器遇到启动或健康失败时会停止 Gateway，不会自动恢复旧代码。此时保留停机状态，查看日志，明确选择上一批准 commit 后再次运行安装器。本部署切片没有新增 migration，禁止执行 destructive database rollback；未来包含 migration 的版本应遵循对应版本的前向恢复方案。

## PostgreSQL 备份与隔离恢复

使用 PostgreSQL custom 格式备份，并把文件保存在只有数据库管理员可读的目录：

```bash
sudo install -d -o postgres -g postgres -m 0700 /var/backups/cowikiharness
export COWIKIHARNESS_BACKUP="/var/backups/cowikiharness/cowikiharness-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo -u postgres pg_dump --format=custom --file="$COWIKIHARNESS_BACKUP" cowikiharness
sudo chmod 0600 "$COWIKIHARNESS_BACKUP"
```

恢复演练只写入隔离数据库，不覆盖生产库：

```bash
sudo -u postgres createdb --owner=cowikiharness cowikiharness_restore_test
sudo -u postgres pg_restore \
  --exit-on-error \
  --no-owner \
  --role=cowikiharness \
  --dbname=cowikiharness_restore_test \
  "$COWIKIHARNESS_BACKUP"
```

用指向隔离数据库的临时 Gateway 完成健康与授权查询，核对 item、location、version ID 和引用关系与备份前一致。数据库 dump 与 `OPENLIFEWIKI_TOKEN_HMAC_SECRET` 必须分别进入安全备份：dump 进入受控备份系统，HMAC 进入 secret 管理系统。恢复时需要原 HMAC 验证现有 token；恢复验收完成后轮换用户和 Agent token，并撤销旧 token。

## 故障排查

按以下顺序确认服务、日志与数据库健康：

```bash
sudo systemctl status cowikiharness-gateway.service
sudo journalctl -u cowikiharness-gateway.service -n 200 --no-pager
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

- 服务未启动：检查 Node.js 与 pnpm 版本、当前 commit、systemd 状态和数据库连通性；
- 回环健康返回 `503`：重点检查 PostgreSQL 17 状态、连接串与数据库权限；
- 回环健康成功、公共健康失败：检查域名、证书、Caddy/云负载均衡/Tailscale Serve 和 `443` 防火墙；
- 公共健康成功、Agent Card 地址错误：核对 `OPENLIFEWIKI_PUBLIC_URL`；
- 外部可以访问 `8080`：立即关闭安全组与主机防火墙规则，并核对 bind host；
- 配置被拒绝：确认模板占位符已经全部替换，环境文件没有重复 key、引号、反斜杠、续行或多余空白。

安装器已经构建 Gateway、管理 CLI 和部署配置校验器。故障排查时不要以普通用户重新构建任何 `dist`；从已安装的 systemd unit 读取安装器写入的绝对 Node.js 路径，再用该路径和已构建 validator 校验配置。成功时只输出配置有效，不回显 secret：

```bash
NODE_BIN="$(sudo sed -n 's|^ExecStart=\([^[:space:]]*\)[[:space:]].*|\1|p' \
  /etc/systemd/system/cowikiharness-gateway.service)"
test -n "$NODE_BIN"
test -x "$NODE_BIN"
sudo "$NODE_BIN" \
  /opt/cowikiharness/apps/knowledge-server/dist/deployment-config.js \
  /etc/cowikiharness/gateway.env
```

本仓库可以自动验证安装器、配置合同与部署资产。真实 Linux systemd、云防火墙、DNS、证书、外部 `8080` 不可达、实际 PostgreSQL 备份恢复和公网调用仍需在目标服务器执行并留存验收结果。
