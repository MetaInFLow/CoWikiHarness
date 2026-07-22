# openLifeWiki Architecture

- Status: canonical on `dev`
- Product shape: local runtime + CLI + MCP
- First delivery mode: connected mode; the user runs an existing Agent

## System Boundary

openLifeWiki owns authorization, lifecycle state, product contracts, evidence validation and approved Wiki writes. External projects own retrieval, platform access, Agent execution and their internal data.

```text
User / Install Skill
        |
        v
openlifewiki CLI ──> Lifecycle Core ──> Component Adapters
        |                                      |
        v                                      v
   local state                           QMD / Agent CLI
        |
        v
Visitor MCP ──> authorized evidence ──> existing Agent
```

## Owning Layers

| Concern | Owner |
| --- | --- |
| JSON commands and public types | `packages/protocol` |
| Lifecycle stages and component policy | `packages/core` |
| Filesystem, subprocess and installer behavior | `packages/adapters` |
| User and Agent command surface | `apps/cli` |
| Installation conversation and approval | `skills/openlifewiki-install` |
| Retrieval algorithms and index format | QMD |
| Agent reasoning and authentication | selected Agent CLI |

## Component Rule

Every external executable follows one contract:

```text
official release → isolated install or existing executable → public CLI/MCP → validated result
```

The repository cannot contain copied upstream source, private database access, copied retrieval algorithms or patched vendor trees. SDKs remain normal code dependencies only when openLifeWiki implements the protocol itself.

## Lifecycle Truth

`docs/product-lifecycle.md` is the product lifecycle truth. `packages/core` exposes the same stable stage IDs to the CLI. The durable state file records only completed stable states; transient operations write atomically and can be retried.

## Local Data

```text
~/.openlifewiki/
  config.json            user configuration
  state.json             completed lifecycle state and component receipts
  components/            isolated external releases
  data/                  openLifeWiki-owned product data
  runtime/               locks, sockets and temporary execution state
  logs/                  redacted operational logs
  wiki/                  confirmed Markdown knowledge
```

Directories are owner-only. Original Source content stays in its authorized location. Rebuildable indexes and runtime state can be removed without deleting the Wiki.

## Delivery Sequence

1. Lifecycle and initializer.
2. Local Folder + QMD public interface.
3. Visitor MCP + Codex cited query.
4. Knowledge proposal and human approval.
5. Additional Sources and Agents.
6. Local management UI and packaged distribution.

No later component enters the dependency graph before its delivery stage begins.
