import { describe, expect, it } from "vitest";

import { nodeCommandRunner } from "../src/index.js";

describe("staged JSONL command runner", () => {
  it("waits for initialize before sending initialized and the first request", async () => {
    const fixture = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let initialized = false;
let acknowledged = false;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => {
      initialized = true;
      process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\n");
    }, 40);
    return;
  }
  if (!initialized) process.exit(20);
  if (message.method === "initialized") {
    acknowledged = true;
    return;
  }
  if (message.method === "account/read" && acknowledged) {
    process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" } } }) + "\n");
  }
});`;

    const responses = await nodeCommandRunner.runJsonLineSession!(process.execPath, ["-e", fixture], [
      { message: { method: "initialize", id: 0 }, awaitResponseId: 0 },
      { message: { method: "initialized" } },
      { message: { method: "account/read", id: 1 }, awaitResponseId: 1 },
    ], { timeoutMs: 2_000 });

    expect(responses).toEqual([
      { id: 0, result: { ready: true } },
      { id: 1, result: { account: { type: "chatgpt" } } },
    ]);
  });

  it("drains provider diagnostics without blocking the JSONL exchange", async () => {
    const fixture = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    fs.writeSync(2, Buffer.alloc(256 * 1024, "x"));
    process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\n");
  }
});`;

    await expect(nodeCommandRunner.runJsonLineSession!(process.execPath, ["-e", fixture], [
      { message: { method: "initialize", id: 0 }, awaitResponseId: 0 },
    ], { timeoutMs: 2_000 })).resolves.toEqual([{ id: 0, result: { ready: true } }]);
  });
});
