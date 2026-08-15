import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPolicyBinding,
  createPolicyResolutionHash,
  createScanPlan,
  sha256Canonical,
  type AuthorizedSourceV1,
} from "@openlifewiki/protocol";

import { loadWikiScanPolicy } from "../src/scan-policy-loader.js";
import { authorizePriorityDocumentReference } from "../src/priority-reference.js";
import { currentOwnerIdentityFingerprint, updateConfigV2, writeConfig } from "../src/config-store.js";
import { resolveRuntimeLayout } from "../src/layout.js";
import {
  approveScanPlan,
  createScanPlanOwnerApproval,
  createScanStore,
  readScanStore,
  previewScanPlanApproval,
} from "../src/scan-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("WIKI.md scan policy input", () => {
  it("distinguishes absent and empty present files with canonical bindings", async () => {
    const wikiDir = await temporaryDirectory();
    const absent = await loadWikiScanPolicy({ wikiDir });
    expect(absent.policy).toBeNull();
    expect(absent.binding.state).toBe("absent");

    await writeFile(join(wikiDir, "WIKI.md"), "", "utf8");
    const empty = await loadWikiScanPolicy({ wikiDir });
    expect(empty.policy).toBeNull();
    expect(empty.binding.state).toBe("present");
    expect(empty.binding.bindingHash).not.toBe(absent.binding.bindingHash);
  });

  it("parses exactly one strict bounded policy block and rejects malformed or duplicate blocks", async () => {
    const wikiDir = await temporaryDirectory();
    const block = [
      "```openlifewiki-scan-policy",
      JSON.stringify({
        schema: "openlifewiki.scan-narrowing-policy/v1",
        include: ["/product/**"], exclude: [],
        sensitivity: { default: "normal", rules: [] },
        budget: { maxNodes: 50 },
        indexing: { default: "metadata-only", rules: [] },
      }),
      "```",
    ].join("\n");
    await writeFile(join(wikiDir, "WIKI.md"), `# Wiki\n\n${block}\n`, "utf8");
    expect((await loadWikiScanPolicy({ wikiDir })).policy?.include).toEqual(["/product/**"]);

    await writeFile(join(wikiDir, "WIKI.md"), "```openlifewiki-scan-policy\n{bad}\n```", "utf8");
    await expect(loadWikiScanPolicy({ wikiDir })).rejects.toThrow(/WIKI\.md.*policy/i);
    await writeFile(join(wikiDir, "WIKI.md"), `${block}\n${block}`, "utf8");
    await expect(loadWikiScanPolicy({ wikiDir })).rejects.toThrow(/exactly one/i);
    await writeFile(join(wikiDir, "WIKI.md"), Buffer.from([0xff]));
    await expect(loadWikiScanPolicy({ wikiDir })).rejects.toThrow(/UTF-8|WIKI\.md/i);
  });
});

describe("authorized priority document references", () => {
  it("authorizes Local and GitHub hierarchy locators without provider or body access", () => {
    const local = source("local-folder", {
      schema: "openlifewiki.scope/local-folder/v1", root: "/approved", symlinkPolicy: "deny",
    });
    const localRef = authorizePriorityDocumentReference({
      source: local,
      locator: pathToFileURL("/approved/product/strategy.md").href,
    });
    expect(localRef.relationMode).toBe("hierarchical");
    expect(() => authorizePriorityDocumentReference({
      source: local, locator: pathToFileURL("/outside/private.md").href,
    })).toThrow(/outside.*scope/i);

    const github = source("github", {
      schema: "openlifewiki.scope/github/v1", hostname: "github.com", repository: "owner/repo",
      path: "docs", ref: "main",
    });
    expect(authorizePriorityDocumentReference({
      source: github,
      locator: "openlifewiki-github://github.com/owner/repo?ref=main&path=docs%2Fstrategy.md&kind=file",
    }).relationMode).toBe("hierarchical");
    expect(() => authorizePriorityDocumentReference({
      source: github,
      locator: "openlifewiki-github://github.com/owner/repo?ref=dev&path=docs%2Fstrategy.md&kind=file",
    })).toThrow(/outside.*scope/i);
    expect(() => authorizePriorityDocumentReference({
      source: github,
      locator: "openlifewiki-github://token@github.com/owner/repo?ref=main&path=docs%2Fstrategy.md&kind=file",
    })).toThrow(/outside.*scope/i);
  });

  it("keeps opaque Feishu and Codex references exact and explicitly authorized", () => {
    const feishu = source("feishu", {
      schema: "openlifewiki.scope/feishu/v1", profile: "work", expectedTenantId: "tenant",
      documentIds: ["doc-1"], wikiNodeIds: ["wiki-1"], baseIds: ["base-1"],
    });
    const locator = opaqueLocator("openlifewiki-feishu", {
      schema: "openlifewiki.locator/feishu/v1", kind: "document", rootKind: "document",
      rootId: "doc-1", objectId: "doc-1", parentObjectId: null, spaceId: null,
      objectToken: null, objectType: "docx", docToken: "doc-1", hasChildren: false,
    });
    expect(authorizePriorityDocumentReference({ source: feishu, locator }).relationMode).toBe("exact");
    for (const [kind, id] of [["wiki", "wiki-1"], ["base", "base-1"]] as const) {
      const rootLocator = opaqueLocator("openlifewiki-feishu", {
        schema: "openlifewiki.locator/feishu/v1", kind, rootKind: kind,
        rootId: id, objectId: id, parentObjectId: null, spaceId: null,
        objectToken: null, objectType: null, docToken: null, hasChildren: true,
      });
      expect(authorizePriorityDocumentReference({ source: feishu, locator: rootLocator }).relationMode).toBe("exact");
    }

    const codex = source("codex-history", {
      schema: "openlifewiki.scope/codex-history/v1", projectRoots: ["/approved/project"], threadIds: ["thread-1"],
    });
    const codexLocator = opaqueLocator("openlifewiki-codex-history", {
      schema: "openlifewiki.locator/codex-history/v1", kind: "thread",
      projectRoot: "/approved/project", threadId: "thread-1",
    });
    expect(authorizePriorityDocumentReference({ source: codex, locator: codexLocator }).relationMode).toBe("exact");
    expect(() => authorizePriorityDocumentReference({
      source: codex,
      locator: opaqueLocator("openlifewiki-codex-history", {
        schema: "openlifewiki.locator/codex-history/v1", kind: "thread",
        projectRoot: "/approved/project", threadId: "thread-2",
      }),
    })).toThrow(/outside.*scope/i);
  });
});

describe("Owner-approved ScanPlan policy bindings", () => {
  it("recomputes canonical config, Skill and WIKI bindings and rejects drift before Probing", async () => {
    const root = await temporaryDirectory();
    const layout = resolveRuntimeLayout({
      OPENLIFEWIKI_HOME: join(root, "runtime-home"),
      OPENLIFEWIKI_WORKSPACE: join(root, "workspace"),
    }, "darwin");
    await mkdir(layout.wikiDir, { recursive: true });
    const skill = await readFile(
      new URL("../../../skills/openlifewiki-progressive-scan/SKILL.md", import.meta.url),
      "utf8",
    );
    const authorized = source("local-folder", {
      schema: "openlifewiki.scope/local-folder/v1", root: "/approved", symlinkPolicy: "deny",
    });
    const selectedAgent = { id: "agent_codex_native", runtime: "codex" as const, mode: "native-cli" as const };
    await writeConfig(layout.configFile, {
      schema: "openlifewiki.config/v2", revision: 0, sources: [authorized], scanPolicy: null,
      hostConfig: {
        schema: "openlifewiki.host-config/v1", selectedAgentId: selectedAgent.id, agents: [selectedAgent],
      },
      compatibility: { p0Sources: [], agentBindings: [] },
    });
    const host = createPolicyBinding({ kind: "host", state: "absent" });
    const wiki = createPolicyBinding({ kind: "wiki", state: "absent" });
    const ownerPolicy = {
      schema: "openlifewiki.scan-narrowing-policy/v1" as const,
      include: ["/**"], exclude: [], sensitivity: { default: "normal" as const, rules: [] },
      budget: { maxNodes: 100, maxBodyBytes: 100_000, maxAgentCalls: 10 },
      indexing: { default: "qmd-current" as const, rules: [] },
    };
    const resolvedPolicy = { ...ownerPolicy, includeSets: [[...ownerPolicy.include]] };
    const policyBindings = { host, wiki };
    const makePlan = (scanId: string) => createScanPlan({
      schema: "openlifewiki.scan-plan/v1", scanId, sourceIds: [authorized.sourceId],
      authorizationHashes: [authorized.authorizationHash], rootNodeIds: [authorized.rootNodeId],
      skeletonVersion: `sha256:${"b".repeat(64)}`, agentProfileId: selectedAgent.id,
      hostConfigRevision: 0, selectedAgentConfigHash: sha256Canonical(selectedAgent),
      skillHash: sha256Canonical(skill), scanIntent: "Build current reusable knowledge.",
      priorityDocumentRefs: [], policyBindings, ownerPolicy, policy: resolvedPolicy,
      policyResolutionHash: createPolicyResolutionHash({
        ownerPolicy, policyBindings, priorityDocumentRefs: [], policy: resolvedPolicy,
      }),
    });
    const approvedPlan = makePlan("scan_policy_approved");
    await createScanStore({ dataDir: layout.dataDir, plan: approvedPlan });
    await expect(approveScanPlan({
      dataDir: layout.dataDir,
      layout,
      scanId: approvedPlan.scanId,
      expectedRevision: 0,
      approval: {
        ...ownerPlanApproval(approvedPlan),
        approvedAt: "2026-07-27T00:00:01.000Z",
      },
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect((await readScanStore({ dataDir: layout.dataDir, scanId: approvedPlan.scanId }))?.state.phase)
      .toBe("Draft");
    expect((await approveScanPlan({
      dataDir: layout.dataDir, layout, scanId: approvedPlan.scanId, expectedRevision: 0,
      approval: ownerPlanApproval(approvedPlan),
    })).state.phase).toBe("Probing");

    const plan = makePlan("scan_policy_drift");
    await createScanStore({ dataDir: layout.dataDir, plan });
    await writeFile(join(layout.wikiDir, "WIKI.md"), "", "utf8");
    await expect(approveScanPlan({
      dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0,
      approval: ownerPlanApproval(plan),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
    expect((await readScanStore({ dataDir: layout.dataDir, scanId: plan.scanId }))?.state.phase).toBe("Draft");

    await rm(join(layout.wikiDir, "WIKI.md"));
    await updateConfigV2(layout.configFile, 0, (config) => ({ ...config, scanPolicy: ownerPolicy }));
    await expect(approveScanPlan({
      dataDir: layout.dataDir, layout, scanId: plan.scanId, expectedRevision: 0,
      approval: ownerPlanApproval(plan),
    })).rejects.toMatchObject({ code: "SCAN_INVALID" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openlifewiki-policy-test-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function source(connectorType: AuthorizedSourceV1["connectorType"], scope: Readonly<Record<string, unknown>>): AuthorizedSourceV1 {
  const approvalUnsigned = {
    schema: "openlifewiki.source-owner-approval/v1" as const, action: "authorize" as const,
    approvedBy: "human:owner" as const, approvedAt: "2026-07-27T00:00:00Z",
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(), previewHash: `sha256:${"c".repeat(64)}`,
    configHash: `sha256:${"d".repeat(64)}`, configRevision: 0, previousAuthorizationHash: null,
  };
  const approval = { ...approvalUnsigned, approvalHash: sha256Canonical(approvalUnsigned) };
  const unsigned = {
    schema: "openlifewiki.authorized-source/v1", sourceId: `source-${connectorType}`, connectorType,
    rootNodeId: `root-${connectorType}`, identityFingerprint: "identity",
    approval, scope,
    include: ["/**"], exclude: [], sensitivity: { default: "normal", rules: [] },
    budget: { maxNodes: 100, maxBodyBytes: 100_000, maxAgentCalls: 10 },
    approvedBy: "human:owner", approvedAt: "2026-07-27T00:00:00Z",
  } as const;
  return { ...unsigned, authorizationHash: sha256Canonical(unsigned) } as AuthorizedSourceV1;
}

function opaqueLocator(protocol: string, value: unknown): string {
  return `${protocol}://node/${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function ownerPlanApproval(plan: ReturnType<typeof createScanPlan>) {
  return createScanPlanOwnerApproval({
    plan,
    preview: previewScanPlanApproval(plan),
    approvedBy: "human:owner",
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    approvedAt: "2026-07-27T00:00:00.000Z",
  });
}
