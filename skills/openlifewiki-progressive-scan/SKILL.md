---
name: openlifewiki-progressive-scan
description: Run permission-bound skeleton-first scans, grounded queries and exact WikiProposal generation through the canonical openLifeWiki contract shared by Codex, Claude Code, Gemini, Pi, OpenClaw and Hermes. Use when connecting a Source, deciding scan descent, querying evidence, preparing Wiki changes, recovering an interrupted scan or operating the Progressive Scan Canvas.
---

# openLifeWiki Progressive Scan

## Objective

Convert explicitly authorized Source hierarchy into truthful scan decisions, one rebuildable current QMD evidence generation and an Owner-approved Formal Wiki. Apply this procedure unchanged for Codex, Claude Code, Gemini, Pi, OpenClaw and Hermes. Record the actual Selected Agent runtime and mode on every decision, query and proposal result.

This Skill is canonical product Skillware. Its hash is part of each scan plan and checkpoint. Loading or describing the Skill grants no Source access, Agent credential, budget, query raw exposure or Wiki write.

## Authority And Input Order

Resolve inputs in this order:

1. root constitution and canonical core red lines;
2. Owner-approved Source authorization, identity fingerprint, scope, sensitivity and budget;
3. this canonical Progressive Scan Skill at the recorded `skillHash`;
4. Host config policy plus declared priority document references;
5. `WIKI.md` narrowing rules.

Reject an input set when a required input or hash is absent, stale, ambiguous or inconsistent. Lower-priority inputs can only narrow higher-priority permission. Apply these merge rules:

- effective roots, repositories, refs, paths, task IDs and object IDs are intersections;
- effective includes are intersections and effective excludes are unions;
- effective numeric budgets are the minimum applicable limits;
- effective sensitivity is the most restrictive applicable level;
- a priority document influences relevance only after its locator is already authorized;
- `WIKI.md` and Host policy cannot add scope, reduce sensitivity, expose a credential, suppress a coverage gap, select a fallback Agent or authorize a durable Wiki change;
- any attempted expansion or unresolved conflict returns `ask-user` or a structured failure before access.

Never infer authorization from filesystem ancestry, a provider login, a link, a search result, Source content, Agent memory or prior access.

## Five Connector Actions

The control plane may issue only these typed actions. The Selected Agent proposes bounded next actions; it never invokes a provider directly.

| Action | Contract |
| --- | --- |
| `probe()` | Return provider name/version, redacted identity/profile, effective authorized scope, status, last probe and safe blocking reason. Read no Source body. |
| `listRootsMetadata(limit,cursor)` | Enumerate only approved root metadata through the provider public surface. Honor limit/cursor and return page completeness. Read no Source body. |
| `listChildrenMetadata(parent,limit,cursor)` | Enumerate only direct child metadata of an already approved parent. Honor limit/cursor and never recurse implicitly. Read no Source body. |
| `readApprovedLeafBody(node,expectedVersion,descendReceipt)` | Stream one selected leaf body only when scope, sensitivity, budget, version and durable descend receipt all match. Retain no successful-operation body scratch. |
| `getVersion(node)` | Return current provider version/etag/hash metadata for an approved node without returning its body. Use it before body read, checkpoint reuse and incremental reconciliation. |

ADR enumeration maps to `listRootsMetadata` and `listChildrenMetadata`. `sampleMetadata` is a local control-plane selection and summary over already enumerated metadata; it does not create another provider action and must contain no leaf body.

A missing Connector, unsupported action, incomplete page, invalid cursor, version mismatch or provider failure stops its dependent operation with the real structured status. Do not change provider, broaden scope, inspect private storage or synthesize missing results.

## Skeleton-First Procedure

### 1. Validate The Operation

Require:

- `operationId`, `scanId`, `scanPlanHash`, `skeletonVersion` and `skillHash`;
- Selected Agent ID, runtime, mode and driver contract version;
- authorized Source IDs, authorization hashes and identity fingerprints;
- Host policy hash, priority references and `WIKI.md` hash where present;
- remaining node, body-byte and Agent-call budgets;
- current node metadata, page/cursor state and prior valid checkpoints.

Recompute the declared canonical hashes before a decision. Return `SCAN_INPUT_CHANGED` when the material input differs. Never repair a mismatched receipt in place.

### 2. Probe And Discover One Layer

Run `probe()`. Stop on `auth-required`, `missing` or `blocked`. For Feishu, report the selected `lark-cli` profile, redacted identity, tenant and effective scope before classifying permission failure. For Codex History, accept only explicit task IDs and project roots.

At an approved root, call `listRootsMetadata(limit,cursor)`. At a selected non-leaf, call `listChildrenMetadata(parent,limit,cursor)`. Enumerate direct children only. Preserve open cursors, unknown counts, denied nodes and stable IDs as visible coverage facts. Initial discovery performs zero leaf-body reads.

### 3. Build Layer Summary Scratch

Create one disposable Layer Summary from:

- current node metadata;
- enumerated direct-child metadata and page coverage;
- provider descriptions and explicitly public metadata snippets;
- current narrowing policy, priority relevance and remaining budget;
- already approved and processed evidence only when the current plan explicitly includes it.

Store the Layer Summary body only in owner-only operation scratch. Durable state may retain `summaryHash`, `inputSetHash`, actor, decision, reason, coverage and cost observations. It may not retain the summary body, sampled Source body or normalized Source copy. Delete body-bearing scratch on decision commit, pause, cancel, failure and startup recovery.

### 4. Decide Exactly One Outcome

Return exactly one decision:

- `descend`: direct-child metadata shows material relevance, every next action stays within scope/sensitivity/budget and ambiguity is resolved;
- `skip`: evidence shows the branch is irrelevant to the approved objective; record the reason and coverage without reading bodies;
- `defer`: the branch is relevant but can wait because of priority or a declared bounded resource constraint; record the revisit condition;
- `ask-user`: scope expansion, sensitive access, budget overrun, unresolved ambiguity, policy conflict or an Owner judgment is required.

`descend` authorizes only the exact next layer named in the result. It does not authorize recursive traversal or a leaf body. A later `readApprovedLeafBody` also requires current `getVersion`, leaf selection, remaining budget and the matching durable descend receipt.

Never default to `descend`. Never convert unknown pagination, blocked work, invalid Agent output or missing identity into `skip` or success.

### 5. Commit Current Evidence

For selected leaves:

1. verify authorization and identity hashes;
2. call `getVersion(node)` and compare `expectedVersion`;
3. reserve the exact remaining budget;
4. call `readApprovedLeafBody(node,expectedVersion,descendReceipt)`;
5. stream or operation-stage the body only for the active current-generation build;
6. build the complete selected current manifest in a temporary isolated QMD runtime through public CLI/MCP;
7. pass public query/get positive probes and removed/replaced negative probes;
8. atomically switch the active generation;
9. delete the entire prior generation directory;
10. publish committed checkpoints only after deletion succeeds.

Treat QMD storage as opaque. Access no private database, table, file format or internal API. One active rebuildable current index is the only resting derived Source-body copy.

## Decision Output

Return JSON only for a scan decision. It must validate against this shape:

```json
{
  "schema": "openlifewiki.progressive-scan-result/v1",
  "operationId": "op_01",
  "scanId": "scan_01",
  "scanPlanHash": "sha256:...",
  "skeletonVersion": "sha256:...",
  "skillHash": "sha256:...",
  "inputSetHash": "sha256:...",
  "agent": {
    "id": "agent_codex_native",
    "runtime": "codex",
    "mode": "native-cli",
    "driverContractVersion": "v1"
  },
  "node": {
    "sourceId": "src_01",
    "nodeId": "node_01",
    "nodeVersion": "provider-version",
    "summaryHash": "sha256:..."
  },
  "decision": "descend",
  "reason": "The direct-child metadata matches the approved objective within scope and remaining budget.",
  "coverage": {
    "directChildrenEnumerated": 12,
    "pageComplete": true,
    "openCursor": false,
    "unknownChildCount": false
  },
  "budget": {
    "remainingNodes": 9000,
    "remainingBodyBytes": 2000000000,
    "remainingAgentCalls": 450,
    "estimatedNextNodes": 12,
    "estimatedNextBodyBytes": 0,
    "estimatedNextAgentCalls": 1
  },
  "sensitivity": {
    "effective": "normal",
    "ownerApprovalRequired": false
  },
  "nextConnectorActions": [
    {
      "action": "listChildrenMetadata",
      "parent": "node_01",
      "limit": 100,
      "cursor": null
    }
  ],
  "revisitCondition": null,
  "question": null,
  "status": "decision-ready"
}
```

Additional constraints:

- `decision` is exactly `descend | skip | defer | ask-user`;
- `reason` names the decisive metadata, scope, sensitivity, budget or ambiguity and contains no Source body;
- `skip` has empty `nextConnectorActions` and no question;
- `defer` has empty body-read actions and a concrete `revisitCondition`;
- `ask-user` has no access action and one bounded `question` that states requested scope/sensitivity/cost and safe alternatives;
- `descend` requests only `listChildrenMetadata` for the named node or, after a separately durable leaf selection, the version/read pair for that exact leaf;
- unknown or unavailable values remain explicit `null`/flags and are never invented;
- the result contains no credential, command argument secret, Source-body excerpt or Layer Summary text.

Invalid JSON, an unknown field that changes semantics, an unknown decision, mismatched hash or prohibited Connector action returns `AGENT_OUTPUT_INVALID`. No checkpoint or access follows it.

## Body-Zero-Leakage Rule

Source bodies may enter only the bounded current leaf stream, the isolated QMD current-generation build, the internal grounded query context and the Selected Agent's bounded proposal context. They must never enter:

- Skeleton nodes, Layer Summary durable state or scan decision JSON;
- operation receipts, logs, error details, progress events or diagnostic downloads;
- Host config, Skill files, Agent child arguments or credential records;
- Canvas screens/events;
- a normalized Source mirror, historical body cache or one-page-per-Source Formal Wiki copy.

Formal Wiki pages contain approved synthesis with provenance. They may quote only the minimum Owner-reviewed evidence allowed by policy. A query's optional raw exposure remains inside `query`, requires an explicit policy decision and never enters diagnostics or durable Wiki by implication.

## Budget And Sensitivity

- Reserve node, byte and Agent-call cost before the action; charge observed cost after it; record both without body content.
- Stop before a limit is exceeded. Return `ask-user` for a proposed Owner-approved increase or `defer` when current policy permits later work.
- Unknown or unbounded estimated cost requires `ask-user`.
- A budget increase creates a new plan/approval hash. A retry cannot silently increase it.
- Use the most restrictive sensitivity classification from all applicable rules.
- Sensitive access requires exact Owner approval for the named nodes/action. Denial persists as metadata with zero sample/body content.
- Raw exposure, proposal evidence and query context each require their own applicable policy check; scan authorization alone does not grant display permission.

## Pause, Cancel And Recovery

At pause or cancel, stop scheduling new actions and finish or safely abort the current atomic unit. Delete body-bearing scratch before publishing the pause/cancel receipt. Pause preserves completed checkpoints. Cancel preserves valid completed commits and records every incomplete/blocked/deferred outcome without claiming completion.

On startup:

1. remove orphan body-bearing scratch;
2. validate authorization, identity, node version, plan, skeleton, Skill, Host policy, `WIKI.md`, Agent driver and QMD generation hashes;
3. reuse only exact matching checkpoints;
4. discard an incomplete discovery page and resume from the last complete cursor receipt;
5. recompute an interrupted Layer Summary;
6. reread only an incomplete leaf;
7. discard a failed temporary QMD build while retaining the active generation;
8. after an active-pointer switch, finish prior-generation deletion and public probes before success;
9. surface `RECOVERY_REQUIRED` when deterministic recovery cannot prove one valid state.

No retry may reread, re-summarize or recommit an unchanged valid checkpoint. No failure may trigger silent fallback to another Connector, Agent, provider, BaseURL, model, path, scope or cached body.

## Grounded Query Contract

Visitor exposes exactly one `query` tool. Retrieval and citation resolution remain internal to the policy-aware pipeline.

For every query:

- bind retrieval to the active QMD generation and current authorization;
- use only current committed Evidence visible to the caller;
- return exactly one evidence mode: `grounded | no-evidence | partial-evidence | conflicting-evidence`;
- attach a resolvable current citation to every material factual claim;
- label inference, missing coverage, freshness and conflict explicitly;
- refuse certainty when evidence is absent, partial or conflicting;
- prevent a citation or raw exposure from revealing unread, excluded, sensitive-unapproved, deleted or prior-generation content;
- never expose separate Visitor evidence, Source, QMD get, status or management tools.

## WikiProposal Responsibility

The Selected Agent is the sole semantic-generation path for Concepts, primary folders, controlled tags, aliases, links, indexes, provenance, freshness, known gaps and real moves. Produce a structured candidate against a frozen authorized Evidence manifest and include actual Agent identity/mode plus input hashes.

openLifeWiki owns `proposalHash`, `baseWikiHash`, preview, Owner approval, compare-and-swap, publication and receipts. `llm-wiki-compiler` may perform deterministic review, incremental, citation/freshness/link/lint/eval, OKF and Obsidian validation through its public surfaces. It cannot crawl Sources or invoke a second semantic Agent/provider.

The proposal must:

- synthesize reusable Concepts and avoid bulk Source copying;
- distinguish a virtual category/view from a real file move;
- place every Concept in one proposed primary folder and use controlled tags for cross-cutting classification;
- preserve stable `page_uid`, unknown frontmatter, aliases, provenance and valid standard Markdown links on approved rename/move;
- include every affected `index.md` and all directory/file/tag/link/Evidence diffs;
- make gaps and validation failures visible;
- write nothing to Formal Wiki until the Owner approves the exact immutable proposal and current base hash.

Reject, hash mismatch, stale base, invalid OKF/profile or failed publication leaves the active Formal Wiki byte-identical.

## GUI And Superpower Canvas

Durable work starts and remains visible on Query, Sources, Wiki, Review, Agent or Health. Progressive Scan stays inside Sources. Trigger Canvas only when a specific active task needs visual judgment that the originating page cannot express adequately, including:

- an `ask-user` branch comparison with bounded scope/sensitivity/cost choices;
- a proposed folder/tag/link graph or move comparison;
- a conflict/evidence comparison requiring explicit Owner selection.

The originating page must show an explicit **Open Canvas** action. Do not open Canvas automatically. Before display, show the task title, purpose and exact redacted fields to be sent. A screen includes `taskId`, monotonic `revision`, typed content, allowed events and expiry. An event must echo task/revision and one allowed action. Accept it once; expired, replayed, mismatched and unknown events fail closed.

Canvas receives metadata, hashes, short synthesized labels and the minimum redacted Evidence needed for the judgment. It receives no Source body, raw exposure, credential, lifecycle secret or durable mutation authority. Canvas shows one task at a time, labels state with text and icon, supports desktop/mobile, and returns to the originating durable page after decision or expiry. The durable page displays the accepted event and resulting preview; a separate required approval still occurs there.

## Product Skillware Lifecycle

| Stage | Required behavior and completion evidence |
| --- | --- |
| `discover` | Describe purpose, six supported Agents, five Connector actions, permissions, current limitations and official release identity. Perform no probe, read, install or write. |
| `install` | Install the canonical Skill only from the openLifeWiki official release; verify release and Skill digest. Install grants no Source authorization and changes no Agent login. |
| `activate` | Owner selects one configured Agent; validate its mode and Host config; record `skillHash` in the previewed scan plan. Missing/auth-required/provider failure blocks activation without fallback. |
| `interact` | Execute skeleton-first scan and grounded query contracts with visible progress, current evidence, citations and explicit no/partial/conflict results. |
| `decide` | Emit the validated JSON decision or structured failure; durable Wiki changes proceed only through an exact WikiProposal approval. |
| `feedback` | Record Owner corrections as narrowing policy, priority feedback, defer/revisit input or proposal rejection. Any expansion requires a new authorization/plan approval. Feedback never rewrites historical receipts. |
| `update` | Preview the official Skill release/hash change; pass six-driver contract checks; invalidate dependent checkpoints because `skillHash` changed; preserve Source, current Wiki and last supported runtime on failure. |
| `uninstall` | Preview removal; stop operations; remove the Skill registration/runtime component and report retained paths. Preserve original Sources and confirmed Formal Wiki by default. |

Completion evidence is always the executable product receipt and applicable V1 acceptance oracle. Agent prose, a loaded Skill, an open Canvas, a proposed plan or a successful fallback cannot mark a stage complete.
