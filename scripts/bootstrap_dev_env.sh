#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

expected_node="$(cat .node-version)"
actual_node="$(node --version | sed 's/^v//')"
if [[ "$actual_node" != "$expected_node" ]]; then
  printf 'Expected Node.js %s, found %s\n' "$expected_node" "$actual_node" >&2
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
