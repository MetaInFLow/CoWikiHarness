# Phase 0 Spike Evidence

Each runner writes one redacted JSON report under `artifacts/spikes/`. Reports contain component versions, boolean checks, counts, Hashes, and selected adapter path only. Source bodies, conversation text, prompts, credentials, tokens, and tool outputs are prohibited.

`pnpm spike:gate` succeeds only when these reports pass:

- `qmd-virtual-documents.json`
- `llmwiki-source-provider.json`
- `codex-history.json`
- `stable-page-identity.json`

The llmwiki runner uses repository fixture content and requires explicit network/provider authorization. The Codex runner reads local history through the read-only stable app-server API and stores counts only.
