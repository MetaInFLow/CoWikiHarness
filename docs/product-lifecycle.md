# openLifeWiki Product Lifecycle

- Status: canonical V1 lifecycle; implementation in progress
- Owner: product owner
- Requirement: [`requirements-v1.md`](requirements/requirements-v1.md)
- Purpose: define what must exist at every stage, what can recover, and how completion is proven

## One Lifecycle

```text
DISCOVER
  -> INSTALL
  -> INITIALIZE
  -> CONNECT
  -> SCAN
  -> USE
  -> PROPOSE
  -> APPROVE
  -> PUBLISH
  -> MAINTAIN / UPDATE
  -> UNINSTALL
```

Operations, stable runtime states and V1 completion are separate facts. An operation can fail and resume from a valid checkpoint without publishing a later stable state. `ACTIVE` means that the runtime can serve at least one authorized, current retrieval path. V1 completes only after the full acceptance suite and Owner Full Journey pass.

## Product Entry

The local Management Companion is the Owner-facing entry for lifecycle status, Connector authorization, progressive scan, Agent selection, proposals, recovery and health. It reads the same public contracts and application services as the CLI. Every mutation requires a preview, the matching immutable plan or proposal hash and explicit confirmation.

The CLI remains the automation and recovery interface. Both surfaces enforce the same Source scope, operation locks and receipts. Neither surface may access QMD private storage or broaden authorization.

## Stable Runtime States

| State | Meaning | Next action |
| --- | --- | --- |
| `INSTALLED` | CLI and Install Skill exist; user runtime is absent or incomplete | initialize |
| `INITIALIZED` | runtime layout and initialization-stage components pass their contracts | connect an authorized Source |
| `ACTIVE` | at least one authorized Source has a verified current retrieval path; the current P0 direct QMD path and the future V1 generation both use this narrow readiness meaning | continue the V1 journey or use the currently implemented retrieval path |
| `DEGRADED` | a previously completed runtime contract is currently failing | doctor, recover and reconcile |

Transient operation labels such as `CONNECTING`, `SCANNING`, `PROPOSING`, `APPROVING`, `PUBLISHING`, `UPDATING` and `UNINSTALLING` belong in operation receipts. They are not durable completion states. No new durable state named `V1_COMPLETE` is published; completion is an acceptance result bound to a release, machine, Owner Full Journey and evidence set.

`ACTIVE` does not assert that the policy-aware MCP, Visitor-only `query`, four Connector scan, Selected Agent or Formal Wiki has shipped. Each remains governed by its own V1 delivery and acceptance gate.

## Stage Contract

### 1. Discover

**Entry:** the user or Agent finds `openlifewiki-install`.

**Required:** product outcome and current limitations; permissions and network disclosure; supported platform/runtime; official release source and version.

**Writes:** none.

**Complete when:** the Skill describes the next operation without probing or changing the machine.

### 2. Install

**Entry:** explicit approval to install openLifeWiki.

**Required:** pinned openLifeWiki release, executable, Install Skill, license and component release manifest.

**Excluded:** Source reads, Agent registration, external component installation and user configuration.

**Complete when:** `openlifewiki --version` and `openlifewiki status --json` pass and the state is `INSTALLED`.

### 3. Initialize

**Entry:** installed product and approval of the initialization preview.

**Required:** owner-only runtime layout; visible Source and Wiki roots; initial configuration; isolated component directory; QMD `2.5.3` from its official release with integrity/version probes; atomic initialization receipt.

**Excluded:** Source reads, Agent authentication changes, Connector authorization, llm-wiki-compiler and optional later-stage components.

**Complete when:** `status` returns `INITIALIZED` and `doctor` passes every initialization contract.

**Recovery checkpoint:** last complete `INSTALLED` or `INITIALIZED` receipt. Failed initialization leaves the stable state at `INSTALLED` and reconciles only its isolated staging directory.

### 4. Connect

**Entry:** initialized runtime and an Owner-reviewed Connector authorization preview.

**Required:** one of the four V1 Connector descriptors; real provider/version probe; redacted identity/profile; exact `authorizedScope`; stable authorization hash; capability and blocking status without credential storage.

**Complete per Connector when:** the approved authorization and a current read-only provider probe agree on identity and scope. All four Connector rows may remain simultaneously visible with truthful `connected | auth-required | missing | blocked` status.

**Recovery checkpoint:** immutable authorization receipt plus last successful probe. Failure preserves prior narrow authorization and publishes no broader scope.

### 5. Scan

**Entry:** connected Source, Selected Agent, approved scan plan, sensitivity policy and budget.

**Required:** metadata-only direct-child discovery; Source Skeleton; disposable Layer Summaries; recorded `descend | skip | defer | ask-user` decisions; truthful independent progress dimensions; selected current leaf reads; QMD temporary-generation build and public query/get verification.

**Complete per plan when:** all selected leaves are processed, current content is retrievable, removed/replaced content is absent, the active QMD pointer switches atomically, the prior generation is deleted and the committed receipt matches `scanPlanHash + skeletonVersion`.

**Recovery checkpoint:** last complete provider page cursor, node version, decision input hash, selected-leaf receipt and active QMD generation receipt. Pause, restart and retry reuse only checkpoints whose authorization, plan, skeleton, policy, Agent and generation hashes still match.

### 6. Use

**Entry:** an active verified generation and available Selected Agent.

**Required:** Visitor discovers only `query`; Admin capabilities follow role policy; answers carry resolvable citations or explicit no/partial/conflicting-evidence status; optional raw exposure remains scope-checked.

**Complete per operation when:** the answer envelope, generation label, policy decision and every citation validate.

### 7. Propose

**Entry:** frozen current Evidence manifest and available Selected Agent.

**Required:** the Selected Agent proposes Concepts, folders, tags, aliases, links, indexes, provenance, freshness, gaps and moves; deterministic compiler services run through the pinned public contract; every displayed diff and receipt contributes to immutable `proposalHash` and `baseWikiHash`.

**Complete when:** the candidate, Evidence manifest, quality results and exact review diffs are complete and immutable.

**Recovery checkpoint:** last complete Evidence manifest and candidate compilation receipt. An incomplete candidate is disposable and the Formal Wiki stays byte-identical.

### 8. Approve

**Entry:** complete immutable WikiProposal displayed in Review.

**Required:** Owner reviews directory/file/tag/link/Evidence diffs and quality findings; reject records a reason; approval binds the exact `proposalHash`, reviewed `baseWikiHash`, Owner actor and time.

**Complete when:** a valid approval receipt is recorded under the current mutation and proposal leases. Hash, lease or current Wiki mismatch fails closed and returns to Review.

**Recovery checkpoint:** immutable proposal and approval receipt. Approval alone makes no Formal Wiki write.

### 9. Publish

**Entry:** valid approval whose proposal and base Wiki still match.

**Required:** complete sibling Vault staging; unknown frontmatter and stable `page_uid` preservation; affected `index.md` regeneration; OKF v0.2 and Obsidian Compatibility Profile validation; atomic Vault swap.

**Complete when:** the active Formal Wiki matches the approved proposal, post-publish checks pass and the publication receipt identifies the exact hashes. Reject, stale approval and failed validation publish nothing.

**Recovery checkpoint:** staging, active and receipt hashes. Startup finishes the verified atomic swap or restores the last approved Vault.

### 10. Maintain And Update

**Entry:** initialized or active runtime.

**Required:** desired/actual version report; previewed update; atomic or recoverable replacement; checkpoint compatibility evaluation; confirmed Wiki backup/restore; stage-timed component installation.

**Complete when:** every previously supported applicable journey and oracle passes after reconciliation.

### 11. Uninstall

**Entry:** installed product and explicit approval of the uninstall preview.

**Required:** remove registrations created by openLifeWiki; stop local processes; remove components and rebuildable indexes; preserve the Formal Wiki by default; record retained paths and a local receipt.

**Complete when:** runtime processes and registrations are absent, and retained user assets are listed.

## Install Skill Responsibility

The Install Skill owns conversation order and approval:

1. explain the current operation and capability boundary;
2. run read-only preflight;
3. show the initialization preview;
4. obtain explicit approval and initialize;
5. run doctor and stop at `INITIALIZED`;
6. continue only after separate Connector authorization and scan-plan approvals;
7. report `ACTIVE` as retrieval readiness and keep the remaining V1 journey visible.

The CLI owns filesystem changes, dependency installation, idempotency and machine-readable receipts. Skill prose is never completion evidence.

## Component Timing

| Component | First required stage | Delivery |
| --- | --- | --- |
| QMD `2.5.3` | Initialize | isolated official npm release; public CLI/MCP only |
| Local Folder adapter | Connect | openLifeWiki-owned filesystem boundary |
| `gh` | Connect GitHub Source | user-managed official CLI |
| `lark-cli` | Connect Feishu Source | user-managed official CLI/profile |
| Codex History connector | Connect Codex History | version-pinned authenticated Codex app-server v2 contract |
| Selected Agent driver | Scan | existing native login or Host-configured provider |
| policy-aware MCP | Use | openLifeWiki public role/policy surface delegating retrieval to QMD |
| llm-wiki-compiler `1.1.0` | Propose | isolated official release; proven deterministic public capabilities and OKF v0.1 exchange only |
| OKF v0.2/Obsidian adapter | Publish | openLifeWiki-owned v0.1-to-v0.2 adaptation and compatibility validation |
| Obsidian | Publish/acceptance | user-managed application opening the Formal Wiki directly |

## V1 Completion Gate

V1 passes only when the canonical acceptance manifest records 17/17 benchmark journeys, 35/35 executable contracts and 11/11 acceptance validations as `pass`, using each validation's declared automated or human mode. Live Connector, recovery, desktop/mobile and Obsidian coverage are required. Any required `fail`, `blocked` or `not-run` result prevents completion. Critical and Important review findings must both be zero, and the Owner must complete the real Full Journey on the target machine.
