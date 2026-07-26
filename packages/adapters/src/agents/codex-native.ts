import {
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
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
  AgentScanDecision,
  AgentScanInvocation,
  AgentScanRequest,
} from "./agent-driver.js";
import { isValidAgentLayerSummary } from "./layer-summary.js";

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
const OUTPUT_SCHEMA_HASH = getAgentIoSchemaHash(OUTPUT_SCHEMA_ID);
const INVALID_INPUT_HASH = sha256Canonical("invalid-agent-scan-input");
const INVALID_SKILL_HASH = sha256Canonical("invalid-canonical-skill");
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REQUIRED_EXEC_FLAGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--sandbox",
  "--skip-git-repo-check",
  "--output-schema",
  "--disable",
] as const;
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
  readonly fileSystem?: CodexNativeFileSystem;
}

export interface CodexNativeFileSystem {
  readFile(path: URL | string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, options: { readonly mode: number }): Promise<void>;
  rm(path: string, options: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
}

const nodeFileSystem: CodexNativeFileSystem = {
  readFile: async (path) => await nodeReadFile(path, "utf8"),
  mkdtemp: nodeMkdtemp,
  writeFile: async (path, data, options) => { await nodeWriteFile(path, data, options); },
  rm: async (path, options) => { await nodeRm(path, options); },
};

interface FailureContext {
  readonly operationId: string;
  readonly inputSetHash: string;
  readonly skillHash: string;
}

/** Invokes the locally authenticated official Codex CLI without application credentials. */
export class CodexNativeAgentDriver implements AgentDriver {
  private readonly runner: CommandRunner;
  private readonly command: string;
  private readonly skillPath: URL | string;
  private readonly timeoutMs: number;
  private readonly scratchRoot: string;
  private readonly fileSystem: CodexNativeFileSystem;

  constructor(options: CodexNativeAgentDriverOptions = {}) {
    this.runner = options.runner ?? nodeCommandRunner;
    this.command = options.command ?? "codex";
    this.skillPath = options.skillPath ?? DEFAULT_SKILL_PATH;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.scratchRoot = options.scratchRoot ?? tmpdir();
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  async decideScan(request: AgentScanRequest): Promise<AgentScanInvocation> {
    const operationIdValid = isSafeIdentifier(request?.operationId);
    const operationId = operationIdValid
      ? request.operationId
      : "agent_operation_invalid";
    const declaredSkillHash = isHash(request?.scanInput?.skillHash)
      ? request.scanInput.skillHash
      : INVALID_SKILL_HASH;
    let inputSetHash = INVALID_INPUT_HASH;
    let version: string | null = null;
    let evidenceSkillHash = declaredSkillHash;
    const invocation = (): AgentInvocationEvidence => ({
      schema: "openlifewiki.agent-invocation/v1",
      binary: { command: this.command, version },
      agent: CODEX_AGENT,
      inputSetHash,
      skillHash: evidenceSkillHash,
      outputSchema: { id: OUTPUT_SCHEMA_ID, hash: OUTPUT_SCHEMA_HASH },
    });
    const result = (decision: AgentScanDecision): AgentScanInvocation => ({ decision, invocation: invocation() });
    const context = (): FailureContext => ({ operationId, inputSetHash, skillHash: evidenceSkillHash });

    try {
      inputSetHash = buildAgentScanInputSetHash(request.scanInput);
    } catch {
      return result(this.failure("AGENT_HOST_CONFIG_INVALID", "validate-host-config", context()));
    }
    if (!operationIdValid) {
      return result(this.failure("AGENT_HOST_CONFIG_INVALID", "validate-host-config", context()));
    }
    if (!isValidAgentLayerSummary(request.layerSummary, request.scanInput)) {
      return result(this.failure("AGENT_HOST_CONFIG_INVALID", "validate-host-config", context()));
    }
    let skill: string;
    try {
      skill = await this.fileSystem.readFile(this.skillPath);
    } catch {
      return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", context()));
    }

    if (typeof skill !== "string") {
      return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", context()));
    }
    const skillHash = sha256Canonical(skill);
    evidenceSkillHash = skillHash;
    if (skillHash !== request.scanInput.skillHash) {
      return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", context()));
    }

    try {
      const probe = await this.runner.run(this.command, ["--version"], {
        env: codexNativeEnvironment(),
        timeoutMs: this.timeoutMs,
      });
      version = normalizeCodexVersion(probe.stdout);
      if (version === null) {
        return result(this.failure("AGENT_UNSUPPORTED_VERSION", "probe-runtime", context()));
      }
    } catch (error) {
      return result(this.failureFor(error, "probe-runtime", context()));
    }

    try {
      const help = await this.runner.run(this.command, ["exec", "--help"], {
        env: codexNativeEnvironment(),
        timeoutMs: this.timeoutMs,
      });
      if (!hasRequiredExecCapabilities(help.stdout)) {
        return result(this.failure("AGENT_CONTRACT_UNSUPPORTED", "probe-runtime", context()));
      }
    } catch (error) {
      return result(this.capabilityFailureFor(error, context()));
    }

    let scratch: string;
    try {
      scratch = await this.fileSystem.mkdtemp(join(this.scratchRoot, "openlifewiki-codex-"));
    } catch {
      return result(this.failure("AGENT_SPAWN_FAILED", "spawn", context()));
    }

    let decision: AgentScanDecision;
    let primaryFailure = false;
    const schemaPath = join(scratch, "agent-scan-result.schema.json");
    try {
      await this.fileSystem.writeFile(
        schemaPath,
        `${JSON.stringify(getAgentIoJsonSchema(OUTPUT_SCHEMA_ID))}\n`,
        { mode: 0o600 },
      );
    } catch {
      decision = this.failure("AGENT_TOOL_ERROR", "tool-call", context());
      primaryFailure = true;
    }

    if (!primaryFailure) {
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
      try {
        const commandResult = await this.runner.run(this.command, [
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
        decision = this.parseOutput(commandResult.stdout, request, context());
      } catch (error) {
        decision = this.failureFor(error, "invoke", context());
        primaryFailure = true;
      }
    }

    try {
      await this.fileSystem.rm(scratch, { recursive: true, force: true });
    } catch {
      if (!isFailureEnvelope(decision!)) {
        decision = this.failure("AGENT_TOOL_ERROR", "normalize-output", context());
      }
    }
    return result(decision!);
  }

  private parseOutput(
    stdout: string,
    request: AgentScanRequest,
    context: FailureContext,
  ): AgentScanDecision {
    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch {
      return this.failure(
        isRefusal(stdout) ? "AGENT_REFUSAL" : "AGENT_OUTPUT_INVALID",
        "validate-output",
        context,
      );
    }
    try {
      if (isFailureEnvelope(output)) {
        return parseAgentFailure(output, this.failureExpected(context));
      }
      return parseAgentScanResult(output, {
        schema: "openlifewiki.agent-scan-result/v1",
        agent: CODEX_AGENT,
        inputSetHash: context.inputSetHash,
        skillHash: context.skillHash,
        scanPlanHash: request.scanInput.scanPlanHash,
        skeletonVersion: request.scanInput.skeletonVersion,
        operationId: context.operationId,
        scanId: request.scanInput.scanId,
        scanInput: request.scanInput,
      });
    } catch {
      return this.failure("AGENT_OUTPUT_INVALID", "validate-output", context);
    }
  }

  private failureFor(
    error: unknown,
    phase: "probe-runtime" | "invoke",
    context: FailureContext,
  ): AgentFailure {
    const details = errorDetails(error);
    const code = details.includes("enoent") || details.includes("not found")
      ? "AGENT_MISSING"
      : details.includes("etimedout") || details.includes("timed out") || details.includes("sigterm")
        ? "AGENT_TIMEOUT"
        : details.includes("auth") || details.includes("login") || details.includes("sign in") || details.includes("unauthorized")
          ? "AGENT_AUTH_REQUIRED"
          : "AGENT_EXIT_NONZERO";
    return this.failure(code, phase, context);
  }

  private capabilityFailureFor(error: unknown, context: FailureContext): AgentFailure {
    const details = errorDetails(error);
    if (isTimeoutDetails(details)) return this.failure("AGENT_TIMEOUT", "probe-runtime", context);
    if (details.includes("enoent") || details.includes("not found")) {
      return this.failure("AGENT_MISSING", "probe-runtime", context);
    }
    return this.failure("AGENT_CONTRACT_UNSUPPORTED", "probe-runtime", context);
  }

  private failure(
    code: keyof typeof AGENT_FAILURE_PRESENTATION,
    phase: AgentFailure["phase"],
    context: FailureContext,
  ): AgentFailure {
    const presentation = AGENT_FAILURE_PRESENTATION[code];
    return parseAgentFailure({
      schema: "openlifewiki.agent-failure/v1",
      operationId: context.operationId,
      inputSetHash: context.inputSetHash,
      skillHash: context.skillHash,
      agent: CODEX_AGENT,
      code,
      phase,
      ...presentation,
      retryable: code === "AGENT_TIMEOUT" || code === "AGENT_EXIT_NONZERO",
      ambiguousRemoteState: false,
      status: "failed",
    }, this.failureExpected(context));
  }

  private failureExpected(context: FailureContext) {
    return {
      schema: "openlifewiki.agent-failure/v1" as const,
      agent: CODEX_AGENT,
      inputSetHash: context.inputSetHash,
      skillHash: context.skillHash,
      operationId: context.operationId,
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

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function hasRequiredExecCapabilities(help: string): boolean {
  return REQUIRED_EXEC_FLAGS.every((flag) => new RegExp(
    `(^|\\s)${flag}(?=\\s|,|<|$)`,
    "mu",
  ).test(help));
}

function isTimeoutDetails(details: string): boolean {
  return details.includes("etimedout")
    || details.includes("timed out")
    || details.includes("sigterm");
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
