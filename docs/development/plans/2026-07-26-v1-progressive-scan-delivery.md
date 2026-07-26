# V1 Progressive Scan Delivery Plan

- Status: executable delivery plan
- Branch: `goal-v1-progressive-scan`
- Runtime: Node.js `24.16.0`, pnpm `10.33.2`
- Requirement: [`requirements-v1.md`](../../requirements/requirements-v1.md)
- Design: [`design_doc-v1-progressive-scan-and-wiki.md`](../../design/active/design_doc-v1-progressive-scan-and-wiki.md)
- Acceptance: [`v1-journeys-and-oracles.md`](../../acceptance/v1-journeys-and-oracles.md)
- Canonical Skill: [`SKILL.md`](../../../skills/openlifewiki-progressive-scan/SKILL.md)

## Execution Rules

Execute Tasks 0-7 in order. One subagent owns one Task, starts from a clean checkout containing the predecessor commit, writes the named RED test first, and stops when an exit gate fails. Preserve existing P0 behavior unless the Task explicitly replaces its boundary.

Before every Task:

```bash
node --version        # must be v24.16.0
pnpm --version       # must be 10.33.2
git status --short   # must contain no unknown related change
```

Every external project stays behind its official release or authenticated public interface. Test fixtures may replace a boundary only when the test does not claim to prove that boundary. Source bodies, credentials, runtime data and acceptance evidence stay outside Git.

Task exit evidence is intermediate engineering evidence. Smoke, `ACTIVE`, a component probe, a completed scan, a proposal or an open page cannot satisfy V1 acceptance. Required `blocked` or `not-run` results stop release judgment. Each review gate requires zero Critical and zero Important findings.

## Task 0 - Freeze Pure V1 Contracts (Complete)

**Goal:** freeze authorization, Connector/Agent registries, body-read gates, progress truth, MCP roles and Wiki approval/CAS as pure protocol/core behavior before adding I/O.

**Status:** completed by `8b6b913` and boundary hardening through `e0a6dae`; the current hash, trusted-ledger, root-path and progress follow-up must land as the final Task 0 fix before Task 1 starts.

**Files:**

- `packages/protocol/src/access.ts`
- `packages/protocol/src/agent.ts`
- `packages/protocol/src/connector.ts`
- `packages/protocol/src/scan.ts`
- `packages/protocol/src/wiki.ts`
- `packages/protocol/src/index.ts`
- `packages/core/src/access-policy.ts`
- `packages/core/src/agent-policy.ts`
- `packages/core/src/body-read-policy.ts`
- `packages/core/src/hashing.ts`
- `packages/core/src/progress.ts`
- `packages/core/src/registries.ts`
- `packages/core/src/wiki-approval.ts`
- `packages/core/src/index.ts`
- `packages/protocol/test/v1-contracts.test.ts`
- `packages/core/test/hashing.test.ts`
- `packages/core/test/v1-body-read-and-wiki.test.ts`
- `packages/core/test/v1-progress.test.ts`
- `packages/core/test/v1-registries-and-access.test.ts`

**RED tests already established:** unsupported Connector/status values; native Agent provider fields; hosted inline credentials; missing Selected Agent; untrusted or wrong-root descend receipts; body read before durable descent; false 100%; Visitor tool leakage; Admin/Visitor Wiki approval; stale proposal/base hashes.

**Reuse boundary:** pure TypeScript only. It declares QMD, Connector, Agent and compiler contracts and performs no filesystem, subprocess, network, private QMD or semantic work.

**Implementation steps:** finish canonical hashing and validation fixes; export only reviewed contracts; keep future Connector descriptors possible while the V1 supported registry remains exactly four; retain Owner-only Wiki approval and Visitor `query`-only policy.

**Verification:**

```bash
pnpm --filter @openlifewiki/protocol exec vitest run test/v1-contracts.test.ts
pnpm --filter @openlifewiki/core exec vitest run test/hashing.test.ts test/v1-body-read-and-wiki.test.ts test/v1-progress.test.ts test/v1-registries-and-access.test.ts
pnpm verify
git diff --check
```

**Exit gate:** all named tests pass on Node 24; no I/O enters core; every privileged action is hash/scope/role bound; the follow-up fix is committed.

**Review gate:** product, architecture and security reviewers confirm the contracts implement the Constitution, five Connector actions and 35 Edge Contract shapes with zero Critical/Important findings.

## Task 1 - Four Real Connector Probes And Visibility

**Goal:** show Local Folder, GitHub, Feishu and Codex History simultaneously with truthful provider/version, redacted identity/profile, approved scope, status, last probe and blocking reason. No scan or leaf body read occurs.

**Files:**

- `packages/adapters/src/connectors/connector-provider.ts` (new)
- `packages/adapters/src/connectors/local-folder.ts` (new)
- `packages/adapters/src/connectors/github.ts` (new)
- `packages/adapters/src/connectors/feishu.ts` (new)
- `packages/adapters/src/connectors/codex-history.ts` (new)
- `packages/adapters/src/connectors/index.ts` (new)
- `packages/adapters/src/connector-status-service.ts` (new)
- `packages/adapters/src/config-store.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/test/connector-probes.test.ts` (new)
- `packages/adapters/test/live-connector-probes.contract.test.ts` (new)
- `packages/companion/src/server.ts`
- `packages/companion/src/public/index.html`
- `packages/companion/src/public/app.js`
- `packages/companion/src/public/styles.css`
- `packages/companion/test/server.test.ts`
- `apps/cli/src/main.ts`
- `apps/cli/test/main.test.ts`

**First RED tests:** four rows remain present when any provider is missing; probes produce the four exact statuses; probe/enumeration body counters stay zero; identity changes invalidate approval; secrets redact; Feishu wrong-profile/wrong-tenant errors retain selected profile, redacted identity, tenant and effective scope; Codex schema/version mismatch blocks.

**Reuse boundary:** reuse `CONNECTOR_DESCRIPTORS`, `CommandRunner`, config/state stores, current Companion session/origin security and public provider interfaces. GitHub uses authenticated `gh`; Feishu uses the explicitly selected authenticated `lark-cli` profile; Codex uses a version-pinned `codex app-server` v2 JSON-RPC handshake. No token is copied or placed in arguments.

**Implementation steps:**

1. Implement one metadata-only `probe()` adapter per descriptor.
2. Bind each authorization preview to provider version, redacted identity fingerprint and exact scope hash.
3. For Feishu, execute the selected profile's public identity/tenant/scope probes before classifying permission failure; never switch profiles automatically.
4. For Codex, verify the pinned generated app-server v2 schemas needed by `thread/list` and `thread/read`; do not read `~/.codex` files.
5. Add CLI JSON status and the partial Sources workspace showing all four rows; defer scan controls to Task 2.

**Verification:**

```bash
pnpm --filter @openlifewiki/adapters exec vitest run test/connector-probes.test.ts
OPENLIFEWIKI_LIVE_CONNECTOR_TEST=1 pnpm --filter @openlifewiki/adapters exec vitest run test/live-connector-probes.contract.test.ts
pnpm --filter @openlifewiki/companion exec vitest run test/server.test.ts
pnpm --filter @openlifewiki/cli exec vitest run test/main.test.ts
pnpm verify
git diff --check
```

**Exit gate:** all four real probe paths are versioned, read-only and truthful; the intended Feishu profile is proven; Codex app-server v2 compatibility is proven; unavailable providers remain visible as non-passing status without fallback.

**Review gate:** Connector, privacy and UX reviewers verify identity/scope accuracy, zero body reads, redaction and four-row visibility with zero Critical/Important findings.

## Task 2 - Local Skeleton-First Scan, Ledger And QMD Generation

**Goal:** complete the first real vertical evidence chain: authorized Local Folder metadata -> Source Skeleton -> durable decision/checkpoint ledger -> selected current leaf stream -> temporary QMD generation -> public positive/negative probes -> atomic current generation.

**Files:**

- `packages/core/src/scan-ledger.ts` (new)
- `packages/core/src/scan-state-machine.ts` (new)
- `packages/core/src/checkpoint-policy.ts` (new)
- `packages/core/src/index.ts`
- `packages/core/test/scan-ledger.test.ts` (new)
- `packages/core/test/scan-state-machine.test.ts` (new)
- `packages/core/test/checkpoint-policy.test.ts` (new)
- `packages/adapters/src/connectors/local-folder.ts`
- `packages/adapters/src/scan-store.ts` (new)
- `packages/adapters/src/scan-scratch.ts` (new)
- `packages/adapters/src/scan-service.ts` (new)
- `packages/adapters/src/qmd-generation.ts` (new)
- `packages/adapters/src/qmd.ts`
- `packages/adapters/src/layout.ts`
- `packages/adapters/src/state-store.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/test/local-progressive-scan.test.ts` (new)
- `packages/adapters/test/scan-recovery.test.ts` (new)
- `packages/adapters/test/qmd-current-generation.contract.test.ts` (new)
- `apps/cli/src/main.ts`
- `apps/cli/test/main.test.ts`

**First RED tests:** initial discovery reads zero bodies; each list call returns direct children only; open cursors/unknown/blocked work prevent every false 100%; forged or stale descend receipts fail; pause/cancel removes body scratch; restart reuses exact valid checkpoints; changed leaf invalidates only its branch; failed QMD build/probe keeps the old pointer; removed/replaced canaries fail candidate publication; post-switch kill completes old-generation deletion before success.

**Reuse boundary:** extend the Task 0 policies, canonical Skill and Task 1 Local provider. Reuse QMD `2.5.3` official release through public CLI/MCP only. A deterministic Agent driver may exist only in tests to exercise the decision contract; it provides no production Agent capability claim.

**Implementation steps:**

1. Persist append-only page, decision and checkpoint receipts with canonical hashes; keep Layer Summary body in owner-only scratch.
2. Enforce `listRootsMetadata`, direct-child `listChildrenMetadata`, `getVersion` and `readApprovedLeafBody` in Skill order.
3. Record four independent progress dimensions, monotonic events and denominator changes.
4. Add pause/resume/cancel/retry and startup recovery at page, summary, decision, leaf and generation boundaries.
5. Build a complete temporary QMD generation, prove current and removed content through public query/get, switch `active.json`, delete the prior directory, then publish committed progress.
6. Expose preview/hash-gated scan commands through CLI; Task 6 will provide the final GUI.

**Verification:**

```bash
pnpm --filter @openlifewiki/core exec vitest run test/scan-ledger.test.ts test/scan-state-machine.test.ts test/checkpoint-policy.test.ts test/v1-progress.test.ts
pnpm --filter @openlifewiki/adapters exec vitest run test/local-progressive-scan.test.ts test/scan-recovery.test.ts
OPENLIFEWIKI_REAL_COMPONENT_TEST=1 pnpm --filter @openlifewiki/adapters exec vitest run test/qmd-current-generation.contract.test.ts
pnpm --filter @openlifewiki/cli exec vitest run test/main.test.ts
pnpm verify
git diff --check
```

**Exit gate:** a real nested Local Folder completes the chain with no pre-decision body read, truthful progress, exact recovery reuse, one active QMD generation and no body-bearing scratch at rest.

**Review gate:** architecture, privacy, recovery and QMD-boundary reviewers close all Critical/Important findings; private QMD inspection and answer-layer filtering are absent.

## Task 3 - Extend The Proven Provider Contract To gh, lark-cli And Codex

**Goal:** reuse the Task 2 scan engine unchanged for real GitHub, Feishu and bounded Codex History metadata/body/version operations.

**Files:**

- `packages/adapters/src/connectors/github.ts`
- `packages/adapters/src/connectors/feishu.ts`
- `packages/adapters/src/connectors/codex-history.ts`
- `packages/adapters/src/scan-service.ts`
- `packages/adapters/test/github-connector.contract.test.ts` (new)
- `packages/adapters/test/feishu-connector.contract.test.ts` (new)
- `packages/adapters/test/codex-app-server-v2.contract.test.ts` (new)
- `packages/adapters/test/live-progressive-scan.contract.test.ts` (new)
- `package.json`

**First RED tests:** out-of-scope repo/path/ref, Feishu object and Codex thread are denied before enumeration; pagination remains open until provider cursor closes; `nodeVersion` change fails selected read; GitHub deleted/changed content reconciles; Feishu wrong selected profile reports the real profile/tenant/scope; Codex `thread/list` omits preview/name/turn bodies and enforces exact approved `cwd` plus `useStateDbOnly: true`; `thread/read` accepts approved thread IDs only.

**Reuse boundary:** providers implement the same five Connector actions and feed the existing ledger/QMD generation service. Invoke authenticated `gh`, the selected `lark-cli` profile and pinned Codex app-server v2 public surfaces. Do not scrape provider storage, broaden to account scope or introduce provider-specific scan state machines.

**Implementation steps:**

1. Normalize each provider's stable IDs, cursor receipts, metadata, version and locators.
2. Build typed commands/JSON-RPC requests from the approved scope intersection.
3. Stream selected bodies through the existing version/body-read gate and current-generation builder.
4. Add opt-in live fixtures with unique canaries and redacted command/identity receipts.
5. Add `test:connectors:live` as a root script; missing authorization yields `blocked` for the live gate and never `pass`.

**Verification:**

```bash
pnpm --filter @openlifewiki/adapters exec vitest run test/github-connector.contract.test.ts test/feishu-connector.contract.test.ts test/codex-app-server-v2.contract.test.ts
OPENLIFEWIKI_LIVE_CONNECTOR_TEST=1 pnpm test:connectors:live
pnpm verify
git diff --check
```

**Exit gate:** each provider completes real probe, paginated skeleton, selected version-bound read, current QMD commit and public QMD query/get for its unique authorized fact; every scope/profile/schema failure stops visibly.

**Review gate:** provider-contract, security and live-evidence reviewers verify all three public boundaries and exact authorization intersections with zero Critical/Important findings.

## Task 4 - Six Agent Drivers And Policy-Aware MCP

**Goal:** run scan decisions and grounded query through all six Selected Agent choices, then replace the direct upstream MCP exposure with an openLifeWiki policy surface where Visitor discovers exactly `query`.

**Files:**

- `packages/adapters/src/agents/agent-driver.ts` (new)
- `packages/adapters/src/agents/native-cli.ts` (new)
- `packages/adapters/src/agents/provider-runtime.ts` (new)
- `packages/adapters/src/agents/index.ts` (new)
- `packages/adapters/src/agent-service.ts` (new)
- `packages/adapters/test/agent-drivers.contract.test.ts` (new)
- `packages/adapters/test/live-agent-drivers.contract.test.ts` (new)
- `packages/mcp/package.json` (new)
- `packages/mcp/tsconfig.json` (new)
- `packages/mcp/tsconfig.build.json` (new)
- `packages/mcp/src/tools.ts` (new)
- `packages/mcp/src/query-service.ts` (new)
- `packages/mcp/src/server.ts` (new)
- `packages/mcp/src/index.ts` (new)
- `packages/mcp/test/access.test.ts` (new)
- `packages/mcp/test/query.test.ts` (new)
- `packages/mcp/test/server.test.ts` (new)
- `packages/adapters/src/mcp-launcher.ts`
- `apps/cli/src/main.ts`
- `apps/cli/test/main.test.ts`
- `apps/cli/package.json`
- `package.json`
- `pnpm-lock.yaml`

**First RED tests:** all six drivers validate the same Skill/input/result hashes; missing CLI, expired login, hosted credential failure, timeout, refusal and malformed output remain distinct; no driver fallback occurs; native config rejects BaseURL/credential/model; hosted config rejects inline secrets; Visitor `tools/list` returns only `query`; Visitor Admin calls fail server-side; query returns current citations or exact no/partial/conflict modes; stale generation and prohibited raw exposure fail closed.

**Reuse boundary:** Codex, Claude Code and Gemini use existing authenticated native CLIs. Pi, OpenClaw and Hermes resolve provider references only through Host config. Reuse the canonical Skill, QMD public retrieval and Task 0 role policy. Pin the official MCP SDK release; QMD remains internal and exposes no direct Visitor tools.

**Implementation steps:** normalize one invocation/result envelope; implement native and provider-runtime transports; record actual Selected Agent/mode; build internal evidence retrieval and citation resolution; expose role-filtered tool schemas and hash-gated Admin operations; route `openlifewiki mcp --stdio` to the product server; retain the legacy QMD launcher only as an internal adapter until migration tests pass.

**Verification:**

```bash
pnpm --filter @openlifewiki/adapters exec vitest run test/agent-drivers.contract.test.ts
OPENLIFEWIKI_LIVE_AGENT_TEST=1 pnpm --filter @openlifewiki/adapters exec vitest run test/live-agent-drivers.contract.test.ts
pnpm --filter @openlifewiki/mcp exec vitest run test/access.test.ts test/query.test.ts test/server.test.ts
pnpm --filter @openlifewiki/cli exec vitest run test/main.test.ts
pnpm verify
git diff --check
```

**Exit gate:** six real drivers pass the normalized decision/query contract; failures never substitute runtime/provider/model; Visitor discovery is exactly `query`; Admin operations still require role plus preview/hash approval.

**Review gate:** Agent-runtime, MCP protocol, credential/privacy and authorization reviewers close all Critical/Important findings and prove no direct QMD or provider escape hatch.

## Task 5 - WikiProposal, Compiler Determinism, Owned OKF v0.2 And CAS

**Goal:** use the one Selected Agent for proposal semantics, reuse proven deterministic llm-wiki-compiler capabilities, fill the verified OKF v0.1-to-v0.2 gap in openLifeWiki, and publish only an exactly approved CAS-safe Vault.

**Files:**

- `packages/core/src/proposal-policy.ts` (new)
- `packages/core/src/wiki-approval.ts`
- `packages/core/src/index.ts`
- `packages/core/test/proposal-policy.test.ts` (new)
- `packages/core/test/v1-body-read-and-wiki.test.ts`
- `packages/adapters/src/compiler.ts` (new)
- `packages/adapters/src/okf-v02-adapter.ts` (new)
- `packages/adapters/src/obsidian-validator.ts` (new)
- `packages/adapters/src/proposal-store.ts` (new)
- `packages/adapters/src/wiki-publisher.ts` (new)
- `packages/adapters/src/index.ts`
- `packages/adapters/test/compiler-release.contract.test.ts` (new)
- `packages/adapters/test/okf-v02-adapter.test.ts` (new)
- `packages/adapters/test/wiki-publisher.test.ts` (new)
- `packages/adapters/test/wiki-publication-recovery.test.ts` (new)
- `apps/cli/src/main.ts`
- `apps/cli/test/main.test.ts`
- `package.json`
- `pnpm-lock.yaml`

**First RED tests:** any compiler attempt to invoke a second semantic provider stops; altered diff/Evidence/compiler receipt changes `proposalHash`; stale `baseWikiHash` fails CAS; only Owner approval publishes; reject and stale cases leave the Vault byte-identical; v0.1 `timestamp` maps only when `generated` is absent; unknown frontmatter and stable `page_uid` survive; invalid YAML/type/link/path/collision/profile fails before swap; kill recovery yields one approved Vault.

**Reuse boundary:** pin llm-wiki-compiler `1.1.0` and use only verified public candidate review, incremental/refresh, citation/freshness/link/lint/eval and OKF v0.1 exchange capabilities. Disable provider-dependent compiler commands unless a contract proves they use the same Selected Agent. openLifeWiki owns minimal v0.1-to-v0.2 adaptation, standard-link normalization, unknown-key preservation, Obsidian profile validation, proposal/base hashing and publication.

**Implementation steps:** freeze Evidence; invoke Selected Agent once for Concepts/taxonomy/tags/aliases/links/gaps/moves; run deterministic compiler checks; adapt/validate staging Vault; render immutable review diffs; record Owner approval; recompute proposal/base hashes; atomically swap the Vault; recover or restore by staging/active/receipt hashes.

**Verification:**

```bash
pnpm --filter @openlifewiki/core exec vitest run test/proposal-policy.test.ts test/v1-body-read-and-wiki.test.ts
OPENLIFEWIKI_REAL_COMPONENT_TEST=1 pnpm --filter @openlifewiki/adapters exec vitest run test/compiler-release.contract.test.ts
pnpm --filter @openlifewiki/adapters exec vitest run test/okf-v02-adapter.test.ts test/wiki-publisher.test.ts test/wiki-publication-recovery.test.ts
pnpm --filter @openlifewiki/cli exec vitest run test/main.test.ts
pnpm verify
git diff --check
```

**Exit gate:** one Selected Agent creates semantics; compiler use stays deterministic and v0.1-bounded; owned output passes OKF v0.2/Obsidian checks; rejection, stale CAS and failure never mutate the active Vault.

**Review gate:** compiler-contract, data-portability, security and recovery reviewers verify the owned gap and exact proposal approval with zero Critical/Important findings.

## Task 6 - Seven-Page Companion And Task-Bound Canvas

**Goal:** deliver Query, Sources, Wiki, Review, Agent, Canvas and Health as one fixed operational product, with Progressive Scan inside Sources and one revision-bound Canvas interaction at a time.

**Files:**

- `packages/companion/src/server.ts`
- `packages/companion/src/index.ts`
- `packages/companion/src/public/index.html`
- `packages/companion/src/public/app.js`
- `packages/companion/src/public/styles.css`
- `packages/companion/test/server.test.ts`
- `packages/companion/test/v1-browser.test.ts` (new)
- `packages/companion/playwright.config.ts` (new)
- `packages/companion/package.json`
- `package.json`
- `pnpm-lock.yaml`

**First RED tests:** seven pages expose one server truth; Sources shows four rows and scan dimensions; Review shows immutable hashes/diffs; stale tabs and conflicting leases fail; Visitor hidden Admin routes reject server-side; progress reconnect replays monotonically; Canvas replay/mismatched/expired events fail; long identity/hash/blocker content does not overlap at `1440x900` or `390x844`; keyboard/labels remain understandable without color.

**Reuse boundary:** extend the loopback-only Companion, token/origin checks, current application services, lucide-static icons and task-bound screen/event contract. Add Playwright for real browser flows. Canvas stores no lifecycle, scan, proposal or approval truth.

**Implementation steps:** expose typed read models and mutations from existing services; build the seven fixed views; add progress event replay, pause/resume/cancel/retry, proposal review and Obsidian-open actions; add server-derived role capabilities and leases; render one redacted Canvas screen with task/revision checks; verify responsive and accessible states.

**Verification:**

```bash
pnpm --filter @openlifewiki/companion exec vitest run test/server.test.ts
pnpm --filter @openlifewiki/companion exec playwright test --config playwright.config.ts
pnpm verify
git diff --check
```

**Exit gate:** all seven pages complete their real application-service journeys at both required viewports; Visitor/Admin boundaries hold server-side; Canvas cannot mutate or retain durable truth; no overlap, truncation or color-only state remains.

**Review gate:** product, UX/accessibility, security and concurrency reviewers inspect Playwright traces/screenshots and close all Critical/Important findings.

## Task 7 - Acceptance Harness, Packaging And Owner UAT

**Goal:** build one installable release candidate, collect tamper-evident external evidence, execute all canonical suites and complete the continuous Owner no-reset rehearsal.

**Files:**

- `scripts/v1/build-release.mjs` (new)
- `scripts/v1/run-controlled.mjs` (new)
- `scripts/v1/run-live.mjs` (new)
- `scripts/v1/run-recovery.mjs` (new)
- `scripts/v1/run-ui.mjs` (new)
- `scripts/v1/run-storage.mjs` (new)
- `scripts/v1/generate-capacity-corpus.mjs` (new)
- `scripts/v1/verify-evidence.mjs` (new)
- `scripts/v1/test-release-artifact.mjs` (new)
- `package.json`
- `pnpm-lock.yaml`
- `apps/cli/package.json`
- `skills/openlifewiki-install/SKILL.md`
- `README.md`
- `docs/memory-bank/active-context.md`
- `docs/governance/changelog.md`

**First RED tests:** release artifact installs on a clean Node 24 environment; result IDs are unique/complete; evidence hashes resolve under one `runId` and release digest; credentials/bodies are absent; each suite rejects mock evidence across its tested boundary; `blocked`/`not-run` and any Critical/Important finding reject sign-off; default uninstall preserves Source/Wiki; a reset/reseed breaks AV-11.

**Reuse boundary:** orchestrate the executable product tests delivered by Tasks 1-6 and the canonical `controlled`, `live`, `recovery`, `ui`, `storage`, `obsidian-human`, `desktop-mobile-human` and `no-reset-rehearsal` suites. Evidence lives under an Owner-selected path outside Git. Human Obsidian and desktop/mobile checks retain human identity and cannot be auto-marked.

**Implementation steps:** build and digest the release; generate deterministic controlled and 10,000-item/2-GB capacity fixtures outside Git; run all automated suites; collect live four-Connector and six-Agent evidence; perform human Obsidian/desktop/mobile checks; execute AV-11 without runtime/workspace reset; verify 63 receipts/results; update README and status docs only after real capability passes; run update and default uninstall last.

**Verification:**

```bash
pnpm release:v1
pnpm acceptance:v1:controlled
pnpm acceptance:v1:live
pnpm acceptance:v1:recovery
pnpm acceptance:v1:ui
pnpm acceptance:v1:storage
pnpm acceptance:v1:verify -- --evidence-root "$OPENLIFEWIKI_ACCEPTANCE_ROOT" --run-id "$OPENLIFEWIKI_RUN_ID"
rg -o '^### BJ-[0-9]{2}' docs/acceptance/v1-journeys-and-oracles.md | wc -l
rg -o '^\| EC-[A-Z]+-[0-9]{2} ' docs/acceptance/v1-journeys-and-oracles.md | wc -l
rg -o '^### AV-[0-9]{2}' docs/acceptance/v1-journeys-and-oracles.md | wc -l
pnpm verify
git diff --check
```

Expected inventory is `17`, `35`, `11` and final results are `63 pass, 0 fail, 0 blocked, 0 not-run`.

**Exit gate:** the same release and continuous workspace history pass BJ-01..17, all 35 Edge Contracts and AV-01..11; Live Connector, six live Agent, recovery, 2-GB storage, desktop/mobile and Obsidian evidence is present; Owner signs the hashed manifest; update/default uninstall preserve the approved Wiki.

**Review gate:** independent release, acceptance, privacy/security and Owner reviews record zero Critical and zero Important findings. Smoke or reduced fixtures cannot close any gate. Any required `fail`, `blocked` or `not-run` stops release and V1 remains incomplete.
