import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_FAILURE_PRESENTATION,
  buildAgentScanInputSetHash,
  getAgentIoJsonSchema,
  getAgentIoSchemaHash,
  parseAgentFailure,
  parseAgentScanResult,
  sha256Canonical,
  type AgentFailure,
  type AgentIoAgent,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "../command-runner.js";
import { nodeCommandRunner } from "../command-runner.js";
import type {
  AgentDriver,
  AgentInvocationEvidence,
  AgentLayerSummary,
  AgentScanDecision,
  AgentScanInvocation,
  AgentScanRequest,
} from "./agent-driver.js";

const CODEX_AGENT: AgentIoAgent = {
  id: "agent_codex_native",
  runtime: "codex",
  mode: "native-cli",
  driverContractVersion: "v1",
};

const DEFAULT_SKILL_PATH = new URL(
  "../../../../skills/openlifewiki-progressive-scan/SKILL.md",
  import.meta.url,
);

const OUTPUT_SCHEMA_ID = "openlifewiki.agent-scan-result/v1" as const;
const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "hooks",
  "in_app_browser",
  "multi_agent",
  "shell_tool",
  "unified_exec",
] as const;
const ENVIRONMENT_ALLOWLIST = [
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export interface CodexNativeAgentDriverOptions {
  readonly runner?: CommandRunner;
  readonly command?: string;
  readonly skillPath?: URL | string;
  readonly timeoutMs?: number;
  readonly scratchRoot?: string;
}

/** Invokes the locally authenticated official Codex CLI without application credentials. */
export class CodexNativeAgentDriver implements AgentDriver {
  private readonly runner: CommandRunner;
  private readonly command: string;
  private readonly skillPath: URL | string;
  private readonly timeoutMs: number;
  private readonly scratchRoot: string;

  constructor(options: CodexNativeAgentDriverOptions = {}) {
    this.runner = options.runner ?? nodeCommandRunner;
    this.command = options.command ?? "codex";
    this.skillPath = options.skillPath ?? DEFAULT_SKILL_PATH;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.scratchRoot = options.scratchRoot ?? tmpdir();
  }

  async decideScan(request: AgentScanRequest): Promise<AgentScanInvocation> {
    const inputSetHash = buildAgentScanInputSetHash(request.scanInput);
    const outputSchemaHash = getAgentIoSchemaHash(OUTPUT_SCHEMA_ID);
    let version: string | null = null;
    let evidenceSkillHash = request.scanInput.skillHash;
    const invocation = (): AgentInvocationEvidence => ({
      schema: "openlifewiki.agent-invocation/v1",
      binary: { command: this.command, version },
      agent: CODEX_AGENT,
      inputSetHash,
      skillHash: evidenceSkillHash,
      outputSchema: { id: OUTPUT_SCHEMA_ID, hash: outputSchemaHash },
    });
    const result = (decision: AgentScanDecision): AgentScanInvocation => ({ decision, invocation: invocation() });
    if (!isValidLayerSummary(request.layerSummary, request.scanInput)) {
      return result(this.failure("AGENT_HOST_CONFIG_INVALID", "validate-host-config", request, inputSetHash, request.scanInput.skillHash));
    }
    let skill: string;
    try {
      skill = await readFile(this.skillPath, "utf8");
    } catch {
      return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", request, inputSetHash, request.scanInput.skillHash));
    }

    const skillHash = sha256Canonical(skill);
    evidenceSkillHash = skillHash;
    if (skillHash !== request.scanInput.skillHash) {
      return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", request, inputSetHash, skillHash));
    }

    try {
      const probe = await this.runner.run(this.command, ["--version"], {
        env: codexNativeEnvironment(),
        timeoutMs: this.timeoutMs,
      });
      version = normalizeCodexVersion(probe.stdout);
      if (version === null) {
        return result(this.failure("AGENT_UNSUPPORTED_VERSION", "probe-runtime", request, inputSetHash, skillHash));
      }
    } catch (error) {
      return result(this.failureFor(error, "probe-runtime", request, inputSetHash, skillHash));
    }

    const scratch = await mkdtemp(join(this.scratchRoot, "openlifewiki-codex-"));
    try {
      const schemaPath = join(scratch, "agent-scan-result.schema.json");
      await writeFile(
        schemaPath,
        `${JSON.stringify(getAgentIoJsonSchema(OUTPUT_SCHEMA_ID))}\n`,
        { mode: 0o600 },
      );
      const payload = JSON.stringify({
        schema: "openlifewiki.codex-scan-request/v1",
        instruction: "Use the canonical Skill and metadata-only scan input. Return only JSON matching the output schema.",
        skill: { hash: skillHash, content: skill },
        operationId: request.operationId,
        scanInput: request.scanInput,
        layerSummary: request.layerSummary,
        expectedBindings: {
          schema: OUTPUT_SCHEMA_ID,
          agent: CODEX_AGENT,
          inputSetHash,
          skillHash,
          scanPlanHash: request.scanInput.scanPlanHash,
          skeletonVersion: request.scanInput.skeletonVersion,
          scanId: request.scanInput.scanId,
          layer: request.scanInput.layer,
        },
      });
      const result = await this.runner.run(this.command, [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
        "-",
      ], {
        cwd: scratch,
        env: codexNativeEnvironment(),
        timeoutMs: this.timeoutMs,
        stdin: payload,
      });
      return { decision: this.parseOutput(result.stdout, request, inputSetHash, skillHash), invocation: invocation() };
    } catch (error) {
      return result(this.failureFor(error, "invoke", request, inputSetHash, skillHash));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private parseOutput(
    stdout: string,
    request: AgentScanRequest,
    inputSetHash: string,
    skillHash: string,
  ): AgentScanDecision {
    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch {
      return this.failure(isRefusal(stdout) ? "AGENT_REFUSAL" : "AGENT_OUTPUT_INVALID", "validate-output", request, inputSetHash, skillHash);
    }
    try {
      if (isFailureEnvelope(output)) {
        return parseAgentFailure(output, this.failureExpected(request, inputSetHash, skillHash));
      }
      return parseAgentScanResult(output, {
        schema: "openlifewiki.agent-scan-result/v1",
        agent: CODEX_AGENT,
        inputSetHash,
        skillHash,
        scanPlanHash: request.scanInput.scanPlanHash,
        skeletonVersion: request.scanInput.skeletonVersion,
        operationId: request.operationId,
        scanId: request.scanInput.scanId,
        scanInput: request.scanInput,
      });
    } catch {
      return this.failure("AGENT_OUTPUT_INVALID", "validate-output", request, inputSetHash, skillHash);
    }
  }

  private failureFor(
    error: unknown,
    phase: "probe-runtime" | "invoke",
    request: AgentScanRequest,
    inputSetHash: string,
    skillHash: string,
  ): AgentFailure {
    const details = errorDetails(error);
    const code = details.includes("enoent") || details.includes("not found")
      ? "AGENT_MISSING"
      : details.includes("etimedout") || details.includes("timed out") || details.includes("sigterm")
        ? "AGENT_TIMEOUT"
        : details.includes("auth") || details.includes("login") || details.includes("sign in") || details.includes("unauthorized")
          ? "AGENT_AUTH_REQUIRED"
          : "AGENT_EXIT_NONZERO";
    return this.failure(code, phase, request, inputSetHash, skillHash);
  }

  private failure(
    code: keyof typeof AGENT_FAILURE_PRESENTATION,
    phase: AgentFailure["phase"],
    request: AgentScanRequest,
    inputSetHash: string,
    skillHash: string,
  ): AgentFailure {
    const presentation = AGENT_FAILURE_PRESENTATION[code];
    return parseAgentFailure({
      schema: "openlifewiki.agent-failure/v1",
      operationId: request.operationId,
      inputSetHash,
      skillHash,
      agent: CODEX_AGENT,
      code,
      phase,
      ...presentation,
      retryable: code === "AGENT_TIMEOUT" || code === "AGENT_EXIT_NONZERO",
      ambiguousRemoteState: false,
      status: "failed",
    }, this.failureExpected(request, inputSetHash, skillHash));
  }

  private failureExpected(request: AgentScanRequest, inputSetHash: string, skillHash: string) {
    return {
      schema: "openlifewiki.agent-failure/v1" as const,
      agent: CODEX_AGENT,
      inputSetHash,
      skillHash,
      operationId: request.operationId,
    };
  }
}

export function codexNativeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export function normalizeCodexVersion(stdout: string): string | null {
  const match = /^\s*codex(?:[-\s][A-Za-z]+)?\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\s*$/iu.exec(stdout);
  return match?.[1] ?? null;
}

function isValidLayerSummary(summary: AgentLayerSummary, input: AgentScanRequest["scanInput"]): boolean {
  try {
    if (!isPlainRecord(summary) || !hasExactKeys(summary, ["schema", "parent", "children", "coverage", "policy"])) return false;
    if (summary.schema !== "openlifewiki.layer-summary/v1") return false;
    if (sha256Canonical(summary) !== input.layer.summaryHash) return false;
    if (!isValidSummaryParent(summary.parent, input) || !Array.isArray(summary.children)) return false;
    if (!sameJson(summary.coverage, input.layer.coverage)) return false;
    if (!isPlainRecord(summary.policy) || !hasExactKeys(summary.policy, ["indexing", "remainingBudget", "scanIntent"])) return false;
    if (summary.policy.scanIntent !== input.scanIntent
      || !sameJson(summary.policy.indexing, input.indexing)
      || !sameJson(summary.policy.remainingBudget, input.remainingBudget)) return false;
    if (summary.children.length !== input.completeChildren.length) return false;
    return summary.children.every((child, index) => {
      const trusted = input.completeChildren[index];
      return trusted !== undefined && isValidSummaryChild(child, trusted);
    });
  } catch {
    return false;
  }
}

function isValidSummaryParent(
  parent: AgentLayerSummary["parent"],
  input: AgentScanRequest["scanInput"],
): boolean {
  return isPlainRecord(parent)
    && hasExactKeys(parent, ["description", "nodeId", "nodeVersion", "sizeBytes", "sourceId", "title", "updatedAt"])
    && parent.sourceId === input.layer.sourceId
    && parent.nodeId === input.layer.parentNodeId
    && parent.nodeVersion === input.layer.parentNodeVersion
    && isBoundedMetadata(parent);
}

function isValidSummaryChild(
  child: AgentLayerSummary["children"][number],
  trusted: AgentScanRequest["scanInput"]["completeChildren"][number],
): boolean {
  return isPlainRecord(child)
    && hasExactKeys(child, ["description", "metadataHash", "sizeBytes", "target", "title", "updatedAt"])
    && child.metadataHash === trusted.metadataHash
    && sameJson(child.target, trusted.target)
    && isBoundedMetadata(child);
}

function isBoundedMetadata(value: {
  readonly title: unknown;
  readonly description: unknown;
  readonly updatedAt: unknown;
  readonly sizeBytes: unknown;
}): boolean {
  return typeof value.title === "string" && value.title.length > 0 && value.title.length <= 512
    && isNullableString(value.description, 4_096)
    && isNullableString(value.updatedAt, 128)
    && (value.sizeBytes === null || (typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0));
}

function isNullableString(value: unknown, maximumLength: number): boolean {
  return value === null || (typeof value === "string" && value.length <= maximumLength);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected.slice().sort()[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFailureEnvelope(value: unknown): value is { readonly schema: "openlifewiki.agent-failure/v1" } {
  return typeof value === "object" && value !== null
    && "schema" in value
    && (value as { readonly schema?: unknown }).schema === "openlifewiki.agent-failure/v1";
}

function isRefusal(value: string): boolean {
  return /\b(refus(?:e|al)|cannot comply|can['’]t comply)\b/iu.test(value);
}

function errorDetails(error: unknown): string {
  const values: string[] = [];
  let current = error;
  while (typeof current === "object" && current !== null) {
    const record = current as { readonly message?: unknown; readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.message === "string") values.push(record.message);
    if (typeof record.code === "string") values.push(record.code);
    if (record.cause === current) break;
    current = record.cause;
  }
  return values.join(" ").toLowerCase();
}
