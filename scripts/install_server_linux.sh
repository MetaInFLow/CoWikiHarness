#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Expected Linux, found %s\n' "$(uname -s)" >&2
  exit 1
fi

if (( EUID != 0 )); then
  printf 'Expected root privileges. Re-run this installer with sudo.\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="/etc/cowikiharness/gateway.env"
config_source="${COWIKIHARNESS_CONFIG_SOURCE:-}"
unit_template="$repo_root/deploy/linux/cowikiharness-gateway.service.template"
unit_path="/etc/systemd/system/cowikiharness-gateway.service"

node_bin="${COWIKIHARNESS_NODE:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
elif [[ "$node_bin" != */* ]]; then
  node_bin="$(command -v "$node_bin" || true)"
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  printf 'Expected Node.js >=24.16.0 <25, found no executable\n' >&2
  exit 1
fi
node_bin="$(readlink -f "$node_bin")"

actual_node="$("$node_bin" --version | sed 's/^v//')"
if ! "$node_bin" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major === 24 && minor >= 16 ? 0 : 1);
'; then
  printf 'Expected Node.js >=24.16.0 <25, found %s\n' "$actual_node" >&2
  exit 1
fi

pnpm_bin="${COWIKIHARNESS_PNPM:-}"
if [[ -z "$pnpm_bin" ]]; then
  pnpm_bin="$(command -v pnpm || true)"
elif [[ "$pnpm_bin" != */* ]]; then
  pnpm_bin="$(command -v "$pnpm_bin" || true)"
fi
if [[ -z "$pnpm_bin" || ! -x "$pnpm_bin" ]]; then
  printf 'Expected pnpm 10.33.2, found no executable\n' >&2
  exit 1
fi

actual_pnpm="$("$pnpm_bin" --version)"
if [[ "$actual_pnpm" != "10.33.2" ]]; then
  printf 'Expected pnpm 10.33.2, found %s\n' "$actual_pnpm" >&2
  exit 1
fi

validate_service_path() {
  local label="$1"
  local path="$2"

  if [[ "$path" != /* || "$path" =~ [^A-Za-z0-9_./+-] ]]; then
    printf 'Expected %s to be an absolute systemd-safe path, found %s\n' "$label" "$path" >&2
    exit 1
  fi
  case "$path/" in
    /home/* | /root/* | /run/user/*)
      printf 'Expected %s outside paths hidden by ProtectHome=true, found %s\n' "$label" "$path" >&2
      exit 1
      ;;
  esac
}

validate_service_path "repository" "$repo_root"
validate_service_path "Node.js executable" "$node_bin"

if ! getent group cowikiharness >/dev/null; then
  groupadd --system cowikiharness
fi
if ! id -u cowikiharness >/dev/null 2>&1; then
  useradd --system \
    --gid cowikiharness \
    --home-dir /var/lib/cowikiharness \
    --shell /usr/sbin/nologin \
    cowikiharness
fi

install -d -o root -g cowikiharness -m 0750 /etc/cowikiharness
install -d -o cowikiharness -g cowikiharness -m 0750 /var/lib/cowikiharness

config_error() {
  printf 'Expected readable configuration at %s. Create it from %s/deploy/linux/gateway.env.example or set COWIKIHARNESS_CONFIG_SOURCE.\n' \
    "$config_path" "$repo_root" >&2
  exit 1
}

if [[ -n "$config_source" ]]; then
  [[ -r "$config_source" ]] || config_error
  install -o root -g cowikiharness -m 0640 "$config_source" "$config_path"
fi
[[ -r "$config_path" ]] || config_error
chown root:cowikiharness "$config_path"
chmod 0640 "$config_path"

cd "$repo_root"
"$pnpm_bin" install --frozen-lockfile
"$pnpm_bin" --filter "@openlifewiki/knowledge-server..." build

escaped_repo="$(printf '%s' "$repo_root" | sed 's/[&|\\]/\\&/g')"
escaped_node="$(printf '%s' "$node_bin" | sed 's/[&|\\]/\\&/g')"
unit_tmp="$(mktemp)"
trap 'rm -f "$unit_tmp"' EXIT
sed \
  -e "s|__REPO_ROOT__|$escaped_repo|g" \
  -e "s|__NODE_BIN__|$escaped_node|g" \
  "$unit_template" > "$unit_tmp"
install -o root -g root -m 0644 "$unit_tmp" "$unit_path"

systemctl daemon-reload
systemctl enable --now cowikiharness-gateway.service

printf 'CoWikiHarness Knowledge Gateway installed and started.\n'
printf 'Status: systemctl status cowikiharness-gateway.service\n'
printf 'Loopback health check: curl --fail http://127.0.0.1:8080/healthz\n'
