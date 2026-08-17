import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

describe("Linux deployment assets", () => {
  it("runs the knowledge gateway as a hardened unprivileged systemd service", async () => {
    const unit = await read("deploy/linux/cowikiharness-gateway.service.template");

    expect(unit).toContain("Description=CoWikiHarness Knowledge Gateway");
    expect(unit).toContain("Wants=network-online.target");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("User=cowikiharness");
    expect(unit).toContain("Group=cowikiharness");
    expect(unit).toContain("WorkingDirectory=__REPO_ROOT__");
    expect(unit).toContain("EnvironmentFile=/etc/cowikiharness/gateway.env");
    expect(unit).toContain("ExecStart=__NODE_BIN__ __REPO_ROOT__/apps/knowledge-server/dist/main.js");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5s");
    expect(unit).toContain("TimeoutStopSec=30s");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=true");
    expect(unit).toContain("StateDirectory=cowikiharness");
    expect(unit).toContain("ReadWritePaths=/var/lib/cowikiharness");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).not.toContain("User=root");
    expect(unit).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);
  });

  it("keeps the gateway on loopback behind the example Caddy site", async () => {
    const [environment, caddyfile] = await Promise.all([
      read("deploy/linux/gateway.env.example"),
      read("deploy/caddy/Caddyfile.example"),
    ]);

    expect(environment).toContain("OPENLIFEWIKI_BIND_HOST=127.0.0.1");
    expect(environment).toContain("OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com");
    expect(environment).not.toContain("unit-test-api-key");
    expect(caddyfile).toContain("knowledge.example.com");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:8080");
  });

  it("validates and installs the Linux service with the pinned toolchain", async () => {
    const installerPath = resolve(repoRoot, "scripts/install_server_linux.sh");
    const installer = await read("scripts/install_server_linux.sh");

    expect(() => execFileSync("bash", ["-n", installerPath])).not.toThrow();
    expect(installer).toContain("Expected Linux");
    expect(installer).toContain("Expected Node.js >=24.16.0 <25");
    expect(installer).toContain("Expected pnpm 10.33.2");
    expect(installer).toContain('"$pnpm_bin" install --frozen-lockfile');
    expect(installer).toContain(
      '"$pnpm_bin" --filter @openlifewiki/knowledge-server build',
    );
    expect(installer).toContain("systemctl enable --now cowikiharness-gateway.service");
    expect(installer).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);
  });
});
