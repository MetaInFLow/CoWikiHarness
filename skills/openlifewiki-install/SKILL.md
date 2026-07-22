---
name: openlifewiki-install
description: Install and initialize openLifeWiki with a preview-first, approval-gated workflow. Use when setting up a new machine, completing initialization, repairing a partial initialization, or checking whether the local runtime is ready.
---

# openLifeWiki Install

## Objective

Move the machine from no product or `INSTALLED` to `INITIALIZED` with an exact, reviewable record. Stop before Source authorization and Agent activation unless the user separately approves that operation.

## Safety Rules

- Perform no write, network access or dependency installation while reading this Skill.
- Never scan the home directory or infer a Source location.
- Never copy credentials or third-party source code.
- Show the dry-run result before requesting approval.
- Treat `INITIALIZED` as complete only after `doctor` verifies the required QMD release.
- Keep a failed or partial initialization at `INSTALLED`.

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

Initialization may create the owner-only openLifeWiki runtime layout, write default configuration and install QMD `2.5.3` from its official npm release into the isolated component directory.

Initialization must not authorize a Source, read personal content, change Agent authentication, register MCP, or install llm-wiki-compiler and optional connectors.

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

### 6. Report And Stop

Report the completed state, installed component versions, state root and next action. Stop at `INITIALIZED`. Source authorization and Codex MCP registration belong to the activation workflow.

## Recovery

If initialization fails:

1. report the failing action and stable error code;
2. run `status --json` and confirm it remains `INSTALLED`;
3. do not delete user files or retry with broader permissions;
4. use a new dry-run before any retry.
