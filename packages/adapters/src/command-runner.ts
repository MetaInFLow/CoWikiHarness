import { execFile } from "node:child_process";

import { AdapterError } from "./errors.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          encoding: "utf8",
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 1024 * 1024,
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
    });
  },
};
