import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { diagnosisFixture } from "@cortex-eval/contracts/test-support/diagnostic-report-fixture.ts";
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
  diagnosticModelClient: {
    diagnose: ({ input }) => {
      const evidence = z
        .object({ evidence: z.array(z.object({ id: z.string(), source: z.string() })) })
        .parse(JSON.parse(input)).evidence;
      return Promise.resolve({
        ...diagnosisFixture(),
        evidenceIds: evidence
          .filter((e) => e.source === "ASSERTIONS" || e.source === "OUTPUT")
          .map((e) => e.id)
      });
    },
    synthesize: () =>
      Promise.resolve({
        markdown:
          "这轮反馈可以整理成 1 个根问题、1 个具体表现。共同原因是：结果卡片没有进入最终输出。\n\n**一、结果卡片缺失**\n\n涉及反馈：\n- C1：缺少结果卡片\n\n已确认：\n- 工具回执成功但输出卡片为空\n\n问题本质：\n> 结果卡片没有进入最终输出\n\n影响：\n- 用户看不到结果卡片\n\n修复目标：\n- 检查结果卡片组装与输出路径"
      })
  },
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
