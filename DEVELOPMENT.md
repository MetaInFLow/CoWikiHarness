# Development

## Start Here

Read `CONSTITUTION.md`, `docs/product/core-red-lines.md`, `docs/memory-bank/active-context.md`, the applicable V2 or V1 requirement, accepted ADRs, architecture, active design and delivery plan before editing. Follow the authority order in `docs/README.md`.

The V2 requirement governs cloud/multi-user work. V1 governs the retained local path. The v0.2 requirement and v0.2/v0.3 designs are completed P0 regression references.

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

## V1 Core Merge And Completion Gate

A V1 implementation branch can merge only when every applicable Core task exit/review gate passes and the Core Owner UAT record is current. V1 Core completion requires:

- `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` pass against one candidate/runtime;
- required four-Source Live Connector, native Codex, core recovery, desktop/mobile and direct Obsidian evidence;
- zero Critical findings and zero Important findings;
- no Core-required `fail`, `blocked` or `not-run` result.

Mock-only, component-only, page-open and `ACTIVE` results remain intermediate evidence. The fixed 17/35/11 catalog, external signatures, six-Agent live equivalence and fixed-scale run belong to Release Certification after Core acceptance.
