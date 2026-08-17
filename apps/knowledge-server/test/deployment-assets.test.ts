import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const installerPath = resolve(repoRoot, "scripts/install_server_linux.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

describe("Linux deployment assets", () => {
  it("runs the knowledge gateway as a hardened unprivileged systemd service", async () => {
    const unit = await read("deploy/linux/cowikiharness-gateway.service.template");

    expect(unit).toContain("Description=CoWikiHarness Knowledge Gateway");
    expect(unit).toContain("Wants=network-online.target");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Type=exec");
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
    expect(unit).toContain("StateDirectoryMode=0750");
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
    const installer = await read("scripts/install_server_linux.sh");

    expect(() => execFileSync("bash", ["-n", installerPath])).not.toThrow();
    expect(installer).toContain("Expected Linux");
    expect(installer).toContain("Expected Node.js >=24.16.0 <25");
    expect(installer).toContain("Expected pnpm 10.33.2");
    expect(installer).toContain('"$pnpm_bin" install --frozen-lockfile');
    expect(installer).toContain(
      '"$pnpm_bin" --filter "@openlifewiki/knowledge-server..." build',
    );
    expect(installer).not.toContain(
      '"$pnpm_bin" --filter @openlifewiki/knowledge-server build',
    );
    expect(installer).toContain("systemctl show-environment");
    expect(installer).toContain(
      "systemctl is-active --quiet cowikiharness-gateway.service",
    );
    expect(installer).toContain("systemctl stop cowikiharness-gateway.service");
    expect(installer).toContain("Existing cowikiharness group is not dedicated.");
    expect(installer).toContain("Existing cowikiharness user is not the required dedicated identity.");
    expect(installer).toContain("id -nG cowikiharness");
    expect(installer).toContain("require_command");
    expect(installer).toContain("systemctl enable --now cowikiharness-gateway.service");
    expect(installer).toContain(
      'curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$health_url"',
    );
    expect(installer).toContain("systemctl status cowikiharness-gateway.service");
    expect(installer).toContain(
      "journalctl -u cowikiharness-gateway.service --no-pager -n 100",
    );
    expect(installer).not.toMatch(/^\s*source\s/mu);
    expect(installer).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);

    const inactiveGate = installer.indexOf(
      "systemctl is-active --quiet cowikiharness-gateway.service",
    );
    expect(inactiveGate).toBeGreaterThan(-1);
    for (const writeOperation of [
      "groupadd --system",
      "useradd --system",
      "install -d",
      '"$pnpm_bin" install --frozen-lockfile',
      'unit_tmp="$(mktemp)"',
    ]) {
      expect(installer.indexOf(writeOperation)).toBeGreaterThan(inactiveGate);
    }

    const healthCheck = installer.indexOf("curl --fail --silent --show-error");
    const successMessage = installer.indexOf(
      "CoWikiHarness Knowledge Gateway installed and started.",
    );
    expect(healthCheck).toBeGreaterThan(-1);
    expect(successMessage).toBeGreaterThan(healthCheck);
  });

  it("accepts a valid gateway configuration without executing its values", async () => {
    const markerPath = join(tmpdir(), `cowikiharness-config-executed-${process.pid}`);
    await rm(markerPath, { force: true });
    const configPath = await writeConfig(validEnvironment({
      OPENAI_API_KEY: `$(touch\${IFS}${markerPath})`,
    }));

    const result = validateConfig(configPath);

    expect(result.status).toBe(0);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "database password placeholder",
      { DATABASE_URL: "postgres://cowikiharness:replace-database-password@127.0.0.1/db" },
    ],
    [
      "HMAC placeholder",
      { OPENLIFEWIKI_TOKEN_HMAC_SECRET: "replace-with-at-least-32-random-bytes" },
    ],
    ["provider key placeholder", { OPENAI_API_KEY: "replace-with-provider-key" }],
    [
      "public URL placeholder",
      { OPENLIFEWIKI_PUBLIC_URL: "https://knowledge.example.com" },
    ],
  ])("rejects the %s", async (_name, overrides) => {
    const configPath = await writeConfig(validEnvironment(overrides));

    const result = validateConfig(configPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Invalid gateway configuration: replace all template placeholder values before installation.",
    );
  });

  it("rejects a weak HMAC secret", async () => {
    const configPath = await writeConfig(validEnvironment({
      OPENLIFEWIKI_TOKEN_HMAC_SECRET: "too-short",
    }));

    const result = validateConfig(configPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENLIFEWIKI_TOKEN_HMAC_SECRET must be exactly 64 hexadecimal characters.",
    );
  });

  it("rejects a non-loopback systemd bind host", async () => {
    const configPath = await writeConfig(validEnvironment({
      OPENLIFEWIKI_BIND_HOST: "0.0.0.0",
    }));

    const result = validateConfig(configPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENLIFEWIKI_BIND_HOST must be exactly 127.0.0.1.",
    );
  });

  it("rejects a duplicate required key", async () => {
    const configPath = await writeConfig(
      `${validEnvironment()} OPENAI_API_KEY =duplicate-provider-key\n`,
    );

    const result = validateConfig(configPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Invalid gateway configuration: expected exactly one OPENAI_API_KEY entry.",
    );
  });

  it("rejects an HTTP public URL", async () => {
    const configPath = await writeConfig(validEnvironment({
      OPENLIFEWIKI_PUBLIC_URL: "http://knowledge.acme.com",
    }));

    const result = validateConfig(configPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENLIFEWIKI_PUBLIC_URL must be a non-example HTTPS URL.",
    );
  });
});

type RequiredEnvironment = {
  DATABASE_URL: string;
  OPENLIFEWIKI_TOKEN_HMAC_SECRET: string;
  OPENAI_API_KEY: string;
  OPENLIFEWIKI_BIND_HOST: string;
  OPENLIFEWIKI_PUBLIC_URL: string;
};

function validEnvironment(overrides: Partial<RequiredEnvironment> = {}): string {
  const environment: RequiredEnvironment = {
    DATABASE_URL: "postgres://cowikiharness:strong-database-password@127.0.0.1:5432/cowikiharness",
    OPENLIFEWIKI_TOKEN_HMAC_SECRET:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPENAI_API_KEY: "test-provider-key",
    OPENLIFEWIKI_BIND_HOST: "127.0.0.1",
    OPENLIFEWIKI_PUBLIC_URL: "https://knowledge.acme.com",
    ...overrides,
  };

  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

async function writeConfig(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cowikiharness-config-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "gateway.env");
  await writeFile(configPath, contents, { mode: 0o600 });
  return configPath;
}

function validateConfig(configPath: string) {
  return spawnSync("bash", [installerPath, "validate-config", configPath], {
    encoding: "utf8",
  });
}
