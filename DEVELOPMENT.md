# Development

## Start Here

编辑前先阅读 `CONSTITUTION.md`、`docs/product/core-red-lines.md`、`docs/memory-bank/active-context.md`、适用的 V2 或 V1 需求、已接受 ADR、架构、活动设计和交付计划。遵循 `docs/README.md` 中的权威顺序。

云端和多人工作以 V2 需求为准；保留的本地链路以 V1 为准。v0.2 需求及 v0.2/v0.3 设计是已完成的 P0 回归参考。

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
pnpm test:postgres
pnpm verify:cloud
pnpm openlifewiki lifecycle --json
pnpm openlifewiki init --dry-run --json
pnpm openlifewiki activate --dry-run --json
```

Use temporary `OPENLIFEWIKI_HOME` and `OPENLIFEWIKI_WORKSPACE` values for initialization, Connector, scan, proposal and publication tests. Both values are required so tests cannot touch the default user workspace or personal Sources.

Cloud bootstrap and migration commands additionally require `DATABASE_URL` and `OPENLIFEWIKI_TOKEN_HMAC_SECRET`; they do not require `OPENLIFEWIKI_MODEL`.

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
