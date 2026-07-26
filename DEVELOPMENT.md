# Development

## Start Here

Read `CONSTITUTION.md`, `docs/product/core-red-lines.md`, `docs/memory-bank/active-context.md`, the canonical V1 requirement/lifecycle, accepted ADRs, architecture, active V1 design and delivery plan before editing. Follow the authority order in `docs/README.md`.

The v0.2 requirement and v0.2/v0.3 designs are completed P0 regression references. They do not authorize V1 behavior.

## Bootstrap

```bash
./scripts/bootstrap_dev_env.sh
```

The script checks Node and pnpm, installs repository development dependencies and runs the current verification suite. It does not initialize personal openLifeWiki data.

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

Use temporary `OPENLIFEWIKI_HOME` and `OPENLIFEWIKI_WORKSPACE` values for initialization, Connector, scan, proposal and publication tests. Both values are required so tests cannot touch the default user workspace or personal Sources.

## Change Gate

- Start each delivery task with its named failing test and keep predecessor contracts green.
- Install external projects from pinned official releases or invoke an existing authenticated executable through a frozen public interface.
- Keep authorization and credential redaction tests adjacent to every Connector or Agent driver.
- Give every mutation a preview/hash approval boundary and an executable failure/recovery test.
- Run the task's exact verification commands from the V1 delivery plan, then `pnpm verify` and `git diff --check`.
- Update active context and the governance changelog when authority, implemented capability or a gate changes.

## V1 Merge And Completion Gate

A V1 implementation branch can merge only when every applicable task exit/review gate passes and the canonical acceptance manifest is current. V1 completion additionally requires:

- 17/17 benchmark journeys, 35/35 executable contracts and 11/11 acceptance validations recorded as `pass` using each validation's declared automated or human mode;
- required Live Connector, recovery, desktop/mobile and direct Obsidian evidence;
- zero Critical findings and zero Important findings;
- no required `fail`, `blocked` or `not-run` result;
- a successful real Owner Full Journey on the target machine.

Smoke, mock-only, component-only, page-open and `ACTIVE` results remain intermediate evidence.
