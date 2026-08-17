import { describe, expect, it } from "vitest";

import { gatewayStartupMessages } from "../src/main.js";

describe("Gateway startup messages", () => {
  it("reports internal and public addresses without configuration secrets", () => {
    const messages = gatewayStartupMessages({
      url: "https://knowledge.example.com",
      host: "127.0.0.1",
      port: 8080,
      internalUrl: "http://127.0.0.1:8080",
    });

    expect(messages).toEqual([
      "CoWikiHarness Gateway listening internally at http://127.0.0.1:8080",
      "CoWikiHarness Gateway public URL https://knowledge.example.com",
    ]);
    expect(messages.join(" ")).not.toMatch(/token|secret|password|api[_-]?key/iu);
  });
});
