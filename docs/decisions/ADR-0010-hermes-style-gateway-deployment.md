# ADR 0010：采用 Hermes 风格单进程 Gateway 部署边界

- 状态：V2 已接受
- 日期：2026-08-17
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-17-hermes-style-gateway-deployment-design.md`](../superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md)

## 背景

`apps/knowledge-server` 已承载 Agent Card、A2A、权限感知 Graph REST、Knowledge Agent、健康检查和 PostgreSQL 连接。云端试运行还需要清晰的内部监听、公共地址、进程守护、TLS 终止、配置校验与升级恢复边界。

Gateway 会处理 bearer token 与知识数据。公网明文 HTTP 会暴露凭据和业务内容；直接暴露应用端口也会扩大防火墙误配的影响。因此部署必须把内部回环 HTTP 与外部 HTTPS 分开，并在服务发布前完成配置、身份和健康门禁。

## 决策

现有 `apps/knowledge-server` 以 CoWikiHarness Gateway 的部署与生命周期名称运行，代码包与 `@openlifewiki/*` 兼容 namespace 保持不变。

- 单个 Node.js 进程承载 Agent Card、A2A、Graph REST、Knowledge Agent、权限链路、模型调用和数据库连接；
- Gateway 默认监听 `127.0.0.1`，Linux 生产配置固定使用 `127.0.0.1:8080`；
- `OPENLIFEWIKI_BIND_HOST` 与 `OPENLIFEWIKI_PUBLIC_URL` 独立：前者决定内部监听，后者决定 Agent Card 和客户端看到的规范公共地址；
- `OPENLIFEWIKI_PUBLIC_URL` 必须是无路径、查询参数、片段或 userinfo 的远程 HTTPS Origin；`OPENAI_BASE_URL` 必须使用远程 HTTPS 且拒绝 username/password userinfo；客户端在读取 token 文件或发出 bearer 请求前拒绝远程 HTTP；
- Linux 使用无登录权限的专用 `cowikiharness` 身份和 systemd 常驻服务；
- 非 root SSH 部署用户拥有 `/opt/cowikiharness` 并执行 Git；installer 构建 Gateway、管理 CLI 及其依赖后，部署用户通过 installer 记录的绝对 Node.js 路径运行 `apps/cli/dist/main.js` 管理命令，服务器管理流程不执行 pnpm 源码重建；sudo 负责主机目录、配置、systemd、数据库管理和 installer；
- Linux installer 不安装 `cowiki` 客户端；`cowiki ask` 与 `cowiki graph` 从已完成 README 本地安装的外部管理工作站通过公网 HTTPS 执行；
- 公网 TLS 由 Caddy、云负载均衡器或 Tailscale Serve 终止，公网不开放 Gateway 的 `8080`；
- 容器只有位于受控网络、应用端口不向公网发布且前方已有 HTTPS 边缘时，才允许显式绑定 `0.0.0.0`；
- 安装器在写入 systemd 配置前完成运行环境与 Gateway 配置校验，复核专用服务身份，并以真实 systemd 服务的回环健康检查作为成功门禁；
- 安装和升级前服务必须停止。升级固定到已批准 commit，采用停机升级，不持续跟随 `dev` HEAD。

## 影响

- A2A 和 Graph REST 共享同一认证、权限策略、PostgreSQL 事实源与进程故障域；
- 内部监听地址不会进入 Agent Card，公共地址也不会改变 Gateway 的 bind 行为；
- systemd 提供启动、停止、异常重启、状态和 journald 日志入口；
- Gateway 主机保留服务与源码内管理 CLI，交互式 `cowiki` 客户端留在外部管理工作站；
- HTTPS 边缘可以按部署环境替换，应用层无需管理证书申请、续期与热加载；
- 单机升级存在明确停机窗口，升级前需要 PostgreSQL 备份和批准 commit；
- 启动或健康检查失败时安装器停止 Gateway，旧代码需要运维人员显式 checkout 后重新安装；
- 生产部署仍需目标环境完成 DNS、证书、防火墙、secret、备份恢复和外部连通性验收；
- 当前部署切片没有新增数据库 migration，应用回滚无需修改数据库。

## 未采用方案

### 独立 Node.js Gateway

该方案会增加第二套路由、认证、流式传输、健康检查和故障恢复。当前没有独立扩缩容或隔离故障域的量化需求，新增进程会提高部署与运维成本。

### 公网直接开放 `0.0.0.0:8080` HTTP

该方案让 bearer token 与知识内容以明文跨公网传输，并把应用端口暴露给扫描与误配风险，违反 V2 的远程 HTTPS 合同。

### Node.js 进程直接管理 TLS 证书

该方案会让 Gateway 承担证书申请、续期、热加载和 TLS 策略。Caddy、云负载均衡器与 Tailscale Serve 已提供成熟能力，应用内重复实现缺少收益。

### 以容器作为单机部署前提

当前 systemd 方案已经满足单机试运行的身份隔离、常驻、日志和回滚需求。容器仍可用于受控网络部署，但不构成该切片的强制运行层。

## 回滚

停止 Gateway，checkout 上一批准 commit，重新运行 Linux 安装器并通过回环与公共健康验收。安装器发生启动或健康失败时会保持 Gateway 停止，不会自动恢复旧代码。

本切片没有新增 migration，禁止执行破坏性数据库回滚。保留当前 PostgreSQL、`/etc/cowikiharness/gateway.env` 和 HMAC secret；若配置问题触发回滚，生产监听仍固定为 `127.0.0.1:8080`。边缘故障可以独立回滚 Caddy、云负载均衡器或 Tailscale Serve 配置，不改变数据库状态。
