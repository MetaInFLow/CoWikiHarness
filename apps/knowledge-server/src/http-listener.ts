import type { Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";

import type { Express } from "express";

export interface HttpListenerBinding {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly internalUrl: string;
  close(): Promise<void>;
}

export function formatInternalHttpUrl(host: string, port: number): string {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

export async function listenHttp(
  app: Express,
  input: { readonly host: string; readonly port: number },
): Promise<HttpListenerBinding> {
  const server = await new Promise<Server>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const listening = app.listen(input.port, input.host, () => {
      listening.off("error", onError);
      resolve(listening);
    });
    listening.once("error", onError);
  });
  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    server,
    host: input.host,
    port,
    internalUrl: formatInternalHttpUrl(input.host, port),
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
