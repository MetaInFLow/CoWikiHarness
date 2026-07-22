#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

actual_node="$(node --version | sed 's/^v//')"
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major === 24 && minor >= 16 ? 0 : 1);
'; then
  printf 'Expected Node.js >=24.16.0 <25, found %s\n' "$actual_node" >&2
  exit 1
fi

expected_pnpm="10.33.2"
actual_pnpm="$(pnpm --version)"
if [[ "$actual_pnpm" != "$expected_pnpm" ]]; then
  printf 'Expected pnpm %s, found %s\n' "$expected_pnpm" "$actual_pnpm" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm verify
