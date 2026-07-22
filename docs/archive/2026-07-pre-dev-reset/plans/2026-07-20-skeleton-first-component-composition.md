# Skeleton-First Component Composition

- Status: completed
- Date: 2026-07-20
- Owner direction: follow the recommended skeleton-first route and directly reuse upstream projects

## User Outcome

The repository has one understandable product skeleton before any component-specific vertical slice grows.
The owner can inspect which capabilities belong to openLifeWiki, which belong to upstream projects, and
which product journeys are genuinely supported.

## Scope

This work package contains only:

1. one production package and one CLI entry;
2. a static Catalog for QMD, llm-wiki-compiler, the official MCP SDK, `gh`, `lark-cli`, six Agent Cores,
   and the Visual Companion source pattern;
3. exact package pins for QMD, llm-wiki-compiler, and the MCP SDK;
4. the four V1 Source descriptors and both Agent Core strategies;
5. read-only `features`, `capabilities`, `doctor`, and `status` commands;
6. truthful status: no business journey is supported yet.

It does not implement Query, indexing, Agent dispatch, Source synchronization, Proposal, approval, CAS,
GUI, workflow, recovery, or component internals.

## Ownership Boundary

Upstream owns retrieval, Wiki utility behavior, Agent loops, platform authentication, MCP protocol, and
the Visual Companion implementation pattern. openLifeWiki owns only identity/policy, the knowledge
kernel, thin dispatch and Connector contracts, evidence/approval/CAS, lossless Markdown, Companion
security, Skillware lifecycle, and conformance tests.

## Verification

```text
pnpm install --frozen-lockfile
pnpm verify
pnpm openlifewiki features --json
pnpm openlifewiki capabilities --json
pnpm openlifewiki doctor --json
pnpm openlifewiki status --json
```

## Stop Condition

Stop after the skeleton is green and reviewable. Do not resume the archived QMD/Codex implementation.
The next work package starts with Identity + Kernel + MCP contracts, then chooses the smallest upstream
composition needed for the first real business journey.

## Outcome

- The previous component-specific implementation is preserved in Git stash
  `archive: overgrown codex-qmd vertical slice before skeleton-first reset`.
- The active package contains only Catalog, inspection CLI, non-executing presence checks, and exports.
- `supportedJourneys` is empty; this package is a skeleton, not a product release.
- Product, architecture/security, and reuse reviews report zero Critical and zero Important findings.
