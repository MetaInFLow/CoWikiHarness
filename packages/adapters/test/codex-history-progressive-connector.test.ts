import { TextDecoder } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createEnumerationIntent,
  createScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
  type EnumerationIntent,
  type EnumerationPageReceipt,
  type LeafSelectionReceipt,
  type ScanDecision,
  type ScanPlan,
  type SkeletonNode,
  type SkeletonPage,
} from "@openlifewiki/protocol";

import type { CommandOptions, CommandRunner, JsonLineStep } from "../src/command-runner.js";
import {
  createBodyBudgetReservationReceipt,
  progressiveConnectorScopeHash,
} from "../src/connectors/connector-provider.js";
import { createCodexHistoryConnector } from "../src/connectors/codex-history.js";

const now = () => new Date("2026-07-27T02:00:00.000Z");
const PROJECT_ROOT = "/projects/openLifeWiki";
const CONTRACT_HASH = sha256Canonical("codex-app-server-v2-contract");
const PHYSICAL_IO_HASH = sha256Canonical("codex-history-physical-io-accounting");

describe("Codex History progressive Connector", () => {
  it("paginates only approved thread IDs under an exact project cwd without reading turns", async () => {
    const fixture = codexFixture();
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now })).nodes[0]!;
    const projects = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const project = projects.nodes[0]!;
    const threadTraversal = traversal(action, project, root);
    const page1 = await connector.listChildrenMetadata({
      ...action, ...threadTraversal, parent: project, limit: 1, cursor: null, now,
    });
    const receipt1 = pageReceipt(action.plan, threadTraversal.intent, page1, 1, null);
    const page2 = await connector.listChildrenMetadata({
      ...action,
      ...threadTraversal,
      trustedReceiptHashes: [...threadTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: project,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    });

    expect(root).toMatchObject({ nodeId: action.rootNodeId, parentId: null, kind: "directory", scanability: "metadata-only" });
    expect(project).toMatchObject({ parentId: root.nodeId, kind: "directory", title: "openLifeWiki" });
    expect([...page1.nodes, ...page2.nodes].map(({ title }) => title)).toEqual(["thread-a", "thread-b"]);
    expect(JSON.stringify([...page1.nodes, ...page2.nodes])).not.toMatch(/private preview|private name|turn-secret/i);
    expect(page1.pageComplete).toBe(false);
    expect(page2.pageComplete).toBe(true);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const requests = fixture.requests("thread/list");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.params).toEqual({ cwd: PROJECT_ROOT, cursor: null, limit: 1, useStateDbOnly: true });
    expect(requests[1]?.params).toEqual({ cwd: PROJECT_ROOT, cursor: "opaque-page-2", limit: 2, useStateDbOnly: true });
    expect(fixture.sessions.every(({ steps }) => messageAt(steps, 0)?.method === "initialize"
      && messageAt(steps, 1)?.method === "initialized")).toBe(true);
    expect(fixture.sessions.every(({ options }) => options?.env !== undefined
      && options.env.OPENAI_API_KEY === undefined && options.env.OPENAI_BASE_URL === undefined)).toBe(true);
  });

  it("reads deterministic Markdown only after version, gate and budget checks", async () => {
    const fixture = codexFixture();
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    const { root, project, thread } = await firstThread(connector, action);
    expect(fixture.bodyCalls()).toHaveLength(0);
    expect(await connector.getVersion({ ...action, node: thread })).toBe(thread.nodeVersion);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const reservedBytes = 2_048;
    const approved = await connector.readApprovedLeafBody({
      ...action, node: thread, expectedVersion: thread.nodeVersion,
      ...bodyPermit(action, thread, bodyGate(action, [root, project, thread]), reservedBytes),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of approved.stream) chunks.push(chunk);
    const markdown = new TextDecoder().decode(Buffer.concat(chunks));
    expect(markdown).toContain("# Codex thread `thread-a`");
    expect(markdown).toContain("### User\n\nNeed a decision.");
    expect(markdown).toContain("### Assistant\n\nUse the bounded option.");
    expect(markdown).not.toMatch(/private preview|private name|turn-secret|tool-secret/i);
    expect(fixture.bodyCalls()).toHaveLength(1);
    expect(fixture.bodyCalls()[0]?.options?.maxOutputBytes).toBe(reservedBytes + 64 * 1024);
  });

  it("denies stale, forged and out-of-scope thread reads before full history I/O", async () => {
    const fixture = codexFixture();
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    const { root, project, thread } = await firstThread(connector, action);
    expect(fixture.requests("thread/list").flatMap((request) => request.returnedIds)).not.toContain("thread-outside");

    const forged = { ...thread, locator: forgeLocatorThreadId(thread.locator, "thread-outside") };
    await expect(connector.getVersion({ ...action, node: forged }))
      .rejects.toMatchObject({ code: "CODEX_ACTION_BINDING_INVALID" });
    expect(fixture.bodyCalls()).toHaveLength(0);

    fixture.setUpdatedAt("thread-a", 300);
    await expect(connector.readApprovedLeafBody({
      ...action, node: thread, expectedVersion: thread.nodeVersion,
      ...bodyPermit(action, thread, bodyGate(action, [root, project, thread]), 2_048),
    })).rejects.toMatchObject({ code: "CODEX_VERSION_MISMATCH" });
    expect(fixture.bodyCalls()).toHaveLength(0);
  });

  it("binds JSONL output to the reservation and rejects rendered bodies over budget", async () => {
    const fixture = codexFixture({ agentText: "x".repeat(2_000) });
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource({ maxBodyBytes: 256 }));
    const { root, project, thread } = await firstThread(connector, action);
    await expect(connector.readApprovedLeafBody({
      ...action, node: thread, expectedVersion: thread.nodeVersion,
      ...bodyPermit(action, thread, bodyGate(action, [root, project, thread]), 256),
    })).rejects.toMatchObject({ code: "CODEX_BODY_BUDGET_EXCEEDED" });
    expect(fixture.bodyCalls()).toHaveLength(1);
    expect(fixture.bodyCalls()[0]?.options?.maxOutputBytes).toBe(256 + 64 * 1024);
  });

  it("fails closed on malformed app-server responses and never leaks raw errors", async () => {
    const fixture = codexFixture({ readError: true });
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    const { thread } = await firstThread(connector, action);
    await expect(connector.getVersion({ ...action, node: thread })).rejects.toMatchObject({ code: "CODEX_METADATA_FAILED" });
    try {
      await connector.getVersion({ ...action, node: thread });
    } catch (error) {
      expect(String(error)).not.toMatch(/raw-private-error|stack|token/i);
    }
    expect(fixture.bodyCalls()).toHaveLength(0);
  });

  it("fails closed when the current Codex login mode differs from the approved identity", async () => {
    const fixture = codexFixture({ loginMode: "Codex login" });
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    await expect(connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now }))
      .rejects.toMatchObject({ code: "CODEX_IDENTITY_CHANGED" });
    expect(fixture.requests("thread/list")).toHaveLength(0);
    expect(fixture.bodyCalls()).toHaveLength(0);
  });

  it("rejects an approved thread replayed on a later page in the same cursor chain", async () => {
    const fixture = codexFixture({ replayOnThirdPage: true });
    const connector = createCodexHistoryConnector(fixture.runner);
    const action = bound(authorizedCodexSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now })).nodes[0]!;
    const project = (await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    })).nodes[0]!;
    const threadTraversal = traversal(action, project, root);
    const page1 = await connector.listChildrenMetadata({
      ...action, ...threadTraversal, parent: project, limit: 1, cursor: null, now,
    });
    const receipt1 = pageReceipt(action.plan, threadTraversal.intent, page1, 1, null);
    const page2 = await connector.listChildrenMetadata({
      ...action, ...threadTraversal,
      trustedReceiptHashes: [...threadTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1, parent: project, limit: 2, cursor: page1.nextCursor, now,
    });
    const receipt2 = pageReceipt(action.plan, threadTraversal.intent, page2, 2, receipt1);
    await expect(connector.listChildrenMetadata({
      ...action, ...threadTraversal,
      trustedReceiptHashes: [...threadTraversal.trustedReceiptHashes, receipt1.receiptHash, receipt2.receiptHash],
      previousPageReceipt: receipt2, parent: project, limit: 1, cursor: page2.nextCursor, now,
    })).rejects.toMatchObject({ code: "CODEX_ENUMERATION_INCOMPLETE" });
    expect(fixture.bodyCalls()).toHaveLength(0);
  });
});

interface SessionCall {
  readonly steps: readonly JsonLineStep[];
  readonly options?: CommandOptions & { readonly maxOutputBytes?: number };
}

interface RequestRecord {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly returnedIds: readonly string[];
}

function codexFixture(overrides: {
  readonly agentText?: string;
  readonly loginMode?: "ChatGPT login" | "Codex login";
  readonly readError?: boolean;
  readonly replayOnThirdPage?: boolean;
} = {}) {
  const sessions: SessionCall[] = [];
  const requestRecords: RequestRecord[] = [];
  const updatedAt = new Map([["thread-a", 100], ["thread-b", 110], ["thread-outside", 120]]);
  const runner: CommandRunner = {
    async run(command, args) {
      if (command === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.146.0\n", stderr: "" };
      if (command === "codex" && args[0] === "login" && args[1] === "status") {
        return { stdout: overrides.loginMode === "Codex login" ? "Authenticated\n" : "Logged in using ChatGPT\n", stderr: "" };
      }
      throw new Error("Unexpected command");
    },
    async runJsonLineSession(_command, _args, steps, options) {
      sessions.push({ steps, ...(options === undefined ? {} : { options }) });
      const messages = steps.map(({ message }) => message).filter(isRecord);
      const account = messages.find(({ method }) => method === "account/read");
      const action = messages.find(({ method }) => method === "thread/list" || method === "thread/read");
      const responses: unknown[] = [];
      if (account !== undefined) responses.push({ id: account.id, result: {
        account: { type: "chatgpt", email: "owner@example.com", planType: "pro" },
      } });
      if (action === undefined) return responses;
      const params = isRecord(action.params) ? action.params : {};
      if (action.method === "thread/list") {
        const cursor = params.cursor;
        const data = cursor === null
          ? [thread("thread-a", updatedAt.get("thread-a")!)]
          : cursor === "opaque-page-2"
            ? [thread("thread-outside", updatedAt.get("thread-outside")!), thread("thread-b", updatedAt.get("thread-b")!)]
            : [thread("thread-a", updatedAt.get("thread-a")!)];
        const nextCursor = cursor === null ? "opaque-page-2"
          : cursor === "opaque-page-2" && overrides.replayOnThirdPage === true ? "opaque-page-3" : null;
        requestRecords.push({ method: action.method, params, returnedIds: data.map(({ id }) => id) });
        responses.push({ id: action.id, result: { data, nextCursor } });
      } else {
        const id = typeof params.threadId === "string" ? params.threadId : "invalid";
        const includeTurns = params.includeTurns === true;
        requestRecords.push({ method: String(action.method), params, returnedIds: [id] });
        if (overrides.readError === true) responses.push({ id: action.id, error: { code: -32_000, message: "raw-private-error token" } });
        else responses.push({ id: action.id, result: { thread: thread(id, updatedAt.get(id) ?? 100, includeTurns) } });
      }
      return responses;
    },
  };
  return {
    runner,
    sessions,
    requests: (method: string) => requestRecords.filter((record) => record.method === method),
    bodyCalls: () => sessions.filter(({ steps }) => steps.some(({ message }) => (
      isRecord(message) && message.method === "thread/read" && isRecord(message.params) && message.params.includeTurns === true
    ))),
    setUpdatedAt: (id: string, value: number) => updatedAt.set(id, value),
  };

  function thread(id: string, modified: number, includeTurns = false) {
    return {
      id, cwd: PROJECT_ROOT, source: "cli", status: { type: "idle" }, createdAt: 50, updatedAt: modified,
      cliVersion: "0.146.0", modelProvider: "openai", ephemeral: false, sessionId: `session-${id}`,
      preview: "private preview", name: "private name", turns: includeTurns ? [{
        id: "turn-1", status: "completed", items: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Need a decision." }] },
          { id: "assistant-1", type: "agentMessage", text: overrides.agentText ?? "Use the bounded option." },
          { id: "tool-1", type: "commandExecution", command: "secret", commandActions: [], cwd: PROJECT_ROOT,
            aggregatedOutput: "tool-secret", status: "completed" },
        ],
      }] : [],
    };
  }
}

async function firstThread(connector: ReturnType<typeof createCodexHistoryConnector>, action: ReturnType<typeof bound>) {
  const root = (await connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now })).nodes[0]!;
  const project = (await connector.listChildrenMetadata({
    ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
  })).nodes[0]!;
  const thread = (await connector.listChildrenMetadata({
    ...action, ...traversal(action, project, root), parent: project, limit: 10, cursor: null, now,
  })).nodes[0]!;
  return { root, project, thread };
}

function authorizedCodexSource(overrides: { readonly maxBodyBytes?: number } = {}): AuthorizedSourceV1 {
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const, action: "authorize" as const,
    approvedBy: "human:owner" as const, approvedAt: now().toISOString(), ownerIdentityFingerprint: sha256Canonical("owner"),
    previewHash: sha256Canonical("preview"), configHash: sha256Canonical("config"), configRevision: 1,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const, sourceId: "source-codex", connectorType: "codex-history" as const,
    rootNodeId: "codex-history-root", identityFingerprint: sha256Canonical({
      provider: "codex", accountType: "chatgpt", email: "owner@example.com", version: "0.146.0",
      loginMode: "ChatGPT login", schema: CONTRACT_HASH,
    }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    providerObservation: { providerName: "codex app-server v2", providerVersion: "0.146.0", contractHash: CONTRACT_HASH },
    scope: { schema: "openlifewiki.scope/codex-history/v1", projectRoots: [PROJECT_ROOT], threadIds: ["thread-a", "thread-b"] },
    include: ["/**"], exclude: [], sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: overrides.maxBodyBytes ?? 100_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const, approvedAt: now().toISOString(),
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function bound(source: AuthorizedSourceV1) {
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1", scanId: "scan-codex", sourceIds: [source.sourceId],
    authorizationHashes: [source.authorizationHash], rootNodeIds: [source.rootNodeId],
    skeletonVersion: sha256Canonical("codex-history-skeleton-v1"), agentProfileId: "agent-codex",
    skillHash: sha256Canonical("skill"), scanIntent: "Build reusable knowledge from selected Codex history.",
    priorityDocumentRefs: [], policy: {
      include: ["/**"], exclude: [], sensitivity: "normal", budget: {},
      indexing: { default: "qmd-current", rules: [] },
    },
  });
  return { source, plan, sourceId: source.sourceId, authorizationHash: source.authorizationHash,
    rootNodeId: source.rootNodeId, scopeHash: progressiveConnectorScopeHash(source) } as const;
}

function traversal(action: ReturnType<typeof bound>, target: SkeletonNode, parentLayer: SkeletonNode | null) {
  const decision = parentLayer === null ? null : containerDecision(action.plan, action.source, parentLayer, target);
  const intent = createEnumerationIntent({
    plan: action.plan, trustedDecisionReceiptHashes: decision === null ? [] : [decision.receiptHash], decisionReceipt: decision,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1", intentId: `intent-${target.nodeId.slice(0, 20)}`,
      sourceId: action.sourceId, targetNodeId: target.nodeId, targetNodeVersion: target.nodeVersion,
      authorizationHash: action.authorizationHash, origin: parentLayer === null ? "authorized-root" : "container-descend",
      parentLayerNodeId: parentLayer?.nodeId ?? null, childSetHash: decision?.childSetHash ?? null,
      inputSetHash: decision?.inputSetHash ?? sha256Canonical(`root-${target.nodeId}`), createdAt: now().toISOString(),
    },
  });
  return { intent, trustedDecisionReceipts: decision === null ? [] : [decision],
    trustedReceiptHashes: [intent.receiptHash, ...(decision === null ? [] : [decision.receiptHash])], previousPageReceipt: null } as const;
}

function containerDecision(plan: ScanPlan, source: AuthorizedSourceV1, parent: SkeletonNode, target: SkeletonNode): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: source.authorizationHash, sourceId: source.sourceId,
    parentNodeId: parent.nodeId, parentNodeVersion: parent.nodeVersion,
    childSetHash: sha256Canonical({ parent: parent.nodeId, target: target.nodeId }), nodeId: target.nodeId,
    nodeVersion: target.nodeVersion, targetKind: "container", summaryHash: sha256Canonical("summary"),
    inputSetHash: sha256Canonical(`input-${target.nodeId}`), decision: "descend", reason: "Selected container",
    revisitCondition: null, question: null, actor: "agent-codex", estimatedCost: { nodes: 1, bodyBytes: 0, agentCalls: 1 },
    persistedAt: now().toISOString(),
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function bodyGate(action: ReturnType<typeof bound>, path: readonly SkeletonNode[]) {
  const leaf = path.at(-1)!;
  const decisions = path.slice(1).map((node, index): ScanDecision => {
    const parent = path[index]!;
    const targetKind = index === path.length - 2 ? "leaf" as const : "container" as const;
    const payload: Omit<ScanDecision, "receiptHash"> = {
      schema: "openlifewiki.scan-decision/v1", scanId: action.plan.scanId, scanPlanHash: action.plan.scanPlanHash,
      skeletonVersion: action.plan.skeletonVersion, authorizationHash: action.authorizationHash, sourceId: action.sourceId,
      parentNodeId: parent.nodeId, parentNodeVersion: parent.nodeVersion, childSetHash: sha256Canonical(`children-${parent.nodeId}`),
      nodeId: node.nodeId, nodeVersion: node.nodeVersion, targetKind, summaryHash: sha256Canonical(`summary-${node.nodeId}`),
      inputSetHash: sha256Canonical(`input-${node.nodeId}`), decision: "descend", reason: `Selected ${targetKind}`,
      revisitCondition: null, question: null, actor: "agent-codex", estimatedCost: { nodes: 1, bodyBytes: 10, agentCalls: 1 },
      persistedAt: now().toISOString(),
    };
    return { ...payload, receiptHash: sha256Canonical(payload) };
  });
  const leafDecision = decisions.at(-1)!;
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1", scanId: action.plan.scanId, sourceId: action.sourceId,
    nodeId: leaf.nodeId, nodeVersion: leaf.nodeVersion, scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion, authorizationHash: action.authorizationHash,
    inputSetHash: leafDecision.inputSetHash, decisionReceiptHash: leafDecision.receiptHash,
    actor: "agent-codex", reason: "Selected within budget", persistedAt: now().toISOString(),
  };
  const selection = { ...selectionPayload, receiptHash: sha256Canonical(selectionPayload) };
  return {
    request: { sourceId: action.sourceId, nodeId: leaf.nodeId, authorizationHash: action.authorizationHash,
      scanPlanHash: action.plan.scanPlanHash, skeletonVersion: action.plan.skeletonVersion, nodeVersion: leaf.nodeVersion },
    authorization: action.source, plan: action.plan, path, decisionReceipts: decisions,
    leafSelectionReceipts: [selection], trustedReceiptHashes: [...decisions.map(({ receiptHash }) => receiptHash), selection.receiptHash],
  };
}

function bodyPermit(action: ReturnType<typeof bound>, node: SkeletonNode, gate: ReturnType<typeof bodyGate>, reservedBytes: number) {
  const budgetReservation = createBodyBudgetReservationReceipt({
    schema: "openlifewiki.body-budget-reservation/v1", scanId: action.plan.scanId, scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion, authorizationHash: action.authorizationHash, sourceId: action.sourceId,
    nodeId: node.nodeId, nodeVersion: node.nodeVersion, physicalIoAccountingHash: PHYSICAL_IO_HASH,
    remainingBeforeBytes: action.source.budget.maxBodyBytes, reservedBytes, reservedAt: now().toISOString(),
  });
  return { budgetReservation, expectedPhysicalIoAccountingHash: PHYSICAL_IO_HASH,
    bodyReadGate: { ...gate, trustedReceiptHashes: [...gate.trustedReceiptHashes, budgetReservation.receiptHash] } };
}

function pageReceipt(plan: ScanPlan, intent: EnumerationIntent, page: SkeletonPage, pageSequence: number, previous: EnumerationPageReceipt | null): EnumerationPageReceipt {
  const payload: Omit<EnumerationPageReceipt, "receiptHash"> = {
    schema: "openlifewiki.enumeration-page-receipt/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, sourceId: intent.sourceId, intentId: intent.intentId, pageSequence,
    eventSequence: pageSequence, previousPageReceiptHash: previous?.receiptHash ?? null,
    discoveredNodeIds: page.nodes.map(({ nodeId }) => nodeId), knownUnenumeratedSlotIds: [], nextCursor: page.nextCursor,
    childCountKind: "known", state: page.pageComplete ? "complete" : "open",
    childSetHash: page.pageComplete ? sha256Canonical(page.nodes.map(({ nodeId }) => nodeId)) : null, observedAt: page.observedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function forgeLocatorThreadId(locator: string, threadId: string): string {
  const url = new URL(locator);
  const payload = JSON.parse(Buffer.from(url.pathname.slice(1), "base64url").toString("utf8")) as Record<string, unknown>;
  payload.threadId = threadId;
  url.pathname = `/${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return url.href;
}

function messageAt(steps: readonly JsonLineStep[], index: number): Record<string, unknown> | undefined {
  const value = steps[index]?.message;
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
