#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="${COWIKIHARNESS_CONFIG:-$HOME/Library/Application Support/CoWikiHarness/config.env}"
node_bin="${COWIKIHARNESS_NODE:-/opt/homebrew/opt/node@24/bin/node}"

if [[ ! -r "$config_path" ]]; then
  printf 'CoWikiHarness config is not readable: %s\n' "$config_path" >&2
  exit 1
fi

if [[ ! -x "$node_bin" ]]; then
  printf 'Node.js 24 is not executable: %s\n' "$node_bin" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$config_path"
set +a

exec "$node_bin" "$repo_root/apps/knowledge-server/dist/main.js"
