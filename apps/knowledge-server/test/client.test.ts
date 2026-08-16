import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runClient, type ClientSendInput } from "../src/client.js";

describe("CoWikiHarness A2A client", () => {
  it("asks with the default URL and token file and prints only the final artifact JSON", async () => {
    const sent: ClientSendInput[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const home = "/Users/tester";

    const code = await runClient({
      argv: ["ask", "知识中枢怎么工作？"],
      env: {},
      homeDir: () => home,
      readTextFile: async (path) => {
        expect(path).toBe(join(home, "Library/Application Support/CoWikiHarness/credentials/agent.token"));
        return "top-secret-token\n";
      },
      send: async (input) => {
        sent.push(input);
        return { schema: "openlifewiki.knowledge-query-result/v1", answer: "通过 A2A。" };
      },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("http://127.0.0.1:8080");
    expect(sent[0]?.token).toBe("top-secret-token");
    expect(sent[0]?.request.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "知识中枢怎么工作？",
    });
    expect(stdout).toEqual([JSON.stringify({
      schema: "openlifewiki.knowledge-query-result/v1",
      answer: "通过 A2A。",
    })]);
    expect(stderr).toEqual([]);
  });

  it("builds register, store, preview and apply operations with repeated tags", async () => {
    const operations: unknown[] = [];
    const files = new Map([
      ["/tmp/token", "token-value"],
      ["/tmp/body.md", "# Managed body"],
    ]);
    const send = async (input: ClientSendInput) => {
      const part = input.request.message?.parts[0];
      operations.push(part?.content?.$case === "data" ? part.content.value : null);
      return { ok: true };
    };
    const base = {
      env: { COWIKIHARNESS_URL: "https://knowledge.example/a2a" },
      homeDir: () => "/unused",
      readTextFile: async (path: string) => files.get(path) ?? "",
      send,
      stdout: () => {},
      stderr: () => {},
    };

    for (const argv of [
      ["register", "--title", "Source", "--kind", "github", "--locator", "https://github.com/acme/repo", "--tag", "one", "--tag", "two", "--token-file", "/tmp/token"],
      ["store", "--title", "Managed", "--body-file", "/tmp/body.md", "--tag", "one", "--token-file", "/tmp/token"],
      ["preview-replace", "--item", "item_1", "--expected-revision", "2", "--title", "Managed", "--body-file", "/tmp/body.md", "--token-file", "/tmp/token"],
      ["apply-replace", "--item", "item_1", "--expected-revision", "2", "--title", "Managed", "--body-file", "/tmp/body.md", "--preview-hash", `sha256:${"a".repeat(64)}`, "--token-file", "/tmp/token"],
    ]) {
      await expect(runClient({ argv, ...base })).resolves.toBe(0);
    }

    expect(operations).toEqual([
      expect.objectContaining({
        kind: "knowledge.register",
        title: "Source",
        tags: ["one", "two"],
        locations: [expect.objectContaining({
          kind: "github",
          locator: "https://github.com/acme/repo",
          ownerPrincipalId: "self",
        })],
      }),
      expect.objectContaining({
        kind: "knowledge.store",
        content: expect.objectContaining({ title: "Managed", bodyMarkdown: "# Managed body", tags: ["one"] }),
      }),
      expect.objectContaining({
        kind: "knowledge.store.preview-replace",
        itemId: "item_1",
        expectedRevision: 2,
      }),
      expect.objectContaining({
        kind: "knowledge.store.apply-replace",
        previewHash: `sha256:${"a".repeat(64)}`,
      }),
    ]);
  });

  it("uses the configured token file and emits a stable token-safe error", async () => {
    const stderr: string[] = [];
    const secret = "never-print-this-token";
    const code = await runClient({
      argv: ["ask", "hello", "--token-file", "/custom/token"],
      env: { OPENLIFEWIKI_PUBLIC_URL: "https://fallback.example" },
      homeDir: () => "/unused",
      readTextFile: async (path) => {
        expect(path).toBe("/custom/token");
        return secret;
      },
      send: async () => { throw new Error(secret); },
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(stderr).toEqual([JSON.stringify({ error: { code: "COWIKIHARNESS_REQUEST_FAILED" } })]);
    expect(stderr.join(" ")).not.toContain(secret);
  });

  it("rejects incomplete commands before reading credentials", async () => {
    let read = false;
    const stderr: string[] = [];
    const code = await runClient({
      argv: ["store", "--title", "Missing body"],
      env: {},
      homeDir: () => "/unused",
      readTextFile: async () => { read = true; return ""; },
      send: async () => ({ ok: true }),
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(stderr).toEqual([JSON.stringify({ error: { code: "COWIKIHARNESS_INVALID_ARGUMENTS" } })]);
  });
});
