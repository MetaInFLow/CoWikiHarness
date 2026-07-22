---
name: openlifewiki-install
description: Install, initialize, and activate openLifeWiki with a preview-first, approval-gated workflow. Use when setting up a new machine, installing QMD, activating the default Source, repairing setup, or checking whether the local MCP is ready.
---

# openLifeWiki Install

## Objective

Move the machine through `INSTALLED`, `INITIALIZED`, and optionally `ACTIVE` with exact, reviewable records. Initialization installs dependencies. Activation requires a separate preview and approval because it reads the default Source.

## Safety Rules

- Perform no write, network access or dependency installation while reading this Skill.
- Never scan the home directory. The product default is exactly `~/openLifeWiki/sources/**/*.md` unless `OPENLIFEWIKI_WORKSPACE` was explicitly set before initialization.
- Never copy credentials or third-party source code.
- Show the dry-run result before requesting approval.
- Treat `INITIALIZED` as complete only after `doctor` verifies the required QMD release.
- Keep a failed or partial initialization at `INSTALLED` and a failed activation at `INITIALIZED`.

## Workflow

### 1. Determine The Entry State

Check whether `openlifewiki` is available.

For an installed release, run:

```bash
openlifewiki status --json
```

For a source checkout on `dev`, first run the repository bootstrap:

```bash
./scripts/bootstrap_dev_env.sh
pnpm openlifewiki status --json
```

Do not invent a download URL when no signed openLifeWiki release is available. Report `PRODUCT_RELEASE_NOT_AVAILABLE` and stop unless the user explicitly selected source-checkout mode.

### 2. Preview Initialization

Run one of:

```bash
openlifewiki init --dry-run --json
```

```bash
pnpm openlifewiki init --dry-run --json
```

Summarize:

- directories and files to be created;
- the hidden runtime root and visible workspace root;
- network access required;
- exact QMD version and package source;
- commands that will execute;
- operations intentionally excluded.

### 3. Obtain Approval

Ask for explicit approval of the displayed plan. Do not treat an earlier request to inspect, explain or install the Skill as approval to execute initialization.

### 4. Initialize

After approval, run the matching command:

```bash
openlifewiki init --yes --json
```

```bash
pnpm openlifewiki init --yes --json
```

Initialization may create `~/.openlifewiki/`, `~/openLifeWiki/sources/` and `~/openLifeWiki/wiki/`, write default configuration and install QMD `2.5.3` from its official npm release into the isolated component directory.

Initialization must not authorize a Source, read personal content, change Agent authentication, register MCP, or install llm-wiki-compiler and optional connectors.

Initialization also skips QMD's optional semantic and reranking models. The P0 lexical MCP query works without them; choosing semantic search later lets QMD download roughly 2 GB into the isolated cache after disclosure.

### 5. Verify

Run:

```bash
openlifewiki doctor --json
openlifewiki status --json
```

In source-checkout mode, prefix both commands with `pnpm`.

Pass only when:

- status is `INITIALIZED`;
- QMD reports exact version `2.5.3`;
- the state receipt exists and contains no secret or Source content;
- the next action is activation.

### 6. Report Initialization

Report the completed state, installed component versions, runtime root, workspace root and next action. Stop at `INITIALIZED` unless the user explicitly asks to continue with activation.

### 7. Prepare Activation

Activation requires at least one non-empty Markdown file under the displayed default Source path. Do not add, move or import personal content on the user's behalf without a separate request.

Run:

```bash
openlifewiki activate --dry-run --json
```

In source-checkout mode, prefix the command with `pnpm`. Summarize the exact Source glob, QMD configuration and cache locations, and the fact that activation reads authorized Markdown.

### 8. Obtain Activation Approval

Ask for explicit approval of the activation plan. Initialization approval does not authorize Source reading.

### 9. Activate And Verify

After approval, run:

```bash
openlifewiki activate --yes --json
openlifewiki doctor --json
openlifewiki status --json
```

In source-checkout mode, prefix each command with `pnpm`.

Pass only when:

- activation returns `ACTIVE`;
- the QMD collection is confined to the displayed default Source;
- the retrieval smoke returns a resolvable Source path;
- `doctor` reports `nextAction: use`.

If activation returns `source-empty`, tell the user to add Markdown to the displayed Source path and stop at `INITIALIZED`.

### 10. Present MCP Registration

Do not modify an Agent configuration without approval. Present the installed-release MCP command:

```bash
openlifewiki mcp --stdio
```

For Codex, the user-approved registration form is:

```bash
codex mcp add openlifewiki -- openlifewiki mcp --stdio
```

In source-checkout mode, use the repository root as the pnpm working directory as documented in `README.md`.

## Recovery

If initialization fails:

1. report the failing action and stable error code;
2. run `status --json` and confirm it remains `INSTALLED`;
3. do not delete user files or retry with broader permissions;
4. use a new dry-run before any retry.

If activation fails, confirm the stable state remains `INITIALIZED`, preserve the Source unchanged and report the failed QMD public command or retrieval check. Never broaden the Source glob to make the smoke pass.
