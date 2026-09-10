import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { createLocalServerRuntime } from "./local-server-runtime.ts";

const projectRoot = resolve(process.cwd());
// Persist local-only resource paths across restarts; explicit shell variables take precedence.
try {
  loadEnvFile(resolve(projectRoot, ".cortex-eval", "server.env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const runtime = await createLocalServerRuntime({
  projectRoot,
  staticRoot: resolve(projectRoot, "apps", "web", "dist")
});

// Close in protocol order when the local operator stops the foreground server.
async function shutdown(): Promise<void> {
  await runtime.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await runtime.listen();
