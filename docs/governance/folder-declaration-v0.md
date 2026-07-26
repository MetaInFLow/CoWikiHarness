# Folder Declaration v0

| Path | Owner | May contain |
| --- | --- | --- |
| `apps/cli` | command surface | parsing, JSON output, composition |
| `packages/protocol` | public contracts | stable types and schemas |
| `packages/core` | product rules | lifecycle, component policy, pure decisions |
| `packages/adapters` | infrastructure | filesystem, process and installer code |
| `packages/mcp` | public Agent surface | role-aware MCP schemas, dispatch and QMD delegation |
| `packages/companion` | local product surface | loopback server, seven fixed pages and task-bound Canvas boundary |
| `skills` | Agent workflows | concise Skill instructions and references |
| `docs/product` | product owner | product red lines below the root Constitution |
| `docs/requirements` | product owner | approved outcomes, behavior and completion standards |
| `docs/acceptance` | acceptance owner | versioned benchmark journeys, executable contracts, declared-mode acceptance validations and evidence manifests |
| `docs/development/plans` | implementation team | ordered delivery slices, file maps and executable gates |
| `docs/design/active` | implementation team | documents whose headers explicitly declare current authority plus superseded references retained in place |
| `docs/design/proposed` | product owner | designs awaiting approval; no implementation authority |
| `docs/design/completed` | implementation team | verified development baselines |
| `docs/decisions` | architecture | accepted decisions and trade-offs |
| `docs/memory-bank` | project Agents | current context and project patterns |
| `docs/archive` | historical | superseded read-only evidence |

Runtime data, personal Sources, downloaded components and generated output stay outside Git.

Directory placement does not grant authority. Follow the order in [`docs/README.md`](../README.md), and treat an acceptance manifest as a veto gate over any lower-level completion claim.
