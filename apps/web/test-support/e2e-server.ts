import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalServerRuntime } from "../../local-server/src/local-server-runtime.ts";

const projectRoot = await mkdtemp(join(tmpdir(), "cortex-eval-web-e2e-"));
const successfulEndpointValidator = {
  validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};
const successfulLlmValidator = {
  validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};
const runtime = await createLocalServerRuntime({
  projectRoot,
  staticRoot: fileURLToPath(new URL("../dist", import.meta.url)),
  endpointValidator: successfulEndpointValidator,
  llmValidator: successfulLlmValidator
});
let closing = false;

// Close owned HTTP, logger, SQLite and the isolated project root exactly once.
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await runtime.close();
  await rm(projectRoot, { recursive: true, force: true });
}

// Terminate the test-only process after owned resources have closed.
async function stop(): Promise<void> {
  await close();
  process.exit(0);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await runtime.listen();
