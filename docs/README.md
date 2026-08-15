# Documentation Index

## Authority Order

Use the first applicable authority below. A lower level may narrow an earlier contract and cannot weaken or contradict it.

1. [`CONSTITUTION.md`](../CONSTITUTION.md): root product red lines.
2. [`product/core-red-lines.md`](product/core-red-lines.md): canonical restatement and V1-derived red lines.
3. 云端和多人工作遵循 [`requirements/requirements-v2.md`](requirements/requirements-v2.md)；保留的本地兼容链路遵循 [`requirements/requirements-v1.md`](requirements/requirements-v1.md)。
4. [`product-lifecycle.md`](product-lifecycle.md): lifecycle stages, stable-state meaning and recovery checkpoints.
5. [`decisions/`](decisions/): accepted architecture decisions and trade-offs.
6. [`ARCHITECTURE.md`](../ARCHITECTURE.md)、[活动 V2 设计](design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)、[活动 V1 设计](design/active/design_doc-v1-progressive-scan-and-wiki.md)和 [V1 wireframe](design/active/v1-product-wireframes.md)：适用的目标架构和实施设计。
7. `packages/protocol`、交付后的 `skills/openlifewiki-knowledge-architect/SKILL.md`，以及 `skills/openlifewiki-progressive-scan/SKILL.md`：可执行公共合同和规范 Agent 流程。
8. V2 和 V1 验收记录：完成要求每条适用必选旅程通过；`fail`、`blocked` 或 `not-run` 均不通过。
9. Root [`README.md`](../README.md) and [`memory-bank/`](memory-bank/): actual released capability and current engineering status. These report implementation state and do not authorize missing behavior.

## Current Baselines

- V2 云端目标：[`requirements-v2.md`](requirements/requirements-v2.md)、[ADR 0005](decisions/ADR-0005-a2a-v1-public-agent-protocol.md) 至 [ADR 0008](decisions/ADR-0008-minimal-v2-runtime.md)、[活动 V2 设计](design/active/2026-08-15-cloud-knowledge-agent-v2-design.md)和[实施计划](superpowers/plans/2026-08-15-cloud-knowledge-agent-v2.md)。
- V1 contract: [`requirements-v1.md`](requirements/requirements-v1.md), [ADR 0003](decisions/ADR-0003-progressive-scan-control-plane.md), [ADR 0004](decisions/ADR-0004-okf-v0.2-and-obsidian-profile.md), the [active V1 design](design/active/design_doc-v1-progressive-scan-and-wiki.md) and [product wireframes](design/active/v1-product-wireframes.md).
- Implemented baseline: the source-checkout P0 Local Folder, QMD retrieval/MCP chain and local Management Companion described by the superseded v0.2/v0.3 references.
- 完成边界：V2 实现尚未开始。V1 `ACTIVE` 只证明已授权本地检索链路可用，不能证明 V1 或 V2 已完成。

## Reference Material

- [`requirements/requirements-v0.2.md`](requirements/requirements-v0.2.md): completed P0 Management Companion reference; superseded for V1 work.
- [`design/active/design_doc-v0.2-default-workspace-and-mcp.md`](design/active/design_doc-v0.2-default-workspace-and-mcp.md): completed P0 Local Folder/QMD reference; superseded for V1 work.
- [`design/active/design_doc-v0.3-local-management-companion.md`](design/active/design_doc-v0.3-local-management-companion.md): completed P0 local GUI reference; superseded for V1 work.
- [`design/completed/`](design/completed/): completed development baselines.
- `archive/`: superseded read-only history; it never authorizes implementation.
