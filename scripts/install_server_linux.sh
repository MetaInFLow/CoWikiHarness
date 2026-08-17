#!/usr/bin/env bash
set -euo pipefail

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s. Install it and rerun.\n' "$command_name" >&2
    exit 1
  fi
}

config_validation_error() {
  printf 'Invalid gateway configuration: %s\n' "$1" >&2
  exit 1
}

required_config_value() {
  local config_file="$1"
  local key="$2"
  local count
  local value

  count="$(awk -F= -v key="$key" '
    {
      name = $1
      gsub(/^[[:space:]]+/, "", name)
      gsub(/[[:space:]]+$/, "", name)
      if (name == key) count++
    }
    END { print count + 0 }
  ' "$config_file")"
  if [[ "$count" != "1" ]]; then
    config_validation_error "expected exactly one $key entry."
  fi

  value="$(awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2) }' "$config_file")"
  if [[ -z "$value" ]]; then
    config_validation_error "$key must not be empty."
  fi
  printf '%s' "$value"
}

validate_config() {
  local config_file="$1"
  local sentinel
  local hmac_secret
  local bind_host
  local public_url

  require_command awk
  require_command grep
  if [[ ! -r "$config_file" ]]; then
    config_validation_error "provide a readable env file and rerun."
  fi

  for sentinel in \
    replace-database-password \
    replace-with-at-least-32-random-bytes \
    replace-with-provider-key \
    knowledge.example.com; do
    if grep -Fq "$sentinel" "$config_file"; then
      config_validation_error "replace all template placeholder values before installation."
    fi
  done

  required_config_value "$config_file" "DATABASE_URL" >/dev/null
  hmac_secret="$(required_config_value "$config_file" "OPENLIFEWIKI_TOKEN_HMAC_SECRET")"
  required_config_value "$config_file" "OPENAI_API_KEY" >/dev/null
  bind_host="$(required_config_value "$config_file" "OPENLIFEWIKI_BIND_HOST")"
  public_url="$(required_config_value "$config_file" "OPENLIFEWIKI_PUBLIC_URL")"

  if [[ ! "$hmac_secret" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    config_validation_error \
      "OPENLIFEWIKI_TOKEN_HMAC_SECRET must be exactly 64 hexadecimal characters."
  fi
  if [[ "$bind_host" != "127.0.0.1" ]]; then
    config_validation_error "OPENLIFEWIKI_BIND_HOST must be exactly 127.0.0.1."
  fi
  if [[ ! "$public_url" =~ ^https://[^[:space:]]+$ ]]; then
    config_validation_error "OPENLIFEWIKI_PUBLIC_URL must be a non-example HTTPS URL."
  fi
}

if [[ "${1:-}" == "validate-config" ]]; then
  if (( $# != 2 )); then
    printf 'Usage: %s validate-config <gateway.env>\n' "$0" >&2
    exit 64
  fi
  validate_config "$2"
  printf 'Gateway configuration is valid.\n'
  exit 0
fi

if (( $# != 0 )); then
  printf 'Usage: %s [validate-config <gateway.env>]\n' "$0" >&2
  exit 64
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Expected Linux, found %s\n' "$(uname -s)" >&2
  exit 1
fi

if (( EUID != 0 )); then
  printf 'Expected root privileges. Re-run this installer with sudo.\n' >&2
  exit 1
fi

require_command systemctl
if ! systemctl show-environment >/dev/null 2>&1; then
  printf 'Expected systemd to be the active service manager. Boot this host with systemd and rerun.\n' >&2
  exit 1
fi
if systemctl is-active --quiet cowikiharness-gateway.service; then
  printf 'cowikiharness-gateway.service is active. Run "systemctl stop cowikiharness-gateway.service" before installation or upgrade.\n' >&2
  exit 1
fi

for command_name in \
  awk chmod chown curl dirname getent grep groupadd id install journalctl mktemp \
  readlink rm sed sleep useradd; do
  require_command "$command_name"
done

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

config_candidate="$config_path"
if [[ -n "$config_source" ]]; then
  config_candidate="$config_source"
fi
if [[ ! -r "$config_candidate" ]]; then
  printf 'Expected a readable gateway configuration. Create %s from %s/deploy/linux/gateway.env.example, replace every placeholder, and rerun; or set COWIKIHARNESS_CONFIG_SOURCE.\n' \
    "$config_path" "$repo_root" >&2
  exit 1
fi
validate_config "$config_candidate"

group_exists=false
group_gid=""
group_entry="$(getent group cowikiharness || true)"
if [[ -n "$group_entry" ]]; then
  group_exists=true
  IFS=: read -r _ _ group_gid existing_group_members <<< "$group_entry"
  if [[ -n "$existing_group_members" ]]; then
    printf 'Existing cowikiharness group is not dedicated. Remove all explicit group members and rerun.\n' >&2
    exit 1
  fi
fi

user_exists=false
user_entry="$(getent passwd cowikiharness || true)"
if [[ -n "$user_entry" ]]; then
  user_exists=true
  IFS=: read -r _ _ _ user_gid _ user_home user_shell <<< "$user_entry"
  user_groups="$(id -nG cowikiharness 2>/dev/null || true)"
  if [[ "$group_exists" != "true" || "$user_gid" != "$group_gid" || \
    "$user_home" != "/var/lib/cowikiharness" || \
    "$user_shell" != "/usr/sbin/nologin" || \
    "$user_groups" != "cowikiharness" ]]; then
    printf 'Existing cowikiharness user is not the required dedicated identity. Set primary group cowikiharness, home /var/lib/cowikiharness, shell /usr/sbin/nologin, remove supplementary groups, and rerun.\n' >&2
    exit 1
  fi
fi

if [[ "$group_exists" != "true" ]]; then
  groupadd --system cowikiharness
fi
if [[ "$user_exists" != "true" ]]; then
  useradd --system \
    --gid cowikiharness \
    --home-dir /var/lib/cowikiharness \
    --shell /usr/sbin/nologin \
    cowikiharness
fi

install -d -o root -g cowikiharness -m 0750 /etc/cowikiharness
install -d -o cowikiharness -g cowikiharness -m 0750 /var/lib/cowikiharness

if [[ -n "$config_source" && "$config_source" != "$config_path" ]]; then
  install -o root -g cowikiharness -m 0640 "$config_source" "$config_path"
fi
chown root:cowikiharness "$config_path"
chmod 0640 "$config_path"
validate_config "$config_path"

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

health_url="http://127.0.0.1:8080/healthz"
health_ok=false
for ((attempt = 1; attempt <= 10; attempt++)); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$health_url" \
    >/dev/null; then
    health_ok=true
    break
  fi
  if (( attempt < 10 )); then
    sleep 1
  fi
done

if [[ "$health_ok" != "true" ]]; then
  printf 'Gateway health check failed at %s.\n' "$health_url" >&2
  printf 'Diagnose: systemctl status cowikiharness-gateway.service\n' >&2
  printf 'Diagnose: journalctl -u cowikiharness-gateway.service --no-pager -n 100\n' >&2
  exit 1
fi

printf 'CoWikiHarness Knowledge Gateway installed and started.\n'
printf 'Status: systemctl status cowikiharness-gateway.service\n'
printf 'Loopback health check passed: %s\n' "$health_url"
