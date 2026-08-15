# Governance Changelog

## 2026-08-15

- accepted V2 as one cloud-hosted Knowledge Agent and retained V1 as the explicit local compatibility path;
- selected A2A v1 as the cloud agent protocol, OpenAI Agents SDK as the sole P0 harness and PostgreSQL 17 as the sole durable cloud store;
- limited P0 runtime to one Node.js service, PostgreSQL and an optional outbound person-local Relay;
- excluded MCP on the cloud boundary, Codex SDK, Pi, Redis, a separate Worker, object storage, vector search, cloud QMD and a separate administration UI until measured expansion triggers are met;
- approved the V2 requirement, architecture, ADR 0005 through ADR 0008, active design and six-slice implementation/acceptance plan;
- required V1 typecheck/tests to return to green before V2 application code begins.

## 2026-07-26

- established the root Constitution, core red lines, V1 requirement, lifecycle, accepted ADRs, architecture/active design, executable protocol/Skill and acceptance veto gates as the ordered authority chain;
- adopted the V1 Progressive Scan to Formal Wiki contract while keeping current P0 implementation status explicit;
- marked v0.2 requirements and the v0.2/v0.3 designs as completed P0 references that no longer authorize V1 work;
- added Connect, Scan, Propose, Approve and Publish lifecycle operations with hash-bound recovery checkpoints;
- defined `ACTIVE` as retrieval-path readiness and kept V1 completion bound to acceptance evidence;
- required all 17 benchmark journeys, 35 executable contracts and 11 acceptance validations to pass in their declared automated or human mode, including Live Connector, recovery, desktop/mobile and Obsidian checks;
- made `fail`, `blocked` and `not-run` non-passing results and required Critical and Important review findings to both equal zero;
- sequenced V1 delivery through contract proof, Connector visibility, the real Local/QMD chain, remaining live Connectors, six Agents/policy MCP, Wiki proposal/publication, seven-page GUI/Canvas and real Full Journey acceptance.
- split first Owner-usable V1 acceptance from later Release Certification: Core now has the fixed `CORE-AV-01..06`, `CORE-EC-01..10` and `Core-UAT-01` inventory, while external signatures, the 17/35/11 catalog, five additional live Agent drivers, fixed-scale measurement, update and uninstall remain post-Core certification;
- reordered delivery so Codex, four live Connectors, one active QMD generation, policy-aware MCP, approved Obsidian Wiki, GUI and incremental update close before release-hardening work.
- completed Task 1.5 executable contracts for exact child outcomes, root/leaf body-read authorization, receipt-derived progress and generic Owner-required Connector-to-Vault Evidence lineage.

## 2026-07-22

- established `dev` as the integration branch;
- defined the install-to-uninstall product lifecycle;
- limited initialization to QMD `2.5.3`;
- required official release installation and public-interface invocation;
- replaced the single placeholder package with CLI, protocol, core and adapter boundaries;
- archived the pre-reset architecture, ADRs, spikes and superseded plans;
- established platform application-data as the runtime default and `~/openLifeWiki/` as the visible knowledge default;
- added approval-gated activation for the default Markdown Source;
- delegated P0 MCP serving to QMD's existing stdio MCP through an isolated launcher;
- verified the real QMD install, retrieval and MCP handshake contract;
- approved requirements v0.2 and activated the Management Companion design;
- added the loopback-only product management GUI for lifecycle status, Source activation, Codex registration and health inspection;
- kept the optional Visual Companion deferred until the fixed workflow is proven.
