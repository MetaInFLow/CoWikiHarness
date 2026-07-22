# Design: Lifecycle And Initialization Baseline v0.1

- Status: active
- Requirement: `docs/requirements/requirements-v0.1.md`
- Decision: `docs/decisions/ADR-0001-release-install-and-public-invocation.md`

## Goal

Produce a development baseline where every lifecycle stage is inspectable and initialization can safely install only the P0 dependency after a dry-run and explicit approval.

## Scope

- stable lifecycle and component contracts;
- `lifecycle`, `status`, `init` and `doctor` CLI commands;
- isolated QMD npm release installation;
- atomic local state receipt;
- Install Skill and Stage 4 governance files;
- tests for dry-run, success, idempotency and failure state.

## Non-goals

- Source indexing, MCP implementation, Codex invocation and Wiki behavior;
- GUI, background daemon and packaged openLifeWiki release;
- optional component installation.

## Command Contract

```text
openlifewiki lifecycle --json
openlifewiki status --json
openlifewiki init --dry-run --json
openlifewiki init --yes --json
openlifewiki doctor --json
```

All commands emit one JSON object. `init --dry-run` performs no writes. `init --yes` is the only initialization form that may write or access the npm registry.

## State Commit

Initialization writes directories and installs QMD first. It probes the installed executable and then atomically writes `state.json` with `INITIALIZED`. Any earlier failure leaves the stable state at `INSTALLED`.

## File Map

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | stable JSON types |
| `packages/core` | lifecycle and component release rules |
| `packages/adapters` | state store, installer and process probe |
| `apps/cli` | command parsing and composition |
| `skills/openlifewiki-install` | approval-gated user/Agent workflow |

## Validation

- lifecycle lists every stage with entry, required outputs and completion checks;
- dry-run leaves a temporary home absent;
- successful initialization records QMD `2.5.3` and `INITIALIZED`;
- the installed npm package integrity matches the pinned release;
- rerun is idempotent;
- installation failure publishes no `INITIALIZED` state;
- Skill structure validates;
- build, typecheck and tests pass on macOS and Linux.

## Rollback

This branch can be deleted without affecting `main`. Initialization tests use temporary directories. Manual initialization must use a temporary `OPENLIFEWIKI_HOME` until the P0 release review.

## Validation Results

- `./scripts/bootstrap_dev_env.sh`: passed;
- `pnpm verify`: 17 tests passed, one network component test skipped by default;
- `pnpm test:component:qmd`: official QMD `2.5.3` installation, integrity and version contract passed;
- Install Skill validation: passed;
- lifecycle, status, doctor and initialization dry-run CLI smoke: passed;
- read-only CLI smoke created no state root.
