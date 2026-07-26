# openLifeWiki V1 Journeys And Acceptance Oracles

- Status: canonical V1 acceptance authority; implementation pending
- Date: 2026-07-26
- Audience: Owner, implementation team, release reviewer and acceptance operator
- Requirements: [`requirements-v1.md`](../requirements/requirements-v1.md)
- Design: [`design_doc-v1-progressive-scan-and-wiki.md`](../design/active/design_doc-v1-progressive-scan-and-wiki.md)
- Recovery decision: [`ADR-0003-progressive-scan-control-plane.md`](../decisions/ADR-0003-progressive-scan-control-plane.md)
- Red lines: [`core-red-lines.md`](../product/core-red-lines.md)

## 1. Release Judgment

V1 passes when one release candidate satisfies all applicable Business Journeys, Edge Contracts and Acceptance Verifications in this document and the Owner completes the no-reset rehearsal. Component readiness, `ACTIVE`, a completed scan, a generated proposal or a page that opens cannot replace these oracles.

Every execution of a check appends one attempt result: `pass | fail | blocked | not-run`. Only `pass` is passing. A retry creates a new `attemptId`; it cannot overwrite, delete or relabel an earlier attempt. The final release view contains exactly one verdict per required ID and cites the attempt plus evidence content hashes that support that verdict. A required final `blocked` or `not-run` verdict prevents V1 completion. Critical and Important review findings must both equal zero at release judgment.

The release reviewer must reject evidence that is mocked across the boundary under test, manually edited after capture, missing its receipt hash, produced by a different build, or detached from the declared `runId`.

## 2. Evidence Contract

One acceptance run writes redacted evidence outside Git under:

```text
<acceptance-evidence-root>/v1/<runId>/
  run-start.json
  run-start.json.sig
  manifest.json
  manifest.json.sig
  environment.json
  results.json
  attempts.jsonl
  evidence-index.json
  owner-acceptance-receipt.json
  receipts/<operationId>.json
  controlled/
  live/
  recovery/
  ui/
  storage/
  obsidian-human/
  desktop-mobile-human/
  no-reset-rehearsal/
```

Before any check executes, the Owner creates `run-start.json` with `runId`, release Git SHA, the sorted exact array of all 63 expected IDs, expected-ID count, a freshly generated 256-bit `ledgerGenesisHash`, signing algorithm, namespace, externally trusted public-key fingerprint and detached signature path. The Owner signs this file with the external trust anchor defined below. The first attempt's `previousAttemptHash` must equal the signed `ledgerGenesisHash`.

`attempts.jsonl` is an append-only ledger. Each line contains `attemptId`, required check ID, result, suite, operator, start/end time, release Git SHA, Host config hash, component versions, evidence paths, evidence content hashes, receipt hashes, `previousAttemptHash` and its own `attemptHash`. `attemptHash` is SHA-256 over the canonical line with the `attemptHash` field omitted. Every later line's `previousAttemptHash` equals the preceding line's `attemptHash`. Retry appends a new line with a new `attemptId`. A failed, blocked or not-run attempt remains permanently visible.

`results.json` contains every required ID exactly once as a release verdict. Each verdict contains `result`, all relevant `attemptIds`, one `verdictAttemptId`, and the exact evidence/receipt content hashes selected from that attempt. A `pass` verdict is valid only when `verdictAttemptId` is a passing attempt under the same release Git SHA, Host config hash and component versions and every referenced content hash resolves. Editing `results.json` cannot convert an old attempt into a pass.

`evidence-index.json` contains the relative path, media type, byte count and SHA-256 content hash of every suite evidence file and operation receipt produced before Owner sign-off; it excludes final `manifest.json` and `owner-acceptance-receipt.json` to avoid circular hashing. `manifest.json` binds the signed run-start content/signature hashes, release Git SHA, canonical redacted Host config hash, canonical Skill hash, exact component versions and component-manifest hash, environment hash, operating system/runtime versions, test corpus hash, `results.json` hash, full append-only attempt-ledger hash, final `attemptHash`, `evidence-index.json` hash, the sorted map of all indexed evidence content hashes, Owner acceptance receipt content hash and start/end time. It also records the final-signature algorithm, `openlifewiki-v1-acceptance` namespace, externally trusted public-key fingerprint and detached `manifest.json.sig` path. The final manifest is valid only when all bindings recompute exactly. Replacing an attempt, verdict, receipt, evidence file, environment, component version, Host config, Git revision, run-start or Owner receipt invalidates it.

The Owner acceptance receipt records the Owner decision and an `acceptanceSetHash` over the release Git SHA, Host config hash, component versions, results hash, final attempt/ledger hashes and evidence-index/all-content hashes. The final manifest is assembled after that receipt and binds its content hash. The Owner then signs the frozen final manifest with the same externally trusted identity. A rerun uses a new `runId` and new attempt IDs; it never edits the prior run. A retry within a run appends to the ledger and recomputes verdict, index, Owner receipt and final manifest. Missing lineage, a broken hash chain or a path-only evidence reference cannot support `pass`. Receipt and evidence files must contain no credential, Source body, Layer Summary body, raw query exposure or unredacted identity.

### External Trust Anchor

The signing private key remains outside openLifeWiki, the acceptance run directory, logs, Host config and every evidence artifact. Before the run, the reviewer pins the Owner's SSH/Ed25519 public key or allowed-signers file outside the run directory and records its expected fingerprint through a trusted out-of-band process. A public key copied from the evidence directory cannot establish trust.

The macOS default verification path is OpenSSH with the fixed namespace `openlifewiki-v1-acceptance`:

```bash
ssh-keygen -Y sign -f <owner-private-key-outside-product> -n openlifewiki-v1-acceptance run-start.json
ssh-keygen -Y verify -f <trusted-allowed-signers-outside-run> -I <owner-principal> -n openlifewiki-v1-acceptance -s run-start.json.sig < run-start.json
ssh-keygen -Y sign -f <owner-private-key-outside-product> -n openlifewiki-v1-acceptance manifest.json
ssh-keygen -Y verify -f <trusted-allowed-signers-outside-run> -I <owner-principal> -n openlifewiki-v1-acceptance -s manifest.json.sig < manifest.json
```

An equivalent detached Ed25519 implementation is permitted only when run-start and manifest record its algorithm, namespace/domain separator, public-key fingerprint and signature paths and the reviewer uses the preconfigured external public key. The reviewer must verify run-start signature/fingerprint before reading attempts, verify the genesis-to-final attempt chain and all manifest bindings, then verify the final manifest signature/fingerprint. A missing or invalid signature, untrusted/mismatched key, wrong namespace, broken chain, changed expected-ID set or failed content binding makes the release `fail`. No local rerun can repair an earlier signed run or manufacture a passing signature.

The frozen manifest uses an explicit descriptor such as:

```json
{
  "signing": {
    "algorithm": "ssh-ed25519",
    "namespace": "openlifewiki-v1-acceptance",
    "publicKeyFingerprint": "SHA256:...",
    "signaturePath": "manifest.json.sig"
  }
}
```

### Required Suite Types

| Suite | Boundary and permitted fixtures |
| --- | --- |
| `controlled` | Deterministic authorized fixtures exercised through real public openLifeWiki, Connector, Agent-driver, QMD and compiler surfaces. A fake is permitted only outside the boundary named by the check and must be declared in `environment.json`. |
| `live` | Opt-in Owner-authorized Local Folder, GitHub, Feishu and Codex History Sources through their real provider surfaces, identities, pagination and current content. |
| `recovery` | Real subprocess termination or process kill at the named commit boundary, followed by normal startup recovery with no receipt editing. |
| `ui` | Management Companion served by the release candidate and driven through its real HTTP/session/API boundary with Playwright and accessibility assertions. |
| `storage` | Instrumented filesystem and process audit over the bounded corpus, including scratch high-water marks and post-operation residue. |
| `obsidian-human` | A human opens the actual Formal Wiki root in a supported Obsidian release without a required plugin and records the named observations. |
| `desktop-mobile-human` | A human inspects the same release state at `1440x900` and `390x844`, including keyboard and screen-reader-visible labels. |

### Target Owner Machine Scale Gates

The V1 capacity result is valid only on the designated Owner machine recorded in `environment.json`. Record CPU model and logical cores, installed memory, OS/build, storage medium and free bytes, power mode, network/provider conditions and measurement tool versions. Sample the complete openLifeWiki process tree and storage paths throughout the capacity run. The fixed passing thresholds are:

| Metric | Passing threshold |
| --- | --- |
| Progress liveness | Maximum gap between a progress event or heartbeat is `<= 5 seconds` from capacity-plan start until terminal receipt, including provider waits. |
| Pause responsiveness | Pause acknowledgement is emitted `<= 10 seconds` after the accepted pause request timestamp. |
| Companion status | Loopback Companion status response p95 is `<= 1 second` over at least 100 evenly sampled requests during the capacity run. |
| Productive progress | When no provider wait is justified, neither node nor byte progress may remain unchanged for more than `120 seconds`. A justified wait requires a redacted provider-call operation ID, start/end timestamps and wait reason in the event stream. |
| End-to-end duration | The full 2,147,483,648 selected/read/committed-byte capacity run completes in `<= 90 minutes` from accepted capacity-plan start to successful current-generation receipt. |
| Process memory | Sampled aggregate RSS high-water across openLifeWiki and its child processes is `<= 4 GiB` (`4294967296` bytes). |
| Body-bearing scratch | Body-bearing scratch high-water is `<= 64 MiB` (`67108864` bytes). |
| QMD disk | Temporary plus active QMD disk high-water is `<= 3 * selectedBodyBytes + 512 MiB`; for the required capacity run this is `6979321856` bytes. |
| Resting generations | After success, exactly one active QMD generation remains and no temporary or prior generation directory remains. |

Every threshold is mandatory. Exceeding one, omitting a sample stream, changing the target hardware mid-run or claiming an undeclared provider wait prevents `pass`. Resource limits on the Owner machine yield `fail` or `blocked`; they do not authorize relaxed thresholds.

The complete journey uses `no-reset-rehearsal`. That label is normative and must appear in the evidence manifest. It means one continuous installation and workspace history with no runtime reset, database replacement, Wiki replacement, fixture reseed or manual receipt repair between steps.

## 3. Business Journeys

Each Business Journey proves an Owner- or Visitor-visible result. The cited evidence paths below are relative to the run directory.

### BJ-01 Install Through First Cited Query

- **Precondition:** supported clean machine or declared clean VM; official release artifact available; Owner controls one authorized Markdown fixture with a unique fact.
- **Steps:** discover the product; preview and approve install/initialize; verify pinned components; preview and approve the Local Folder authorization; activate; register the policy-aware MCP through the selected Agent's public surface; invoke Visitor `query` for the unique fact.
- **Oracle:** stable states advance only after their probes pass; Source reading begins only after authorization; Visitor discovery exposes exactly `query`; the answer cites the current authorized fixture with a resolvable locator and active generation ID.
- **Evidence:** `controlled/BJ-01/`, initialization, authorization, QMD generation and query receipts.
- **Suites:** `controlled`, with the final Owner run repeated in `no-reset-rehearsal`.

### BJ-02 Grounded Writing

- **Precondition:** current committed Evidence includes at least two authorized facts, one known gap and one unique canary in a scope that the Owner will remove.
- **Steps:** ask the Selected Agent to draft a reusable note for a named audience; inspect its claims and citations; capture the canary leaf's body-read counter; approve the narrower Source authorization; immediately retry scan/query access to the excluded leaf; complete the queued current-source reconciliation into a new QMD generation; request the revised note.
- **Oracle:** each material claim is grounded by a resolvable current citation or marked as an inference/gap; the excluded leaf's body-read counter stops increasing at authorization approval; query cannot expose the canary while reconciliation is pending; reconciliation publishes a new current generation whose public QMD query/get cannot find the canary; the prior generation directory is deleted before reconciliation success; the revised note excludes the newly unauthorized evidence; no draft writes the Formal Wiki.
- **Evidence:** `controlled/BJ-02/` with redacted prompts, answer envelopes, old/new authorization hashes, per-leaf read counters, reconciliation queued/completed receipts, old/new QMD generation receipts, public negative query/get probes and prior-generation deletion audit.
- **Suites:** `controlled`, `live`.

### BJ-03 Grounded Decision

- **Precondition:** committed Evidence contains alternatives, constraints and at least one uncertainty.
- **Steps:** request a decision with criteria and trade-offs; open each citation; then remove one decisive item from the current Source and run the approved incremental path.
- **Oracle:** the decision separates evidence, inference and unresolved uncertainty; citations resolve to the active generation; the second decision reflects the removal and cannot cite the prior body.
- **Evidence:** `controlled/BJ-03/`, decision envelopes and both generation receipts.
- **Suites:** `controlled`, `live`.

### BJ-04 Grounded Review And Retrospective

- **Precondition:** a time-bounded project corpus contains events, outcomes and explicit missing records.
- **Steps:** request a retrospective; inspect chronology, outcomes, lessons and gaps; follow every citation.
- **Oracle:** chronology and outcomes match current evidence, unsupported causal claims are labeled, missing periods remain visible and no historical QMD body fills a gap.
- **Evidence:** `controlled/BJ-04/` and citation-resolution report.
- **Suites:** `controlled`, `live`.

### BJ-05 No, Partial And Conflicting Evidence

- **Precondition:** three controlled questions respectively have zero evidence, incomplete evidence and two current contradictory Sources.
- **Steps:** invoke the same Visitor `query` contract for all three.
- **Oracle:** result modes are exactly `no-evidence`, `partial-evidence` and `conflicting-evidence`; partial and conflicting results identify supported bounds and citations; none invents a definitive answer.
- **Evidence:** `controlled/BJ-05/` with three answer envelopes and retrieval receipts.
- **Suites:** `controlled`.

### BJ-06 Visitor And Admin Permissions

- **Precondition:** active Visitor and Admin sessions exist against the same runtime.
- **Steps:** discover and invoke capabilities from both sessions; attempt scan, Source, proposal and lifecycle mutations as Visitor; perform one preview/hash-gated scan action as Admin.
- **Oracle:** Visitor discovers exactly `query`; every Visitor management invocation is absent or denied server-side; Admin sees permitted management operations; Admin still cannot publish a Wiki mutation without exact Owner approval and compare-and-swap.
- **Evidence:** `controlled/BJ-06/` and `ui/BJ-06/` with tool manifests and authorization decisions.
- **Suites:** `controlled`, `ui`.

### BJ-07 Policy-Controlled Raw Exposure

- **Precondition:** one normal authorized leaf, one sensitive leaf awaiting approval and one excluded leaf are distinguishable by unique canaries.
- **Steps:** query with raw exposure off; request raw exposure for each leaf; approve only the normal leaf path.
- **Oracle:** raw exposure is an explicit mode inside `query`; only the approved normal content appears; sensitive and excluded canaries never appear; diagnostic downloads, events and receipts contain no raw body.
- **Evidence:** `controlled/BJ-07/`, raw-exposure decisions and redaction scan report.
- **Suites:** `controlled`, `live`, `ui`.

### BJ-08 Four Real Connector Chains

- **Precondition:** Owner has approved a bounded Local Folder, one GitHub repository/path/ref, one Feishu profile and explicit document/wiki/base scope, plus explicit Codex task IDs/project roots.
- **Steps:** probe identity/version/scope; enumerate metadata pages; approve descent; read selected current leaves; commit them; query one unique fact from each Source.
- **Oracle:** all four Connector rows are simultaneously truthful; every fact traverses the real provider public surface to the active QMD generation and a resolvable citation; Feishu records selected profile, redacted identity and effective scope; Codex History performs no account-wide discovery.
- **Evidence:** `live/BJ-08/<connector>/` with redacted provider command receipts, page receipts, body-read counters, QMD receipt and query envelope.
- **Suites:** `live`.

### BJ-09 QMD Current Replacement And Rebuild

- **Precondition:** generation A contains unique canaries for a retained leaf, a leaf that will change, a leaf that will be deleted and a leaf whose authorization will be removed; each leaf has an instrumented body-read counter.
- **Steps:** change and delete the named Source leaves; approve the narrower authorization; immediately attempt another read of the excluded leaf and record the unchanged counter; require a current-source reconciliation receipt; run approved incremental discovery; build generation B from the complete selected current manifest; verify current and excluded canaries through QMD public query/get; publish B; delete A's whole generation directory.
- **Oracle:** authorization narrowing blocks every new read at approval time and query cannot expose the excluded canary while reconciliation is pending; retained and replacement content resolve from B; changed, deleted and authorization-removed canaries are absent through public query/get and storage audit; the reconciliation receipt binds the narrower authorization hash to B; `active.json` points to B; A is absent before reconciliation success; no QMD private file, table or API was accessed.
- **Evidence:** `controlled/BJ-09/` and `storage/BJ-09/` with authorization hashes, before/after body-read counters, reconciliation receipt, both manifests, positive/negative public probes, active-pointer receipt and prior-generation deletion audit.
- **Suites:** `controlled`, `storage`.

### BJ-10 OKF Proposal Review And Approval

- **Precondition:** current Evidence supports at least two Concepts, one link, tags, aliases, provenance, freshness and a known gap.
- **Steps:** Selected Agent creates proposal semantics; compiler public surfaces produce deterministic review and quality evidence; Owner reviews directory/file/tag/link/Evidence diffs and hashes; Owner approves; publisher rechecks hashes and publishes.
- **Oracle:** output is valid OKF v0.2 and the Obsidian Compatibility Profile; every directory has `index.md`; approval is bound to immutable `proposalHash` and reviewed `baseWikiHash`; no second Agent/provider performs semantics; rejection and stale-hash variants leave the Wiki byte-identical.
- **Evidence:** `controlled/BJ-10/`, proposal manifest, compiler receipt, approval receipt and before/after Vault hashes.
- **Suites:** `controlled`, `obsidian-human`.

### BJ-11 Crash Recovery At Commit Boundaries

- **Precondition:** a multi-level controlled Source and valid prior active generation exist; recovery kill hooks are enabled only for the test run.
- **Steps:** terminate separately during discovery page commit, Layer Summary creation, selected leaf read and QMD generation commit; restart normally after each termination.
- **Oracle:** under [core red line 15](../product/core-red-lines.md) and [ADR 0003](../decisions/ADR-0003-progressive-scan-control-plane.md), discovery resumes at the last complete cursor and deduplicates stable IDs; summary body scratch is deleted and recomputed; an interrupted leaf read deletes scratch and rereads only that incomplete leaf. A failed pre-switch full-generation build deletes temporary QMD data and retains the prior active generation. Its retry may rematerialize every already selected current leaf needed for a new complete temporary generation only after `getVersion` and `expectedVersion`/content-hash validation. Matching leaves retain discovery, summary, Agent decision, selection and logical completion checkpoints; rematerialization increments no completed progress counter and is recorded separately as `rematerializedItems` and `rematerializedBytes`. A version/hash change invalidates only the affected branch and opens a new incremental plan before any commit. A post-switch failure finishes old-generation deletion before success.
- **Evidence:** `recovery/BJ-11/<kill-point>/` with kill marker, pre/post logical checkpoint manifests, initial-read and rematerialization counters, expected/observed version hashes, scratch audits, incremental-plan receipt where applicable and recovery receipt.
- **Suites:** `recovery`, `storage`.

### BJ-12 Virtual Classification And Approved Real Move

- **Precondition:** a Concept has stable `page_uid`, unknown frontmatter, one primary folder and controlled cross-cutting tags.
- **Steps:** apply a virtual category/filter; verify the Vault; create a proposal for a real primary-folder move; reject once; regenerate and approve once.
- **Oracle:** virtual classification changes no file path or body; rejection leaves the Vault byte-identical; approval moves the file, preserves `page_uid`, unknown frontmatter, aliases and valid links, and regenerates affected indexes.
- **Evidence:** `controlled/BJ-12/` and `obsidian-human/BJ-12/` with manifests, diffs and Vault hashes.
- **Suites:** `controlled`, `obsidian-human`.

### BJ-13 Six Agent Consistency

- **Precondition:** Codex, Claude Code and Gemini native CLIs have their own valid logins; Pi, OpenClaw and Hermes have valid Host provider references; one canonical input fixture is frozen.
- **Steps:** run layer decision, grounded query and proposal-contract exercises through each Agent driver.
- **Oracle:** all six consume the same canonical Skill and normalized input/output schemas, enforce identical authorization and citation rules, record actual identity/mode, and surface their own failures without substitution; semantic wording may vary while contract outcomes remain equivalent.
- **Evidence:** `controlled/BJ-13/<agent>/` with Skill/input hashes, normalized outputs and failure taxonomy results.
- **Suites:** `controlled`, with opt-in live provider calls declared in `environment.json`.

### BJ-14 Superpower Canvas

- **Precondition:** one scan ambiguity and one proposal taxonomy judgment require a visual decision.
- **Steps:** explicitly open the task-bound Canvas from the originating durable page; render a redacted screen; submit one allowed event; replay it, alter its revision and let another screen expire.
- **Oracle:** screen and event bind to the same `taskId` and monotonic `revision`; only the first valid event is accepted; replayed, mismatched, expired and unknown events fail closed; Canvas stores no lifecycle, scan or proposal truth and returns to the originating page.
- **Evidence:** `ui/BJ-14/` with screen/event envelopes, rejection codes and post-expiry state proof.
- **Suites:** `ui`, `desktop-mobile-human`.

### BJ-15 Sessions, Concurrency, Cancel And Locks

- **Precondition:** two Admin sessions, one Visitor session and a resumable scan plan exist.
- **Steps:** start a mutation in Admin A; attempt a conflicting mutation and proposal approval in Admin B; observe as Visitor; request Cancel; reconnect all sessions; retry with the released lease.
- **Oracle:** one runtime mutation lease and one approval lease per `baseWikiHash` are enforced; observers receive monotonic progress; Cancel prevents new work, removes body-bearing scratch, preserves completed committed generation/checkpoints and records incomplete outcomes; stale sessions cannot replay an approval.
- **Evidence:** `controlled/BJ-15/` and `ui/BJ-15/` with lease, event cursor, cancel and retry receipts.
- **Suites:** `controlled`, `ui`, `recovery`.

### BJ-16 Update And Default Uninstall Preserve Wiki

- **Precondition:** installed V1 runtime has an approved Formal Wiki, active Source authorization, Agent registration and current QMD generation.
- **Steps:** preview and execute an update; rerun prior supported journeys; preview and execute default uninstall.
- **Oracle:** update is atomic or recoverable and retains authorization/Wiki identity; uninstall removes registrations, processes, components, runtime metadata and derived indexes; original Sources and confirmed Formal Wiki remain byte-identical; the final local receipt lists retained paths.
- **Evidence:** `controlled/BJ-16/` with update/uninstall plans, receipts, process/registration audit and before/after Wiki hash.
- **Suites:** `controlled`, `storage`, `obsidian-human`.

### BJ-17 10,000 Items And 2 GB

- **Precondition:** the designated Owner machine hardware/environment is frozen and recorded as required by the Target Owner Machine Scale Gates. A deterministic authorized corpus contains at least 10,000 leaves across paginated hierarchy, with changed/deleted leaves, sensitive branches and unique old/current canaries. A capacity-plan selection manifest names fixture bodies totaling exactly 2,147,483,648 bytes. A deterministic generator may create the corpus at test runtime; the repository stores no generated corpus or Source body, and evidence records the generator version, seed and output manifest hash.
- **Steps:** enumerate every authorized hierarchy page until all cursors close and all child counts resolve; record complete discovery; execute a capacity scan plan that selects, actually reads and commits fixture bodies totaling 2,147,483,648 bytes; collect heartbeat/progress, pause acknowledgement, at least 100 Companion status latencies, provider-wait, process-tree RSS, scratch and QMD disk time series; pause and resume during the run; build/publish QMD; run an incremental change; audit runtime and storage throughout.
- **Oracle:** `discoveredLeaves >= 10000`, `openPages = 0` and `unknownParents = 0` before Discovery can pass; the receipt records `discoveredBodyBytes`, `selectedBodyBytes`, `readBodyBytes` and `committedBodyBytes`, with the last three each exactly `2147483648`; every fixed Target Owner Machine Scale Gate passes, including `<=5s` heartbeat/progress gap, `<=10s` pause acknowledgement, `<=1s` Companion status p95, `<=120s` unjustified progress stall, `<=90m` duration, `<=4GiB` aggregate RSS, `<=64MiB` body-bearing scratch and QMD disk high-water within the formula; configured node/body/Agent budgets are enforced; restart repeats no valid logical checkpoint; scratch is body-free after pause/success; at rest there is no second durable Source-body mirror and exactly one active current QMD generation remains.
- **Evidence:** `storage/BJ-17/` with environment/hardware and measurement-tool record, generator/seed and corpus manifest hashes, closed pagination receipts, discovery counters, capacity start/end timestamps, heartbeat/progress stream, pause timestamps, Companion latency samples/p95, justified provider-wait events, `discovered/selected/read/committed` byte counters, process-tree RSS/scratch/QMD disk high-water series, per-leaf read counters, generation receipts and residue audit.
- **Suites:** `storage`, `recovery`.

## 4. Edge Contracts

Every row requires an executable failure injection. Expected behavior must be observed through the public product surface and durable receipts. The final column names evidence that is forbidden as proof of a pass because it would conceal or violate the boundary.

| ID | Failure injection | Expected fail-closed result | Forbidden pass evidence |
| --- | --- | --- | --- |
| EC-IDENTITY-01 | Select a valid Feishu login profile that belongs to the wrong tenant. | Probe reports `blocked` with selected profile, redacted identity, tenant and scope remediation; enumeration and body reads stay at zero. | Generic permission error, automatic profile switch, token output or any Source result. |
| EC-IDENTITY-02 | Change provider identity after authorization preview and before execution. | Identity fingerprint/hash mismatch invalidates the plan and requires a new preview and Owner approval. | Execution under the new identity, reused approval or a success receipt with the old hash. |
| EC-IDENTITY-03 | Add a repository, path, task, project, Feishu object or local path outside approved scope through discovery/config text. | Effective scope remains the approved intersection and the attempted expansion returns `SCOPE_*` or `ask-user` without access. | Newly discovered content, inferred account-wide scope or rewritten authorization. |
| EC-IDENTITY-04 | Place token-shaped values in environment errors, provider output and Host resolution errors. | Redaction removes credential values from arguments, logs, GUI, receipts, proposals and Wiki while preserving a stable failure code. | Secret value, reversible secret fragment or a body/credential-bearing diagnostic archive. |
| EC-AGENT-01 | Remove the selected native Agent CLI. | Operation stops with `AGENT_MISSING`; Selected Agent and input hash remain recorded. | Another Agent result, provider fallback or a generic success. |
| EC-AGENT-02 | Expire the selected native Agent login. | Operation stops with `AGENT_AUTH_REQUIRED` and the native login remediation. | BaseURL/token prompt inside openLifeWiki, another native CLI or hosted fallback. |
| EC-AGENT-03 | Add `baseUrl`, `credentialRef` or token to a native Agent entry. | Host config validation rejects activation before invocation. | Sanitized-and-accepted native config or a child process receiving the field. |
| EC-AGENT-04 | Break a hosted credential reference or provider endpoint. | The selected Pi/OpenClaw/Hermes driver reports its structured provider failure and performs no semantic action. | Inherited credentials, another BaseURL/model/runtime or resolved secret in output. |
| EC-AGENT-05 | Return malformed JSON, an unknown decision or an input hash mismatch. | Result is `AGENT_OUTPUT_INVALID`; no decision checkpoint, body read or proposal is published. | Parsed prose guess, default `descend` or a repaired receipt. |
| EC-AGENT-06 | Force timeout, refusal and process termination in separate attempts. | Each retains its distinct failure code; retry uses the same input hash unless a new plan is approved. | Collapsed success, changed hidden prompt/model or silent Agent substitution. |
| EC-SOURCE-01 | Request a local root, repository, Feishu object or Codex history item with no authorization record. | Provider action is denied before enumeration; read counters remain zero. | Filesystem/provider result, auto-created authorization or inferred parent scope. |
| EC-SOURCE-02 | Leave pagination cursor open or child count unknown. | Progress remains open-ended, `unknown/openPages` stays visible and affected discovery cannot reach 100%. | Rounded 100%, dropped cursor or guessed denominator. |
| EC-SOURCE-03 | Instrument an unselected leaf and attempt a body read before a durable descend receipt. | `SCAN_BODY_READ_DENIED`; body-read counter and body-bearing scratch stay zero. | Leaf text in Layer Summary, Agent input, logs, events or receipts. |
| EC-SOURCE-04 | Mark a selected branch sensitive and withhold Owner approval. | Decision becomes `ask-user`; no sample/body action proceeds and denial is durable metadata only. | Automatic descent, a content preview or sensitivity downgraded by `WIKI.md`. |
| EC-SOURCE-05 | Change `nodeVersion` between selection and `readApprovedLeafBody` or QMD recovery rematerialization. | Expected-version/hash check fails, invalidates the affected branch checkpoint and opens a new incremental plan while preserving valid sibling logical checkpoints. | Commit of stale bytes, continuation under the old plan, unchanged skeleton version or repeated sibling discovery/summary/decision. |
| EC-QMD-01 | Terminate or fail the temporary full-generation build after selected bodies were staged. | Body scratch and the temporary generation are deleted, active pointer and prior generation remain unchanged, and no committed receipt is emitted. Retry may rematerialize selected current bodies from their Sources only after expected-version/hash validation; it records `rematerializedItems/Bytes`, repeats no discovery/summary/Agent decision/selection checkpoint and increments no completed progress count. | Partial active generation, persistent body cache, stale rematerialized bytes, uncounted rereads, duplicate logical progress, in-place mutation or success based on file existence. |
| EC-QMD-02 | Make public QMD query/get verification fail. | Candidate generation stays inactive and is removed; previous active generation continues serving. | Private SQLite inspection, pointer switch or an adapter-only retrieval assertion. |
| EC-QMD-03 | Keep a removed/replaced canary retrievable in the candidate. | Publication stops with `QMD_PROBE_FAILED`; current-only status and Committed Index 100% are withheld. | Search-result filtering, hidden historical hit or a success receipt that omits the negative probe. |
| EC-QMD-04 | Kill immediately after active-pointer switch and before prior-directory deletion. | Startup enters recovery, deletes the whole prior generation, reruns public probes and publishes success only afterward. | Two resting generations, manual directory deletion outside recovery or pre-cleanup success. |
| EC-WRITER-01 | Let compiler/provider configuration attempt a second semantic Agent call. | Operation stops; only the Selected Agent may create Concepts, taxonomy, links or moves. | Proposal content from a hidden model, second BaseURL/credential/model or unattributed semantics. |
| EC-WRITER-02 | Change any displayed diff, Evidence item or compiler receipt after review. | Recomputed `proposalHash` mismatches and approval/publish fails closed. | Approval of the altered candidate, mutable proposal record or hash recalculation that retains old approval. |
| EC-WRITER-03 | Change the Formal Wiki after proposal review. | `baseWikiHash` compare-and-swap fails; current Wiki stays byte-identical and renewed review is required. | Merge-on-write, overwritten human edit or publication under stale approval. |
| EC-WRITER-04 | Inject invalid YAML, missing required `type`, broken output path or failed Obsidian profile validation. | Staging Vault is rejected and active Vault remains byte-identical. | Partially published files, validator warning treated as pass or repaired active files outside proposal. |
| EC-WRITER-05 | Kill during candidate compilation and during Vault publication in separate attempts. | Incomplete candidate is discarded; publication recovery proves staging/active hashes and restores or completes one atomic approved Vault. | Mixed old/new Vault, unreviewed regenerated files or success without approval and recovery receipts. |
| EC-MOVE-01 | Apply a virtual category/filter to a Concept. | Only the view changes; path, `page_uid`, frontmatter, body and links remain unchanged. | Filesystem move, rewritten Markdown or a proposal approval receipt. |
| EC-MOVE-02 | Request a real move without exact proposal approval or under a stale base hash. | Move is denied and the entire Vault remains byte-identical. | Admin-role bypass, best-effort move or link/index edits without publication. |
| EC-MOVE-03 | Propose a path traversal, symlink escape, collision or case-fold collision. | Validation rejects staging before publication and identifies safe remediation. | Write outside Wiki root, overwritten file, dropped Concept or unstable `page_uid`. |
| EC-GUI-01 | Call hidden Admin endpoints from a Visitor session. | Server returns denied/absent capability; no plan, status detail or mutation leaks. | Disabled-button-only proof, client-side route hiding or Admin response body. |
| EC-GUI-02 | Replay, expire, alter revision or mismatch task ID for a Canvas event. | Event fails closed; originating durable page remains authoritative and unchanged. | Accepted duplicate action, revision rollback or Canvas-held mutation truth. |
| EC-GUI-03 | Reconnect with an old progress cursor after denominator growth. | Ordered replay reaches current truth and shows the plan/version denominator change. | Backward silent percentage, blended completion or dropped blocked/unknown counts. |
| EC-GUI-04 | Render long identities, hashes, blockers and localized labels at both required viewports with color disabled. | Content remains readable, labeled and non-overlapping; state meaning survives without color. | Cropped text, horizontal page loss, inaccessible icon-only state or desktop-only proof. |
| EC-LIFECYCLE-01 | Fail dependency install or initialization after partial writes. | Durable state stays `INSTALLED`; partial success is not published and retry starts from a new preview. | `INITIALIZED`, unverified component receipt or personal Source read. |
| EC-LIFECYCLE-02 | Start conflicting mutations and stale approvals from two Admin sessions. | Lease/hash checks return `OPERATION_LOCKED` or stale-plan failure; one operation owns mutation. | Last-writer-wins, two approval receipts or replayed confirmation. |
| EC-LIFECYCLE-03 | Fail update during component replacement or contract verification. | Prior supported release/state remains active or recovery is explicitly required; no later stable state is published. | Mixed component versions marked healthy or skipped regression journeys. |
| EC-LIFECYCLE-04 | Run default uninstall with a confirmed Formal Wiki and original Local Source. | Components, registrations, runtime and derived indexes are removed; Wiki and Source hashes remain unchanged and retained paths are receipted. | Deleted/modified user asset, removal proof that omits retained paths or executable deleted before receipt. |

## 5. Acceptance Verifications

Each Acceptance Verification is a release gate. The `receipt/evidence` field is mandatory. Automated checks may prepare evidence for a human suite; they cannot mark the human observation as run.

### AV-01 Controlled Install, Activation And First Query

- **Preconditions:** clean supported environment; signed/pinned release candidate; controlled Markdown fixture; selected native Agent login available.
- **Real steps:** execute discover, install, initialize and activation previews and approvals through released interfaces; register policy-aware MCP; issue first Visitor query.
- **Success standard:** BJ-01 and its lifecycle/role oracles pass; exact component versions and resolvable citation are visible; no read occurs before Source approval.
- **Execution:** automated `controlled` runner plus Owner confirmation of the displayed plans.
- **Receipt/evidence:** `controlled/AV-01/`, `receipts/<install>.json`, `receipts/<init>.json`, `receipts/<activate>.json`, query envelope and provider read counter.
- **Failure standard:** any missing receipt/hash, wrong state, extra Visitor tool, unresolved citation, `blocked` or `not-run` yields `fail` for release judgment.

### AV-02 Four Live Connector Chains

- **Preconditions:** opt-in Owner authorizations and working real identities for all four required Connectors; unique current fact in each approved scope.
- **Real steps:** probe, paginate metadata, approve descent, read selected leaves, commit and query Local Folder, GitHub through `gh`, Feishu through selected `lark-cli` profile and bounded Codex History.
- **Success standard:** BJ-08 passes for all four in one release run; displayed provider/version/redacted identity/scope matches the account and approval; every citation resolves to the intended current item.
- **Execution:** automated live harness for redacted receipts plus manual Owner identity/scope confirmation.
- **Receipt/evidence:** `live/AV-02/<local|github|feishu|codex-history>/` and one combined active-generation manifest.
- **Failure standard:** mock provider, wrong Feishu profile, incomplete connector, broadened scope, generic permission diagnosis, `blocked` or `not-run` fails the gate.

### AV-03 Progressive Scan And Grounded Use

- **Preconditions:** authorized multi-level corpus with pagination, unknown counts, sensitivity boundaries, evidence gaps and conflicts.
- **Real steps:** execute skeleton-first discovery and all four decisions; pause/resume; complete query, writing, decision, retrospective and raw-exposure journeys; narrow an authorization after its canary is committed, attempt immediate reread/query, then complete current-source reconciliation.
- **Success standard:** BJ-02 through BJ-07 pass; Layer Summary stays scratch; all progress dimensions and denominator changes remain truthful; only approved selected leaves are read; narrowing immediately freezes the excluded leaf's read counter, queues a reconciliation receipt, removes the canary through a newly published QMD generation's public query/get probes and deletes the prior generation.
- **Execution:** automated `controlled` and `ui`, with manual review of raw exposure and sensitive `ask-user` behavior.
- **Receipt/evidence:** `controlled/AV-03/`, `ui/AV-03/`, decision/checkpoint receipts, authorization hashes, before/after read counters, reconciliation/generation receipts, public negative probes, prior-generation deletion proof, answer envelopes and scratch residue audit.
- **Failure standard:** Source body in decision evidence, unsupported answer, hidden gap, false 100%, new read after narrowing, answer-layer-only filtering without current-source reconciliation, retained old generation, silent scope expansion, `blocked` or `not-run` fails the gate.

### AV-04 Crash, Pause And Cancel Recovery

- **Preconditions:** valid prior generation, resumable multi-page plan, deterministic read counters and all named kill hooks.
- **Real steps:** perform separate hard terminations at discovery commit, Layer Summary creation, leaf read, QMD build, QMD pointer switch, proposal compilation and Wiki publication; exercise pause and cancel; restart normally.
- **Success standard:** BJ-11 and BJ-15 recovery oracles pass; valid logical discovery, summary, Agent decision, selection and completion checkpoints are reused exactly; body scratch is removed; a QMD full-generation retry rematerializes only the selected current bodies required to reconstruct the temporary generation after expected-version/hash validation; rematerialized items/bytes are audited separately and do not increment logical completed counts; any version change invalidates the affected branch and creates a new incremental plan; active evidence/Wiki never becomes partial and every recovery state is receipted.
- **Execution:** automated `recovery` with filesystem `storage` audit.
- **Receipt/evidence:** `recovery/AV-04/<kill-point>/`, `storage/AV-04/`, pre/post logical manifests, per-phase action counters, `rematerializedItems`, `rematerializedBytes`, expected/observed version hashes, progress snapshots and incremental-plan receipts.
- **Failure standard:** manual repair, repeated valid discovery/summary/Agent decision/selection, logical completed-count inflation, unreported rematerialization, stale-version reconstruction, persistent body cache, residual body scratch, partial stable state, `blocked` or `not-run` fails the gate.

### AV-05 QMD Current-Only Replacement

- **Preconditions:** generation A and a change set containing retain/change/delete/authorization-removed fixtures with unique canaries and per-leaf read counters.
- **Real steps:** approve the narrower authorization and prove the excluded read counter stops immediately; require reconciliation; build B from the complete current selected manifest through QMD public CLI; execute positive and negative public query/get probes; switch pointer; remove A; query through openLifeWiki.
- **Success standard:** BJ-09 passes; changed/deleted/authorization-removed canaries are absent from public retrieval and disk; the reconciliation receipt binds the narrower authorization to B; exactly one active current generation remains at rest; QMD private storage is untouched.
- **Execution:** automated `controlled` plus `storage` instrumentation.
- **Receipt/evidence:** `controlled/AV-05/`, `storage/AV-05/`, authorization/read-counter evidence, reconciliation receipt, A/B manifests, public probe transcript, pointer and prior-generation deletion receipts.
- **Failure standard:** new read after narrowing, answer-layer-only filtering, in-place-only proof, private database inspection, stale hit, two resting generations, `blocked` or `not-run` fails the gate.

### AV-06 Proposal, Move And Obsidian Publication

- **Preconditions:** current Evidence manifest; existing approved Vault with unknown frontmatter; supported Obsidian installed.
- **Real steps:** generate with the Selected Agent; validate through compiler public surfaces; reject one proposal; trigger stale proposal and stale base variants; approve a valid Concept/taxonomy/move proposal; open the resulting Vault.
- **Success standard:** BJ-10 and BJ-12 pass; OKF/profile validations pass; CAS and exact proposal binding are proven; `page_uid`, unknown keys, indexes and links survive; Obsidian displays Properties, tags, aliases, backlinks and graph without a required plugin.
- **Execution:** automated `controlled` plus `obsidian-human`.
- **Receipt/evidence:** `controlled/AV-06/`, `obsidian-human/AV-06/checklist.json`, proposal/approval/compiler receipts and before/after Vault manifests.
- **Failure standard:** hidden semantic provider, approval bypass, byte change after reject/stale CAS, missing human checklist, `blocked` or `not-run` fails the gate.

### AV-07 Six-Agent Contract Equivalence

- **Preconditions:** the canonical protocol package has generated and release-bound all four hard prerequisite schemas: `agent-scan-result/v1`, `agent-query-result/v1`, `agent-wiki-semantics/v1` and `agent-failure/v1`; all six driver configurations are valid; canonical Skill/input fixtures and expected contract invariants are frozen.
- **Real steps:** load the generated protocol schemas and their hashes; run the same decision, query, proposal and failure cases through Codex, Claude Code, Gemini, Pi, OpenClaw and Hermes; validate every normalized output against the required schema.
- **Success standard:** BJ-13 passes; all four schema artifacts are generated from the canonical protocol package and their hashes match the release component manifest; each of the six Agents validates scan, query, Wiki semantics and failure outputs with the same schema IDs, Skill/input hashes, permission outcomes, citation modes and proposal responsibilities; actual driver failures surface without fallback.
- **Execution:** automated `controlled`; live Agent invocation is required for each selected runtime and declared in the environment manifest.
- **Receipt/evidence:** `controlled/AV-07/schemas/` with protocol generator/version, four schema artifacts and content hashes; `controlled/AV-07/<agent>/` with validation receipts; equivalence matrix with normalized fields.
- **Failure standard:** any required schema absent or not generated from protocol, schema/hash mismatch, invalid normalized output, skipped Agent, substituted model/runtime, credential copy or schema repair from prose yields `blocked` or `fail`; it can never pass the gate.

### AV-08 Role, GUI, Canvas And Concurrency

- **Preconditions:** release Companion running on loopback; Visitor plus two Admin sessions; scan ambiguity and proposal judgment fixtures.
- **Real steps:** traverse Query, Sources, Wiki, Review, Agent, Canvas and Health; exercise role discovery, stale tabs, progress reconnect, Canvas replay/expiry, conflicting mutations and cancellation at desktop and mobile sizes.
- **Success standard:** BJ-06, BJ-14 and BJ-15 pass; seven pages expose the same truth, Admin controls are hidden and rejected for Visitor, task events are revision-bound, and state remains understandable without color or overlap.
- **Execution:** automated `ui` plus `desktop-mobile-human`.
- **Receipt/evidence:** `ui/AV-08/` Playwright traces/accessibility report and `desktop-mobile-human/AV-08/checklist.json` with screenshots.
- **Failure standard:** client-only security, accepted stale event, content overlap/truncation, missing mobile detail, missing human check, `blocked` or `not-run` fails the gate.

### AV-09 Lifecycle Update And Uninstall

- **Preconditions:** accepted installed runtime with active generation, approved Formal Wiki, original Local Source and product-created Agent registration.
- **Real steps:** preview/update/verify; rerun supported query/scan/proposal checks; preview/default-uninstall; audit process, registration, runtime, derived data, Source and Wiki.
- **Success standard:** BJ-16 passes; update remains atomic/recoverable; default uninstall preserves Source and Wiki byte-for-byte and writes a final retained-path receipt before executable removal.
- **Execution:** automated `controlled` and `storage`, with `obsidian-human` confirmation that retained Wiki still opens.
- **Receipt/evidence:** `controlled/AV-09/`, `storage/AV-09/`, `obsidian-human/AV-09/checklist.json`, update/uninstall receipts and asset hashes.
- **Failure standard:** unverified mixed release, lost registration cleanup, modified user asset, missing final receipt, `blocked` or `not-run` fails the gate.

### AV-10 Bounded 10,000-Item / 2-GB Operation

- **Preconditions:** the designated Owner machine's hardware/environment and measurement tools are recorded; BJ-17 corpus manifest proves at least 10,000 leaves and the capacity-plan selection proves exactly 2,147,483,648 body bytes; runtime-generated fixtures identify generator version, seed and manifest hash; storage instrumentation is calibrated; declared budgets and fixed Target Owner Machine Scale Gates are recorded before execution.
- **Real steps:** close every discovery page/cursor and resolve unknown parents across at least 10,000 leaves; execute the capacity plan and actually read/commit its full 2,147,483,648 selected bytes; collect all liveness, latency, provider-wait, duration, process-tree RSS, scratch and QMD disk measurements; pause/resume; publish current QMD; perform incremental replacement/deletion and residue audit without changing limits mid-run.
- **Success standard:** BJ-17 passes; `discoveredLeaves >= 10000`, `openPages = 0`, `unknownParents = 0`; receipts record discovered bytes and prove `selectedBodyBytes = readBodyBytes = committedBodyBytes = 2147483648`; every fixed scale threshold passes; no budget is exceeded or hidden; progress remains live and truthful; valid logical work is reused under core red line 15 and ADR 0003; no second durable body mirror or old generation remains.
- **Execution:** automated `storage` and `recovery`.
- **Receipt/evidence:** `storage/AV-10/`, `recovery/AV-10/`, environment/hardware/tool record, generator/seed and corpus hashes, closed pagination receipts, discovery counts, `discovered/selected/read/committed` byte counters, capacity duration, heartbeat/progress and pause timelines, at least 100 Companion status samples/p95, justified provider-wait events, process-tree RSS/scratch/QMD disk time series/high-water marks, action counters and final filesystem manifest.
- **Failure standard:** fewer than 10,000 fully discovered leaves, any open page or unknown parent, selected/read/committed bytes below 2,147,483,648, a tiny substitute subset, any fixed scale threshold exceeded, missing sample stream, unreported limit/hardware change, false completion or residual body copy fails the gate. Insufficient machine resources produce `blocked` or `fail`; they can never produce `pass` from a smaller run or relaxed threshold.

### AV-11 Complete No-Reset Rehearsal

- **Preconditions:** one clean supported Owner machine; release artifact; real four-Connector authorizations; six valid Agent configurations; supported Obsidian; 10,000-item/2-GB corpus may be a separately approved local Source within the same runtime.
- **Real steps:** use one `runId` to install and initialize; activate and make the first cited query; connect all four real Sources; complete progressive scan and evidence-mode journeys; run writing, decision and retrospective; test raw exposure and roles; rotate through six Agents; create/reject/approve a proposal; inspect virtual classification and approve a real move; use Canvas; perform pause, recovery, concurrency and cancel cases; change Sources and rebuild current QMD; open the Wiki in Obsidian; execute the scale run; update; default-uninstall last.
- **Success standard:** BJ-01 through BJ-17, all applicable Edge Contracts and AV-01 through AV-10 have passing evidence tied to the same release and continuous workspace history; the scale segment retains AV-10's full 10,000-leaf discovery, 2,147,483,648 selected/read/committed-byte thresholds and every fixed Target Owner Machine Scale Gate with no resource waiver; run-start and final-manifest external signatures plus the complete attempt chain verify; approved Wiki remains usable after uninstall; Critical and Important findings equal zero.
- **Execution:** Owner-led `no-reset-rehearsal`, supported by automated suites and explicit `obsidian-human` plus `desktop-mobile-human` observations.
- **Receipt/evidence:** `no-reset-rehearsal/AV-11/timeline.json`, the single run manifest, cross-suite receipt index, before/after workspace manifests and Owner sign-off.
- **Failure standard:** any reset/reseed/manual receipt repair, different release digest, missing real Connector or Agent, missing human observation, reduced scale fixture or byte count, failed run-start/final-manifest signature or external-key fingerprint verification, broken attempt chain, failed manifest binding, any required `fail | blocked | not-run`, or any Critical/Important finding fails V1.

## 6. Count And Release Record

The canonical inventory is 17 Business Journeys, 35 Edge Contracts and 11 Acceptance Verifications. Release automation must verify identifiers are unique and contiguous, every execution is appended once to `attempts.jsonl`, every ID has exactly one release verdict in `results.json`, every passing verdict cites a passing `verdictAttemptId` plus immutable evidence/receipt content hashes, all required verdicts equal `pass`, the attempt hash chain is intact and all final-manifest bindings recompute. Re-running a failed check is allowed; deleting the failed attempt or fabricating a verdict from unbound evidence invalidates the release.

The Owner acceptance receipt records:

```json
{
  "schema": "openlifewiki.v1-owner-acceptance/v1",
  "runId": "...",
  "releaseGitSha": "...",
  "hostConfigHash": "sha256:...",
  "componentVersions": { "openlifewiki": "...", "qmd": "2.5.3", "llmWikiCompiler": "1.1.0" },
  "resultsHash": "sha256:...",
  "attemptLedgerHash": "sha256:...",
  "finalAttemptHash": "sha256:...",
  "evidenceIndexHash": "sha256:...",
  "acceptanceSetHash": "sha256:...",
  "counts": { "businessJourneys": 17, "edgeContracts": 35, "acceptanceVerifications": 11 },
  "results": { "pass": 63, "fail": 0, "blocked": 0, "notRun": 0 },
  "reviewFindings": { "critical": 0, "important": 0 },
  "decision": "accepted",
  "owner": "human:owner",
  "signedAt": "..."
}
```
