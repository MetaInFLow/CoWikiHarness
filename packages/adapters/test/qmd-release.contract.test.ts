import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  activateDefaultSource,
  initializeRuntime,
  inspectRuntime,
  launchLocalMcp,
  nodeCommandRunner,
  resolveRuntimeLayout,
} from "../src/index.js";

const realComponentTest = process.env.OPENLIFEWIKI_REAL_COMPONENT_TEST === "1" ? it : it.skip;

realComponentTest("installs QMD, activates a real Source, and serves its upstream MCP", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "openlifewiki-qmd-contract-"));
  const layout = resolveRuntimeLayout({
    OPENLIFEWIKI_HOME: join(temporary, "runtime"),
    OPENLIFEWIKI_WORKSPACE: join(temporary, "workspace"),
  });

  try {
    const initialized = await initializeRuntime({ layout, runner: nodeCommandRunner });
    await writeFile(
      join(layout.sourcesDir, "northstar.md"),
      "# Northstar\n\nHelios evidence proves the local MCP can retrieve authorized knowledge.\n",
    );
    const activated = await activateDefaultSource({ layout, runner: nodeCommandRunner });
    const doctor = await inspectRuntime(layout, nodeCommandRunner);
    const mcpResults: Array<{ tools: string[]; queryResult: string; getResult: string }> = [];
    const mcpExit = await launchLocalMcp({
      layout,
      runner: nodeCommandRunner,
      interactiveRunner: {
        async run(command, args, options) {
          expect(args).toEqual(["mcp"]);
          mcpResults.push(await probeMcp(command, options.cwd, options.env));
          return 0;
        },
      },
    });
    const mcp = mcpResults[0]!;

    expect(initialized).toMatchObject({
      stableState: "INITIALIZED",
      components: [{ id: "qmd", version: "2.5.3" }],
    });
    expect(activated).toMatchObject({
      status: "activated",
      stableState: "ACTIVE",
      indexedFiles: 1,
    });
    expect(doctor).toMatchObject({
      status: "ready",
      stableState: "ACTIVE",
      nextAction: "use",
      components: [{ id: "qmd", status: "ready", actualVersion: "2.5.3" }],
    });
    expect(mcpExit).toBe(0);
    expect(mcp.tools).toEqual(expect.arrayContaining(["query", "get", "multi_get", "status"]));
    expect(mcp.queryResult).toContain("openlifewiki-sources/northstar.md");
    expect(mcp.getResult).toContain("Helios evidence proves the local MCP");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20 * 60_000);

async function probeMcp(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ tools: string[]; queryResult: string; getResult: string }> {
  const child = spawn(command, ["mcp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    const result = await new Promise<{
      tools: string[];
      queryResult: string;
      getResult: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`MCP handshake timed out: ${stderr}`)), 30_000);
      let tools: string[] = [];
      let queryResult = "";
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== null && code !== 0) reject(new Error(`MCP exited with ${code}: ${stderr}`));
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line) as {
            id?: number;
            result?: {
              tools?: Array<{ name: string }>;
              structuredContent?: { results?: Array<{ file?: string }> };
            };
          };
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            })}\n`);
            child.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {},
            })}\n`);
          }
          if (message.id === 2 && message.result?.tools !== undefined) {
            tools = message.result.tools.map(({ name }) => name);
            child.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: {
                name: "query",
                arguments: {
                  searches: [{ type: "lex", query: "Helios" }],
                  collections: ["openlifewiki-sources"],
                  limit: 1,
                  rerank: false,
                },
              },
            })}\n`);
          }
          if (message.id === 3) {
            queryResult = JSON.stringify(message.result);
            const file = message.result?.structuredContent?.results?.[0]?.file;
            if (file === undefined) {
              clearTimeout(timeout);
              reject(new Error(`MCP query returned no resolvable file: ${queryResult}`));
              continue;
            }
            child.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: 4,
              method: "tools/call",
              params: {
                name: "get",
                arguments: { file, lineNumbers: true },
              },
            })}\n`);
          }
          if (message.id === 4) {
            clearTimeout(timeout);
            resolve({ tools, queryResult, getResult: JSON.stringify(message.result) });
          }
        }
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "openlifewiki-contract", version: "0.1.0" },
        },
      })}\n`);
    });
    return result;
  } finally {
    child.kill("SIGTERM");
  }
}
