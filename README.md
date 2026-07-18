# openLifeWiki

openLifeWiki is a local-first personal knowledge hub for reusing historical information in writing, decisions, and reviews. It connects explicitly authorized sources, compiles a native Markdown Wiki, and serves cited knowledge to Agents through permissioned MCP surfaces.

The product has two architectural spines:

```text
openLifeWiki = Knowledge Core + Skillware Spine
```

Phase 0 creates the engineering baseline and validates four blocking contracts: QMD virtual documents, llmwiki source injection, Codex History access, and stable Wiki page identity. See `docs/architecture/design.md` for the approved V1 design.

## Phase 0

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm spike:qmd
pnpm spike:codex
pnpm spike:page-identity
pnpm spike:llmwiki
pnpm spike:gate
```

The llmwiki spike uses synthetic fixture content and an explicitly configured model provider. It never reads personal sources.

## Storage Boundary

- Original content remains in its authorized source.
- QMD may store the current normalized body as rebuildable derived data.
- Compiler source materialization is temporary and removed when the session closes.
- Historical source bodies are not retained.
- The native Markdown Wiki remains useful without openLifeWiki running.

## License

MIT. Reused components retain their own license and attribution notices.
