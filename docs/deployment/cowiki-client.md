# CoWikiHarness 客户端与 Gateway 部署路径

## 先看边界

当前系统由两个交付面组成：

| 交付面 | 作用 | 部署方式 |
| --- | --- | --- |
| Knowledge Gateway | 持有 PostgreSQL、A2A、权限和模型调用 | Linux 云服务器 + systemd，见 [Linux Gateway 手册](linux-gateway.md) |
| `cowiki` 客户端 | 从工作站查询、登记、存储和整理知识 | npm 公共包，使用 `npx` 启动 |

`npx` 只安装和运行客户端，不部署 Gateway、不创建 PostgreSQL，也不接触服务器端 secret。服务器和客户端可以在两台不同机器上运行。

## 客户端安装

当前包名为 `cowiki`。发布工作流需要显式手动触发，发布前先完成 CI 和 Gateway 验收：

当前仓库已经具备发布产物和 workflow；npm registry 是否可直接安装取决于首次发布是否完成。首次稳定发布在 GitHub Actions 手动运行 `publish-cowiki`，输入版本 `0.1.0`、tag `latest`，并使用仓库 Secret `NPM_TOKEN`。

```bash
npx --yes cowiki@latest --help
```

稳定使用时固定版本，避免客户端合同随 npm `latest` 自动变化：

```bash
npx --yes cowiki@0.1.0 ask "知识中心里有哪些交付规范？" \
  --token-file "$HOME/.config/cowikiharness/credentials/agent.token"
```

## 连接已部署 Gateway

```bash
export COWIKIHARNESS_URL="https://knowledge.example.com"

npx --yes cowiki@0.1.0 ask "知识中心里有哪些交付规范？" \
  --token-file "$HOME/.config/cowikiharness/credentials/agent.token"

npx --yes cowiki@0.1.0 graph \
  --depth 2 \
  --include tags,locations,versions \
  --token-file "$HOME/.config/cowikiharness/credentials/owner.token"
```

远程地址必须使用 HTTPS；回环 HTTP 只适合本机 Gateway。token 只从权限为 `0600` 的文件读取，不得写入命令参数、仓库、日志或 npm 配置。

## 本地开发与 macOS

本地开发仍使用仓库源码和 pnpm：

```bash
./scripts/bootstrap_dev_env.sh
pnpm build
./scripts/install_local_macos.sh
```

安装脚本负责本机 Knowledge Server 和 LaunchAgent；`npx cowiki` 适合连接已运行的 Gateway，不替代本地服务安装。

## Linux Gateway

服务器部署仍按 [Linux Gateway 部署手册](linux-gateway.md) 执行：固定 Git commit、配置 PostgreSQL 和仓库外 secret、运行 `scripts/install_server_linux.sh`、配置 HTTPS 边缘并完成 `/healthz` 和 A2A/Graph 验收。不要在服务器上用 `npx` 代替 systemd 安装器。
