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
    const deploymentValidation = "ExecStartPre=__NODE_BIN__ "
      + "__REPO_ROOT__/apps/knowledge-server/dist/deployment-config.js "
      + "/etc/cowikiharness/gateway.env";
    expect(unit).toContain(deploymentValidation);
    expect(unit).toContain("ExecStart=__NODE_BIN__ __REPO_ROOT__/apps/knowledge-server/dist/main.js");
    expect(unit.indexOf(deploymentValidation)).toBeLessThan(unit.indexOf("ExecStart="));
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
    expect(environment).toContain("PORT=8080");
    expect(environment).toContain(
      "# Use a remote HTTPS origin only; do not include a path, query, fragment, or userinfo.",
    );
    expect(environment).toContain("OPENLIFEWIKI_PUBLIC_URL=https://knowledge.example.com");
    expect(environment).not.toContain("unit-test-api-key");
    expect(caddyfile).toContain("knowledge.example.com");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:8080");
  });

  it("validates before system writes and verifies the real service health", async () => {
    const [installer, deploymentValidator] = await Promise.all([
      read("scripts/install_server_linux.sh"),
      read("apps/knowledge-server/src/deployment-config.ts"),
    ]);

    expect(() => execFileSync("bash", ["-n", installerPath])).not.toThrow();
    expect(installer).toContain("Expected Linux");
    expect(installer).toContain("Expected Node.js >=24.16.0 <25");
    expect(installer).toContain("Expected pnpm 10.33.2");
    expect(installer).toContain('"$pnpm_bin" install --frozen-lockfile');
    const deploymentBuild = [
      '  "$pnpm_bin" \\',
      '    --filter "@openlifewiki/knowledge-server..." \\',
      '    --filter "@openlifewiki/cli..." \\',
      "    build",
    ].join("\n");
    expect(installer).toContain(deploymentBuild);
    expect(installer).toContain(
      '"$node_bin" "$repo_root/apps/knowledge-server/dist/deployment-config.js" "$config_candidate"',
    );
    expect(installer).toContain(
      "systemctl show --property=LoadState --property=ActiveState --value cowikiharness-gateway.service",
    );
    expect(installer).toContain('case "$service_state_output" in');
    expect(installer).toContain("$'not-found\\ninactive' | $'loaded\\ninactive' | $'loaded\\nfailed')");
    expect(installer).not.toContain("systemctl list-unit-files");
    expect(installer).toContain("systemctl stop cowikiharness-gateway.service");
    expect(installer).toContain("load_and_validate_identity");
    expect(installer).toContain('passwd_entries="$(getent passwd)"');
    expect(installer).toContain('group_entries="$(getent group)"');
    expect(installer).toContain(
      '[[ "$identity_group_exists" != "true" || "$identity_user_exists" != "true" ]]',
    );
    expect(installer).toContain(
      "if ! systemctl enable --now cowikiharness-gateway.service; then",
    );
    expect(installer).toContain(
      'curl --noproxy \'*\' --fail --silent --show-error --connect-timeout 1 --max-time 2 "$health_url"',
    );
    expect(installer).toContain(
      "systemctl is-active --quiet cowikiharness-gateway.service",
    );
    expect(installer).toContain("[[ \"$health_body\" == '{\"status\":\"ready\"}' ]]");
    expect(installer).not.toContain(
      "systemctl stop cowikiharness-gateway.service || true",
    );
    expect(installer).toContain("cleanup_gateway_service_after_failure");
    expect(installer).toContain(
      "Failed to stop cowikiharness-gateway.service during failed installation cleanup.",
    );
    expect(installer).toContain(
      "cowikiharness-gateway.service did not reach a stopped state after failed installation cleanup.",
    );
    expect(installer).toContain(
      "journalctl -u cowikiharness-gateway.service --no-pager -n 100",
    );
    expect(installer).not.toMatch(/^\s*source\s/mu);
    expect(installer).not.toMatch(/OPENAI_API_KEY=|TOKEN_HMAC_SECRET=/u);

    const inactiveGate = installer.indexOf(
      "systemctl show --property=LoadState --property=ActiveState --value cowikiharness-gateway.service",
    );
    const build = installer.indexOf(deploymentBuild);
    const sharedValidation = installer.indexOf(
      '"$node_bin" "$repo_root/apps/knowledge-server/dist/deployment-config.js" "$config_candidate"',
    );
    expect(inactiveGate).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(inactiveGate);
    expect(sharedValidation).toBeGreaterThan(build);
    for (const systemWrite of [
      "groupadd --system",
      "useradd --system",
      "install -d",
      'unit_tmp="$(mktemp)"',
    ]) {
      expect(installer.indexOf(systemWrite)).toBeGreaterThan(sharedValidation);
    }

    const identityValidationCalls = installer.match(/^  load_and_validate_identity$/gmu);
    expect(identityValidationCalls).toHaveLength(2);
    const cleanupCalls = installer.match(/^    if ! cleanup_gateway_service_after_failure; then$/gmu);
    expect(cleanupCalls).toHaveLength(2);
    const enableFailure = installer.indexOf(
      "if ! systemctl enable --now cowikiharness-gateway.service; then",
    );
    const startupCleanup = installer.indexOf(
      "if ! cleanup_gateway_service_after_failure; then",
      enableFailure,
    );
    const healthFailure = installer.indexOf('if [[ "$health_ok" != "true" ]]; then');
    const healthCleanup = installer.indexOf(
      "if ! cleanup_gateway_service_after_failure; then",
      healthFailure,
    );
    expect(startupCleanup).toBeGreaterThan(enableFailure);
    expect(startupCleanup).toBeLessThan(healthFailure);
    expect(healthCleanup).toBeGreaterThan(healthFailure);
    const healthCheck = installer.indexOf("curl --noproxy");
    const successMessage = installer.indexOf(
      "CoWikiHarness Knowledge Gateway installed and started.",
    );
    expect(healthCheck).toBeGreaterThan(-1);
    expect(successMessage).toBeGreaterThan(healthCheck);

    expect(deploymentValidator).toContain(
      "process.argv[1] === fileURLToPath(import.meta.url)",
    );
    expect(deploymentValidator).toContain("Gateway deployment configuration is valid.");
    expect(deploymentValidator).toContain("Invalid gateway deployment configuration.");
  });

  it.each([
    [
      "UID 0",
      "cowikiharness:x:0:991::/var/lib/cowikiharness:/usr/sbin/nologin",
      "cowikiharness:x:991:",
      "Existing cowikiharness user has forbidden UID 0.",
    ],
    [
      "GID 0",
      "cowikiharness:x:991:0::/var/lib/cowikiharness:/usr/sbin/nologin",
      "cowikiharness:x:0:",
      "Existing cowikiharness group has forbidden GID 0.",
    ],
    [
      "duplicate UID",
      [
        "cowikiharness:x:991:991::/var/lib/cowikiharness:/usr/sbin/nologin",
        "other:x:991:992::/var/lib/other:/usr/sbin/nologin",
      ].join("\n"),
      "cowikiharness:x:991:",
      "Existing cowikiharness UID is shared.",
    ],
    [
      "duplicate GID",
      "cowikiharness:x:991:991::/var/lib/cowikiharness:/usr/sbin/nologin",
      ["cowikiharness:x:991:", "other:x:991:"].join("\n"),
      "Existing cowikiharness GID is shared.",
    ],
    [
      "another primary-GID user",
      [
        "cowikiharness:x:991:991::/var/lib/cowikiharness:/usr/sbin/nologin",
        "other:x:992:991::/var/lib/other:/usr/sbin/nologin",
      ].join("\n"),
      "cowikiharness:x:991:",
      "Existing cowikiharness group is a primary group for another user.",
    ],
    [
      "explicit group member",
      "cowikiharness:x:991:991::/var/lib/cowikiharness:/usr/sbin/nologin",
      "cowikiharness:x:991:other",
      "Existing cowikiharness group is not dedicated.",
    ],
  ])("fails closed for identity conflict: %s", (
    _name,
    passwdEntries,
    groupEntries,
    expectedError,
  ) => {
    const result = validateIdentity(passwdEntries, groupEntries, "cowikiharness");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it.each([
    ["a missing unit", "not-found\ninactive\n"],
    ["an inactive loaded unit", "loaded\ninactive\n"],
    ["a failed loaded unit", "loaded\nfailed\n"],
  ])("allows %s through the inactive gate", async (_name, showOutput) => {
    const result = await runSystemctlFunction("require_inactive_service", { showOutput });

    expect(result.status).toBe(0);
  });

  it.each([
    ["an empty response", "", 0],
    ["a failed query", "", 1],
    ["an activating unit", "loaded\nactivating\n", 0],
    ["a missing field", "loaded\n", 0],
    ["a repeated field", "loaded\ninactive\ninactive\n", 0],
    ["an unknown load state", "unknown\ninactive\n", 0],
  ])("fails closed for %s", async (_name, showOutput, showStatus) => {
    const result = await runSystemctlFunction("require_inactive_service", {
      showOutput,
      showStatus,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /Unable to determine|Run "systemctl stop cowikiharness-gateway.service"/u,
    );
  });

  it("reports a failed cleanup stop", async () => {
    const result = await runSystemctlFunction("cleanup_gateway_service_after_failure", {
      showOutput: "loaded\ninactive\n",
      stopStatus: 1,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Failed to stop cowikiharness-gateway.service during failed installation cleanup.",
    );
  });

  it("fails closed when cleanup leaves the service active", async () => {
    const result = await runSystemctlFunction("cleanup_gateway_service_after_failure", {
      showOutput: "loaded\nactive\n",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "cowikiharness-gateway.service did not reach a stopped state after failed installation cleanup.",
    );
  });

  it("keeps the shell safety preflight aligned with trimmed deployment keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cowikiharness-shell-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "gateway.env");
    await writeFile(
      configPath,
      [
        " OPENLIFEWIKI_TOKEN_HMAC_SECRET =0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        " OPENLIFEWIKI_BIND_HOST =127.0.0.1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; validate_config_safety "$2"',
        "bash",
        installerPath,
        configPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });
});

function validateIdentity(
  passwdEntries: string,
  groupEntries: string,
  userGroups: string,
) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; validate_identity_records "$2" "$3" "$4"',
      "bash",
      installerPath,
      passwdEntries,
      groupEntries,
      userGroups,
    ],
    { encoding: "utf8" },
  );
}

async function runSystemctlFunction(
  functionName: "require_inactive_service" | "cleanup_gateway_service_after_failure",
  options: { showOutput: string; showStatus?: number; stopStatus?: number },
) {
  const stubDirectory = await mkdtemp(join(tmpdir(), "cowikiharness-systemctl-"));
  temporaryDirectories.push(stubDirectory);
  await writeFile(
    join(stubDirectory, "systemctl"),
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      "  show)",
      "    printf '%b' " + JSON.stringify(options.showOutput),
      "    exit " + String(options.showStatus ?? 0),
      "    ;;",
      "  stop)",
      "    exit " + String(options.stopStatus ?? 0),
      "    ;;",
      "  *)",
      "    exit 0",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return spawnSync(
    "bash",
    ["-c", 'source "$1"; "$2"', "bash", installerPath, functionName],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: stubDirectory + ":" + (process.env.PATH ?? ""),
      },
    },
  );
}
