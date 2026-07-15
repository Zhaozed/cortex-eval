import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisModelClient } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@cortex-eval/evaluation-adapters/src/frozen-analyzer-model-client.ts", () => ({
  createFrozenAnalyzerModelClient: (): AnalysisModelClient => ({
    analyze: (): Promise<AnalysisResultDraft> => {
      model.calls += 1;
      return Promise.resolve({
        classification: "NORMAL_FAILURE",
        confidence: 0.8,
        evidence: [{ source: "failed_assertions", fieldPath: "/0", conclusion: "冻结断言失败" }],
        explanation: "结果不满足冻结约束",
        recommendedAction: "修复被测系统"
      });
    }
  })
}));

import { LocalAnalysisCommandService } from "../src/analysis-command-service.ts";
import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../src/cli-hashing.ts";
import { CliSecretEnvironment } from "../src/cli-secret-environment.ts";
import {
  COMPLETED_REPORT_EXECUTION_ID,
  completedReportService,
  materializeCompletedEvaluation
} from "../test-support/completed-report-fixture.ts";

const PROCESS_STARTED_AT = "Wed Jul 15 08:00:00 2026";
const roots: string[] = [];

function commandService(
  processStartedAt: string | null = PROCESS_STARTED_AT
): LocalAnalysisCommandService {
  let nonce = 0;
  let minute = 6;
  return new LocalAnalysisCommandService({
    contextHasher: cliExecutionContextHasher,
    caseHasher: cliCaseDefinitionHasher,
    restHashing: cliRestSemanticHashing,
    evalHashing: cliEvalSemanticHashing,
    nonce: (): string => `analysis_command_${String(++nonce).padStart(2, "0")}`,
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    processIdentity: {
      processStartedAt: (): Promise<string | null> => Promise.resolve(processStartedAt)
    },
    inheritedEnvironment: (): Readonly<Record<string, string>> => ({
      GEMINI_API_KEY: "test-secret"
    }),
    errorMessage: (): string => "分析失败"
  });
}

async function reportedPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-analysis-command-"));
  roots.push(root);
  await materializeCompletedEvaluation(root);
  await completedReportService().run({
    packagePath: root,
    executionId: COMPLETED_REPORT_EXECUTION_ID,
    signal: new AbortController().signal
  });
  return root;
}

afterEach(async () => {
  model.calls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Local Analysis Command Service", () => {
  it("使用命令期 Secret、严格预检和官方 SDK Port 完成真实工作包 Analysis", async () => {
    const packagePath = await reportedPackage();
    const result = await commandService().run({
      packagePath,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "failed",
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ selectedCount: 1, succeededCount: 1, errorCount: 0 });
    expect(model.calls).toBe(1);
  }, 20_000);

  it("预检在打开阶段前拒绝进程身份、缺失 Secret 和取消", async () => {
    const packagePath = await reportedPackage();
    const environment = await CliSecretEnvironment.load({
      inherited: { GEMINI_API_KEY: "test-secret" }
    });
    await expect(
      commandService(null).preflightWithEnvironment(
        { packagePath, signal: new AbortController().signal },
        environment
      )
    ).rejects.toThrow("WORK_PACKAGE_LOCKED");

    const missing = await CliSecretEnvironment.load({ inherited: {} });
    await expect(
      commandService().preflightWithEnvironment(
        { packagePath, signal: new AbortController().signal },
        missing
      )
    ).rejects.toThrow("VALIDATION_FAILED");

    const controller = new AbortController();
    controller.abort();
    await expect(
      commandService().preflightWithEnvironment(
        { packagePath, signal: controller.signal },
        environment
      )
    ).rejects.toThrow("REQUEST_ABORTED");
  }, 20_000);

  it("显式 Env 文件读取失败时不打开工作包或调用 Analyzer", async () => {
    await expect(
      commandService().run({
        packagePath: "/does/not/open",
        executionId: COMPLETED_REPORT_EXECUTION_ID,
        selector: "failed",
        envFile: "/does/not/exist.env",
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(model.calls).toBe(0);
  });
});
