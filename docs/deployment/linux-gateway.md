# CoWikiHarness Linux Gateway 部署手册

## 适用范围

本手册用于单台 Linux 云服务器的试运行部署：一个 CoWikiHarness Gateway、一个 PostgreSQL 17 数据库和一个现有 HTTPS 边缘。`apps/knowledge-server` 作为 Gateway 常驻运行，内部固定监听 `127.0.0.1:8080`，公网只通过远程 HTTPS 地址访问。

本手册采用停机安装与停机升级。安装器会构建当前检出的 commit、校验配置与服务身份、安装 systemd 单元、启动 Gateway，并检查真实服务的回环健康状态。只有安装器返回成功且 `/healthz` 响应为 `{"status":"ready"}`，本次安装才完成。

## 部署前准备

- 64 位 Linux 云服务器使用 systemd；
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

首次部署把仓库放在固定路径：

```bash
sudo git clone --branch dev https://github.com/MetaInFLow/CoWikiHarness.git /opt/cowikiharness
cd /opt/cowikiharness
sudo git fetch origin dev
export COWIKIHARNESS_RELEASE_COMMIT="$(git rev-parse origin/dev)"
printf 'Candidate commit %s\n' "$COWIKIHARNESS_RELEASE_COMMIT"
```

记录输出的完整 SHA，并在审批通过后继续。后续命令把工作区固定为该 SHA；服务不会随 `dev` 变化。

```bash
sudo git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
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
- `OPENLIFEWIKI_PUBLIC_URL` 不允许包含用户名或密码；
- 远程 `OPENLIFEWIKI_PUBLIC_URL` 与 `OPENAI_BASE_URL` 使用 HTTPS；
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

然后运行无参数安装器：

```bash
cd /opt/cowikiharness
sudo ./scripts/install_server_linux.sh
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

只对全新空数据库执行一次 bootstrap。先在受控管理终端通过 secret 管理方式注入与 `gateway.env` 相同的 `DATABASE_URL` 和 `OPENLIFEWIKI_TOKEN_HMAC_SECRET`，不要把 `gateway.env` 当作 shell 脚本加载。然后把一次性输出写入仓库外的受控文件：

```bash
cd /opt/cowikiharness
install -d -m 0700 "$HOME/.config/cowikiharness/credentials"
umask 077
pnpm openlifewiki cloud bootstrap \
  --organization openLifeWiki \
  --owner Owner \
  --agent codex \
  --json > "$HOME/.config/cowikiharness/credentials/bootstrap.json"
chmod 0600 "$HOME/.config/cowikiharness/credentials/bootstrap.json"
```

bootstrap 输出中的 Owner token 与 Agent token 只显示一次。通过受控编辑器分别保存为权限 `0600` 的 `owner.token` 和 `agent.token`，核对可读性后安全删除中间 `bootstrap.json`。token 只能保存在仓库外或 secret 管理系统中，不得进入命令参数、Git、日志、终端历史采集或前端。

重复 bootstrap 会返回配置冲突。安装脚本不会自动创建组织、成员、授权或 token。

## 6. 部署验收

先在服务器执行回环检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

预期响应为 `{"status":"ready"}`。再从服务器外部执行公共入口检查：

```bash
curl --fail --silent --show-error https://knowledge.example.com/healthz
curl --fail --silent --show-error https://knowledge.example.com/.well-known/agent-card.json
curl --connect-timeout 5 http://server-public-ip:8080/healthz
```

前两条必须成功，Agent Card 中的远程接口 URL 必须使用 HTTPS；第三条必须连接失败。

使用仓库外、权限 `0600` 的 Agent token 验证查询：

```bash
export COWIKIHARNESS_URL=https://knowledge.example.com
export COWIKIHARNESS_TOKEN_FILE="$HOME/.config/cowikiharness/credentials/agent.token"
cowiki ask "CoWikiHarness Gateway 是否可用？"
```

授权图谱与撤销验收按以下顺序执行：

1. 使用 `openlifewiki cloud member create` 创建专用 member，把一次性 token 保存到仓库外、权限 `0600` 的文件，并记录返回的 `principalId` 与 `tokenId`；
2. 使用 `openlifewiki cloud grant` 只授予验收所需的 `knowledge.query` scope；
3. 执行以下图谱读取并确认只返回该 member 有权查看的内容；
4. 使用 Owner token 文件和记录的 `tokenId` 执行 `openlifewiki cloud token revoke`；
5. 重复图谱读取，必须返回拒绝。

```bash
cowiki graph \
  --depth 2 \
  --include tags,locations \
  --token-file "$HOME/.config/cowikiharness/credentials/member.token"

pnpm openlifewiki cloud token revoke \
  --token-id "<验收tokenId>" \
  --owner-token-file "$HOME/.config/cowikiharness/credentials/owner.token" \
  --json
```

`member create`、精确 scope 授权与图谱参数见 [README 的外部图谱快速路径](../../README.md#外部图谱快速路径)。撤销命令需要在安全注入数据库与 HMAC 环境变量的管理终端执行。

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
cd /opt/cowikiharness
sudo git fetch origin dev
export COWIKIHARNESS_RELEASE_COMMIT="$(git rev-parse origin/dev)"
printf 'Candidate commit %s\n' "$COWIKIHARNESS_RELEASE_COMMIT"
```

批准该完整 SHA 后，停止服务、checkout、重跑安装器并完成健康验收：

```bash
sudo systemctl stop cowikiharness-gateway.service
sudo git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
test "$(git rev-parse HEAD)" = "$COWIKIHARNESS_RELEASE_COMMIT"
sudo ./scripts/install_server_linux.sh
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
curl --fail --silent --show-error https://knowledge.example.com/healthz
```

每次升级都固定到批准 commit；禁止让生产工作区持续跟随浮动 `dev` HEAD。恢复外部流量前重新完成 Agent Card、`cowiki ask`、授权图谱和外部 `8080` 不可达检查。

## 回滚

回滚同样是停机操作。把 `COWIKIHARNESS_RELEASE_COMMIT` 设为上一批准 commit，停止服务、checkout 并重新运行安装器：

```bash
cd /opt/cowikiharness
export COWIKIHARNESS_RELEASE_COMMIT="<上一批准commit的40位SHA>"
sudo systemctl stop cowikiharness-gateway.service
sudo git checkout --detach "$COWIKIHARNESS_RELEASE_COMMIT"
sudo ./scripts/install_server_linux.sh
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

在仓库完成构建后，可直接运行与安装器相同的部署配置校验器。成功时只输出配置有效，不回显 secret：

```bash
cd /opt/cowikiharness
pnpm --filter "@openlifewiki/knowledge-server..." build
sudo node apps/knowledge-server/dist/deployment-config.js /etc/cowikiharness/gateway.env
```

本仓库可以自动验证安装器、配置合同与部署资产。真实 Linux systemd、云防火墙、DNS、证书、外部 `8080` 不可达、实际 PostgreSQL 备份恢复和公网调用仍需在目标服务器执行并留存验收结果。
