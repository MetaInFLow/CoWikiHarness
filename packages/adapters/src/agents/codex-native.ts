import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_FAILURE_PRESENTATION,
  buildAgentScanInputSetHash,
  getAgentIoJsonSchema,
  parseAgentFailure,
  parseAgentScanResult,
  sha256Canonical,
  type AgentFailure,
  type AgentIoAgent,
} from "@openlifewiki/protocol";

import type { CommandRunner } from "../command-runner.js";
import { nodeCommandRunner } from "../command-runner.js";
import type { AgentDriver, AgentScanDecision, AgentScanRequest } from "./agent-driver.js";

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

  async decideScan(request: AgentScanRequest): Promise<AgentScanDecision> {
    const inputSetHash = buildAgentScanInputSetHash(request.scanInput);
    let skill: string;
    try {
      skill = await readFile(this.skillPath, "utf8");
    } catch {
      return this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", request, inputSetHash, request.scanInput.skillHash);
    }

    const skillHash = sha256Canonical(skill);
    if (skillHash !== request.scanInput.skillHash) {
      return this.failure("AGENT_CONTRACT_UNSUPPORTED", "validate-host-config", request, inputSetHash, skillHash);
    }

    try {
      await this.runner.run(this.command, ["--version"], { timeoutMs: this.timeoutMs });
    } catch (error) {
      return this.failureFor(error, "probe-runtime", request, inputSetHash, skillHash);
    }

    const scratch = await mkdtemp(join(this.scratchRoot, "openlifewiki-codex-"));
    try {
      const schemaPath = join(scratch, "agent-scan-result.schema.json");
      await writeFile(
        schemaPath,
        `${JSON.stringify(getAgentIoJsonSchema("openlifewiki.agent-scan-result/v1"))}\n`,
        { mode: 0o600 },
      );
      const payload = JSON.stringify({
        schema: "openlifewiki.codex-scan-request/v1",
        instruction: "Use the canonical Skill and metadata-only scan input. Return only JSON matching the output schema.",
        skill: { hash: skillHash, content: skill },
        operationId: request.operationId,
        scanInput: request.scanInput,
      });
      const result = await this.runner.run(this.command, [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "-",
      ], {
        cwd: scratch,
        timeoutMs: this.timeoutMs,
        stdin: payload,
      });
      return this.parseOutput(result.stdout, request, inputSetHash, skillHash);
    } catch (error) {
      return this.failureFor(error, "invoke", request, inputSetHash, skillHash);
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
