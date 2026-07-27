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

import type { CommandOptions, CommandRunner } from "../src/command-runner.js";
import {
  createBodyBudgetReservationReceipt,
  issueActiveBodyReadLease,
  progressiveConnectorScopeHash,
} from "../src/connectors/connector-provider.js";
import { createFeishuConnector } from "../src/connectors/feishu.js";

const now = () => new Date("2026-07-27T01:00:00.000Z");
const PHYSICAL_IO_HASH = sha256Canonical("feishu-physical-io-accounting");

describe("Feishu progressive Connector", () => {
  it("reports blocked when the selected profile lacks Drive metadata scope", async () => {
    const fixture = feishuFixture({ missingDriveScope: true });
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    await expect(connector.probe({ ...action, now })).resolves.toMatchObject({
      status: "blocked",
      blocking: { code: "FEISHU_SCOPE_MISSING" },
    });
  });

  it("checks the stronger Drive scope actually granted by the selected profile", async () => {
    const fixture = feishuFixture({ strongDriveScope: true });
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    await expect(connector.probe({ ...action, now })).resolves.toMatchObject({ status: "connected" });
    const check = fixture.calls.find(({ args }) => args.slice(2, 4).join(" ") === "auth check");
    const checked = check?.args[check.args.indexOf("--scope") + 1]?.split(" ") ?? [];
    expect(checked).toContain("drive:drive");
    expect(checked).not.toContain("drive:drive.metadata:readonly");
  });

  it("exposes approved document, Wiki and Base objects through one body-free direct layer", async () => {
    const fixture = feishuFixture();
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 10, cursor: null, now })).nodes[0]!;
    const roots = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    expect(roots.nodes.map(({ title, kind }) => [title, kind])).toEqual([
      ["Base A", "directory"], ["Direct Doc", "file"], ["Wiki Root", "directory"],
    ]);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const wiki = roots.nodes.find(({ title }) => title === "Wiki Root")!;
    const wikiTraversal = traversal(action, wiki, root);
    await expect(connector.listChildrenMetadata({
      ...action, ...wikiTraversal, trustedReceiptHashes: [], parent: wiki, limit: 10, cursor: null, now,
    })).rejects.toThrow(/intent|trusted/i);
    const wikiPage = await connector.listChildrenMetadata({
      ...action, ...wikiTraversal, parent: wiki, limit: 10, cursor: null, now,
    });
    expect(wikiPage.nodes.map(({ title }) => title)).toEqual(["Page content", "Wiki Child"]);
    expect(wiki.scanability).toBe("metadata-only");
    const wikiContent = wikiPage.nodes[0]!;
    expect(wikiContent).toMatchObject({
      parentId: wiki.nodeId, kind: "file", scanability: "metadata-and-body",
      childCount: { value: 0, kind: "known" },
    });
    expect(await connector.getVersion({ ...action, node: wikiContent })).toBe(wikiContent.nodeVersion);
    expect(fixture.bodyCalls()).toHaveLength(0);
    await expect(connector.readApprovedLeafBody({
      ...action, node: wiki, expectedVersion: wiki.nodeVersion,
      ...bodyPermit(action, wiki, bodyGate(action, root, wiki)),
    })).rejects.toThrow(/body|permit|target/i);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const wikiBody = await connector.readApprovedLeafBody({
      ...action, node: wikiContent, expectedVersion: wikiContent.nodeVersion,
      ...bodyPermit(action, wikiContent, bodyGate(action, root, wikiContent, [wiki])),
    });
    const wikiChunks: Uint8Array[] = [];
    for await (const chunk of wikiBody.stream) wikiChunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(wikiChunks))).toBe("# Wiki Root\n");

    const wikiChild = wikiPage.nodes[1]!;
    const childBody = await connector.readApprovedLeafBody({
      ...action, node: wikiChild, expectedVersion: wikiChild.nodeVersion,
      ...bodyPermit(action, wikiChild, bodyGate(action, root, wikiChild, [wiki])),
    });
    const childChunks: Uint8Array[] = [];
    for await (const chunk of childBody.stream) childChunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(childChunks))).toBe("# Wiki Child\n");
    expect(fixture.bodyCalls()).toHaveLength(2);

    const base = roots.nodes.find(({ title }) => title === "Base A")!;
    await expect(connector.listChildrenMetadata({
      ...action, ...traversal(action, base, root), parent: base, limit: 10, cursor: null, now,
    })).rejects.toThrow(/direct-child|unsupported|hierarchy/i);
    expect(fixture.calls.some(({ args }) => args.includes("+base-block-list"))).toBe(false);
    expect(fixture.calls.every(({ args }) => args[0] === "--profile" && args[1] === "work-feishu")).toBe(true);
  });

  it("paginates approved root objects with a trusted continuation chain", async () => {
    const fixture = feishuFixture({ paginatedWiki: true });
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const rootTraversal = traversal(action, root, null);
    const page1 = await connector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: root, limit: 2, cursor: null, now,
    });
    const receipt1 = pageReceipt(action.plan, rootTraversal.intent, page1, 1, null);
    const page2 = await connector.listChildrenMetadata({
      ...action,
      ...rootTraversal,
      trustedReceiptHashes: [...rootTraversal.trustedReceiptHashes, receipt1.receiptHash],
      previousPageReceipt: receipt1,
      parent: root,
      limit: 2,
      cursor: page1.nextCursor,
      now,
    });
    expect(page1.nodes).toHaveLength(2);
    expect(page2.nodes).toHaveLength(1);
    expect(page2.pageComplete).toBe(true);
    await expect(connector.listChildrenMetadata({
      ...action, ...rootTraversal, parent: root, previousPageReceipt: null,
      limit: 2, cursor: page1.nextCursor, now,
    })).rejects.toThrow(/page|receipt/i);

    const wiki = page2.nodes[0]!;
    const wikiTraversal = traversal(action, wiki, root);
    const wikiPage1 = await connector.listChildrenMetadata({
      ...action, ...wikiTraversal, parent: wiki, limit: 1, cursor: null, now,
    });
    const wikiReceipt1 = pageReceipt(action.plan, wikiTraversal.intent, wikiPage1, 1, null);
    const wikiPage2 = await connector.listChildrenMetadata({
      ...action,
      ...wikiTraversal,
      trustedReceiptHashes: [...wikiTraversal.trustedReceiptHashes, wikiReceipt1.receiptHash],
      previousPageReceipt: wikiReceipt1,
      parent: wiki,
      limit: 1,
      cursor: wikiPage1.nextCursor,
      now,
    });
    const wikiReceipt2 = pageReceipt(action.plan, wikiTraversal.intent, wikiPage2, 2, wikiReceipt1);
    const wikiPage3 = await connector.listChildrenMetadata({
      ...action,
      ...wikiTraversal,
      trustedReceiptHashes: [...wikiTraversal.trustedReceiptHashes, wikiReceipt1.receiptHash, wikiReceipt2.receiptHash],
      previousPageReceipt: wikiReceipt2,
      parent: wiki,
      limit: 1,
      cursor: wikiPage2.nextCursor,
      now,
    });
    expect([wikiPage1, wikiPage2, wikiPage3].flatMap(({ nodes }) => nodes.map(({ title }) => title)))
      .toEqual(["Page content", "Wiki Child", "Wiki Child 2"]);
    expect(new Set([wikiPage1, wikiPage2, wikiPage3].flatMap(({ nodes }) => nodes.map(({ nodeId }) => nodeId))).size).toBe(3);
    expect(wikiPage1.pageComplete).toBe(false);
    expect(wikiPage2.pageComplete).toBe(false);
    expect(wikiPage3.pageComplete).toBe(true);
  });

  it("reads a selected current document only after trusted gate and budget receipts", async () => {
    const fixture = feishuFixture();
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const roots = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const doc = roots.nodes.find(({ title }) => title === "Direct Doc")!;
    expect(fixture.bodyCalls()).toHaveLength(0);
    const gate = bodyGate(action, root, doc);
    const approved = await connector.readApprovedLeafBody({
      ...action, node: doc, expectedVersion: doc.nodeVersion, ...bodyPermit(action, doc, gate),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of approved.stream) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("# Direct\n");
    expect(fixture.bodyCalls()).toHaveLength(1);

    await expect(connector.readApprovedLeafBody({
      ...action,
      node: doc,
      expectedVersion: doc.nodeVersion,
      ...bodyPermit(action, doc, gate),
      bodyReadGate: { ...bodyPermit(action, doc, gate).bodyReadGate, trustedReceiptHashes: [] },
    })).rejects.toThrow(/trusted|ledger|budget/i);
    const wrongAccounting = bodyPermit(action, doc, gate);
    await expect(connector.readApprovedLeafBody({
      ...action, node: doc, expectedVersion: doc.nodeVersion, ...wrongAccounting,
      expectedPhysicalIoAccountingHash: sha256Canonical("wrong-accounting"),
    })).rejects.toThrow(/budget/i);
  });

  it("fails closed for scope escape, stale versions, wrong identity and forged budgets", async () => {
    const fixture = feishuFixture();
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const roots = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const doc = roots.nodes.find(({ title }) => title === "Direct Doc")!;

    await expect(connector.getVersion({
      ...action, node: { ...doc, locator: forgeLocatorObjectId(doc.locator, "doc-outside") },
    })).rejects.toThrow(/scope|binding/i);
    const forgedDocTokenNode = { ...doc, locator: forgeLocatorField(doc.locator, "docToken", "doc-outside") };
    await expect(connector.readApprovedLeafBody({
      ...action, node: forgedDocTokenNode, expectedVersion: forgedDocTokenNode.nodeVersion,
      ...bodyPermit(action, forgedDocTokenNode, bodyGate(action, root, forgedDocTokenNode)),
    })).rejects.toThrow(/changed|version|binding/i);
    fixture.setDocModified("doc-a", "101");
    await expect(connector.readApprovedLeafBody({
      ...action, node: doc, expectedVersion: doc.nodeVersion,
      ...bodyPermit(action, doc, bodyGate(action, root, doc)),
    })).rejects.toThrow(/changed|version/i);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const wrongIdentity = createFeishuConnector(feishuFixture({ openId: "ou-other" }).runner);
    await expect(wrongIdentity.listRootsMetadata({ ...action, limit: 1, cursor: null, now }))
      .rejects.toThrow(/identity/i);
    await expect(connector.listRootsMetadata({
      ...action, authorizationHash: sha256Canonical("forged"), limit: 1, cursor: null, now,
    })).rejects.toThrow(/binding/i);

    const raceFixture = feishuFixture({ mutateDocumentDuringFetch: true });
    const raceConnector = createFeishuConnector(raceFixture.runner);
    const raceRoot = (await raceConnector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const raceRoots = await raceConnector.listChildrenMetadata({
      ...action, ...traversal(action, raceRoot, null), parent: raceRoot, limit: 10, cursor: null, now,
    });
    const raceDoc = raceRoots.nodes.find(({ title }) => title === "Direct Doc")!;
    await expect(raceConnector.readApprovedLeafBody({
      ...action, node: raceDoc, expectedVersion: raceDoc.nodeVersion,
      ...bodyPermit(action, raceDoc, bodyGate(action, raceRoot, raceDoc)),
    })).rejects.toThrow(/changed|version/i);
    expect(raceFixture.bodyCalls()).toHaveLength(1);
  });

  it("denies known oversized bodies before fetch and binds unknown-size output to the reservation", async () => {
    const fixture = feishuFixture({ docSize: 100 });
    const connector = createFeishuConnector(fixture.runner);
    const source = authorizedFeishuSource({ maxBodyBytes: 10 });
    const action = bound(source, { maxBodyBytes: 10 });
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const roots = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const doc = roots.nodes.find(({ title }) => title === "Direct Doc")!;
    await expect(connector.readApprovedLeafBody({
      ...action, node: doc, expectedVersion: doc.nodeVersion,
      ...bodyPermit(action, doc, bodyGate(action, root, doc), 10),
    })).rejects.toThrow(/budget/i);
    expect(fixture.bodyCalls()).toHaveLength(0);

    const unknownFixture = feishuFixture({ body: "x".repeat(20), docSize: null });
    const unknownConnector = createFeishuConnector(unknownFixture.runner);
    const unknownAction = bound(authorizedFeishuSource({ maxBodyBytes: 10 }), { maxBodyBytes: 10 });
    const unknownRoot = (await unknownConnector.listRootsMetadata({ ...unknownAction, limit: 1, cursor: null, now })).nodes[0]!;
    const unknownRoots = await unknownConnector.listChildrenMetadata({
      ...unknownAction, ...traversal(unknownAction, unknownRoot, null),
      parent: unknownRoot, limit: 10, cursor: null, now,
    });
    const unknownDoc = unknownRoots.nodes.find(({ title }) => title === "Direct Doc")!;
    await expect(unknownConnector.readApprovedLeafBody({
      ...unknownAction, node: unknownDoc, expectedVersion: unknownDoc.nodeVersion,
      ...bodyPermit(unknownAction, unknownDoc, bodyGate(unknownAction, unknownRoot, unknownDoc), 10),
    })).rejects.toThrow(/budget|body/i);
    expect(unknownFixture.bodyCalls()).toHaveLength(1);
    expect(unknownFixture.bodyCalls()[0]?.options?.maxOutputBytes).toBe(10);
  });

  it("rejects malformed document size metadata instead of treating it as unknown", async () => {
    const fixture = feishuFixture({ invalidDocSize: true });
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    await expect(connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    })).rejects.toMatchObject({ code: "FEISHU_METADATA_INVALID" });
    expect(fixture.bodyCalls()).toHaveLength(0);
  });

  it("rejects a malformed document revision from the real fetch envelope", async () => {
    const fixture = feishuFixture({ invalidRevision: true });
    const connector = createFeishuConnector(fixture.runner);
    const action = bound(authorizedFeishuSource());
    const root = (await connector.listRootsMetadata({ ...action, limit: 1, cursor: null, now })).nodes[0]!;
    const roots = await connector.listChildrenMetadata({
      ...action, ...traversal(action, root, null), parent: root, limit: 10, cursor: null, now,
    });
    const doc = roots.nodes.find(({ title }) => title === "Direct Doc")!;
    await expect(connector.readApprovedLeafBody({
      ...action, node: doc, expectedVersion: doc.nodeVersion,
      ...bodyPermit(action, doc, bodyGate(action, root, doc), 2_048),
    })).rejects.toMatchObject({ code: "FEISHU_BODY_INVALID" });
  });
});

interface Call { readonly args: readonly string[]; readonly options?: CommandOptions }

function feishuFixture(overrides: {
  readonly openId?: string;
  readonly docSize?: number | null;
  readonly body?: string;
  readonly invalidDocSize?: boolean;
  readonly paginatedWiki?: boolean;
  readonly missingDriveScope?: boolean;
  readonly strongDriveScope?: boolean;
  readonly invalidRevision?: boolean;
  readonly mutateDocumentDuringFetch?: boolean;
} = {}) {
  const calls: Call[] = [];
  const modified = new Map([
    ["doc-a", "100"], ["obj-wiki-root", "100"], ["obj-wiki-child", "100"], ["obj-wiki-child-2", "100"],
  ]);
  const runner: CommandRunner = {
    async run(_command, args, options) {
      calls.push({ args, ...(options === undefined ? {} : { options }) });
      const command = args.slice(2);
      if (command[0] === "--version") return { stdout: "lark-cli 1.0.64\n", stderr: "" };
      if (command[0] === "auth" && command[1] === "status") {
        return { stdout: JSON.stringify({
          appId: "cli-app", verified: true, identities: { user: {
            status: "ready", available: true, verified: true, openId: overrides.openId ?? "ou-owner",
            userName: "Owner", tokenStatus: "valid",
            scope: [
              "base:app:read", "base:record:read", "base:table:read", "docs:document.content:read",
              ...(overrides.missingDriveScope === true ? [] : [
                overrides.strongDriveScope === true ? "drive:drive" : "drive:drive.metadata:readonly",
              ]),
              "wiki:node:read",
            ].join(" "),
          } },
        }), stderr: "" };
      }
      if (command[0] === "auth" && command[1] === "check") {
        const required = command[command.indexOf("--scope") + 1]?.split(" ") ?? [];
        const missing = overrides.missingDriveScope === true ? ["drive:drive.metadata:readonly"] : [];
        const granted = required.filter((scope) => !missing.includes(scope));
        return { stdout: JSON.stringify({
          ok: missing.length === 0,
          granted,
          missing: missing.length === 0 ? null : missing,
        }), stderr: "" };
      }
      if (command[0] === "contact") {
        return { stdout: JSON.stringify({ data: { user: {
          name: "Owner", open_id: overrides.openId ?? "ou-owner", tenant_key: "tenant-a",
        } } }), stderr: "" };
      }
      if (command[0] === "drive") {
        const data = JSON.parse(command[command.indexOf("--data") + 1]!) as { request_docs: { doc_token: string }[] };
        const token = data.request_docs[0]!.doc_token;
        const titles: Record<string, string> = {
          "doc-a": "Direct Doc", "obj-wiki-root": "Wiki Root", "obj-wiki-child": "Wiki Child",
          "obj-wiki-child-2": "Wiki Child 2",
        };
        const bodies: Record<string, string> = {
          "doc-a": overrides.body ?? "# Direct\n",
          "obj-wiki-root": "# Wiki Root\n",
          "obj-wiki-child": "# Wiki Child\n",
          "obj-wiki-child-2": "# Wiki Child 2\n",
        };
        const selectedSize = token === "doc-a" ? overrides.docSize : undefined;
        const sizeField = token === "doc-a" && overrides.invalidDocSize === true
          ? { size: "unknown" }
          : typeof selectedSize === "number" ? { size: selectedSize } : {};
        const meta = {
          doc_token: token, doc_type: "docx", title: titles[token] ?? "Unknown",
          latest_modify_time: modified.get(token) ?? "100",
          ...sizeField,
        };
        return { stdout: JSON.stringify({ metas: [meta], failed_list: [] }), stderr: "" };
      }
      if (command[0] === "wiki" && command[1] === "+node-get") {
        const token = command[command.indexOf("--node-token") + 1];
        const node = token === "wiki-a" ? {
          space_id: "space-a", node_token: "wiki-a", obj_token: "obj-wiki-root", obj_type: "docx",
          parent_node_token: "", has_child: true, title: "Wiki Root",
        } : token === "wiki-child" ? {
          space_id: "space-a", node_token: "wiki-child", obj_token: "obj-wiki-child", obj_type: "docx",
          parent_node_token: "wiki-a", has_child: false, title: "Wiki Child",
        } : token === "wiki-child-2" ? {
          space_id: "space-a", node_token: "wiki-child-2", obj_token: "obj-wiki-child-2", obj_type: "docx",
          parent_node_token: "wiki-a", has_child: false, title: "Wiki Child 2",
        } : null;
        return { stdout: JSON.stringify({ data: { node } }), stderr: "" };
      }
      if (command[0] === "wiki" && command[1] === "+node-list") {
        const secondPage = command.includes("wiki-page-2");
        const item = secondPage ? {
          space_id: "space-a", node_token: "wiki-child-2", obj_token: "obj-wiki-child-2", obj_type: "docx",
          parent_node_token: "wiki-a", has_child: false, title: "Wiki Child 2",
        } : {
          space_id: "space-a", node_token: "wiki-child", obj_token: "obj-wiki-child", obj_type: "docx",
          parent_node_token: "wiki-a", has_child: false, title: "Wiki Child",
        };
        const hasMore = overrides.paginatedWiki === true && !secondPage;
        return { stdout: JSON.stringify({ data: {
          items: [item], has_more: hasMore, page_token: hasMore ? "wiki-page-2" : "",
        } }), stderr: "" };
      }
      if (command[0] === "base" && command[1] === "+base-get") {
        return { stdout: JSON.stringify({ data: { app: { app_token: "base-a", name: "Base A", revision: 3 } } }), stderr: "" };
      }
      if (command[0] === "base" && command[1] === "+base-block-list") {
        return { stdout: JSON.stringify({ blocks: [
          { id: "folder-a", type: "folder", name: "Folder", parent_id: "" },
          { id: "table-a", type: "table", name: "Table", parent_id: "" },
          { id: "base-doc", type: "docx", name: "Base Doc", parent_id: "folder-a", docx_token: "doc-base" },
        ] }), stderr: "" };
      }
      if (command[0] === "docs" && command[1] === "+fetch") {
        if (overrides.mutateDocumentDuringFetch === true) modified.set("doc-a", "101");
        const token = command[command.indexOf("--doc") + 1]!;
        const bodies: Record<string, string> = {
          "doc-a": overrides.body ?? "# Direct\n",
          "obj-wiki-root": "# Wiki Root\n",
          "obj-wiki-child": "# Wiki Child\n",
          "obj-wiki-child-2": "# Wiki Child 2\n",
        };
        return { stdout: JSON.stringify({ data: { document: {
          content: bodies[token] ?? "",
          revision_id: overrides.invalidRevision === true ? "invalid" : Number(modified.get(token) ?? "100"),
        } } }), stderr: "" };
      }
      throw new Error(`Unexpected lark-cli command ${command.join(" ")}`);
    },
  };
  return {
    runner,
    calls,
    bodyCalls: () => calls.filter(({ args }) => args.slice(2, 4).join(" ") === "docs +fetch"),
    setDocModified: (token: string, value: string) => modified.set(token, value),
  };
}

function authorizedFeishuSource(overrides: { readonly maxBodyBytes?: number } = {}): AuthorizedSourceV1 {
  const approvalPayload = {
    schema: "openlifewiki.source-owner-approval/v1" as const,
    action: "authorize" as const,
    approvedBy: "human:owner" as const,
    approvedAt: now().toISOString(),
    ownerIdentityFingerprint: sha256Canonical("owner"),
    previewHash: sha256Canonical("preview"),
    configHash: sha256Canonical("config"),
    configRevision: 1,
    previousAuthorizationHash: null,
  };
  const payload = {
    schema: "openlifewiki.authorized-source/v1" as const,
    sourceId: "source-feishu",
    connectorType: "feishu" as const,
    rootNodeId: "feishu-root",
    identityFingerprint: sha256Canonical({
      provider: "feishu", profile: "work-feishu", appId: "cli-app", tenantKey: "tenant-a", openId: "ou-owner",
    }),
    approval: { ...approvalPayload, approvalHash: sha256Canonical(approvalPayload) },
    providerObservation: { providerName: "lark-cli", providerVersion: "1.0.64", contractHash: null },
    scope: {
      schema: "openlifewiki.scope/feishu/v1", profile: "work-feishu", expectedTenantId: "tenant-a",
      documentIds: ["doc-a"], wikiNodeIds: ["wiki-a"], baseIds: ["base-a"],
    },
    include: ["/**"], exclude: [],
    sensitivity: { default: "normal" as const, rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: overrides.maxBodyBytes ?? 1_000_000, maxAgentCalls: 20 },
    approvedBy: "human:owner" as const,
    approvedAt: now().toISOString(),
  };
  return { ...payload, authorizationHash: sha256Canonical(payload) };
}

function bound(source: AuthorizedSourceV1, policy: { readonly maxBodyBytes?: number } = {}) {
  const plan = createScanPlan({
    schema: "openlifewiki.scan-plan/v1",
    scanId: "scan-feishu",
    sourceIds: [source.sourceId], authorizationHashes: [source.authorizationHash], rootNodeIds: [source.rootNodeId],
    skeletonVersion: sha256Canonical("feishu-skeleton-v1"),
    agentProfileId: "agent-codex", skillHash: sha256Canonical("skill"),
    scanIntent: "Build the current reusable knowledge Wiki.", priorityDocumentRefs: [],
    policy: {
      include: ["/**"], exclude: [], sensitivity: "normal",
      budget: policy.maxBodyBytes === undefined ? {} : { maxBodyBytes: policy.maxBodyBytes },
      indexing: { default: "qmd-current", rules: [] },
    },
  });
  return {
    source, plan, sourceId: source.sourceId, authorizationHash: source.authorizationHash,
    rootNodeId: source.rootNodeId, scopeHash: progressiveConnectorScopeHash(source),
  } as const;
}

function traversal(action: ReturnType<typeof bound>, target: SkeletonNode, parentLayer: SkeletonNode | null) {
  const decision = parentLayer === null ? null : containerDecision(action.plan, action.source, parentLayer, target);
  const intent = createEnumerationIntent({
    plan: action.plan, trustedDecisionReceiptHashes: decision === null ? [] : [decision.receiptHash],
    decisionReceipt: decision,
    intent: {
      schema: "openlifewiki.enumeration-intent/v1", intentId: `intent-${target.nodeId.slice(0, 20)}`,
      sourceId: action.sourceId, targetNodeId: target.nodeId, targetNodeVersion: target.nodeVersion,
      authorizationHash: action.authorizationHash,
      origin: parentLayer === null ? "authorized-root" : "container-descend",
      parentLayerNodeId: parentLayer?.nodeId ?? null, childSetHash: decision?.childSetHash ?? null,
      inputSetHash: decision?.inputSetHash ?? sha256Canonical(`root-${target.nodeId}`), createdAt: now().toISOString(),
    },
  });
  return {
    intent, trustedDecisionReceipts: decision === null ? [] : [decision],
    trustedReceiptHashes: [intent.receiptHash, ...(decision === null ? [] : [decision.receiptHash])],
    previousPageReceipt: null,
  } as const;
}

function containerDecision(plan: ScanPlan, source: AuthorizedSourceV1, parent: SkeletonNode, target: SkeletonNode): ScanDecision {
  const payload: Omit<ScanDecision, "receiptHash"> = {
    schema: "openlifewiki.scan-decision/v1", scanId: plan.scanId, scanPlanHash: plan.scanPlanHash,
    skeletonVersion: plan.skeletonVersion, authorizationHash: source.authorizationHash, sourceId: source.sourceId,
    parentNodeId: parent.nodeId, parentNodeVersion: parent.nodeVersion,
    childSetHash: sha256Canonical({ parent: parent.nodeId, target: target.nodeId }),
    nodeId: target.nodeId, nodeVersion: target.nodeVersion, targetKind: "container",
    summaryHash: sha256Canonical("summary"), inputSetHash: sha256Canonical(`input-${target.nodeId}`),
    decision: "descend", reason: "Selected container", revisitCondition: null, question: null,
    actor: "agent-codex", estimatedCost: { nodes: 1, bodyBytes: 0, agentCalls: 1 }, persistedAt: now().toISOString(),
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function bodyGate(
  action: ReturnType<typeof bound>,
  root: SkeletonNode,
  leaf: SkeletonNode,
  containers: readonly SkeletonNode[] = [],
) {
  const path = [root, ...containers, leaf];
  const decisions = path.slice(1).map((node, index): ScanDecision => {
    const parent = path[index]!;
    const targetKind = index === path.length - 2 ? "leaf" as const : "container" as const;
    const decisionPayload: Omit<ScanDecision, "receiptHash"> = {
      schema: "openlifewiki.scan-decision/v1", scanId: action.plan.scanId,
      scanPlanHash: action.plan.scanPlanHash, skeletonVersion: action.plan.skeletonVersion,
      authorizationHash: action.authorizationHash, sourceId: action.sourceId,
      parentNodeId: parent.nodeId, parentNodeVersion: parent.nodeVersion,
      childSetHash: sha256Canonical(`children-${parent.nodeId}`), nodeId: node.nodeId, nodeVersion: node.nodeVersion,
      targetKind, summaryHash: sha256Canonical(`summary-${node.nodeId}`), inputSetHash: sha256Canonical(`input-${node.nodeId}`),
      decision: "descend", reason: `Selected ${targetKind}`, revisitCondition: null, question: null,
      actor: "agent-codex", estimatedCost: { nodes: 1, bodyBytes: targetKind === "leaf" ? 10 : 0, agentCalls: 1 },
      persistedAt: "2026-07-27T01:01:00.000Z",
    };
    return { ...decisionPayload, receiptHash: sha256Canonical(decisionPayload) };
  });
  const decision = decisions.at(-1)!;
  const selectionPayload: Omit<LeafSelectionReceipt, "receiptHash"> = {
    schema: "openlifewiki.leaf-selection/v1", scanId: action.plan.scanId, sourceId: action.sourceId,
    nodeId: leaf.nodeId, nodeVersion: leaf.nodeVersion, scanPlanHash: action.plan.scanPlanHash,
    skeletonVersion: action.plan.skeletonVersion, authorizationHash: action.authorizationHash,
    inputSetHash: decision.inputSetHash, decisionReceiptHash: decision.receiptHash,
    actor: "agent-codex", reason: "Selected within budget", persistedAt: "2026-07-27T01:01:01.000Z",
  };
  const selection: LeafSelectionReceipt = { ...selectionPayload, receiptHash: sha256Canonical(selectionPayload) };
  return {
    request: { sourceId: action.sourceId, nodeId: leaf.nodeId, authorizationHash: action.authorizationHash,
      scanPlanHash: action.plan.scanPlanHash, skeletonVersion: action.plan.skeletonVersion, nodeVersion: leaf.nodeVersion },
    authorization: action.source, plan: action.plan, path, decisionReceipts: decisions,
    leafSelectionReceipts: [selection], trustedReceiptHashes: [...decisions.map(({ receiptHash }) => receiptHash), selection.receiptHash],
  };
}

function bodyPermit(action: ReturnType<typeof bound>, node: SkeletonNode, gate: ReturnType<typeof bodyGate>, reservedBytes = action.source.budget.maxBodyBytes) {
  const budgetReservation = createBodyBudgetReservationReceipt({
    schema: "openlifewiki.body-budget-reservation/v1", scanId: action.plan.scanId,
    scanPlanHash: action.plan.scanPlanHash, skeletonVersion: action.plan.skeletonVersion,
    authorizationHash: action.authorizationHash, sourceId: action.sourceId, nodeId: node.nodeId,
    nodeVersion: node.nodeVersion, scanTransitionSequence: 0, physicalIoAccountingHash: PHYSICAL_IO_HASH,
    remainingBeforeBytes: action.source.budget.maxBodyBytes, reservedBytes, reservedAt: now().toISOString(),
  });
  return { budgetReservation, activeBodyReadLease: issueActiveBodyReadLease({
    scanId: budgetReservation.scanId, reservationReceiptHash: budgetReservation.receiptHash,
    scanTransitionSequence: budgetReservation.scanTransitionSequence,
  }),
    expectedPhysicalIoAccountingHash: PHYSICAL_IO_HASH,
    bodyReadGate: { ...gate, trustedReceiptHashes: [...gate.trustedReceiptHashes, budgetReservation.receiptHash] } };
}

function pageReceipt(plan: ScanPlan, intent: EnumerationIntent, page: SkeletonPage, pageSequence: number, previous: EnumerationPageReceipt | null): EnumerationPageReceipt {
  const payload: Omit<EnumerationPageReceipt, "receiptHash"> = {
    schema: "openlifewiki.enumeration-page-receipt/v1", scanId: plan.scanId,
    scanPlanHash: plan.scanPlanHash, skeletonVersion: plan.skeletonVersion, sourceId: intent.sourceId,
    intentId: intent.intentId, pageSequence, eventSequence: pageSequence,
    previousPageReceiptHash: previous?.receiptHash ?? null, discoveredNodeIds: page.nodes.map(({ nodeId }) => nodeId),
    knownUnenumeratedSlotIds: [], nextCursor: page.nextCursor, childCountKind: "known",
    state: page.pageComplete ? "complete" : "open",
    childSetHash: page.pageComplete ? sha256Canonical(page.nodes.map(({ nodeId }) => nodeId)) : null,
    observedAt: page.observedAt,
  };
  return { ...payload, receiptHash: sha256Canonical(payload) };
}

function forgeLocatorObjectId(locator: string, objectId: string): string {
  return forgeLocatorField(locator, "objectId", objectId);
}

function forgeLocatorField(locator: string, field: string, value: string): string {
  const url = new URL(locator);
  const payload = JSON.parse(Buffer.from(url.pathname.slice(1), "base64url").toString("utf8")) as Record<string, unknown>;
  payload[field] = value;
  url.pathname = `/${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return url.href;
}
