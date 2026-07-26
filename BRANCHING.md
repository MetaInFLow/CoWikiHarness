# Branching

## Branch Roles

- `main`: release-ready and reviewed product baseline.
- `dev`: integration branch for the next coherent product baseline.
- `goal-v1-progressive-scan`: ordered V1 Goal branch based on `dev`.
- `feature/<topic>`: focused feature work based on the current integration/Goal branch.
- `fix/<topic>`: focused correction based on the target branch.

Direct work on `main` is limited to an explicitly approved emergency fix.

## Checkout Rule

- A focused follow-up on a clean integration checkout may edit that branch directly.
- Parallel work, unrelated tasks or changes larger than one reviewable topic use separate worktrees or explicitly partitioned files.
- Unknown related changes stop the task; do not stash, reset or overwrite them.
- Never restore the superseded phase-0 branch or archived stash content into current work.

## Task Merge Gate

A V1 delivery task can merge into its Goal branch only when:

- its named failing test is now green;
- every predecessor contract remains green;
- its delivery-plan exit gate passes;
- product, architecture, implementation, test and privacy/security reviewers applicable to the task close all Critical and Important findings;
- no generated output, runtime data, log, credential or personal Source enters Git.

## Integration And Release Gate

The V1 Goal branch can merge to `dev` when the public README matches real implemented behavior, CI is green and the Core Owner UAT record proves:

- `Core-UAT-01` passes against one candidate/runtime;
- four-Source Live Connector, native Codex, core recovery, desktop/mobile and direct Obsidian gates pass;
- Critical findings equal zero and Important findings equal zero;
- every Core-required result is `pass`; `fail`, `blocked` and `not-run` prevent merge.

Promotion from `dev` to a fully certified `main` release may additionally require the deferred 17/35/11 catalog, external signatures, six-Agent live equivalence, fixed-scale run, update and uninstall gates defined by Release Certification policy.

`ACTIVE`, mock-only tests, component probes and open GUI pages cannot satisfy either gate.
