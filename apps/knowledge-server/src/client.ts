import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  ClientFactory,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  Role,
  TaskState,
  type SendMessageRequest,
} from "@a2a-js/sdk";
import {
  KNOWLEDGE_GRAPH_INCLUDES,
  knowledgeGraphResponseSchema,
} from "@openlifewiki/protocol";

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_TOKEN_RELATIVE_PATH = "Library/Application Support/CoWikiHarness/credentials/agent.token";

type ClientErrorCode =
  | "COWIKIHARNESS_INVALID_ARGUMENTS"
  | "COWIKIHARNESS_TOKEN_UNAVAILABLE"
  | "COWIKIHARNESS_BODY_UNAVAILABLE"
  | "COWIKIHARNESS_REQUEST_FAILED"
  | "COWIKIHARNESS_ARTIFACT_MISSING";

interface ClientError {
  readonly error: { readonly code: ClientErrorCode };
}

export interface ClientSendInput {
  readonly url: string;
  readonly token: string;
  readonly request: SendMessageRequest;
}

export interface ClientGraphInput {
  readonly url: string;
  readonly token: string;
}

export interface RunClientInput {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir?: () => string;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly send?: (input: ClientSendInput) => Promise<unknown>;
  readonly fetchGraph?: (input: ClientGraphInput) => Promise<unknown>;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}

type ParsedCommand =
  | { readonly kind: "ask"; readonly text: string }
  | { readonly kind: "graph"; readonly query: string }
  | { readonly kind: "operation"; readonly operation: Record<string, unknown> }
  | {
    readonly kind: "body-operation";
    readonly bodyFile: string;
    readonly build: (bodyMarkdown: string) => Record<string, unknown>;
  };

export async function runClient(input: RunClientInput): Promise<number> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  try {
    const { args, tokenFile } = extractTokenFile(input.argv);
    const command = parseCommand(args);
    if (command.kind === "graph" && tokenFile === undefined) invalidArguments();
    const url = parseUrl(input.env.COWIKIHARNESS_URL
      ?? input.env.OPENLIFEWIKI_PUBLIC_URL
      ?? DEFAULT_URL);
    const readTextFile = input.readTextFile ?? (async (path) => await readFile(path, "utf8"));
    const operation = command.kind === "body-operation"
      ? command.build(await readRequiredFile(readTextFile, command.bodyFile, "COWIKIHARNESS_BODY_UNAVAILABLE"))
      : command.kind === "operation" ? command.operation : null;
    let credentialsPath = tokenFile;
    if (command.kind !== "graph") {
      credentialsPath ??= input.env.COWIKIHARNESS_TOKEN_FILE
        ?? join((input.homeDir ?? homedir)(), DEFAULT_TOKEN_RELATIVE_PATH);
    }
    if (credentialsPath === undefined) invalidArguments();
    const token = (await readRequiredFile(
      readTextFile,
      credentialsPath,
      "COWIKIHARNESS_TOKEN_UNAVAILABLE",
    )).trim();
    if (token.length === 0) throw new CliError("COWIKIHARNESS_TOKEN_UNAVAILABLE");
    if (command.kind === "graph") {
      const rawGraph = await (input.fetchGraph ?? fetchGraph)({
        url: `${url}/api/v1/graph?${command.query}`,
        token,
      });
      const graph = knowledgeGraphResponseSchema.safeParse(rawGraph);
      if (!graph.success) throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
      stdout(JSON.stringify(graph.data));
      return 0;
    }
    const request = command.kind === "ask"
      ? requestWithPart({ $case: "text", value: command.text }, "text/plain")
      : requestWithPart({ $case: "data", value: operation }, "application/json");
    const artifact = await (input.send ?? sendA2A)({ url, token, request });
    stdout(JSON.stringify(artifact));
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : "COWIKIHARNESS_REQUEST_FAILED";
    const result: ClientError = { error: { code } };
    stderr(JSON.stringify(result));
    return 1;
  }
}

export async function fetchGraph(input: ClientGraphInput): Promise<unknown> {
  try {
    const response = await fetch(input.url, {
      headers: { Authorization: `Bearer ${input.token}` },
    });
    if (!response.ok) throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
    return await response.json();
  } catch {
    throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
  }
}

export async function sendA2A(input: ClientSendInput): Promise<unknown> {
  try {
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
      preferredTransports: ["JSONRPC"],
    }).createFromUrl(input.url);
    let taskId = input.request.message?.taskId ?? "";
    try {
      let artifact: unknown;
      let failed = false;
      for await (const event of client.sendMessageStream(input.request, {
        serviceParameters: { Authorization: `Bearer ${input.token}` },
      })) {
        if (event.payload?.$case === "task") taskId = event.payload.value.id;
        if (event.payload?.$case === "artifactUpdate") taskId = event.payload.value.taskId;
        if (event.payload?.$case === "statusUpdate") taskId = event.payload.value.taskId;
        if (event.payload?.$case === "artifactUpdate") {
          const part = event.payload.value.artifact?.parts.at(-1);
          if (part?.content?.$case === "data") artifact = part.content.value;
        }
        if (event.payload?.$case === "statusUpdate") {
          const state = event.payload.value.status?.state;
          failed = failed
            || state === TaskState.TASK_STATE_FAILED
            || state === TaskState.TASK_STATE_CANCELED
            || state === TaskState.TASK_STATE_INPUT_REQUIRED;
        }
      }
      if (failed) throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
      if (artifact === undefined) throw new CliError("COWIKIHARNESS_ARTIFACT_MISSING");
      return artifact;
    } catch {
      if (taskId === "") throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
      const task = await client.getTask(
        { tenant: "", id: taskId },
        { serviceParameters: { Authorization: `Bearer ${input.token}` } },
      );
      if (task.status?.state !== TaskState.TASK_STATE_COMPLETED) {
        throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
      }
      for (const artifact of [...task.artifacts].reverse()) {
        for (const part of [...artifact.parts].reverse()) {
          if (part.content?.$case === "data") return part.content.value;
        }
      }
      throw new CliError("COWIKIHARNESS_ARTIFACT_MISSING");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("COWIKIHARNESS_REQUEST_FAILED");
  }
}

function requestWithPart(
  content: { readonly $case: "text"; readonly value: string }
    | { readonly $case: "data"; readonly value: unknown },
  mediaType: string,
): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{ content, mediaType, filename: "", metadata: {} }],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: {},
  };
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const [command, ...args] = argv;
  if (command === "ask") {
    const text = args.join(" ").trim();
    if (text.length === 0 || text.length > 8_000) invalidArguments();
    return { kind: "ask", text };
  }
  const flags = parseFlags(args);
  const tags = flags.get("tag") ?? [];
  if (command === "graph") {
    assertOnly(flags, ["depth", "include", "root", "limit", "cursor"]);
    const depth = parseBoundedInteger(one(flags, "depth"), 0, 4);
    const include = parseGraphIncludes(one(flags, "include"));
    const root = optionalOne(flags, "root");
    const limit = optionalOne(flags, "limit");
    const cursor = optionalOne(flags, "cursor");
    if (root !== undefined && !/^(?:collection|item):[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(root)) {
      invalidArguments();
    }
    if (cursor !== undefined
      && (cursor.length > 4_096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(cursor))) {
      invalidArguments();
    }
    const query = new URLSearchParams();
    query.set("depth", String(depth));
    query.set("include", include);
    if (root !== undefined) query.set("root", root);
    if (limit !== undefined) query.set("limit", String(parseBoundedInteger(limit, 1, 500)));
    if (cursor !== undefined) query.set("cursor", cursor);
    return { kind: "graph", query: query.toString() };
  }
  if (command === "collection-create") {
    assertOnly(flags, ["name", "description", "expected-registry-revision", "parent"]);
    return {
      kind: "operation",
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.create",
        expectedRegistryRevision: parseRevision(one(flags, "expected-registry-revision")),
        parentCollectionId: parseParentCollectionId(optionalOne(flags, "parent")),
        name: parseBoundedText(one(flags, "name"), 200),
        description: parseBoundedText(one(flags, "description"), 2_000),
      },
    };
  }
  if (command === "collection-move") {
    assertOnly(flags, ["collection", "name", "description", "expected-revision", "parent"]);
    return {
      kind: "operation",
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.collection.move",
        collectionId: parseRegistryId(one(flags, "collection")),
        expectedRevision: parseRevision(one(flags, "expected-revision")),
        parentCollectionId: parseParentCollectionId(optionalOne(flags, "parent")),
        name: parseBoundedText(one(flags, "name"), 200),
        description: parseBoundedText(one(flags, "description"), 2_000),
      },
    };
  }
  if (command === "knowledge-place") {
    assertOnly(flags, ["item", "collection", "expected-placement-revision"]);
    const expectedPlacementRevision = optionalOne(flags, "expected-placement-revision");
    return {
      kind: "operation",
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.place",
        itemId: parseRegistryId(one(flags, "item")),
        collectionId: parseRegistryId(one(flags, "collection")),
        expectedPlacementRevision: expectedPlacementRevision === undefined
          ? null
          : parseRevision(expectedPlacementRevision),
      },
    };
  }
  if (command === "register") {
    const title = one(flags, "title");
    const locationKind = one(flags, "kind");
    const locator = one(flags, "locator");
    assertOnly(flags, ["title", "kind", "locator", "tag"]);
    if (!["managed-markdown", "feishu", "github", "person-local"].includes(locationKind)) invalidArguments();
    return {
      kind: "operation",
      operation: {
        schema: "openlifewiki.operation/v1",
        kind: "knowledge.register",
        itemId: null,
        expectedRevision: null,
        title,
        aliases: [],
        tags,
        locations: [{
          kind: locationKind,
          role: "original",
          locator,
          connectorInstanceId: null,
          ownerPrincipalId: "self",
          metadata: {},
        }],
      },
    };
  }
  if (command === "store") {
    const title = one(flags, "title");
    const bodyFile = one(flags, "body-file");
    assertOnly(flags, ["title", "body-file", "tag"]);
    return bodyOperation(bodyFile, (bodyMarkdown) => ({
      schema: "openlifewiki.operation/v1",
      kind: "knowledge.store",
      itemId: null,
      expectedRevision: null,
      content: { title, bodyMarkdown, aliases: [], tags },
    }));
  }
  if (command === "preview-replace" || command === "apply-replace") {
    const itemId = one(flags, "item");
    const expectedRevision = parseRevision(one(flags, "expected-revision"));
    const title = one(flags, "title");
    const bodyFile = one(flags, "body-file");
    const previewHash = command === "apply-replace" ? one(flags, "preview-hash") : undefined;
    assertOnly(flags, command === "apply-replace"
      ? ["item", "expected-revision", "title", "body-file", "preview-hash", "tag"]
      : ["item", "expected-revision", "title", "body-file", "tag"]);
    if (previewHash !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(previewHash)) invalidArguments();
    return bodyOperation(bodyFile, (bodyMarkdown) => ({
      schema: "openlifewiki.operation/v1",
      kind: command === "apply-replace"
        ? "knowledge.store.apply-replace"
        : "knowledge.store.preview-replace",
      itemId,
      expectedRevision,
      ...(previewHash === undefined ? {} : { previewHash }),
      content: { title, bodyMarkdown, aliases: [], tags },
    }));
  }
  invalidArguments();
}

function bodyOperation(
  bodyFile: string,
  build: (bodyMarkdown: string) => Record<string, unknown>,
): ParsedCommand {
  return { kind: "body-operation", bodyFile, build };
}

function parseFlags(args: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || value.startsWith("--")) {
      invalidArguments();
    }
    const key = flag.slice(2);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function extractTokenFile(argv: readonly string[]): { readonly args: string[]; readonly tokenFile?: string } {
  const args: string[] = [];
  let tokenFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--token-file") {
      args.push(argv[index] ?? "");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--") || tokenFile !== undefined) {
      invalidArguments();
    }
    tokenFile = value;
    index += 1;
  }
  return { args, ...(tokenFile === undefined ? {} : { tokenFile }) };
}

function one(flags: ReadonlyMap<string, readonly string[]>, key: string): string {
  const values = flags.get(key);
  if (values?.length !== 1 || values[0]?.trim() === "") invalidArguments();
  return values[0]!;
}

function optionalOne(flags: ReadonlyMap<string, readonly string[]>, key: string): string | undefined {
  if (!flags.has(key)) return undefined;
  return one(flags, key);
}

function assertOnly(flags: ReadonlyMap<string, readonly string[]>, allowed: readonly string[]): void {
  if ([...flags.keys()].some((key) => !allowed.includes(key))) invalidArguments();
}

function parseBoundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = parseRevision(value);
  if (parsed < minimum || parsed > maximum) invalidArguments();
  return parsed;
}

function parseRevision(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) invalidArguments();
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) invalidArguments();
  return revision;
}

function parseGraphIncludes(value: string): string {
  const entries = value.split(",");
  if (entries.some((entry) => entry === "") || new Set(entries).size !== entries.length) {
    invalidArguments();
  }
  if (entries.some((entry) => !(KNOWLEDGE_GRAPH_INCLUDES as readonly string[]).includes(entry))) {
    invalidArguments();
  }
  return value;
}

function parseParentCollectionId(value: string | undefined): string | null {
  if (value === undefined || value === "root") return null;
  return parseRegistryId(value);
}

function parseRegistryId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) invalidArguments();
  return value;
}

function parseBoundedText(value: string, maximum: number): string {
  if (value.length > maximum) invalidArguments();
  return value;
}

function parseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") invalidArguments();
    return url.toString().replace(/\/$/u, "");
  } catch {
    invalidArguments();
  }
}

async function readRequiredFile(
  reader: (path: string) => Promise<string>,
  path: string,
  code: ClientErrorCode,
): Promise<string> {
  try {
    return await reader(path);
  } catch {
    throw new CliError(code);
  }
}

function invalidArguments(): never {
  throw new CliError("COWIKIHARNESS_INVALID_ARGUMENTS");
}

class CliError extends Error {
  constructor(readonly code: ClientErrorCode) {
    super(code);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runClient({ argv: process.argv.slice(2), env: process.env }).then((code) => {
    process.exitCode = code;
  }).catch(() => {
    console.error(JSON.stringify({ error: { code: "COWIKIHARNESS_REQUEST_FAILED" } }));
    process.exitCode = 1;
  });
}
