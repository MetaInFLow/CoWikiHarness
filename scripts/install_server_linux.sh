#!/usr/bin/env bash
set -euo pipefail

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s. Install it and rerun.\n' "$command_name" >&2
    return 1
  fi
}

config_validation_error() {
  printf 'Invalid gateway configuration: %s\n' "$1" >&2
  return 1
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
    return 1
  fi

  value="$(awk -v key="$key" '
    {
      separator = index($0, "=")
      if (separator == 0) next
      name = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+/, "", name)
      gsub(/[[:space:]]+$/, "", name)
      if (name == key) {
        print substr($0, separator + 1)
        exit
      }
    }
  ' "$config_file")"
  if [[ -z "$value" ]]; then
    config_validation_error "$key must not be empty."
    return 1
  fi
  printf '%s' "$value"
}

validate_config_safety() {
  local config_file="$1"
  local sentinel
  local hmac_secret
  local bind_host

  if [[ ! -r "$config_file" ]]; then
    config_validation_error "provide a readable env file and rerun."
    return 1
  fi
  for sentinel in \
    replace-database-password \
    replace-with-at-least-32-random-bytes \
    replace-with-provider-key \
    knowledge.example.com; do
    if grep -Fq "$sentinel" "$config_file"; then
      config_validation_error "replace all template placeholder values before installation."
      return 1
    fi
  done

  hmac_secret="$(required_config_value "$config_file" "OPENLIFEWIKI_TOKEN_HMAC_SECRET")"
  bind_host="$(required_config_value "$config_file" "OPENLIFEWIKI_BIND_HOST")"
  if [[ ! "$hmac_secret" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    config_validation_error \
      "OPENLIFEWIKI_TOKEN_HMAC_SECRET must be exactly 64 hexadecimal characters."
    return 1
  fi
  if [[ "$bind_host" != "127.0.0.1" ]]; then
    config_validation_error "OPENLIFEWIKI_BIND_HOST must be exactly 127.0.0.1."
    return 1
  fi
}

identity_error() {
  printf '%s\n' "$1" >&2
  return 1
}

validate_identity_records() {
  local passwd_entries="$1"
  local group_entries="$2"
  local user_groups="$3"
  local group_count
  local group_entry
  local group_gid
  local group_members
  local user_count
  local user_entry
  local user_uid
  local user_gid
  local user_home
  local user_shell
  local conflict_count

  identity_group_exists=false
  identity_user_exists=false
  group_count="$(printf '%s\n' "$group_entries" | awk -F: '$1 == "cowikiharness" { count++ } END { print count + 0 }')"
  if [[ "$group_count" -gt 1 ]]; then
    identity_error "Existing cowikiharness GID is shared."
    return 1
  fi
  if [[ "$group_count" -eq 1 ]]; then
    identity_group_exists=true
    group_entry="$(printf '%s\n' "$group_entries" | awk -F: '$1 == "cowikiharness" { print; exit }')"
    IFS=: read -r _ _ group_gid group_members <<< "$group_entry"
    if [[ ! "$group_gid" =~ ^[0-9]+$ ]]; then
      identity_error "Existing cowikiharness group is not the required dedicated identity."
      return 1
    fi
    if [[ "$group_gid" == "0" ]]; then
      identity_error "Existing cowikiharness group has forbidden GID 0."
      return 1
    fi
    if [[ -n "$group_members" ]]; then
      identity_error "Existing cowikiharness group is not dedicated."
      return 1
    fi

    conflict_count="$(printf '%s\n' "$group_entries" | awk -F: -v gid="$group_gid" '
      $3 == gid && $1 != "cowikiharness" { count++ }
      END { print count + 0 }
    ')"
    if [[ "$conflict_count" -ne 0 ]]; then
      identity_error "Existing cowikiharness GID is shared."
      return 1
    fi
    conflict_count="$(printf '%s\n' "$passwd_entries" | awk -F: -v gid="$group_gid" '
      $4 == gid && $1 != "cowikiharness" { count++ }
      END { print count + 0 }
    ')"
    if [[ "$conflict_count" -ne 0 ]]; then
      identity_error "Existing cowikiharness group is a primary group for another user."
      return 1
    fi
  fi

  user_count="$(printf '%s\n' "$passwd_entries" | awk -F: '$1 == "cowikiharness" { count++ } END { print count + 0 }')"
  if [[ "$user_count" -gt 1 ]]; then
    identity_error "Existing cowikiharness UID is shared."
    return 1
  fi
  if [[ "$user_count" -eq 1 ]]; then
    identity_user_exists=true
    user_entry="$(printf '%s\n' "$passwd_entries" | awk -F: '$1 == "cowikiharness" { print; exit }')"
    IFS=: read -r _ _ user_uid user_gid _ user_home user_shell <<< "$user_entry"
    if [[ ! "$user_uid" =~ ^[0-9]+$ || ! "$user_gid" =~ ^[0-9]+$ ]]; then
      identity_error "Existing cowikiharness user is not the required dedicated identity."
      return 1
    fi
    if [[ "$user_uid" == "0" ]]; then
      identity_error "Existing cowikiharness user has forbidden UID 0."
      return 1
    fi
    if [[ "$identity_group_exists" != "true" || "$user_gid" != "$group_gid" || \
      "$user_home" != "/var/lib/cowikiharness" || \
      "$user_shell" != "/usr/sbin/nologin" || \
      "$user_groups" != "cowikiharness" ]]; then
      identity_error "Existing cowikiharness user is not the required dedicated identity."
      return 1
    fi
    conflict_count="$(printf '%s\n' "$passwd_entries" | awk -F: -v uid="$user_uid" '
      $3 == uid && $1 != "cowikiharness" { count++ }
      END { print count + 0 }
    ')"
    if [[ "$conflict_count" -ne 0 ]]; then
      identity_error "Existing cowikiharness UID is shared."
      return 1
    fi
  fi
}

load_and_validate_identity() {
  local passwd_entries
  local group_entries
  local user_groups=""

  if ! passwd_entries="$(getent passwd)"; then
    identity_error "Identity database query failed. Verify NSS/getent and rerun."
    return 1
  fi
  if ! group_entries="$(getent group)"; then
    identity_error "Identity database query failed. Verify NSS/getent and rerun."
    return 1
  fi
  if printf '%s\n' "$passwd_entries" | awk -F: '$1 == "cowikiharness" { found = 1 } END { exit !found }'; then
    if ! user_groups="$(id -nG cowikiharness)"; then
      identity_error "Identity database query failed. Verify NSS/getent and rerun."
      return 1
    fi
  fi
  validate_identity_records "$passwd_entries" "$group_entries" "$user_groups"
}

read_gateway_service_state() {
  systemctl show --property=LoadState --property=ActiveState --value cowikiharness-gateway.service \
    2>/dev/null
}

gateway_service_is_stopped() {
  local service_state_output="$1"

  case "$service_state_output" in
    $'not-found\ninactive' | $'loaded\ninactive' | $'loaded\nfailed')
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_inactive_service() {
  local service_state_output

  if ! service_state_output="$(read_gateway_service_state)"; then
    printf 'Unable to determine cowikiharness-gateway.service LoadState and ActiveState. Verify systemd and rerun.\n' >&2
    return 1
  fi
  if ! gateway_service_is_stopped "$service_state_output"; then
    printf 'cowikiharness-gateway.service is not safely stopped. Run "systemctl stop cowikiharness-gateway.service" before installation or upgrade.\n' >&2
    return 1
  fi
}

cleanup_gateway_service_after_failure() {
  local service_state_output
  local stop_failed=false

  if ! systemctl stop cowikiharness-gateway.service; then
    printf 'Failed to stop cowikiharness-gateway.service during failed installation cleanup.\n' >&2
    stop_failed=true
  fi
  if ! service_state_output="$(read_gateway_service_state)"; then
    printf 'Unable to determine cowikiharness-gateway.service state after failed installation cleanup.\n' >&2
    return 1
  fi
  if ! gateway_service_is_stopped "$service_state_output"; then
    printf 'cowikiharness-gateway.service did not reach a stopped state after failed installation cleanup.\n' >&2
    return 1
  fi
  if [[ "$stop_failed" == "true" ]]; then
    return 1
  fi
}

validate_service_path() {
  local label="$1"
  local path="$2"

  if [[ "$path" != /* || "$path" =~ [^A-Za-z0-9_./+-] ]]; then
    printf 'Expected %s to be an absolute systemd-safe path, found %s\n' "$label" "$path" >&2
    return 1
  fi
  case "$path/" in
    /home/* | /root/* | /run/user/*)
      printf 'Expected %s outside paths hidden by ProtectHome=true, found %s\n' "$label" "$path" >&2
      return 1
      ;;
  esac
}

main() {
  local repo_root
  local config_path="/etc/cowikiharness/gateway.env"
  local config_source="${COWIKIHARNESS_CONFIG_SOURCE:-}"
  local config_candidate
  local unit_template
  local unit_path="/etc/systemd/system/cowikiharness-gateway.service"
  local node_bin
  local actual_node
  local pnpm_bin
  local actual_pnpm
  local command_name
  local escaped_repo
  local escaped_node
  local unit_tmp
  local health_url="http://127.0.0.1:8080/healthz"
  local health_ok=false
  local health_body
  local attempt

  if (( $# != 0 )); then
    printf 'Usage: %s\n' "$0" >&2
    return 64
  fi
  if [[ "$(uname -s)" != "Linux" ]]; then
    printf 'Expected Linux, found %s\n' "$(uname -s)" >&2
    return 1
  fi
  if (( EUID != 0 )); then
    printf 'Expected root privileges. Re-run this installer with sudo.\n' >&2
    return 1
  fi

  require_command systemctl
  if ! systemctl show-environment >/dev/null 2>&1; then
    printf 'Expected systemd to be the active service manager. Boot this host with systemd and rerun.\n' >&2
    return 1
  fi
  require_inactive_service

  for command_name in \
    awk chmod chown curl dirname getent grep groupadd id install journalctl mktemp \
    readlink rm sed sleep useradd; do
    require_command "$command_name"
  done

  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  unit_template="$repo_root/deploy/linux/cowikiharness-gateway.service.template"
  node_bin="${COWIKIHARNESS_NODE:-}"
  if [[ -z "$node_bin" ]]; then
    node_bin="$(command -v node || true)"
  elif [[ "$node_bin" != */* ]]; then
    node_bin="$(command -v "$node_bin" || true)"
  fi
  if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    printf 'Expected Node.js >=24.16.0 <25, found no executable\n' >&2
    return 1
  fi
  node_bin="$(readlink -f "$node_bin")"

  actual_node="$("$node_bin" --version | sed 's/^v//')"
  if ! "$node_bin" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major === 24 && minor >= 16 ? 0 : 1);
  '; then
    printf 'Expected Node.js >=24.16.0 <25, found %s\n' "$actual_node" >&2
    return 1
  fi

  pnpm_bin="${COWIKIHARNESS_PNPM:-}"
  if [[ -z "$pnpm_bin" ]]; then
    pnpm_bin="$(command -v pnpm || true)"
  elif [[ "$pnpm_bin" != */* ]]; then
    pnpm_bin="$(command -v "$pnpm_bin" || true)"
  fi
  if [[ -z "$pnpm_bin" || ! -x "$pnpm_bin" ]]; then
    printf 'Expected pnpm 10.33.2, found no executable\n' >&2
    return 1
  fi
  actual_pnpm="$("$pnpm_bin" --version)"
  if [[ "$actual_pnpm" != "10.33.2" ]]; then
    printf 'Expected pnpm 10.33.2, found %s\n' "$actual_pnpm" >&2
    return 1
  fi

  validate_service_path "repository" "$repo_root"
  validate_service_path "Node.js executable" "$node_bin"

  config_candidate="$config_path"
  if [[ -n "$config_source" ]]; then
    config_candidate="$config_source"
  fi
  if [[ ! -r "$config_candidate" ]]; then
    printf 'Expected a readable gateway configuration. Create %s from %s/deploy/linux/gateway.env.example, replace every placeholder, and rerun; or set COWIKIHARNESS_CONFIG_SOURCE.\n' \
      "$config_path" "$repo_root" >&2
    return 1
  fi
  validate_config_safety "$config_candidate"

  cd "$repo_root"
  "$pnpm_bin" install --frozen-lockfile
  "$pnpm_bin" --filter "@openlifewiki/knowledge-server..." build
  "$node_bin" "$repo_root/apps/knowledge-server/dist/deployment-config.js" "$config_candidate"

  load_and_validate_identity
  if [[ "$identity_group_exists" != "true" ]]; then
    groupadd --system cowikiharness
  fi
  if [[ "$identity_user_exists" != "true" ]]; then
    useradd --system \
      --gid cowikiharness \
      --home-dir /var/lib/cowikiharness \
      --shell /usr/sbin/nologin \
      cowikiharness
  fi
  load_and_validate_identity
  if [[ "$identity_group_exists" != "true" || "$identity_user_exists" != "true" ]]; then
    identity_error "cowikiharness identity could not be verified after creation. Verify NSS propagation and rerun."
    return 1
  fi

  install -d -o root -g cowikiharness -m 0750 /etc/cowikiharness
  install -d -o cowikiharness -g cowikiharness -m 0750 /var/lib/cowikiharness
  if [[ -n "$config_source" && "$config_source" != "$config_path" ]]; then
    install -o root -g cowikiharness -m 0640 "$config_source" "$config_path"
  fi
  chown root:cowikiharness "$config_path"
  chmod 0640 "$config_path"
  "$node_bin" "$repo_root/apps/knowledge-server/dist/deployment-config.js" "$config_path"

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
  if ! systemctl enable --now cowikiharness-gateway.service; then
    if ! cleanup_gateway_service_after_failure; then
      printf 'Gateway cleanup could not be verified after startup failed.\n' >&2
    fi
    printf 'Gateway service failed to enable or start.\n' >&2
    printf 'Diagnose: systemctl status cowikiharness-gateway.service\n' >&2
    printf 'Diagnose: journalctl -u cowikiharness-gateway.service --no-pager -n 100\n' >&2
    return 1
  fi

  for ((attempt = 1; attempt <= 10; attempt++)); do
    health_body=""
    if systemctl is-active --quiet cowikiharness-gateway.service; then
      health_body="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 "$health_url" \
        2>/dev/null || true)"
      if [[ "$health_body" == '{"status":"ready"}' ]]; then
        health_ok=true
        break
      fi
    fi
    if (( attempt < 10 )); then
      sleep 1
    fi
  done

  if [[ "$health_ok" != "true" ]]; then
    if ! cleanup_gateway_service_after_failure; then
      printf 'Gateway cleanup could not be verified after health check failure.\n' >&2
    fi
    printf 'Gateway health check failed at %s.\n' "$health_url" >&2
    printf 'Diagnose: systemctl status cowikiharness-gateway.service\n' >&2
    printf 'Diagnose: journalctl -u cowikiharness-gateway.service --no-pager -n 100\n' >&2
    return 1
  fi

  printf 'CoWikiHarness Knowledge Gateway installed and started.\n'
  printf 'Status: systemctl status cowikiharness-gateway.service\n'
  printf 'Loopback health check passed: %s\n' "$health_url"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
