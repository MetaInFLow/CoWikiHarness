import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { AdapterError } from "./errors.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

export interface JsonLineStep {
  readonly message: unknown;
  readonly awaitResponseId?: string | number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  runJsonLineSession?(
    command: string,
    args: readonly string[],
    steps: readonly JsonLineStep[],
    options?: Omit<CommandOptions, "stdin">,
  ): Promise<readonly unknown[]>;
}

export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    const maxOutputBytes = outputLimit(options.maxOutputBytes);
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        [...args],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          encoding: "utf8",
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: maxOutputBytes,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new AdapterError(
              "COMMAND_FAILED",
              `Command failed: ${command}`,
              { cause: error },
            ));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    });
  },
  runJsonLineSession(command, args, steps, options = {}) {
    const maxOutputBytes = outputLimit(options.maxOutputBytes);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout });
      child.stderr.resume();
      const responses: unknown[] = [];
      let stepIndex = 0;
      let waitingFor: string | number | undefined;
      let receivedBytes = 0;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        lines.close();
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause instanceof AdapterError
          ? cause
          : new AdapterError("COMMAND_FAILED", `Command failed: ${command}`, { cause }));
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(responses);
      };
      const sendAvailable = (): void => {
        while (!settled && waitingFor === undefined && stepIndex < steps.length) {
          const step = steps[stepIndex];
          stepIndex += 1;
          child.stdin.write(`${JSON.stringify(step?.message)}\n`);
          if (step?.awaitResponseId !== undefined) waitingFor = step.awaitResponseId;
        }
        if (!settled && stepIndex === steps.length && waitingFor === undefined) finish();
      };
      const timer = setTimeout(() => {
        fail(Object.assign(new Error("JSONL session timed out"), { code: "ETIMEDOUT" }));
      }, options.timeoutMs ?? 60_000);

      child.once("spawn", sendAvailable);
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (!settled) fail(new Error(`JSONL process exited before completing the exchange (${code ?? signal ?? "unknown"})`));
      });
      child.stdin.once("error", fail);
      lines.on("line", (line) => {
        receivedBytes += Buffer.byteLength(line) + 1;
        if (receivedBytes > maxOutputBytes) {
          fail(Object.assign(new Error("JSONL output exceeded the safe limit"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }));
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        if (waitingFor === undefined || !hasResponseId(message, waitingFor)) return;
        responses.push(message);
        waitingFor = undefined;
        sendAvailable();
      });
    });
  },
};

function outputLimit(value: number | undefined): number {
  const limit = value ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 64 * 1024 * 1024) {
    throw new AdapterError("COMMAND_FAILED", "Command output limit is invalid");
  }
  return limit;
}

function hasResponseId(value: unknown, expected: string | number): boolean {
  return typeof value === "object" && value !== null && "id" in value
    && (value as { readonly id?: unknown }).id === expected;
}
