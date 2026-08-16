#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_support="${COWIKIHARNESS_HOME:-$HOME/Library/Application Support/CoWikiHarness}"
config_path="${COWIKIHARNESS_CONFIG:-$app_support/config.env}"
template="$repo_root/deploy/macos/com.metainflow.cowikiharness.knowledge-server.plist.template"
target="$HOME/Library/LaunchAgents/com.metainflow.cowikiharness.knowledge-server.plist"
label="com.metainflow.cowikiharness.knowledge-server"
domain="gui/$(id -u)"
client_link="$HOME/.local/bin/cowiki"
skill_link="$HOME/.codex/skills/cowikiharness"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

if [[ ! -r "$config_path" ]]; then
  printf '请先填写配置文件：%s\n' "$config_path" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$config_path"
set +a

cd "$repo_root"
pnpm install --frozen-lockfile
pnpm --filter @openlifewiki/knowledge-server build

mkdir -p "$app_support/logs" "$HOME/Library/LaunchAgents" "$HOME/.local/bin" "$HOME/.codex/skills"
escaped_repo="$(printf '%s' "$repo_root" | sed 's/[&|\\]/\\&/g')"
escaped_support="$(printf '%s' "$app_support" | sed 's/[&|\\]/\\&/g')"
sed -e "s|__REPO_ROOT__|$escaped_repo|g" -e "s|__APP_SUPPORT__|$escaped_support|g" "$template" > "$target"
plutil -lint "$target" >/dev/null
chmod +x "$repo_root/scripts/run_knowledge_server.sh" "$repo_root/scripts/cowiki"

for path in "$client_link" "$skill_link"; do
  if [[ -e "$path" && ! -L "$path" ]]; then
    printf '安装目标已存在且不是符号链接：%s\n' "$path" >&2
    exit 1
  fi
done
ln -sfn "$repo_root/scripts/cowiki" "$client_link"
ln -sfn "$repo_root/skills/cowikiharness" "$skill_link"

launchctl bootout "$domain/$label" 2>/dev/null || true
bootstrapped=false
for _attempt in {1..10}; do
  if launchctl bootstrap "$domain" "$target" 2>/dev/null; then
    bootstrapped=true
    break
  fi
  sleep 0.2
done
if [[ "$bootstrapped" != "true" ]]; then
  printf '无法注册 CoWikiHarness macOS 常驻服务。\n' >&2
  exit 1
fi
launchctl kickstart -k "$domain/$label"

printf 'CoWikiHarness 已安装并启动。\n'
printf '健康检查：%s/healthz\n' "${OPENLIFEWIKI_PUBLIC_URL:-http://127.0.0.1:8080}"
printf 'Codex 命令：cowiki ask "你的问题"\n'
