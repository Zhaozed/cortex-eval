import { resolve } from "node:path";

import { createLocalServerRuntime } from "./local-server-runtime.ts";

const projectRoot = resolve(process.cwd());
const runtime = await createLocalServerRuntime({ projectRoot });

// Close in protocol order when the local operator stops the foreground server.
async function shutdown(): Promise<void> {
  await runtime.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await runtime.listen();
