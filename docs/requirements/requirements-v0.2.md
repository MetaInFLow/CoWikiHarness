# openLifeWiki Requirements v0.2

- Status: completed P0 reference; superseded for new work
- Date: 2026-07-22
- Audience: product owner and implementation team
- Supersedes: `requirements-v0.1.md`
- Superseded by: [`requirements-v1.md`](requirements-v1.md)

## Reference Boundary

This document records the implemented P0 Management Companion baseline. It remains useful for regression expectations and no longer authorizes V1 implementation, scope or completion claims. V1 work follows [`requirements-v1.md`](requirements-v1.md), the canonical lifecycle and the active V1 design.

## Product Decision

The local Management Companion is part of the current product journey. It must let the owner manage openLifeWiki without terminal knowledge after the initial source-checkout launch.

## Required Journey

```text
start local Management Companion
→ see current state, health and paths
→ open the default Source folder
→ preview and approve initialization or activation
→ see operation result and refreshed stable state
→ inspect MCP readiness
→ register the Codex MCP from the GUI
```

## Requirements

| Requirement | Acceptance |
| --- | --- |
| Local access | Server binds only to loopback and opens on a random port |
| Authentication | Every API request requires the current local session token |
| State truth | GUI renders the same lifecycle and doctor contracts as the CLI |
| Initialization | GUI displays the exact plan and requires confirmation before execution |
| Source boundary | GUI can open only the configured workspace and cannot submit arbitrary paths |
| Activation | Empty Source remains `INITIALIZED`; successful retrieval reaches `ACTIVE` |
| MCP | GUI displays readiness, expected tools and the exact Codex registration command |
| Codex | GUI registers through the public `codex mcp` CLI after explicit confirmation |
| Reuse | QMD remains an official installed Release invoked through public CLI/MCP |
| Offline shell | Browser assets require no internet access |
| Responsive use | Core workflows work at desktop and mobile viewport sizes |
| Failure | Errors remain actionable and never publish a later stable state |

## Current Scope

- fixed Management Companion Web shell;
- Overview, Source, Agent Connection and Health views;
- initialization and activation preview/execute;
- open workspace, refresh health, copy command and register Codex;
- explicit stop control and local runtime metadata;
- automated service and browser-flow verification.

## Deferred

- dynamic Visual Companion Canvas;
- Markdown editing and knowledge graph;
- remote access and multi-user permissions;
- packaged desktop application and tray process;
- GitHub, Feishu and history Sources;
- Wiki proposal and approval workflow.

## Success Standard

On the owner machine, the Management Companion starts from `dev`, shows the real `INITIALIZED` runtime, opens the default Source, safely handles an empty activation, and can complete activation plus Codex MCP registration after Markdown is present.
