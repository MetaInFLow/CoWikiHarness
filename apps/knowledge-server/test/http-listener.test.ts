import type { AddressInfo } from "node:net";

import express from "express";
import { describe, expect, it } from "vitest";

import { formatInternalHttpUrl, listenHttp } from "../src/http-listener.js";

describe("HTTP listener", () => {
  it("listens on the requested host and reports the actual binding", async () => {
    const app = express();
    app.get("/healthz", (_request, response) => {
      response.status(200).send({ status: "ready" });
    });

    const binding = await listenHttp(app, { host: "127.0.0.1", port: 0 });
    try {
      expect(binding.host).toBe("127.0.0.1");
      expect(binding.port).toBeGreaterThan(0);
      expect(binding.internalUrl).toBe(`http://127.0.0.1:${binding.port}`);
      expect((binding.server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(await (await fetch(`${binding.internalUrl}/healthz`)).json()).toEqual({
        status: "ready",
      });
    } finally {
      await binding.close();
    }
  });

  it("brackets IPv6 hosts in internal URLs", () => {
    expect(formatInternalHttpUrl("::1", 8080)).toBe("http://[::1]:8080");
  });
});
