# openLifeWiki Core Red Lines

- Status: canonical product authority
- Applies to: product definition, implementation, operations and acceptance
- Root authority: [`CONSTITUTION.md`](../../CONSTITUTION.md)

When another document conflicts with this file, the root red lines below win. A V1-derived red line may narrow behavior but cannot weaken the root constitution.

## Root Red Lines

These ten rules restate the project constitution without changing its meaning:

1. Scan no directory or platform without explicit Source authorization.
2. Copy no third-party project source into this repository; install official releases and use public interfaces.
3. Access no QMD private storage, private SQLite table or internal API.
4. Put no Agent credential in openLifeWiki configuration, Wiki, logs or command arguments.
5. Mark no lifecycle stage complete until its executable acceptance checks pass.
6. Make no durable Wiki change without human approval of the exact proposal.
7. Publish no partial successful state after failed installation or initialization.
8. Preserve the confirmed Wiki during default uninstall.
9. Add no later-stage dependency to initialization for convenience.
10. Commit no generated output, runtime data, logs or personal Source content to Git.

## V1-Derived Red Lines

### Authorization And Identity

1. A Connector may enumerate or read only its approved `authorizedScope`. Discovery cannot broaden authorization.
2. Source connection status must expose the real provider, version, redacted identity, profile/account, scope, last probe and blocking reason. It must never expose a token, session secret or credential value.
3. Feishu permission failures require a probe of the selected `lark-cli` profile, identity and scope before the product reports a platform block.
4. Codex History may read only explicitly approved task and project scopes. Account-wide history discovery is forbidden.
5. `WIKI.md`, a canonical Skill and Host config may narrow a Source scope, sensitivity rule or budget. `WIKI.md` cannot grant or broaden authorization.

### Source Skeleton And Reading

6. Source Skeleton and Formal Wiki are the two durable product poles. A skeleton contains metadata only; a Formal Wiki contains approved synthesized Concepts.
7. Initial discovery enumerates only the approved root's direct children. Leaf bodies remain unread until a recorded `descend` path and indexing policy authorize the read.
8. Layer Summary is scan scratch. Durable scan state may contain only node metadata, `summaryHash`, `inputSetHash`, decision, actor, reason, coverage and cost observations.
9. Persist no normalized Source mirror, Layer Summary body, historical Source body or one-Wiki-page-per-Source copy.
10. A body from a Source may exist only in the original Source and QMD's rebuildable current-source index. A changed or deleted Source must replace or remove its earlier indexed body.

### Decision, Progress And Recovery

11. Each completed layer requires exactly one Selected Agent outcome of `descend`, `skip`, `defer` or `ask-user` for every decision-eligible direct child. Agent outcomes plus Control Plane system outcomes must exactly equal the hash-bound direct-child set; implicit traversal, omission, duplicate and extra targets are forbidden.
12. The Agent may descend autonomously only within approved scope, sensitivity and budget. Scope expansion, sensitive access, budget overrun or unresolved ambiguity requires `ask-user`.
13. Every ratio is independently derived from durable sets: `EnumerationIntent` plus closed page nodes, summary-bearing layers, selected/processed leaves and the published active QMD manifest. It binds one `scanPlanHash`, `skeletonVersion` and exact `sourceIds`; global progress uses set union and never averages Connector percentages.
14. Unknown/unconverged child counts, unfinished pagination, pending layer decisions, blocked/failed work, unresolved `ask-user`, zero denominators or uncommitted leaves cannot produce a completion claim.
15. Pause, restart and retry preserve exact logical checkpoints: unchanged nodes are not re-enumerated, re-summarized, re-decided, re-counted or recommitted. When a failed temporary QMD generation has been deleted to satisfy minimum storage, recovery may stream an unchanged selected body again solely to rematerialize a complete generation. That exception requires current version/hash revalidation, separate rematerialization counters and no new logical completion credit.
16. Silent fallback is forbidden. A missing Connector, unavailable Agent, invalid Host config or failed provider must surface its real status and stop the dependent operation.

### Wiki And Human Control

17. Taxonomy is an Agent proposal. The Owner approves primary folders, controlled cross-cutting tags, links, aliases and moves before they reach Formal Wiki.
18. Every durable Wiki mutation requires an immutable `proposalHash`, the reviewed `baseWikiHash` and a compare-and-swap check at approval time. A mismatch requires regeneration or renewed review.
19. The Visitor surface is read-only. The Admin surface may prepare and manage operations, but it cannot bypass proposal review for durable Wiki writes.
20. Formal Wiki uses OKF v0.2 plus the Obsidian Compatibility Profile: UTF-8 Markdown, parseable YAML, stable `page_uid`, standard Markdown links, primary folder classification, controlled tags and an `index.md` at every level.
21. Unknown frontmatter keys survive import, move, compilation and export. Optional `.obsidian/` display configuration remains removable and never becomes a knowledge source of truth.
22. The final Owner-accepted Vault must derive from the same active QMD generation produced by the four required live Connector chains. Connected, committed, proposed and published Connector sets must all equal Local Folder, GitHub, Feishu and Codex History, with a verifiable receipt/hash chain.

## Completion Rule

`ACTIVE`, a passing component test, a generated plan or a page that opens is intermediate evidence. V1 completes only when the Owner executes the Full Journey on the local machine, every applicable acceptance oracle passes, Critical and Important review findings are zero, and no required check is `blocked` or `not-run`.
