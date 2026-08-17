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

  it("listens on IPv6 loopback and serves its bracketed internal URL", async ({ skip }) => {
    const app = express();
    app.get("/healthz", (_request, response) => {
      response.status(200).send({ status: "ready" });
    });

    let binding: Awaited<ReturnType<typeof listenHttp>>;
    try {
      binding = await listenHttp(app, { host: "::1", port: 0 });
    } catch (error) {
      if (isIpv6Unavailable(error)) skip("IPv6 loopback is unavailable in this environment");
      throw error;
    }

    try {
      const address = binding.server.address() as AddressInfo;
      expect(binding.host).toBe("::1");
      expect(address).toMatchObject({ address: "::1", family: "IPv6" });
      expect(binding.internalUrl).toBe(`http://[::1]:${binding.port}`);
      expect(await (await fetch(`${binding.internalUrl}/healthz`)).json()).toEqual({
        status: "ready",
      });
    } finally {
      await binding.close();
    }
  });
});

function isIpv6Unavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(String(error.code));
}
