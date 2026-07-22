# Branching

## Branch Roles

- `main`: release-ready and reviewed product baseline.
- `dev`: integration branch for the next coherent product baseline.
- `feature/<topic>`: multi-file feature work based on `dev`.
- `fix/<topic>`: focused correction based on the target branch.

Direct work on `main` is limited to an explicitly approved emergency fix. The current lifecycle rebaseline is performed on `dev`.

## Checkout Rule

- A focused follow-up on a clean `dev` checkout may edit `dev` directly.
- Parallel work, unrelated tasks or changes larger than one reviewable topic use separate worktrees.
- Unknown related changes stop the task; do not stash, reset or overwrite them.

## Merge Gate

`dev` can merge to `main` only after its active design has validation results, CI is green, the public README matches actual behavior and no P0 capability is represented as available before its real journey passes.
