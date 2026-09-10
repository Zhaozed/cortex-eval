import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalServerRuntime } from "../../local-server/src/local-server-runtime.ts";

const port = Number(process.env.CORTEX_EVAL_E2E_PORT ?? "4310");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT_INVALID");
const projectRoot = await mkdtemp(join(tmpdir(), "cortex-eval-web-e2e-"));
const successfulEndpointValidator = {
  validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};
const successfulLlmValidator = {
  validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};
const runtime = await createLocalServerRuntime({
  projectRoot,
  allowedHosts: [`127.0.0.1:${port}`],
  staticRoot: fileURLToPath(new URL("../dist", import.meta.url)),
  endpointValidator: successfulEndpointValidator,
  llmValidator: successfulLlmValidator,
  analysisModelClient: {
    analyze: () =>
      Promise.resolve({
        classification: "NORMAL_FAILURE",
        confidence: 0.92,
        evidence: [
          {
            source: "run_context",
            fieldPath: null,
            conclusion: "运行上下文确认该 Case 未通过评估"
          }
        ],
        explanation: "冻结结果未满足 Case 约束",
        recommendedAction: "修复被测系统后重新执行"
      })
  }
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
await runtime.server.listen({
  host: "127.0.0.1",
  port
});
