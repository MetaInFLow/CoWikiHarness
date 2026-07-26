import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const PUBLIC_ROOT = new URL("../src/public/", import.meta.url);

describe("Sources management UI contract", () => {
  it("keeps migration, four-scope editing and exact approval controls reachable", async () => {
    const [html, app] = await Promise.all([
      readFile(new URL("index.html", PUBLIC_ROOT), "utf8"),
      readFile(new URL("app.js", PUBLIC_ROOT), "utf8"),
    ]);

    expect(html).toContain('id="sources-migration-banner"');
    expect(html).toContain('id="source-form"');
    expect(html).toContain('id="connector-scope-fields"');
    expect(html).toContain('id="source-sensitivity-default"');
    expect(html).toContain('id="source-budget-nodes"');
    expect(html).toContain('id="source-diagnostic"');
    expect(html).toContain('id="source-diagnostic-details"');

    for (const fieldId of [
      "scope-local-root", "scope-local-symlink",
      "scope-github-host", "scope-github-repository", "scope-github-path", "scope-github-ref",
      "scope-feishu-profile", "scope-feishu-tenant", "scope-feishu-documents", "scope-feishu-wiki", "scope-feishu-base",
      "scope-codex-roots", "scope-codex-threads",
    ]) expect(app).toContain(fieldId);

    for (const scope of [
      "openlifewiki.scope/local-folder/v1",
      "openlifewiki.scope/github/v1",
      "openlifewiki.scope/feishu/v1",
      "openlifewiki.scope/codex-history/v1",
    ]) expect(app).toContain(scope);

    for (const endpoint of [
      "/api/config/migration/preview",
      "/api/config/migration/execute",
      "/api/sources/authorization/preview",
      "/api/sources/authorization/execute",
      "/api/sources/revoke/preview",
      "/api/sources/revoke/execute",
    ]) expect(app).toContain(endpoint);

    expect(app).toContain("sourcesSnapshot?.authorizations");
    expect(app).toContain("normalizedRequest");
    expect(app).toContain("identityFingerprint");
    expect(app).toContain("preview.provider.identity");
    expect(app).toContain("configRevision");
    expect(app).toContain("previousAuthorizationHash");
    expect(app).toContain("confirmed: true");
    expect(app).toContain("error.details = value.details");
    expect(app).toContain("identity.effectiveScope");
    expect(app).toContain("blocking.remediation");
  });
});
