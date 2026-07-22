# openLifeWiki Product Lifecycle

- Status: canonical on `dev`
- Owner: product owner
- Purpose: define what must exist at every stage and how completion is proven

## One Lifecycle

```text
DISCOVER
  → INSTALL
  → INITIALIZE
  → ACTIVATE
  → USE
  → MAINTAIN / UPDATE
  → UNINSTALL
```

Operations and stable runtime states are separate. An operation can fail and be retried without publishing a later stable state.

## Stable Runtime States

| State | Meaning | Next action |
| --- | --- | --- |
| `INSTALLED` | CLI and Install Skill exist; user runtime is absent or incomplete | initialize |
| `INITIALIZED` | runtime directories and P0 dependencies pass their contracts | activate one Source and Agent |
| `ACTIVE` | one real cited-query journey passes | use the knowledge service |
| `DEGRADED` | a previously completed contract is currently failing | doctor and reconcile |

Transient operation labels such as `INITIALIZING`, `ACTIVATING`, `UPDATING` and `UNINSTALLING` belong in operation receipts and logs. They are not durable completion states.

## Stage Contract

### 1. Discover

**Entry:** the user or Agent finds `openlifewiki-install`.

**Required:**

- product purpose and current limitations;
- permission and network disclosure;
- supported platform and runtime requirements;
- official release source and version.

**Writes:** none.

**Complete when:** the Skill can describe the next operation without probing or changing the machine.

### 2. Install

**Entry:** the user approves installation of openLifeWiki itself.

**Required:**

- pinned openLifeWiki release;
- `openlifewiki` executable;
- `openlifewiki-install` Skill;
- license and component release manifest.

**Excluded:** Source scanning, Agent registration, external component installation and user configuration.

**Complete when:** `openlifewiki --version` and `openlifewiki status --json` return successfully. The first state is `INSTALLED`.

### 3. Initialize

**Entry:** installed product and explicit approval of the dry-run plan.

**Required:**

- owner-only `~/.openlifewiki/` directory layout;
- initial `config.json`;
- isolated component directory;
- QMD `2.5.3` installed from the official npm release;
- npm package integrity matches the pinned release manifest;
- QMD executable version check;
- atomic `state.json` initialization receipt.

**Excluded:** reading personal Sources, Agent authentication changes, MCP registration, llm-wiki-compiler and optional connectors.

**Complete when:** `status` returns `INITIALIZED` and `doctor` reports the required QMD contract as ready.

**Failure recovery:** keep the durable state at `INSTALLED`; retain only a redacted operation failure. A rerun reconciles the isolated component directory.

### 4. Activate

**Entry:** initialized runtime.

**Required for P0:**

- one explicitly authorized local folder;
- one QMD collection created through the public CLI or MCP;
- existing Codex installation and native authentication confirmed;
- Visitor MCP registered for the selected Agent host;
- one controlled query returns a current citation.

**Complete when:** the real Local Folder → QMD → MCP → Codex smoke passes and state becomes `ACTIVE`.

**Failure recovery:** revoke incomplete Source or MCP registration and remain `INITIALIZED`.

### 5. Use

**Entry:** active runtime.

**Required:**

- authorized queries only;
- citations resolvable to current Source content;
- explicit insufficient/conflicting evidence result;
- no durable Wiki write through the Visitor surface.

**Complete per operation when:** the answer envelope and every citation validate.

### 6. Maintain And Update

**Entry:** initialized or active runtime.

**Required:**

- `doctor` reports desired and actual versions;
- update dry-run lists downloads, state changes and restart needs;
- component replacement is atomic or recoverable;
- confirmed Wiki backup and restore path remain valid;
- later-stage components are installed only when that capability is activated.

**Complete when:** prior supported journeys still pass after reconciliation.

### 7. Uninstall

**Entry:** installed product and explicit approval of an uninstall preview.

**Required:**

- remove Agent registrations created by openLifeWiki;
- stop local processes;
- remove external component installations and rebuildable indexes;
- preserve confirmed Wiki by default;
- produce a local removal receipt before deleting the executable.

**Complete when:** runtime processes and registrations are absent and retained user assets are listed.

## Install Skill Responsibility

The Install Skill owns conversation order and approval:

1. explain the current operation;
2. run read-only preflight;
3. show `init --dry-run --json`;
4. obtain explicit approval;
5. run `init --yes --json`;
6. run `doctor --json`;
7. stop at `INITIALIZED` unless the user separately approves activation.

The CLI owns filesystem changes, dependency installation, idempotency and machine-readable receipts. The Skill never hides shell commands or treats its prose as completion evidence.

## Component Timing

| Component | First required stage | Delivery |
| --- | --- | --- |
| QMD | Initialize | isolated npm release; public CLI/MCP |
| Codex | Activate P0 | user-managed native CLI and login |
| MCP SDK | Build-time | openLifeWiki library dependency |
| `gh` | Activate GitHub Source | user-managed official CLI |
| `lark-cli` | Activate Feishu Source | official installer or release binary |
| llm-wiki-compiler | Activate Wiki management | isolated npm release; public CLI |
| Other Agent CLIs | Activate selected Agent | user-selected native installation |
