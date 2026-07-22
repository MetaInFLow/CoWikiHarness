# openLifeWiki Requirements v0.1

- Status: owner-directed baseline
- Audience: product owner and implementation team
- Source: owner instructions in the project conversation through 2026-07-22

## Product Definition

openLifeWiki is a local-first personal knowledge hub for one person using multiple AI Agents. It gives those Agents one authorized knowledge entry, returns source-grounded answers and preserves confirmed knowledge as portable Markdown.

## Owner Decisions

1. Start the knowledge organization from fresh data; do not bind AF-wiki.
2. Reach a usable personal workflow quickly.
3. Reuse mature open-source projects through official installation and public invocation.
4. Keep the project skeleton clear before component-specific implementation.
5. Make every software lifecycle stage explicit.
6. Run dependency installation during initialization through an approval-gated Install Skill.
7. Keep development work on `dev`; protect `main` from incomplete baselines.
8. Provide a project-owned default local folder when no special path is requested.

## P0 User

One owner who already uses Codex and has a local folder containing material they explicitly choose to query.

## P0 Journey

```text
install openLifeWiki
→ initialize the local runtime and QMD
→ add Markdown to the default local folder
→ activate the isolated QMD collection and local MCP
→ register the MCP in Codex
→ ask one question
→ receive an answer with a resolvable citation
```

## P0 Requirements

| Requirement | Acceptance |
| --- | --- |
| Installation | CLI and Install Skill can be installed without scanning personal data |
| Initialization | Dry-run lists writes and downloads; approved execution installs QMD `2.5.3` and reaches `INITIALIZED` |
| Default layout | Runtime defaults to `~/.openlifewiki`; visible knowledge defaults to `~/openLifeWiki` |
| Authorization | Only `~/openLifeWiki/sources/**/*.md` is readable after activation approval |
| Retrieval | QMD is called through a public CLI/MCP surface; no private database access |
| Isolation | QMD config, cache, index and working directory remain inside the runtime root |
| MCP | `openlifewiki mcp --stdio` launches QMD's upstream MCP only after `ACTIVE` |
| Agent use | Existing Codex login is reused; credentials are not copied |
| Evidence | A controlled question returns at least one citation resolving to current content |
| Failure | Failed initialization remains `INSTALLED`; failed activation remains `INITIALIZED` |
| Data ownership | Original files remain in place and no AF-wiki content is imported |

## P0 Non-goals

- GUI or desktop packaging;
- GitHub, Feishu or Codex History Sources;
- Claude Code, Gemini, Pi, OpenClaw or Hermes integration;
- Wiki compilation and approval;
- team sharing, remote service or multi-user permissions;
- custom retrieval, embedding, reranking or Agent runtime.

## Success Standard

P0 is complete when a clean machine can follow the Install Skill, activate the default Source, complete an MCP handshake and pass the real cited-query journey without manual repository edits or access to unapproved data.
