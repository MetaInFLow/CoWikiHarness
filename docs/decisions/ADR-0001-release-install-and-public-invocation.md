# ADR 0001: Install Official Releases And Invoke Public Interfaces

- Status: accepted
- Date: 2026-07-22

## Context

Earlier experiments coupled openLifeWiki to QMD private storage and built product behavior around component internals before the lifecycle existed. The owner requires mature external software to be installed and called directly.

## Decision

External executables are pinned official releases installed into an isolated component directory or discovered as an existing user-managed CLI. openLifeWiki invokes only documented CLI, MCP or stable SDK surfaces.

QMD is the sole P0 initialization dependency. llm-wiki-compiler, platform CLIs and additional Agent CLIs enter only when their product stage is activated. QMD already provides the P0 stdio MCP, so openLifeWiki launches that public interface directly and does not add another MCP SDK dependency.

## Consequences

- no vendored upstream source or patched vendor tree;
- no QMD private database access;
- component upgrades require contract tests;
- installers record exact versions and publish durable state only after probes pass;
- the experimental branch and stashes cannot be merged into `dev`.
