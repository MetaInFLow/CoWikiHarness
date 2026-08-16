import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runClient,
  type ClientGraphInput,
  type ClientSendInput,
} from "../src/client.js";

const GRAPH_RESPONSE = {
  schema: "cowikiharness.graph/v1",
  registryRevision: 1,
  generatedAt: "2026-08-16T00:00:00.000Z",
  elements: {
    nodes: [
      {
        data: {
          id: "collection:root",
          type: "collection",
          label: "Root",
          description: "",
          revision: 1,
        },
      },
      {
        data: {
          id: "item:item_1",
          type: "knowledge",
          label: "Placed item",
          status: "stable",
          revision: 2,
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      },
    ],
    edges: [{
      data: {
        id: "edge:placement",
        source: "collection:root",
        target: "item:item_1",
        type: "CONTAINS",
        placementRevision: 7,
      },
    }],
  },
  truncated: false,
  nextCursor: null,
} as const;

const INVALID_ARGUMENTS = JSON.stringify({
  error: { code: "COWIKIHARNESS_INVALID_ARGUMENTS" },
});

const REQUEST_FAILED = JSON.stringify({
  error: { code: "COWIKIHARNESS_REQUEST_FAILED" },
});

const COWIKIHARNESS_SKILL = readFileSync(
  new URL("../../../skills/cowikiharness/SKILL.md", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CoWikiHarness A2A client", () => {
  it("documents exact placement revision handling for new and existing knowledge placements", () => {
    expect(COWIKIHARNESS_SKILL).toContain("placementRevision");
    expect(COWIKIHARNESS_SKILL).toContain("collection→knowledge");
    expect(COWIKIHARNESS_SKILL).toContain("新放置");
    expect(COWIKIHARNESS_SKILL).toContain("null");
    expect(COWIKIHARNESS_SKILL).toContain("移动已放置");
    expect(COWIKIHARNESS_SKILL).toContain("--expected-placement-revision");
  });

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
    expect(sent[0]?.request.message?.taskId).toBe("");
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
    const taskIds: string[] = [];
    await runClient({
      argv: ["store", "--title", "Managed", "--body-file", "/tmp/body.md", "--token-file", "/tmp/token"],
      ...base,
      send: async (input) => { taskIds.push(input.request.message?.taskId ?? ""); return { ok: true }; },
    });
    await runClient({
      argv: ["store", "--title", "Managed", "--body-file", "/tmp/body.md", "--token-file", "/tmp/token"],
      ...base,
      send: async (input) => { taskIds.push(input.request.message?.taskId ?? ""); return { ok: true }; },
    });
    expect(taskIds).toEqual(["", ""]);
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

  it.each([
    {
      name: "graph user token",
      argv: ["graph", "--depth", "0", "--include", "tags", "--token-file", "/tmp/user.token"],
    },
    {
      name: "A2A Agent token",
      argv: ["ask", "hello"],
    },
  ])("rejects remote HTTP before reading or sending the $name", async ({ argv }) => {
    let read = false;
    let fetched = false;
    let sent = false;
    const stderr: string[] = [];

    const code = await runClient({
      argv,
      env: {
        COWIKIHARNESS_URL: "http://knowledge.example",
        COWIKIHARNESS_TOKEN_FILE: "/tmp/agent.token",
      },
      readTextFile: async () => { read = true; return "must-not-be-read"; },
      fetchGraph: async () => { fetched = true; return GRAPH_RESPONSE; },
      send: async () => { sent = true; return { unexpected: true }; },
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(fetched).toBe(false);
    expect(sent).toBe(false);
    expect(stderr).toEqual([INVALID_ARGUMENTS]);
    expect(stderr.join(" ")).not.toContain("must-not-be-read");
  });

  it.each([
    "http://user:password@localhost:8080",
    "ftp://localhost:8080",
  ])("rejects an unsafe configured URL before credential access: %s", async (url) => {
    let read = false;
    let fetched = false;
    const stderr: string[] = [];

    const code = await runClient({
      argv: ["graph", "--depth", "0", "--include", "tags", "--token-file", "/tmp/user.token"],
      env: { COWIKIHARNESS_URL: url },
      readTextFile: async () => { read = true; return "must-not-be-read"; },
      fetchGraph: async () => { fetched = true; return GRAPH_RESPONSE; },
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(fetched).toBe(false);
    expect(stderr).toEqual([INVALID_ARGUMENTS]);
  });

  it.each([
    ["localhost HTTP", "http://localhost:8080"],
    ["IPv4 loopback HTTP", "http://127.42.3.4:8080"],
    ["normalized IPv4 loopback HTTP", "http://127.1:8080"],
    ["IPv6 loopback HTTP", "http://[::1]:8080"],
    ["remote HTTPS", "https://knowledge.example"],
  ] as const)("allows %s for graph reads", async (_name, configuredUrl) => {
    const fetched: ClientGraphInput[] = [];

    const code = await runClient({
      argv: ["graph", "--depth", "0", "--include", "tags", "--token-file", "/tmp/user.token"],
      env: { COWIKIHARNESS_URL: configuredUrl },
      readTextFile: async () => "user-token",
      fetchGraph: async (value) => { fetched.push(value); return GRAPH_RESPONSE; },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe(
      `${new URL(configuredUrl).toString().replace(/\/$/u, "")}/api/v1/graph?depth=0&include=tags`,
    );
  });

  it("allows remote HTTPS for A2A Agent calls", async () => {
    const sent: ClientSendInput[] = [];

    const code = await runClient({
      argv: ["ask", "hello"],
      env: {
        COWIKIHARNESS_URL: "https://knowledge.example",
        COWIKIHARNESS_TOKEN_FILE: "/tmp/agent.token",
      },
      readTextFile: async () => "agent-token",
      send: async (value) => { sent.push(value); return { ok: true }; },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://knowledge.example");
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

  it("reads the graph through the injected fetch path with an explicit user token", async () => {
    const fetched: ClientGraphInput[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let sent = false;
    const secret = "user-token-value";

    const code = await runClient({
      argv: ["graph", "--depth", "2", "--include", "tags,locations", "--token-file", "/tmp/owner.token"],
      env: { COWIKIHARNESS_URL: "https://knowledge.example" },
      homeDir: () => "/unused",
      readTextFile: async (path) => {
        expect(path).toBe("/tmp/owner.token");
        return secret;
      },
      fetchGraph: async (input) => {
        fetched.push(input);
        return GRAPH_RESPONSE;
      },
      send: async () => { sent = true; return { unexpected: true }; },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(0);
    expect(fetched).toEqual([{
      url: "https://knowledge.example/api/v1/graph?depth=2&include=tags%2Clocations",
      token: secret,
    }]);
    expect(sent).toBe(false);
    expect(stdout).toEqual([JSON.stringify(GRAPH_RESPONSE)]);
    expect(JSON.parse(stdout[0]!).elements.edges[0].data.placementRevision).toBe(7);
    expect(stderr).toEqual([]);
    expect([...stdout, ...stderr].join(" ")).not.toContain(secret);
  });

  it("builds graph query parameters in contract order and includes only supplied options", async () => {
    const fetched: ClientGraphInput[] = [];

    const code = await runClient({
      argv: [
        "graph",
        "--cursor", "page.signature",
        "--limit", "25",
        "--root", "item:item_1",
        "--include", "locations,tags",
        "--depth", "4",
        "--token-file", "/tmp/user.token",
      ],
      env: { COWIKIHARNESS_URL: "https://knowledge.example/" },
      readTextFile: async () => "user-token",
      fetchGraph: async (input) => { fetched.push(input); return GRAPH_RESPONSE; },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(fetched[0]?.url).toBe(
      "https://knowledge.example/api/v1/graph?depth=4&include=locations%2Ctags&root=item%3Aitem_1&limit=25&cursor=page.signature",
    );
  });

  it("uses native fetch with the bearer token only in the Authorization header", async () => {
    const secret = "native-user-token";
    const timeoutSignal = new AbortController().signal;
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ...GRAPH_RESPONSE, elements: { nodes: [], edges: [] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const stdout: string[] = [];

    const code = await runClient({
      argv: ["graph", "--depth", "0", "--include", "tags", "--token-file", "/tmp/user.token"],
      env: { COWIKIHARNESS_URL: "https://knowledge.example" },
      readTextFile: async () => secret,
      stdout: (value) => stdout.push(value),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://knowledge.example/api/v1/graph?depth=0&include=tags",
      {
        headers: { Authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: timeoutSignal,
      },
    );
    expect(timeoutMock).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(secret);
    expect(stdout.join(" ")).not.toContain(secret);
  });

  it.each([302, 307, 401, 403, 404, 409, 503])(
    "maps graph HTTP %s to one stable token-safe request failure",
    async (status) => {
      const secret = `status-${status}-secret`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
        `server detail containing ${secret}`,
        { status },
      ));
      const stdout: string[] = [];
      const stderr: string[] = [];

      const code = await runClient({
        argv: ["graph", "--depth", "2", "--include", "tags", "--token-file", "/tmp/user.token"],
        env: { COWIKIHARNESS_URL: "https://knowledge.example" },
        readTextFile: async () => secret,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });

      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([REQUEST_FAILED]);
      expect([...stdout, ...stderr].join(" ")).not.toContain(secret);
      expect(stderr.join(" ")).not.toContain("server detail");
      expect(stderr.join(" ")).not.toContain("depth=2");
    },
  );

  it.each([
    ["non-JSON", () => Promise.resolve(new Response("not-json", { status: 200 }))],
    ["malformed schema", () => Promise.resolve(new Response(JSON.stringify({ schema: "wrong" }), { status: 200 }))],
    ["network error", (secret: string) => Promise.reject(new Error(secret))],
  ] as const)("maps a graph %s to one stable token-safe request failure", async (_name, response) => {
    const secret = "graph-failure-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => await response(secret));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runClient({
      argv: ["graph", "--depth", "2", "--include", "tags", "--token-file", "/tmp/user.token"],
      env: { COWIKIHARNESS_URL: "https://knowledge.example" },
      readTextFile: async () => secret,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([REQUEST_FAILED]);
    expect([...stdout, ...stderr].join(" ")).not.toContain(secret);
  });

  it.each([
    ["abort", (secret: string) => new DOMException(secret, "AbortError")],
    ["redirect", (secret: string) => new TypeError(`redirect blocked: ${secret}`)],
  ] as const)("maps a graph %s failure to one stable token-safe request failure", async (_name, error) => {
    const secret = "graph-transport-secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error(secret));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runClient({
      argv: ["graph", "--depth", "2", "--include", "tags", "--token-file", "/tmp/user.token"],
      env: { COWIKIHARNESS_URL: "https://knowledge.example" },
      readTextFile: async () => secret,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([REQUEST_FAILED]);
    expect([...stdout, ...stderr].join(" ")).not.toContain(secret);
  });

  it.each([
    ["missing explicit token file", ["graph", "--depth", "2", "--include", "tags"]],
    ["missing token file value", ["graph", "--depth", "2", "--include", "tags", "--token-file"]],
    ["repeated token file", ["graph", "--depth", "2", "--include", "tags", "--token-file", "/one", "--token-file", "/two"]],
    ["unknown flag", ["graph", "--depth", "2", "--include", "tags", "--unknown", "value", "--token-file", "/token"]],
    ["missing flag value", ["graph", "--depth", "--include", "tags", "--token-file", "/token"]],
    ["repeated flag", ["graph", "--depth", "2", "--depth", "3", "--include", "tags", "--token-file", "/token"]],
    ["negative depth", ["graph", "--depth", "-1", "--include", "tags", "--token-file", "/token"]],
    ["excessive depth", ["graph", "--depth", "5", "--include", "tags", "--token-file", "/token"]],
    ["fractional depth", ["graph", "--depth", "1.5", "--include", "tags", "--token-file", "/token"]],
    ["zero limit", ["graph", "--depth", "2", "--include", "tags", "--limit", "0", "--token-file", "/token"]],
    ["excessive limit", ["graph", "--depth", "2", "--include", "tags", "--limit", "501", "--token-file", "/token"]],
    ["fractional limit", ["graph", "--depth", "2", "--include", "tags", "--limit", "1.5", "--token-file", "/token"]],
    ["malformed root", ["graph", "--depth", "2", "--include", "tags", "--root", "collection:", "--token-file", "/token"]],
    ["unknown root type", ["graph", "--depth", "2", "--include", "tags", "--root", "knowledge:item_1", "--token-file", "/token"]],
    ["empty include", ["graph", "--depth", "2", "--include", "", "--token-file", "/token"]],
    ["duplicate include", ["graph", "--depth", "2", "--include", "tags,tags", "--token-file", "/token"]],
    ["unknown include", ["graph", "--depth", "2", "--include", "tags,secrets", "--token-file", "/token"]],
    ["malformed cursor", ["graph", "--depth", "2", "--include", "tags", "--cursor", "unsigned-cursor", "--token-file", "/token"]],
  ] as const)("rejects graph arguments before token access: %s", async (_name, argv) => {
    let read = false;
    let fetched = false;
    let sent = false;
    const stderr: string[] = [];

    const code = await runClient({
      argv,
      env: { COWIKIHARNESS_TOKEN_FILE: "/default-agent.token" },
      readTextFile: async () => { read = true; return "must-not-be-read"; },
      fetchGraph: async () => { fetched = true; return GRAPH_RESPONSE; },
      send: async () => { sent = true; return { unexpected: true }; },
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(fetched).toBe(false);
    expect(sent).toBe(false);
    expect(stderr).toEqual([INVALID_ARGUMENTS]);
    expect(stderr.join(" ")).not.toContain("must-not-be-read");
  });

  it.each([
    {
      name: "collection create with omitted parent",
      argv: ["collection-create", "--name", "Projects", "--description", "Project knowledge", "--expected-registry-revision", "3"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 3,
        parentCollectionId: null,
        name: "Projects",
        description: "Project knowledge",
      },
    },
    {
      name: "collection create with root parent",
      argv: ["collection-create", "--name", "Projects", "--description", "Project knowledge", "--expected-registry-revision", "0", "--parent", "root"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 0,
        parentCollectionId: null,
        name: "Projects",
        description: "Project knowledge",
      },
    },
    {
      name: "collection create with collection parent",
      argv: ["collection-create", "--name", "Projects", "--description", "Project knowledge", "--expected-registry-revision", "4", "--parent", "collection_parent"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: 4,
        parentCollectionId: "collection_parent",
        name: "Projects",
        description: "Project knowledge",
      },
    },
    {
      name: "collection move with omitted parent",
      argv: ["collection-move", "--collection", "collection_1", "--name", "Architecture", "--description", "Architecture knowledge", "--expected-revision", "2"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: "collection_1",
        expectedRevision: 2,
        parentCollectionId: null,
        name: "Architecture",
        description: "Architecture knowledge",
      },
    },
    {
      name: "collection move with root parent",
      argv: ["collection-move", "--collection", "collection_1", "--name", "Architecture", "--description", "Architecture knowledge", "--expected-revision", "0", "--parent", "root"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: "collection_1",
        expectedRevision: 0,
        parentCollectionId: null,
        name: "Architecture",
        description: "Architecture knowledge",
      },
    },
    {
      name: "collection move with collection parent",
      argv: ["collection-move", "--collection", "collection_1", "--name", "Architecture", "--description", "Architecture knowledge", "--expected-revision", "5", "--parent", "collection_2"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: "collection_1",
        expectedRevision: 5,
        parentCollectionId: "collection_2",
        name: "Architecture",
        description: "Architecture knowledge",
      },
    },
    {
      name: "knowledge place with omitted placement revision",
      argv: ["knowledge-place", "--item", "item_1", "--collection", "collection_2"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: "item_1",
        collectionId: "collection_2",
        expectedPlacementRevision: null,
      },
    },
    {
      name: "knowledge place with zero placement revision",
      argv: ["knowledge-place", "--item", "item_1", "--collection", "collection_2", "--expected-placement-revision", "0"],
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: "item_1",
        collectionId: "collection_2",
        expectedPlacementRevision: 0,
      },
    },
  ])("builds the exact structured A2A operation: $name", async ({ argv, operation }) => {
    const sent: ClientSendInput[] = [];
    let fetched = false;
    const home = "/Users/tester";

    const code = await runClient({
      argv,
      env: { COWIKIHARNESS_URL: "https://knowledge.example" },
      homeDir: () => home,
      readTextFile: async (path) => {
        expect(path).toBe(join(home, "Library/Application Support/CoWikiHarness/credentials/agent.token"));
        return "agent-token";
      },
      fetchGraph: async () => { fetched = true; return GRAPH_RESPONSE; },
      send: async (input) => { sent.push(input); return { ok: true }; },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(fetched).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe("agent-token");
    const part = sent[0]?.request.message?.parts[0];
    expect(part?.content?.$case).toBe("data");
    expect(part?.content?.$case === "data" ? part.content.value : null).toEqual(operation);
  });

  it("allows an existing token-file override for structured A2A organization", async () => {
    const sent: ClientSendInput[] = [];

    const code = await runClient({
      argv: [
        "knowledge-place",
        "--item", "item_1",
        "--collection", "collection_2",
        "--token-file", "/tmp/agent.token",
      ],
      env: {},
      readTextFile: async (path) => {
        expect(path).toBe("/tmp/agent.token");
        return "agent-override-token";
      },
      send: async (input) => { sent.push(input); return { ok: true }; },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(sent[0]?.token).toBe("agent-override-token");
  });

  it.each([
    ["create missing name", ["collection-create", "--description", "Description", "--expected-registry-revision", "0"]],
    ["create empty name", ["collection-create", "--name", "", "--description", "Description", "--expected-registry-revision", "0"]],
    ["create missing flag value", ["collection-create", "--name", "Name", "--description", "--expected-registry-revision", "0"]],
    ["create repeated name", ["collection-create", "--name", "One", "--name", "Two", "--description", "Description", "--expected-registry-revision", "0"]],
    ["create unknown flag", ["collection-create", "--name", "Name", "--description", "Description", "--expected-registry-revision", "0", "--unknown", "value"]],
    ["create negative revision", ["collection-create", "--name", "Name", "--description", "Description", "--expected-registry-revision", "-1"]],
    ["create fractional revision", ["collection-create", "--name", "Name", "--description", "Description", "--expected-registry-revision", "1.5"]],
    ["create malformed parent", ["collection-create", "--name", "Name", "--description", "Description", "--expected-registry-revision", "0", "--parent", "bad/id"]],
    ["move missing collection", ["collection-move", "--name", "Name", "--description", "Description", "--expected-revision", "0"]],
    ["move empty description", ["collection-move", "--collection", "collection_1", "--name", "Name", "--description", "", "--expected-revision", "0"]],
    ["move repeated parent", ["collection-move", "--collection", "collection_1", "--name", "Name", "--description", "Description", "--expected-revision", "0", "--parent", "root", "--parent", "collection_2"]],
    ["move unsafe revision", ["collection-move", "--collection", "collection_1", "--name", "Name", "--description", "Description", "--expected-revision", "9007199254740992"]],
    ["place missing item", ["knowledge-place", "--collection", "collection_2"]],
    ["place malformed item", ["knowledge-place", "--item", "bad/item", "--collection", "collection_2"]],
    ["place repeated collection", ["knowledge-place", "--item", "item_1", "--collection", "collection_1", "--collection", "collection_2"]],
    ["place unknown flag", ["knowledge-place", "--item", "item_1", "--collection", "collection_2", "--unknown", "value"]],
    ["place negative revision", ["knowledge-place", "--item", "item_1", "--collection", "collection_2", "--expected-placement-revision", "-1"]],
    ["place fractional revision", ["knowledge-place", "--item", "item_1", "--collection", "collection_2", "--expected-placement-revision", "1.5"]],
  ] as const)("rejects organize arguments before token access: %s", async (_name, argv) => {
    let read = false;
    let fetched = false;
    let sent = false;
    const stderr: string[] = [];

    const code = await runClient({
      argv,
      env: {},
      readTextFile: async () => { read = true; return "must-not-be-read"; },
      fetchGraph: async () => { fetched = true; return GRAPH_RESPONSE; },
      send: async () => { sent = true; return { unexpected: true }; },
      stdout: () => {},
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(fetched).toBe(false);
    expect(sent).toBe(false);
    expect(stderr).toEqual([INVALID_ARGUMENTS]);
    expect(stderr.join(" ")).not.toContain("must-not-be-read");
  });
});
