# openLifeWiki Requirements V1: Progressive Scan To Formal Wiki

- Status: canonical V1 product baseline; implementation pending
- Date: 2026-07-26
- Audience: Owner, product team, implementation team and acceptance reviewers
- Supersedes: [`requirements-v0.2.md`](requirements-v0.2.md)
- Red lines: [`core-red-lines.md`](../product/core-red-lines.md)

## Product Outcome

openLifeWiki V1 gives one Owner a visible, permission-bound path from real knowledge Sources to a durable personal Wiki:

```text
connect four real Sources
-> inspect identity and authorized scope
-> discover a metadata-only Source Skeleton
-> review explainable layer summaries and descend decisions
-> commit current authorized evidence to QMD
-> ask, write, decide and review with citations
-> compile a WikiProposal
-> approve the exact proposal
-> open the Formal Wiki directly as an Obsidian Vault
-> change a Source and approve the incremental Wiki update
```

The Owner's visible result is a useful, organized Wiki with provenance, freshness, known gaps, folders, tags, aliases and cross-links. Architecture, individual components, generated proposals, `ACTIVE` state and open GUI pages are necessary evidence but do not complete V1.

## Product Actors

| Actor | Responsibility |
| --- | --- |
| Owner | authorizes Sources, selects Agent and budgets, resolves sensitive access, approves exact Wiki proposals and accepts the Full Journey |
| Visitor | invokes the single MCP `query` tool and receives a grounded answer with resolvable citations; has no separate evidence, Wiki, status or management tool |
| Admin | manages Connectors, scans, Agent selection, proposals, lifecycle and recovery; every durable Wiki write still requires Owner approval |
| Selected Agent | makes bounded layer decisions, produces grounded answers and proposes taxonomy/Wiki changes through the configured Agent Core |
| Connector | exposes provider identity, scope, metadata-only skeleton and authorized bodies through a versioned public contract |

## Four Required Connectors

The Sources page must show the following at the same time:

| Source | Required provider | Authorization boundary |
| --- | --- | --- |
| Local Folder | openLifeWiki filesystem adapter | explicit root, include/exclude rules, symlink policy and sensitivity settings |
| GitHub | existing authenticated [`gh`](https://github.com/cli/cli) CLI | explicit repositories and optional path/ref filters |
| Feishu | existing authenticated [`lark-cli`](https://github.com/larksuite/cli) profile | selected profile, tenant identity and explicit document/wiki/base scopes |
| Codex History | version-pinned Codex `app-server` v2 JSON-RPC | exact project roots through `thread/list`; approved thread IDs through `thread/read` |

Each Connector displays name, provider, provider version, redacted current identity/profile, authorized scope, `connected | auth-required | missing | blocked`, last probe, last scan and changed items. Credential values are never displayed or stored.

## Functional Requirements

### R1. Connector Visibility And Authorization

1. Connection probes are read-only and distinguish missing software, missing authentication, wrong profile, insufficient scope and provider failure.
2. Authorization is an Owner-approved record. A Connector descriptor declares capability; a provider performs public-interface calls within that record.
3. Feishu checks the intended profile, redacted identity and effective scope before classifying a permission failure.
4. Removing or narrowing authorization prevents new reads immediately and queues current-source reconciliation.
5. The Sources page supports preview, exact Owner approval, persistence, narrowing and revocation for Local roots, GitHub repository/path/ref, Feishu profile/object scope and Codex project/thread scope. Every Feishu operation carries the approved profile explicitly; the active shell profile is never implicit authority.

### R2. Skeleton-First Progressive Scan

1. Every Connector first returns a metadata-only hierarchical skeleton with stable node ID, parent ID, kind, title, locator, known or estimated child count, modified range, permission, scanability, page/cursor and size estimate.
2. The first pass enumerates only direct children of the authorized root. No unselected leaf body is read.
3. For every visited non-leaf, openLifeWiki creates a scratch Layer Summary using metadata, provider description and an explicitly budgeted metadata sample. A metadata sample cannot contain leaf body text.
4. The Selected Agent reads the canonical Progressive Scan Skill plus narrowing rules in `WIKI.md` and Host config, then records `descend | skip | defer | ask-user`, reason, actor, `inputSetHash`, coverage and estimated cost.
5. Autonomous descent is limited by scope, sensitivity and budget. Expansion or ambiguity requires Owner input.
6. Only selected, authorized leaves enter the indexing policy and QMD current-source index.

### R3. Truthful Progress And Control

The Sources workspace displays these independent dimensions:

- Discovery: enumerated nodes / currently known nodes;
- Summarization: summarized non-leaf nodes / selected non-leaf nodes;
- Selected Scan: processed leaves / leaves selected by the current plan;
- Committed Index: current QMD commits / processed leaves;
- counts for Skipped, Deferred, Blocked, Failed and Unknown;
- current path, current Layer Summary, Agent decision and reason.

All dimensions bind to `scanPlanHash + skeletonVersion`. Denominator changes are visible. Unknown child counts, open cursors and blocked items prevent false 100%. For every visited non-leaf, the tree retains body-free summary/decision metadata (`summaryHash`, `inputSetHash`, decision and reason) after scratch deletion so coverage and decisions remain inspectable. The workspace supports Pause, Resume, Cancel, failed-item retry and incremental rescan. Restart skips checkpoints whose version and input hashes still match.

### R4. Evidence And Agent Use

1. QMD is the current-source retrieval layer and is accessed only through public CLI/MCP.
2. Queries return resolvable citations or an explicit no-evidence, partial-evidence or conflicting-evidence outcome.
3. Raw exposure follows Source authorization and sensitivity rules; an answer cannot reveal an unread or blocked body.
4. All six Agent choices support the same user journeys without credential copying or silent fallback.
5. Codex, Claude Code and Gemini use their already logged-in native CLIs with no openLifeWiki BaseURL or token field.
6. Pi, OpenClaw and Hermes run through a provider declared by Host config using optional BaseURL, credential reference and model. Host config is the only configuration source and the knowledge workspace stores no credential.

### R5. WikiProposal And Formal Wiki

1. After evidence commit, the Selected Agent proposes primary folders, subfolders, Concepts, controlled tags, aliases, links, `index.md` files, provenance, freshness, known gaps and moves.
2. The Selected Agent is the only semantic-generation path. No compiler command may activate a second model, provider or Agent behind that selection.
3. [`llm-wiki-compiler`](https://github.com/atomicstrata/llm-wiki-compiler) `1.1.0` provides its public candidate review queue, incremental state and refresh support, citation/freshness/link/lint/eval checks and OKF v0.1 exchange. Provider-dependent compiler operations are permitted only when their runtime is demonstrably bound to the same Selected Agent; V1 does not configure a second provider for them.
4. openLifeWiki owns Source selection, authorization, Selected Agent orchestration, `proposalHash` and `baseWikiHash` approval binding, a minimal OKF v0.1-to-v0.2 upgrade, the Obsidian Compatibility Profile validator and GUI orchestration. It reuses verified compiler capabilities and supplies only the missing v0.2/profile boundary.
5. Review shows directory diff, file diff, tags diff, link changes and supporting Evidence. Reject leaves Formal Wiki byte-identical.
6. Approval succeeds only when the reviewed proposal hash matches and the current Wiki still matches `baseWikiHash`; otherwise compare-and-swap fails closed.
7. Formal Wiki follows OKF v0.2 and the Obsidian Compatibility Profile. It stores synthesized reusable Concepts, not bulk Source copies.

### R6. Obsidian Compatibility

1. The Wiki root opens directly as an Obsidian Vault without a required plugin.
2. Concept pages are UTF-8 Markdown with YAML frontmatter. `type` is required; `title`, `description`, `sources`, `generated`, `verified`, `status` and `stale_after` follow OKF v0.2 when present.
3. `page_uid` stays stable across approved rename or move operations. Unknown frontmatter keys are preserved.
4. Primary classification uses folders; cross-cutting classification uses controlled hierarchical tags such as `domain/...` and `source/...`.
5. Canonical links are standard Markdown links, and every directory has an `index.md` for progressive disclosure.
6. Optional `.obsidian/` content is removable display configuration and cannot carry unique knowledge or authorization.

### R7. Management Companion

The fixed local GUI has seven operational pages: Query, Sources, Wiki, Review, Agent, Canvas and Health. Query includes lifecycle overview and current next action. Progressive Scan is a workspace inside Sources and cannot become a separate page or general workflow engine. Review is the independent exact-proposal approval surface. Canvas is a task-bound dynamic screen/event surface; it cannot replace durable product management. Desktop and mobile views expose the same truth and never use color alone for state.

### R8. Lifecycle And Operations

1. Install, initialize, activate, scan, compile, approve, maintain, update and uninstall have previewable, recoverable operations and machine-readable receipts.
2. Failed operations do not publish later stable states. Default uninstall preserves Formal Wiki.
3. Session and operation locks prevent two Admin sessions from approving or mutating the same plan concurrently.
4. A 10,000-item / 2 GB authorized Source corpus can be progressively scanned with bounded scratch storage, visible dynamic progress, pause/resume and no second durable body mirror.

## Storage Contract

| Data | Durable location | Rule |
| --- | --- | --- |
| Original Source body | original provider | Source remains authoritative |
| Current searchable body | isolated QMD index | rebuildable; one current committed version |
| Source Skeleton | openLifeWiki runtime | metadata and cursors only |
| Layer Summary body | scan scratch | disposable; hash only is durable |
| Scan decisions/coverage | openLifeWiki runtime | metadata, hashes, actor, reason, counters and checkpoints |
| WikiProposal | review workspace | immutable candidate bound to `proposalHash` and `baseWikiHash` |
| Formal Wiki | visible Wiki root | Owner-approved OKF/Obsidian Concepts |

## V1 Exclusions

- team accounts, remote sharing and multi-user authorization;
- custom retrieval, embedding or reranking engines;
- cloud-hosted openLifeWiki service;
- credential management or Agent login replacement;
- raw Source archival, historical body versions or a persistent normalized mirror;
- taxonomy changes outside WikiProposal review;
- silent provider or Agent substitution.

## Success Standard

V1 passes only when the Owner completes the real Full Journey from four visible Connector states through progressive scan, current QMD commit, WikiProposal approval, direct Obsidian opening and one incremental update. All applicable checks in [`v1-journeys-and-oracles.md`](../acceptance/v1-journeys-and-oracles.md) must pass, including Live Connector, recovery, desktop/mobile and Obsidian manual acceptance. `blocked` and `not-run` are non-passing results. Critical and Important review findings must be zero.
