# CoWikiHarness Hermes 风格 Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Knowledge Server 交付为默认回环监听、可由 systemd 常驻、可通过边缘 HTTPS 暴露的单进程 CoWikiHarness Gateway。

**Architecture:** 继续复用 `apps/knowledge-server` 这一 Node.js 进程承载 Agent Card、A2A、健康检查与 Graph REST，只分离内部 bind host 和外部 public URL。Linux 使用 systemd 管理进程，Caddy/云负载均衡/Tailscale Serve 终止 TLS；远程客户端维持 HTTPS fail-closed。

**Tech Stack:** TypeScript 5.9、Node.js 24、Express 5、Zod 4、Vitest 3、Bash、systemd、Caddy、PostgreSQL 17。

---

## 1. 权威、范围和执行约束

### Source docs

- 需求：[`docs/requirements/requirements-v2.md`](../../requirements/requirements-v2.md)
- 已批准设计：[`docs/superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md`](../specs/2026-08-17-hermes-style-gateway-deployment-design.md)
- V2 架构：[`docs/design/active/2026-08-15-cloud-knowledge-agent-v2-design.md`](../../design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)
- A2A 决策：[`docs/decisions/ADR-0005-a2a-v1-public-agent-protocol.md`](../../decisions/ADR-0005-a2a-v1-public-agent-protocol.md)
- Graph 决策：[`docs/decisions/ADR-0009-authorized-graph-projection-api.md`](../../decisions/ADR-0009-authorized-graph-projection-api.md)
- Hermes 对标：[API Server](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md)、[Programmatic Integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)、[CLI Commands](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)

### Checkout 决策

- 当前分支：`dev`；`main` 保持不动。
- 当前工作树在设计提交 `f0f8c54` 后干净。
- 本切片聚焦同一部署主题，按 `BRANCHING.md` 可在干净的 `dev` checkout 直接实施。
- 发现相关未知改动时立即停止；禁止 stash、reset 或覆盖用户内容。

### Scope

- 默认监听 `127.0.0.1`；
- 独立校验 `OPENLIFEWIKI_BIND_HOST` 与 `OPENLIFEWIKI_PUBLIC_URL`；
- 现有进程使用配置的 host 监听；
- 启动日志区分内部地址和公共地址；
- 增加 Linux systemd 单元、环境模板、安装脚本和 Caddy 示例；
- 增加中文服务器部署、升级、备份、恢复和验收说明；
- 保留 macOS LaunchAgent、本地 HTTP、远程 HTTPS、A2A 和 Graph 合同。

### Non-goals

- 不增加第二个 Gateway 进程；
- 不增加 npm 运行时依赖；
- 不改 PostgreSQL schema；
- 不自动 bootstrap 组织、成员、授权或 token；
- 不开放远程明文 HTTP；
- 不要求 Docker；
- 不实现 Web 管理后台；
- 不修改 `main`。

## 2. File Map

| 文件 | 责任 |
| --- | --- |
| `apps/knowledge-server/src/config.ts` | 解析和校验 bind host、public URL 与既有服务配置 |
| `apps/knowledge-server/src/http-listener.ts` | 只负责把 Express app 绑定到给定 host/port，并返回真实监听地址 |
| `apps/knowledge-server/src/a2a-server.ts` | 装配 Gateway，使用 HTTP listener，维持公共 URL 兼容字段 |
| `apps/knowledge-server/src/main.ts` | 启动 Gateway、输出脱敏地址、处理退出信号 |
| `apps/knowledge-server/test/gateway-config.test.ts` | 无数据库的 Gateway 配置合同 |
| `apps/knowledge-server/test/http-listener.test.ts` | 真实回环 socket 监听合同 |
| `apps/knowledge-server/test/main.test.ts` | 启动信息不泄密且区分内部/公共地址 |
| `apps/knowledge-server/test/deployment-assets.test.ts` | systemd、installer、env、Caddy 静态安全合同和 Bash 语法 |
| `deploy/linux/cowikiharness-gateway.service.template` | Linux systemd 常驻服务模板 |
| `deploy/linux/gateway.env.example` | 仓库内无真实 secret 的生产环境模板 |
| `deploy/caddy/Caddyfile.example` | 同机 HTTPS 终止示例 |
| `scripts/install_server_linux.sh` | 校验、构建、安装 systemd 单元并启动 Gateway |
| `.env.example` | 统一说明 bind host、port 和 public URL |
| `docs/deployment/linux-gateway.md` | 中文服务器部署、升级、备份、恢复、回滚和验收手册 |
| `docs/decisions/ADR-0010-hermes-style-gateway-deployment.md` | 固化单进程 Gateway、默认回环和边缘 TLS 决策 |
| `README.md` | 增加最短服务器部署入口 |
| `ARCHITECTURE.md` | 增加 Gateway 运行与网络边界 |
| `docs/memory-bank/active-context.md` | 记录实际实施和验证证据 |
| `docs/superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md` | 验收后更新状态与实际证据 |

## 3. Validation Gates

所有 Node/pnpm 命令使用：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

最小测试：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run \
  test/gateway-config.test.ts \
  test/http-listener.test.ts \
  test/main.test.ts \
  test/deployment-assets.test.ts
```

完整静态回归：

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm verify
```

PostgreSQL/A2A 回归：

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm verify:cloud
```

真实 Linux systemd 验收需要目标服务器。当前 macOS 开发机完成静态 unit/installer 合同、Bash 语法、本机 LaunchAgent 回归与真实 HTTP/A2A smoke；服务器可用后再执行文档中的 Linux 验收清单。

---

### Task 1: Gateway 配置默认回环并约束公共 URL

**Files:**
- Create: `apps/knowledge-server/test/gateway-config.test.ts`
- Modify: `apps/knowledge-server/src/config.ts:1-111`
- Modify: `apps/knowledge-server/test/a2a-query.integration.test.ts:60-92`

- [ ] **Step 1: 写默认值和合法地址的失败测试**

创建 `apps/knowledge-server/test/gateway-config.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { readServerConfig } from "../src/config.js";

describe("CoWikiHarness Gateway configuration", () => {
  it("defaults the listener to IPv4 loopback and keeps the public URL separate", () => {
    const config = readServerConfig(testEnvironment());

    expect(config).toMatchObject({
      bindHost: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
    });
  });

  it.each(["127.0.0.1", "::1", "0.0.0.0", "::", "10.20.30.40", "localhost"])(
    "accepts an explicit IP or localhost bind host: %s",
    (bindHost) => {
      expect(readServerConfig({
        ...testEnvironment(),
        OPENLIFEWIKI_BIND_HOST: bindHost,
      }).bindHost).toBe(bindHost);
    },
  );
});

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://test.invalid/openlifewiki_test",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET: "unit-test-token-secret-with-at-least-32-bytes",
    OPENLIFEWIKI_MODEL: "gpt-5.5",
    OPENLIFEWIKI_PUBLIC_URL: "http://127.0.0.1:0",
    OPENAI_API_KEY: "unit-test-api-key",
    OPENAI_BASE_URL: "https://agent108.work/",
    OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE: "true",
    PORT: "0",
  };
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/gateway-config.test.ts
```

Expected: FAIL，`ServerConfig` 没有 `bindHost`，默认配置断言不成立。

- [ ] **Step 3: 增加 bind host 最小实现**

在 `apps/knowledge-server/src/config.ts` 顶部增加：

```ts
import { isIP } from "node:net";
```

增加 schema：

```ts
const bindHostSchema = z.string().trim().min(1).refine(
  (value) => value === "localhost" || isIP(value) !== 0,
  "OPENLIFEWIKI_BIND_HOST must be localhost or an IP address without a scheme or port",
);
```

在 `parsedConfigSchema` 增加：

```ts
bindHost: bindHostSchema,
```

在 `ServerConfig` 增加字段和构造赋值：

```ts
readonly bindHost: string;

this.bindHost = value.bindHost;
```

在 `readServerConfig` 传入：

```ts
bindHost: env.OPENLIFEWIKI_BIND_HOST ?? "127.0.0.1",
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run 同 Step 2。

Expected: 7 tests PASS。

- [ ] **Step 5: 写非法 bind host 和远程 HTTP public URL 的失败测试**

追加到 `gateway-config.test.ts`：

```ts
it.each([
  "",
  "https://127.0.0.1",
  "127.0.0.1:8080",
  "knowledge.example",
  "[::1]",
])("rejects an invalid bind host: %s", (bindHost) => {
  expect(() => readServerConfig({
    ...testEnvironment(),
    OPENLIFEWIKI_BIND_HOST: bindHost,
  })).toThrow(/OPENLIFEWIKI_BIND_HOST/u);
});

it("allows loopback HTTP or remote HTTPS and rejects remote HTTP public URLs", () => {
  for (const publicUrl of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://knowledge.example.com",
  ]) {
    expect(readServerConfig({
      ...testEnvironment(),
      OPENLIFEWIKI_PUBLIC_URL: publicUrl,
    }).publicUrl).toBe(publicUrl);
  }

  expect(() => readServerConfig({
    ...testEnvironment(),
    OPENLIFEWIKI_PUBLIC_URL: "http://knowledge.example.com",
  })).toThrow(/OPENLIFEWIKI_PUBLIC_URL/u);
});
```

- [ ] **Step 6: 运行测试并确认 RED**

Run 同 Step 2。

Expected: bind host tests 已由 Step 3 通过；remote HTTP public URL case FAIL，因为当前 `publicUrl` 只校验 URL 语法。

- [ ] **Step 7: 增加 public URL 安全 schema**

在 `config.ts` 增加：

```ts
const publicUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}, "OPENLIFEWIKI_PUBLIC_URL must use https unless it targets a loopback host");
```

将：

```ts
publicUrl: z.string().url(),
```

替换为：

```ts
publicUrl: publicUrlSchema,
```

- [ ] **Step 8: 更新既有配置合同并运行回归**

在 `a2a-query.integration.test.ts` 首个配置测试的 `toMatchObject` 增加：

```ts
bindHost: "127.0.0.1",
```

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run \
  test/gateway-config.test.ts test/a2a-query.integration.test.ts
```

Expected: Gateway config tests PASS；未启用 PostgreSQL 的 A2A 合同测试 PASS，PostgreSQL journeys SKIP。

- [ ] **Step 9: 提交配置切片**

```bash
git add apps/knowledge-server/src/config.ts \
  apps/knowledge-server/test/gateway-config.test.ts \
  apps/knowledge-server/test/a2a-query.integration.test.ts
git commit -m "feat: default gateway configuration to loopback"
```

---

### Task 2: 监听配置地址并返回内部/公共绑定

**Files:**
- Create: `apps/knowledge-server/src/http-listener.ts`
- Create: `apps/knowledge-server/test/http-listener.test.ts`
- Modify: `apps/knowledge-server/src/a2a-server.ts:1-199`

- [ ] **Step 1: 写真实回环监听失败测试**

创建 `apps/knowledge-server/test/http-listener.test.ts`：

```ts
import express from "express";
import { describe, expect, it } from "vitest";

import { formatInternalHttpUrl, listenHttp } from "../src/http-listener.js";

describe("Gateway HTTP listener", () => {
  it("binds only the configured loopback host and returns the actual ephemeral port", async () => {
    const app = express();
    app.get("/healthz", (_request, response) => response.status(200).send({ status: "ready" }));

    const binding = await listenHttp(app, { host: "127.0.0.1", port: 0 });
    try {
      expect(binding.host).toBe("127.0.0.1");
      expect(binding.port).toBeGreaterThan(0);
      expect(binding.internalUrl).toBe(`http://127.0.0.1:${binding.port}`);
      expect(binding.server.address()).toMatchObject({ address: "127.0.0.1" });
      expect(await (await fetch(`${binding.internalUrl}/healthz`)).json()).toEqual({ status: "ready" });
    } finally {
      await binding.close();
    }
  });

  it("formats an IPv6 listener URL with brackets", () => {
    expect(formatInternalHttpUrl("::1", 8080)).toBe("http://[::1]:8080");
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/http-listener.test.ts
```

Expected: FAIL，`../src/http-listener.js` 尚不存在。

- [ ] **Step 3: 实现聚焦的 HTTP listener**

创建 `apps/knowledge-server/src/http-listener.ts`：

```ts
import { isIP } from "node:net";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Express } from "express";

export interface HttpListenerBinding {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly internalUrl: string;
  close(): Promise<void>;
}

export function formatInternalHttpUrl(host: string, port: number): string {
  const hostForUrl = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${hostForUrl}:${port}`;
}

export async function listenHttp(
  app: Express,
  input: { readonly host: string; readonly port: number },
): Promise<HttpListenerBinding> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(input.port, input.host, () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    host: input.host,
    port: address.port,
    internalUrl: formatInternalHttpUrl(input.host, address.port),
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
```

- [ ] **Step 4: 运行 listener 测试并确认 GREEN**

Run 同 Step 2。

Expected: 2 tests PASS；IPv4 使用真实 socket，IPv6 只验证确定性 URL formatter。

- [ ] **Step 5: 写 A2AServer 新 binding 的失败断言**

在 `describePostgres("A2A Knowledge Server PostgreSQL journeys", ...)` 的首项增加独立测试：

```ts
it("binds the configured loopback host and keeps the public URL separate", async () => {
  const server = await createA2AServer(readServerConfig(testEnvironment()), {
    modelRuntime: runtime(new ScriptedModel()),
  });
  try {
    const binding = await server.start();
    expect(binding).toMatchObject({
      host: "127.0.0.1",
      internalUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
    });
    expect(binding.url).toBe(binding.internalUrl);
  } finally {
    await server.close();
  }
});
```

测试环境公共 URL 是 `http://127.0.0.1:0`，因此真实端口替换后两个 URL 应相同。

- [ ] **Step 6: 运行启用 PostgreSQL 的目标测试并确认 RED**

Run:

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/a2a-query.integration.test.ts
```

Expected: FAIL，binding 缺少 `host` 和 `internalUrl`。

- [ ] **Step 7: 让 A2AServer 使用 listener**

在 `a2a-server.ts`：

1. 删除本地 `listen` 和 `closeHttpServer`；
2. 导入 `listenHttp` 和 `HttpListenerBinding`；
3. 将 `A2AServer.start` 返回类型扩展为：

```ts
start(): Promise<{
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly internalUrl: string;
}>;
```

4. 将运行时字段替换为：

```ts
let httpBinding: HttpListenerBinding | undefined;
```

5. 将 `start()` 的监听段替换为：

```ts
if (httpBinding !== undefined) throw new Error("Knowledge server is already listening");
httpBinding = await listenHttp(app, { host: config.bindHost, port: config.port });
const url = listeningUrl(config.publicUrl, httpBinding.port);
updateCardUrl(card, url);
return {
  url,
  host: httpBinding.host,
  port: httpBinding.port,
  internalUrl: httpBinding.internalUrl,
};
```

6. 将关闭段替换为：

```ts
if (httpBinding !== undefined) await httpBinding.close();
```

- [ ] **Step 8: 运行 listener 与 A2A 回归并确认 GREEN**

Run Step 2 和 Step 6 两条命令。

Expected: listener 2 tests PASS；A2A PostgreSQL journeys 全部 PASS。

- [ ] **Step 9: 提交监听切片**

```bash
git add apps/knowledge-server/src/http-listener.ts \
  apps/knowledge-server/src/a2a-server.ts \
  apps/knowledge-server/test/http-listener.test.ts \
  apps/knowledge-server/test/a2a-query.integration.test.ts
git commit -m "feat: bind knowledge gateway to configured host"
```

---

### Task 3: 启动输出使用 Gateway 语义且保持脱敏

**Files:**
- Create: `apps/knowledge-server/test/main.test.ts`
- Modify: `apps/knowledge-server/src/main.ts:1-24`

- [ ] **Step 1: 写纯启动信息失败测试**

创建 `apps/knowledge-server/test/main.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { gatewayStartupMessages } from "../src/main.js";

describe("Gateway startup messages", () => {
  it("reports internal and public addresses without configuration secrets", () => {
    const messages = gatewayStartupMessages({
      url: "https://knowledge.example.com",
      host: "127.0.0.1",
      port: 8080,
      internalUrl: "http://127.0.0.1:8080",
    });

    expect(messages).toEqual([
      "CoWikiHarness Gateway listening internally at http://127.0.0.1:8080",
      "CoWikiHarness Gateway public URL https://knowledge.example.com",
    ]);
    expect(messages.join(" ")).not.toMatch(/token|secret|password|api[_-]?key/iu);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/main.test.ts
```

Expected: FAIL，`gatewayStartupMessages` 尚未导出。

- [ ] **Step 3: 实现纯 formatter 并接入 main**

在 `main.ts` 增加：

```ts
interface GatewayBinding {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly internalUrl: string;
}

export function gatewayStartupMessages(binding: GatewayBinding): readonly string[] {
  return [
    `CoWikiHarness Gateway listening internally at ${binding.internalUrl}`,
    `CoWikiHarness Gateway public URL ${binding.url}`,
  ];
}
```

将原启动日志替换为：

```ts
for (const message of gatewayStartupMessages(binding)) console.log(message);
```

失败日志统一改为：

```ts
console.error("CoWikiHarness Gateway failed to start");
```

- [ ] **Step 4: 运行 main、listener、config 测试并确认 GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run \
  test/main.test.ts test/http-listener.test.ts test/gateway-config.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交 Gateway 启动语义**

```bash
git add apps/knowledge-server/src/main.ts apps/knowledge-server/test/main.test.ts
git commit -m "feat: report gateway runtime boundaries"
```

---

### Task 4: 增加 Linux systemd、installer 与 Caddy 资产

**Files:**
- Create: `apps/knowledge-server/test/deployment-assets.test.ts`
- Create: `deploy/linux/cowikiharness-gateway.service.template`
- Create: `deploy/linux/gateway.env.example`
- Create: `deploy/caddy/Caddyfile.example`
- Create: `scripts/install_server_linux.sh`

- [ ] **Step 1: 写部署资产失败测试**

创建 `apps/knowledge-server/test/deployment-assets.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(
  new URL(`../../../${path}`, import.meta.url),
  "utf8",
);

describe("Linux Gateway deployment assets", () => {
  it("runs the Gateway as an unprivileged restartable systemd service", () => {
    const unit = read("deploy/linux/cowikiharness-gateway.service.template");

    expect(unit).toContain("User=cowikiharness");
    expect(unit).toContain("Group=cowikiharness");
    expect(unit).toContain("EnvironmentFile=/etc/cowikiharness/gateway.env");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).not.toContain("User=root");
    expect(unit).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);
  });

  it("provides a loopback env template and a single HTTPS reverse proxy", () => {
    const env = read("deploy/linux/gateway.env.example");
    const caddy = read("deploy/caddy/Caddyfile.example");

    expect(env).toContain("OPENLIFEWIKI_BIND_HOST=127.0.0.1");
    expect(env).toContain("OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com");
    expect(env).not.toContain("unit-test-api-key");
    expect(caddy).toContain("knowledge.example.com");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8080");
  });

  it("keeps the Linux installer syntactically valid and explicit about prerequisites", () => {
    const installerPath = new URL("../../../scripts/install_server_linux.sh", import.meta.url);
    const installer = read("scripts/install_server_linux.sh");
    const syntax = spawnSync("bash", ["-n", installerPath.pathname], { encoding: "utf8" });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(installer).toContain("Expected Linux");
    expect(installer).toContain("Expected Node.js >=24.16.0 <25");
    expect(installer).toContain("Expected pnpm 10.33.2");
    expect(installer).toContain("\"$pnpm_bin\" install --frozen-lockfile");
    expect(installer).toContain("\"$pnpm_bin\" --filter @openlifewiki/knowledge-server build");
    expect(installer).toContain("systemctl enable --now cowikiharness-gateway.service");
    expect(installer).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run test/deployment-assets.test.ts
```

Expected: FAIL，四个部署资产尚不存在。

- [ ] **Step 3: 创建 systemd 单元模板**

创建 `deploy/linux/cowikiharness-gateway.service.template`：

```ini
[Unit]
Description=CoWikiHarness Knowledge Gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=cowikiharness
Group=cowikiharness
WorkingDirectory=__REPO_ROOT__
EnvironmentFile=/etc/cowikiharness/gateway.env
ExecStart=__NODE_BIN__ __REPO_ROOT__/apps/knowledge-server/dist/main.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=cowikiharness
ReadWritePaths=/var/lib/cowikiharness

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: 创建无真实 secret 的环境模板**

创建 `deploy/linux/gateway.env.example`：

```dotenv
DATABASE_URL=postgres://cowikiharness:replace-database-password@127.0.0.1:5432/cowikiharness
OPENLIFEWIKI_TOKEN_HMAC_SECRET=replace-with-at-least-32-random-bytes
OPENAI_API_KEY=replace-with-provider-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENLIFEWIKI_MODEL=gpt-5.5
OPENLIFEWIKI_MODEL_REASONING_EFFORT=xhigh
OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE=true
OPENLIFEWIKI_BIND_HOST=127.0.0.1
PORT=8080
OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com
OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS=
```

- [ ] **Step 5: 创建 Caddy 示例**

创建 `deploy/caddy/Caddyfile.example`：

```caddyfile
knowledge.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

- [ ] **Step 6: 创建最小 Linux 安装脚本**

创建 `scripts/install_server_linux.sh`，完整行为如下：

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Expected Linux.\n' >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${COWIKIHARNESS_NODE:-$(command -v node || true)}"
pnpm_bin="${COWIKIHARNESS_PNPM:-$(command -v pnpm || true)}"
config_path="/etc/cowikiharness/gateway.env"
config_source="${COWIKIHARNESS_CONFIG_SOURCE:-}"
unit_template="$repo_root/deploy/linux/cowikiharness-gateway.service.template"
unit_path="/etc/systemd/system/cowikiharness-gateway.service"

if [[ -z "$node_bin" ]] || ! "$node_bin" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major === 24 && minor >= 16 ? 0 : 1);
'; then
  printf 'Expected Node.js >=24.16.0 <25.\n' >&2
  exit 1
fi
if [[ -z "$pnpm_bin" ]] || [[ "$($pnpm_bin --version)" != "10.33.2" ]]; then
  printf 'Expected pnpm 10.33.2.\n' >&2
  exit 1
fi

getent group cowikiharness >/dev/null || groupadd --system cowikiharness
if ! id cowikiharness >/dev/null 2>&1; then
  useradd --system --gid cowikiharness --home-dir /var/lib/cowikiharness \
    --shell /usr/sbin/nologin cowikiharness
fi
install -d -o root -g cowikiharness -m 0750 /etc/cowikiharness
install -d -o cowikiharness -g cowikiharness -m 0750 /var/lib/cowikiharness

if [[ -n "$config_source" ]]; then
  install -o root -g cowikiharness -m 0640 "$config_source" "$config_path"
fi
if [[ ! -r "$config_path" ]]; then
  printf 'Create %s from deploy/linux/gateway.env.example first.\n' "$config_path" >&2
  exit 1
fi
chown root:cowikiharness "$config_path"
chmod 0640 "$config_path"

cd "$repo_root"
"$pnpm_bin" install --frozen-lockfile
"$pnpm_bin" --filter @openlifewiki/knowledge-server build

escaped_repo="$(printf '%s' "$repo_root" | sed 's/[&|\\]/\\&/g')"
escaped_node="$(printf '%s' "$node_bin" | sed 's/[&|\\]/\\&/g')"
sed -e "s|__REPO_ROOT__|$escaped_repo|g" \
  -e "s|__NODE_BIN__|$escaped_node|g" \
  "$unit_template" > "$unit_path"
chmod 0644 "$unit_path"
systemctl daemon-reload
systemctl enable --now cowikiharness-gateway.service

printf 'CoWikiHarness Gateway installed.\n'
printf 'Check: systemctl status cowikiharness-gateway.service\n'
printf 'Health: curl http://127.0.0.1:8080/healthz\n'
```

脚本使用 `apply_patch` 创建后执行：

```bash
chmod +x scripts/install_server_linux.sh
```

- [ ] **Step 7: 运行部署资产测试并确认 GREEN**

Run 同 Step 2。

Expected: 3 tests PASS，Bash syntax status 0。

- [ ] **Step 8: 运行 knowledge-server typecheck/build**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server typecheck
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server build
```

Expected: 两条命令 exit 0。

- [ ] **Step 9: 提交 Linux 部署资产**

```bash
git add apps/knowledge-server/test/deployment-assets.test.ts \
  deploy/linux/cowikiharness-gateway.service.template \
  deploy/linux/gateway.env.example \
  deploy/caddy/Caddyfile.example \
  scripts/install_server_linux.sh
git commit -m "feat: add Linux knowledge gateway deployment"
```

---

### Task 5: 补齐中文部署手册、ADR 和配置入口

**Files:**
- Create: `docs/deployment/linux-gateway.md`
- Create: `docs/decisions/ADR-0010-hermes-style-gateway-deployment.md`
- Modify: `.env.example:5-30`
- Modify: `README.md:75-170`
- Modify: `ARCHITECTURE.md:1-100`

- [ ] **Step 1: 更新统一环境变量示例**

在 `.env.example` 的 `OPENLIFEWIKI_PUBLIC_URL` 之前增加：

```dotenv
# Gateway 内部监听地址。默认只监听本机；只有受控容器网络才显式使用 0.0.0.0。
# OPENLIFEWIKI_BIND_HOST=127.0.0.1
# PORT=8080
```

保留 public URL 和 CORS 说明，删除文件末尾重复的 `# PORT=8080`。

- [ ] **Step 2: 写 Linux Gateway 部署手册**

创建 `docs/deployment/linux-gateway.md`，必须完整包含以下章节和命令：

````markdown
# CoWikiHarness Linux Gateway 部署手册

## 适用范围

本手册用于单台 Linux 服务器的云端试运行：一个 CoWikiHarness Gateway、一个 PostgreSQL 17 和一个现有 HTTPS 边缘。Gateway 默认只监听 `127.0.0.1:8080`。

## 部署前准备

- 服务器安装 Node.js `>=24.16.0 <25` 与 pnpm `10.33.2`；
- PostgreSQL 17 已创建独立数据库和最小权限用户；
- 域名 A/AAAA 记录指向服务器；
- 防火墙只开放 SSH 和 443；
- 准备模型 API key 和至少 32 字节随机 HMAC secret。

## 1. 放置固定版本源码

```bash
sudo git clone --branch dev https://github.com/MetaInFLow/CoWikiHarness.git /opt/cowikiharness
cd /opt/cowikiharness
git fetch origin dev
export COWIKIHARNESS_RELEASE_COMMIT="$(git rev-parse origin/dev)"
printf 'Deploying commit %s\n' "$COWIKIHARNESS_RELEASE_COMMIT"
sudo git checkout "$COWIKIHARNESS_RELEASE_COMMIT"
```

## 2. 创建 Gateway 配置

```bash
sudo install -d -m 0750 /etc/cowikiharness
sudo cp deploy/linux/gateway.env.example /etc/cowikiharness/gateway.env
sudo editor /etc/cowikiharness/gateway.env
```

必须替换数据库密码、HMAC secret、模型 key、模型地址、模型名称和公共域名。生产保持：

```dotenv
OPENLIFEWIKI_BIND_HOST=127.0.0.1
PORT=8080
OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com
```

## 3. 安装并启动

```bash
cd /opt/cowikiharness
sudo ./scripts/install_server_linux.sh
sudo systemctl status cowikiharness-gateway.service
curl http://127.0.0.1:8080/healthz
```

## 4. 配置 HTTPS

将 `deploy/caddy/Caddyfile.example` 中的域名替换为真实域名并加载到已有 Caddy。使用云负载均衡或 Tailscale Serve 时保持 Gateway 配置不变。

## 5. 初始化知识中心

只在全新数据库执行一次 bootstrap，并立即把只显示一次的 token 写入仓库外、权限为 `0600` 的文件。不得把 token 放入命令参数、Git、日志或前端。

## 6. 验收

```bash
curl https://knowledge.example.com/healthz
curl https://knowledge.example.com/.well-known/agent-card.json
```

还需验证：外部无法访问 `http://server-ip:8080`；`cowiki ask` 成功；专用 member token 可读取授权图谱；撤销 token 返回拒绝。

## 日常运维

```bash
sudo systemctl restart cowikiharness-gateway.service
sudo systemctl status cowikiharness-gateway.service
sudo journalctl -u cowikiharness-gateway.service -n 200 --no-pager
```

## 升级

升级前执行 PostgreSQL 备份，停止 Gateway，切换到已批准 commit，重新运行安装脚本并完成健康检查。升级不得直接跟随浮动 `dev` HEAD。

## PostgreSQL 备份与恢复演练

使用 `pg_dump --format=custom` 备份，使用 `pg_restore` 恢复到隔离数据库。恢复验收必须证明 item、location、version ID 和授权查询结果保持一致。数据库备份必须与 `OPENLIFEWIKI_TOKEN_HMAC_SECRET` 一起纳入独立 secret 备份；恢复后轮换用户和 Agent token。

## 回滚

恢复上一批准 commit 并重新运行安装脚本。本切片没有数据库 migration；禁止执行 destructive rollback。若边缘异常，Gateway 仍可在服务器本机通过回环健康检查诊断。
````

- [ ] **Step 3: 写 ADR 0010**

创建 `docs/decisions/ADR-0010-hermes-style-gateway-deployment.md`，内容必须包括：

```markdown
# ADR 0010：采用 Hermes 风格单进程 Gateway 部署边界

- 状态：V2 已接受
- 日期：2026-08-17
- 需求：[`requirements-v2.md`](../requirements/requirements-v2.md)
- 设计：[`2026-08-17-hermes-style-gateway-deployment-design.md`](../superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md)

## 背景

Knowledge Server 已承载 A2A、Agent Card、健康检查和 Graph REST，但固定监听 `0.0.0.0`，Linux 还缺少明确的常驻服务和 HTTPS 部署边界。Hermes Gateway 默认回环监听、操作系统守护和外部网络边缘的模式可以减少应用内基础设施。

## 决策

现有 `apps/knowledge-server` 作为 CoWikiHarness Gateway 运行时。默认监听 `127.0.0.1`，`OPENLIFEWIKI_BIND_HOST` 只接受 localhost 或 IP 地址；`OPENLIFEWIKI_PUBLIC_URL` 对远程主机要求 HTTPS。Linux 使用 systemd，公网 TLS 由 Caddy、云负载均衡器或 Tailscale Serve 终止。客户端继续在读取 token 前拒绝远程 HTTP。

## 影响

- A2A、Graph REST、权限、数据库和模型调用继续共享一个进程；
- 内部 bind 地址与 Agent Card 公共地址分离；
- 默认安装不会公开 8080；
- systemd、Caddy 示例和 Linux 安装脚本进入仓库；
- 生产部署仍需防火墙、证书、数据库备份和 secret 管理；
- 容器只有在应用端口不向公网发布且前方已有 HTTPS 边缘时才绑定 `0.0.0.0`。

## 未采用方案

### 独立 Node.js Gateway

它会重复路由、认证、流式传输和健康检查，当前没有拆分证据。

### 公网 HTTP

Bearer token 与知识内容会明文跨网络传输，违反已批准的 V2 HTTPS 合同。

### Node.js 进程直接管理证书

应用将承担证书申请、续期和热加载，运维复杂度高于复用成熟边缘。

## 回滚

应用可回滚到上一 commit；新增部署文件不改变数据库。移除 bind host 配置后仍回到 `127.0.0.1` 安全默认值。
```

- [ ] **Step 4: 更新 README 最短路径**

在 macOS 本地安装章节之后增加：

````markdown
#### Linux 云端 Gateway

CoWikiHarness 采用 Hermes 风格的单进程 Gateway：应用默认只监听 `127.0.0.1:8080`，systemd 负责常驻，公网 HTTPS 由 Caddy、云负载均衡器或 Tailscale Serve 提供。

```bash
sudo git clone --branch dev https://github.com/MetaInFLow/CoWikiHarness.git /opt/cowikiharness
cd /opt/cowikiharness
sudo cp deploy/linux/gateway.env.example /etc/cowikiharness/gateway.env
sudo editor /etc/cowikiharness/gateway.env
sudo ./scripts/install_server_linux.sh
```

生产部署必须固定到已批准 commit，并在开放域名前完成 PostgreSQL 备份、HTTPS、应用端口防火墙和 token 文件权限检查。完整步骤见 [Linux Gateway 部署手册](docs/deployment/linux-gateway.md)。
````

- [ ] **Step 5: 更新架构运行边界**

在 `ARCHITECTURE.md` 的 V2 运行组件说明附近增加：

```markdown
### Gateway 部署边界

`apps/knowledge-server` 以 CoWikiHarness Gateway 形态常驻，单进程承载 Agent Card、A2A、Graph REST、Knowledge Agent 和数据库连接。默认 bind host 为 `127.0.0.1`；公共 URL 与内部监听地址独立。公网 HTTPS 在 Caddy、云负载均衡器或 Tailscale Serve 终止，远程客户端禁止明文 bearer 传输。该边界由 [ADR 0010](docs/decisions/ADR-0010-hermes-style-gateway-deployment.md) 固化。
```

- [ ] **Step 6: 检查文档和链接**

Run:

```bash
rg -n "OPENLIFEWIKI_BIND_HOST|Linux Gateway|ADR 0010|127\.0\.0\.1:8080" \
  README.md ARCHITECTURE.md .env.example docs/deployment docs/decisions
git diff --check
```

Expected: 第一条覆盖所有新增入口；`git diff --check` exit 0。

- [ ] **Step 7: 提交中文文档和 ADR**

```bash
git add .env.example README.md ARCHITECTURE.md \
  docs/deployment/linux-gateway.md \
  docs/decisions/ADR-0010-hermes-style-gateway-deployment.md
git commit -m "docs: document Linux knowledge gateway deployment"
```

---

### Task 6: 完整验证、真实本机 smoke 与实施记录

**Files:**
- Modify: `docs/memory-bank/active-context.md`
- Modify: `docs/superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md`

- [ ] **Step 1: 运行四个聚焦测试**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm --filter @openlifewiki/knowledge-server exec vitest run \
  test/gateway-config.test.ts \
  test/http-listener.test.ts \
  test/main.test.ts \
  test/deployment-assets.test.ts
```

Expected: 全部 PASS，无 warning/error。

- [ ] **Step 2: 运行完整静态门禁**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm verify
```

Expected: schema check、build、typecheck 和 tests 全部 exit 0。

- [ ] **Step 3: 运行 PostgreSQL/A2A 门禁**

确认 PostgreSQL 17 测试实例监听 `127.0.0.1:55432` 后运行：

```bash
OPENLIFEWIKI_POSTGRES_TEST=1 \
OPENLIFEWIKI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openlifewiki_test \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
pnpm verify:cloud
```

Expected: 全部 exit 0；记录实际 pass/skip 数量，不复用旧数字。

- [ ] **Step 4: 重新安装并验证 macOS 兼容链路**

Run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" ./scripts/install_local_macos.sh
curl --fail --silent http://127.0.0.1:8080/healthz
```

Expected: installer exit 0；health 返回 `{"status":"ready"}`；LaunchAgent 日志显示 Gateway 内部地址为 `http://127.0.0.1:8080`。

- [ ] **Step 5: 运行真实 A2A 和 Graph smoke**

Run:

```bash
cowiki ask "CoWikiHarness 本机使用说明有哪些标签？"
cowiki graph \
  --depth 2 \
  --include tags,locations \
  --token-file "$HOME/Library/Application Support/CoWikiHarness/credentials/owner.token"
```

Expected: ask 返回可解析的带引用结果；graph 返回 `cowikiharness.graph/v1`。输出不得包含 token、digest、HMAC secret、模型 key、知识正文或个人绝对路径。

- [ ] **Step 6: 验证安全边界和工作树**

Run:

```bash
bash -n scripts/install_server_linux.sh
git diff --check
git status -sb
```

人工检查：

- server 默认绑定 `127.0.0.1`；
- macOS LaunchAgent 正常；
- 远程 HTTP 客户端测试仍为 fail-closed；
- systemd unit 无 secret、无 root 用户、失败重启；
- Caddy 只反代回环地址；
- 没有运行时数据、token、日志或个人知识进入 Git。

- [ ] **Step 7: 更新设计状态和 active context**

将设计文档状态改为：

```text
- 状态：已实现并完成 macOS/自动化门禁；待首台 Linux 服务器真实 systemd 验收
```

在设计文档“测试与验收”末尾追加实际 commit、Node/pnpm/PostgreSQL 版本、测试 pass/skip 数量、本机 health/A2A/Graph 结果和 Linux 尚未执行的验收项。

在 `docs/memory-bank/active-context.md` 的 Current Focus 与 Implemented Baseline 增加：

```markdown
- CoWikiHarness Gateway 已采用 Hermes 风格部署边界：默认回环监听、内部地址与公共 URL 分离、Linux systemd/Caddy 资产和中文部署手册已交付；远程 HTTP bearer 继续 fail-closed。
- 自动化、PostgreSQL/A2A 和 macOS LaunchAgent 真实 smoke 已完成；首台 Linux 服务器的 systemd、公网 443、8080 不可达和备份恢复演练仍是部署验收项。
```

实际测试数字必须替换描述中的概括，不得写计划值。

- [ ] **Step 8: 提交验证证据**

```bash
git add docs/memory-bank/active-context.md \
  docs/superpowers/specs/2026-08-17-hermes-style-gateway-deployment-design.md
git commit -m "test: verify hermes-style gateway deployment"
```

- [ ] **Step 9: 最终检查并推送 dev**

```bash
git status -sb
git log -6 --oneline --decorate
git push origin dev
```

Expected: 工作树干净；`dev` 与 `origin/dev` 同步；`main` 未变化。

## 4. Review Roles

- **Product/Owner:** Gateway 使用路径、安装边界、非目标与实际部署可理解性。
- **Architecture:** 单进程边界、bind/public URL 分离、A2A/Graph 兼容性、退出成本。
- **Security:** 默认监听、bearer 传输、systemd 用户/权限、环境文件、CORS、防火墙、日志脱敏。
- **DX:** Linux 首次安装、状态、日志、升级、回滚和错误信息。
- **QA:** config/listener/deployment 合同、完整 verify、PostgreSQL/A2A、macOS smoke。
- **Release:** commit 固定、备份顺序、Linux 待验收项、`dev` 推送和 `main` 不变。

## 5. Rollback / Fallback

- 代码回滚到本切片前的 `f0f8c54`；本切片没有数据库 migration。
- 删除显式 `OPENLIFEWIKI_BIND_HOST` 后使用安全默认 `127.0.0.1`。
- Caddy/负载均衡异常时保留服务器本机 `/healthz` 诊断。
- systemd 安装失败时不执行 bootstrap、不修改 PostgreSQL 业务状态；修复环境后重复运行 installer。
- macOS LaunchAgent 继续作为本地 fallback，不受 Linux 资产影响。
