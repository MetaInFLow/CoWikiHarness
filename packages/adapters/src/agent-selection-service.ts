import {
  sha256Canonical,
  type HostConfigV1,
  type OpenLifeWikiConfigV2,
} from "@openlifewiki/protocol";

import { validateHostConfig } from "@openlifewiki/core";

import {
  currentOwnerIdentityFingerprint,
  readConfigSnapshot,
  updateConfigV2,
} from "./config-store.js";
import { AdapterError } from "./errors.js";

const OWNER_ACTOR = "human:owner" as const;
const CODEX_AGENT = {
  id: "agent_codex_native",
  runtime: "codex",
  mode: "native-cli",
} as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export interface CodexNativeSelectionPreview {
  readonly schema: "openlifewiki.codex-native-selection-preview/v1";
  readonly label: "Use logged-in Codex";
  readonly ownerIdentityFingerprint: string;
  readonly configRevision: number;
  readonly configHash: string;
  readonly targetHostConfig: HostConfigV1;
  readonly targetHostConfigHash: string;
  readonly previewHash: string;
}

export interface CodexNativeSelectionApproval {
  readonly schema: "openlifewiki.codex-native-selection-approval/v1";
  readonly approvedBy: "human:owner";
  readonly approvedAt: string;
  readonly ownerIdentityFingerprint: string;
  readonly previewHash: string;
  readonly configHash: string;
  readonly configRevision: number;
  readonly targetHostConfigHash: string;
  readonly approvalHash: string;
}

export async function previewCodexNativeSelection(options: {
  readonly configPath: string;
}): Promise<CodexNativeSelectionPreview> {
  const snapshot = await requireV2(options.configPath);
  const targetHostConfig = buildTargetHostConfig(snapshot.config.hostConfig);
  const unsigned = {
    schema: "openlifewiki.codex-native-selection-preview/v1" as const,
    label: "Use logged-in Codex" as const,
    ownerIdentityFingerprint: currentOwnerIdentityFingerprint(),
    configRevision: snapshot.config.revision,
    configHash: snapshot.hash,
    targetHostConfig,
    targetHostConfigHash: sha256Canonical(targetHostConfig),
  };
  return Object.freeze({ ...unsigned, previewHash: sha256Canonical(unsigned) });
}

export async function executeCodexNativeSelection(options: {
  readonly configPath: string;
  readonly preview: CodexNativeSelectionPreview;
  readonly approval: CodexNativeSelectionApproval;
}): Promise<{ readonly config: OpenLifeWikiConfigV2; readonly approval: CodexNativeSelectionApproval }> {
  assertPreview(options.preview);
  assertApproval(options.approval, options.preview);

  const current = await requireV2(options.configPath);
  if (current.hash !== options.preview.configHash
    || current.config.revision !== options.preview.configRevision) {
    throw planChanged("Configuration changed after the Codex selection preview");
  }
  const currentTarget = buildTargetHostConfig(current.config.hostConfig);
  if (sha256Canonical(currentTarget) !== options.preview.targetHostConfigHash
    || sha256Canonical(currentTarget) !== sha256Canonical(options.preview.targetHostConfig)) {
    throw planChanged("Codex selection target changed after preview");
  }

  const updated = await updateConfigV2(
    options.configPath,
    options.preview.configRevision,
    (config) => ({ ...config, hostConfig: currentTarget }),
  );
  return { config: updated.config, approval: options.approval };
}

function buildTargetHostConfig(current: HostConfigV1 | null): HostConfigV1 {
  const agents = current === null
    ? [CODEX_AGENT]
    : current.agents.some(({ id }) => id === CODEX_AGENT.id)
      ? current.agents.map((agent) => agent.id === CODEX_AGENT.id ? CODEX_AGENT : agent)
      : [...current.agents, CODEX_AGENT];
  return validateHostConfig({
    schema: "openlifewiki.host-config/v1",
    selectedAgentId: CODEX_AGENT.id,
    agents,
  });
}

function assertPreview(preview: CodexNativeSelectionPreview): void {
  const { previewHash, ...unsigned } = preview;
  if (preview.schema !== "openlifewiki.codex-native-selection-preview/v1"
    || preview.label !== "Use logged-in Codex"
    || !SHA256.test(previewHash)
    || sha256Canonical(unsigned) !== previewHash
    || preview.ownerIdentityFingerprint !== currentOwnerIdentityFingerprint()
    || preview.targetHostConfigHash !== sha256Canonical(preview.targetHostConfig)) {
    throw planChanged("Codex selection preview is invalid or belongs to a different Owner");
  }
  const canonical = buildTargetHostConfig(preview.targetHostConfig);
  if (sha256Canonical(canonical) !== sha256Canonical(preview.targetHostConfig)) {
    throw planChanged("Codex selection preview does not contain the canonical native entry");
  }
}

function assertApproval(
  approval: CodexNativeSelectionApproval,
  preview: CodexNativeSelectionPreview,
): void {
  const { approvalHash, ...unsigned } = approval;
  if (approval.schema !== "openlifewiki.codex-native-selection-approval/v1"
    || approval.approvedBy !== OWNER_ACTOR
    || !Number.isFinite(Date.parse(approval.approvedAt))
    || !SHA256.test(approvalHash)
    || sha256Canonical(unsigned) !== approvalHash
    || approval.ownerIdentityFingerprint !== currentOwnerIdentityFingerprint()
    || approval.ownerIdentityFingerprint !== preview.ownerIdentityFingerprint
    || approval.previewHash !== preview.previewHash
    || approval.configHash !== preview.configHash
    || approval.configRevision !== preview.configRevision
    || approval.targetHostConfigHash !== preview.targetHostConfigHash) {
    throw planChanged("Codex selection approval does not match the exact Owner preview");
  }
}

async function requireV2(path: string) {
  const snapshot = await readConfigSnapshot(path);
  if (snapshot === undefined) {
    throw new AdapterError("INITIALIZATION_REQUIRED", "The openLifeWiki configuration is missing");
  }
  if (snapshot.config.schema !== "openlifewiki.config/v2") {
    throw new AdapterError("CONFIG_MIGRATION_REQUIRED", "Approve config/v2 migration before selecting an Agent");
  }
  return { ...snapshot, config: snapshot.config };
}

function planChanged(message: string): AdapterError {
  return new AdapterError("PLAN_CHANGED", message);
}
