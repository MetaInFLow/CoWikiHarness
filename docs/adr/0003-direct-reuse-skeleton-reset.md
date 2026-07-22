# ADR 0003: Direct-Reuse Skeleton Reset

- Status: Accepted
- Date: 2026-07-20
- Owner approval: approved the recommended direct-reuse route on 2026-07-20

## Context

The `phase-0-foundation` experiment moved into QMD private-schema lifecycle work and replaced several
llm-wiki-compiler capabilities before a real product skeleton existed. It also accumulated a large
uncommitted application surface whose Query, Source, Wiki, Review, and Agent operations were still mostly
placeholders.

The approved architecture starts with Registry First and direct composition. The experimental branch is
preserved for evidence but is not merged into this branch.

## Decision

The product skeleton will invoke installed upstream components through documented public surfaces:

- QMD `2.5.3` owns indexing and retrieval. openLifeWiki may use its CLI, MCP, and exported SDK only.
  `store.internal`, private SQLite tables, private FTS maintenance, and copied retrieval algorithms are
  forbidden.
- llm-wiki-compiler `1.1.0` remains the declared Wiki utility component. After public-surface contract
  verification, V1 may invoke only its no-provider status, lint, Viewer, context, and OKF export surfaces
  through its public CLI or SDK. Its provider-backed
  compile/search/query, Candidate approval gate, and typed writer are outside the production path because
  they do not satisfy the product's content-bound approval and CAS contract. openLifeWiki does not patch,
  fork, or recreate those excluded component surfaces.
- Codex, Claude Code, Gemini CLI, Pi, OpenClaw, and Hermes retain their own Agent loops. openLifeWiki owns
  only selection, invocation, task-scoped tool registration, result validation, cancellation, and product
  error mapping.
- GitHub and Feishu use `gh` and `lark-cli` for native authentication and platform behavior.
- MCP uses the official TypeScript SDK. Visitor and Admin remain distinct product surfaces.
- The component Catalog and product inspection shell must be reviewed before a component-specific path
  starts. The first later working path is Local Folder -> QMD public surface -> Codex native login -> cited
  result. GUI, generic recovery, and other adapters do not expand until that path calls real upstream
  components.

The initial openLifeWiki-owned surface is limited to host configuration, component readiness, explicit
source authorization, stable product identities/provenance, Visitor/Admin facade policy, citation/result
validation, lifecycle registration, and thin adapters.

## Gap Rule

An upstream gap is not permission to start a replacement subsystem. The implementation must first record:

1. the exact public operation attempted;
2. the failed product outcome and bounded reproduction;
3. whether composition, upstream contribution, or a smaller adapter solves it;
4. the proposed code and removal condition;
5. Owner approval when product semantics or ownership changes.

## Consequences

- `phase-0-foundation` and its dirty worktree remain untouched as an experiment.
- Only commits `f164f70` and `45a2c58` were migrated from that line; generated-output ignore rules were
  recreated locally.
- Previous private-QMD and custom llmwiki-replacement work is not release evidence for this branch.
- `pnpm verify` must stop being a vacuous workspace command as soon as the first package is added.
- A reused component is supported only after a real contract and journey pass; installation alone is not
  support.

## Reversal

Reverting this decision requires a new Owner-approved ADR. It must identify a concrete upstream contract
failure and cannot restore the experimental branch wholesale.
