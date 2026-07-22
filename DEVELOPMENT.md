# Development

## Start Here

Read `CONSTITUTION.md`, `docs/memory-bank/active-context.md`, the linked requirement and the active design before editing.

## Bootstrap

```bash
./scripts/bootstrap_dev_env.sh
```

The script checks Node and pnpm, installs repository development dependencies and runs the full verification suite. It does not initialize personal openLifeWiki data.

## Commands

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm verify
pnpm openlifewiki lifecycle --json
pnpm openlifewiki init --dry-run --json
pnpm openlifewiki activate --dry-run --json
```

Use temporary `OPENLIFEWIKI_HOME` and `OPENLIFEWIKI_WORKSPACE` values when testing initialization or activation manually. Both are required so tests cannot touch the default user workspace.

## Definition Of Done

- Behavior is linked to an active design and requirement.
- External projects are installed from a pinned official release and called through public surfaces.
- Every write has a dry-run or explicit approval boundary.
- Tests cover success, idempotency and failure without publishing partial durable state.
- `pnpm verify` and `git diff --check` pass.
- `docs/memory-bank/active-context.md` and the governance changelog are current.
