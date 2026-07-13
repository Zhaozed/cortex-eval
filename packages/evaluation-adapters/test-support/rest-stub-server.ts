import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** One test-only HTTP request handler. */
export type RestStubHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

/** Owned loopback REST stub used by adapter integration tests. */
export interface RestStubServer {
  /** Loopback HTTP origin with its assigned ephemeral port. */
  readonly origin: string;
  /** Stop listening and release all current connections. */
  readonly close: () => Promise<void>;
}

/** Start one loopback-only test server. */
export async function startRestStub(handler: RestStubHandler): Promise<RestStubServer> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("STUB_ADDRESS_INVALID");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  };
}
