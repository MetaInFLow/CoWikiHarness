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

The V1 Goal branch can merge to `dev`, and `dev` can merge to `main`, only when the public README matches real implemented behavior, CI is green and the canonical acceptance manifest proves:

- 17/17 benchmark journeys pass;
- 35/35 executable contracts pass;
- 11/11 acceptance validations pass using each validation's declared automated or human mode;
- Live Connector, recovery, desktop/mobile and direct Obsidian gates pass;
- Critical findings equal zero and Important findings equal zero;
- every required result is `pass`; `fail`, `blocked` and `not-run` prevent merge;
- the Owner Full Journey passes on the target machine.

`ACTIVE`, smoke tests, mock-only tests, component probes and open GUI pages cannot satisfy the integration or release gate.
