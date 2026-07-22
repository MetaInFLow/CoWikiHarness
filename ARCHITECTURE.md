# openLifeWiki Architecture

- Status: canonical on `dev`
- Product shape: local runtime + CLI + upstream MCP
- First delivery mode: connected mode; the user runs an existing Agent

## System Boundary

openLifeWiki owns authorization, lifecycle state, product contracts, component isolation and approved Wiki writes. External projects own retrieval, protocol serving, platform access, Agent execution and their internal data.

```text
User / Install Skill
        |
        v
openlifewiki CLI ──> Lifecycle Core ──> Component Adapters
        |                                      |
        v                                      v
   local state                           QMD public CLI
                                               |
                                               v
existing Agent <── stdio ── openlifewiki MCP launcher ──> QMD upstream MCP
```

## Owning Layers

| Concern | Owner |
| --- | --- |
| JSON commands and public types | `packages/protocol` |
| Lifecycle stages and component policy | `packages/core` |
| Filesystem, subprocess, installer and launch behavior | `packages/adapters` |
| User and Agent command surface | `apps/cli` |
| Installation conversation and approval | `skills/openlifewiki-install` |
| Retrieval algorithms and index format | QMD |
| P0 MCP server and retrieval tools | QMD |
| MCP readiness gate and isolated launch | openLifeWiki adapters |
| Agent reasoning and authentication | selected Agent CLI |

## Component Rule

Every external executable follows one contract:

```text
official release → isolated install or existing executable → public CLI/MCP → validated result
```

The repository cannot contain copied upstream source, private database access, copied retrieval algorithms or patched vendor trees. SDKs enter the dependency graph only when an upstream public CLI or MCP cannot satisfy an accepted product requirement.

## Lifecycle Truth

`docs/product-lifecycle.md` is the product lifecycle truth. `packages/core` exposes the same stable stage IDs to the CLI. The durable state file records only completed stable states; transient operations write atomically and can be retried.

## Local Data

```text
<platform application-data>/openLifeWiki/
  config.json            authorization and Agent bindings
  state.json             completed lifecycle state and component receipts
  components/            isolated external releases
  data/qmd/config/       isolated QMD collection configuration
  data/qmd/cache/        isolated QMD index and model cache
  runtime/               locks, sockets and temporary execution state
  logs/                  redacted operational logs

~/openLifeWiki/
  sources/               default authorized Markdown input
  wiki/                  confirmed Markdown knowledge, reserved for later stages
```

The runtime root follows the host convention: macOS Application Support, Linux XDG data and Windows LocalAppData. `OPENLIFEWIKI_HOME` and `OPENLIFEWIKI_WORKSPACE` override the runtime and visible roots independently. Initialization creates the directories and reads no Source content.

QMD commands run with a fixed runtime working directory plus isolated `QMD_CONFIG_DIR` and `XDG_CACHE_HOME`. This prevents accidental discovery of another project's local `.qmd` configuration.

## MCP Runtime

P0 uses stdio and opens no listening port. `openlifewiki mcp --stdio` checks that the runtime is `ACTIVE`, then launches the installed QMD `mcp` command with inherited stdin, stdout and stderr. Standard output remains reserved for MCP messages.

Before launch, openLifeWiki verifies that its authorization record contains exactly one default Source, QMD contains exactly one matching collection, the path and mask match, and `qmd update` succeeds. Any broader or inconsistent configuration blocks MCP startup.

QMD owns the P0 tools: `query`, `get`, `multi_get` and `status`. openLifeWiki currently adds policy at the lifecycle and process boundary; it does not proxy or duplicate these tools.

## Delivery Sequence

1. Lifecycle and initializer.
2. Default Local Folder + QMD public CLI.
3. Isolated QMD MCP launcher + Codex cited query.
4. Knowledge proposal and human approval.
5. Additional Sources and Agents.
6. Local management UI and packaged distribution.

No later component enters the dependency graph before its delivery stage begins.
