---
name: cowikiharness
description: Query, register, and store authorized knowledge through the CoWikiHarness central Knowledge Agent. Use when Codex needs to retrieve shared knowledge with citations, register an external knowledge location, save a managed Markdown draft, or replace an existing managed knowledge item with explicit approval.
---

# CoWikiHarness

Use the `cowiki` command as the only knowledge-center entry point. Do not access its PostgreSQL database or Connectors directly.

## Query

Run:

```bash
cowiki ask "<question>"
```

Use only the returned answer and citations as knowledge-center evidence. Preserve `itemId`, `locationId`, locator and version in citations. When `evidenceMode` is `no-evidence`, report the gap and continue only with clearly labeled non-hub sources if the user permits them.

## Register an external location

Require an exact title, location kind and locator. Run:

```bash
cowiki register --title "<title>" --kind "<kind>" --locator "<locator>" --tag "<tag>"
```

Registration records the address and metadata. It does not authorize copying the external body.

## Store a managed draft

Store only when the user explicitly requests durable knowledge storage. Put the body in a temporary Markdown file, then run:

```bash
cowiki store --title "<title>" --body-file "<absolute-markdown-path>" --tag "<tag>"
```

Treat the new item as a private draft until the user explicitly asks to share it.

## Replace managed knowledge

Always preview first:

```bash
cowiki preview-replace --item "<item-id>" --expected-revision <revision> --title "<title>" --body-file "<absolute-markdown-path>"
```

Show the returned old/new hashes, revision and `previewHash`. Obtain explicit user approval for that exact preview. After approval, run:

```bash
cowiki apply-replace --item "<item-id>" --expected-revision <revision> --title "<title>" --body-file "<absolute-markdown-path>" --preview-hash "<preview-hash>"
```

Do not reuse approval after any title, body, item, revision or preview hash changes.

## Failure handling

- On authentication or delegation failure, stop and report the stable error code.
- On revision or preview conflict, generate a fresh preview; do not retry the write automatically.
- Never print token files, bearer tokens, model credentials or database secrets.
