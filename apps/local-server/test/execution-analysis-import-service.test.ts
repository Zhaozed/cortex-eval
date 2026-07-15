import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import { initializeSqliteStorage } from "@cortex-eval/storage-sqlite/src/sqlite-database.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPLETED_REPORT_EXECUTION_ID,
  completedReportService,
  materializeCompletedEvaluation
} from "../../cli/test-support/completed-report-fixture.ts";
import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../../cli/src/cli-hashing.ts";
import { WorkPackageAnalysisRunService } from "../../cli/src/work-package-analysis-run-service.ts";
import { ExecutionAnalysisImportService } from "../src/execution-analysis-import-service.ts";
import { ExecutionReportImportService } from "../src/execution-report-import-service.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000501";
const PROCESS_STARTED_AT = "Wed Jul 15 08:00:00 2026";
const roots: string[] = [];

function analysisService(modelFails: boolean): WorkPackageAnalysisRunService {
  let nonce = 0;
  let minute = 6;
  return new WorkPackageAnalysisRunService({
    contextHasher: cliExecutionContextHasher,
    caseHasher: cliCaseDefinitionHasher,
    restHashing: cliRestSemanticHashing,
    evalHashing: cliEvalSemanticHashing,
    modelClient: {
      analyze: (): Promise<AnalysisResultDraft> => {
        if (modelFails) {
          throw Object.assign(new Error("untrusted"), { code: "ANALYZER_OUTPUT_INVALID" });
        }
        return Promise.resolve({
          classification: "NORMAL_FAILURE",
          confidence: 0.8,
          evidence: [{ source: "failed_assertions", fieldPath: "/0", conclusion: "冻结断言失败" }],
          explanation: "结果不满足冻结约束",
          recommendedAction: "修复被测系统"
        });
      }
    },
    processIdentity: {
      processStartedAt: (): Promise<string> => Promise.resolve(PROCESS_STARTED_AT)
    },
    nonce: (): string => `analysis_import_run_${String(++nonce).padStart(2, "0")}`,
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    errorMessage: () => "分析输出无效"
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function importCompletedAnalysis(modelFails: boolean): Promise<{
  readonly first: Awaited<ReturnType<ExecutionAnalysisImportService["importAnalysis"]>>;
  readonly second: Awaited<ReturnType<ExecutionAnalysisImportService["importAnalysis"]>>;
  readonly currentErrorMessage: string | null | undefined;
}> {
  const packagePath = await mkdtemp(join(tmpdir(), "cortex-analysis-import-package-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-import-platform-"));
  roots.push(packagePath, projectRoot);
  await materializeCompletedEvaluation(packagePath);
  await completedReportService().run({
    packagePath,
    executionId: COMPLETED_REPORT_EXECUTION_ID,
    signal: new AbortController().signal
  });
  const storage = await initializeSqliteStorage({ projectRoot });
  try {
    let reportNonce = 0;
    const reportImporter = new ExecutionReportImportService({
      transactionManager: storage.createTransactionManager(),
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:08:00.000Z" },
      processIdentity: {
        processStartedAt: (): Promise<string> => Promise.resolve(PROCESS_STARTED_AT)
      },
      nonce: (): string => `report_import_${String(++reportNonce).padStart(2, "0")}`
    });
    const report = await reportImporter.importReport(
      {
        contractVersion: "cortex.execution-report-import-request.v1",
        packagePath,
        executionId: COMPLETED_REPORT_EXECUTION_ID
      },
      new AbortController().signal
    );
    expect(report).toMatchObject({ ok: true, value: { runId: RUN_ID } });

    await analysisService(modelFails).run({
      packagePath,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "failed",
      signal: new AbortController().signal
    });
    let analysisNonce = 0;
    let analysisId = 0;
    const analysisImporter = new ExecutionAnalysisImportService({
      stagingFactory: storage.createAnalysisImportStagingFactory(),
      idGenerator: {
        nextId: (): string => `01900000-0000-7000-8000-${String(++analysisId).padStart(12, "0")}`
      },
      clock: { now: (): string => "2026-07-15T00:09:00.000Z" },
      processIdentity: {
        processStartedAt: (): Promise<string> => Promise.resolve(PROCESS_STARTED_AT)
      },
      nonce: (): string => `analysis_import_${String(++analysisNonce).padStart(2, "0")}`,
      errorMessage: (code): string =>
        code === "ANALYZER_OUTPUT_INVALID" ? "平台本地化：Analyzer 输出结构无效" : "平台分析错误"
    });
    const request = {
      contractVersion: "cortex.execution-analysis-import-request.v1" as const,
      packagePath,
      executionId: COMPLETED_REPORT_EXECUTION_ID
    };
    const first = await analysisImporter.importAnalysis(request, new AbortController().signal);
    const second = await analysisImporter.importAnalysis(request, new AbortController().signal);
    const current = await storage
      .createAnalysisTransactionManager()
      .execute((transaction) => transaction.analyses.getCurrent(RUN_ID, "case-1"));
    return { first, second, currentErrorMessage: current?.errorMessage };
  } finally {
    await storage.close();
  }
}

describe("Execution Analysis Import Service", () => {
  it("双遍读取成功结果并按完整 Execution 版本幂等导入", async () => {
    const result = await importCompletedAnalysis(false);
    expect(result.first).toMatchObject({
      ok: true,
      value: {
        runId: RUN_ID,
        executionId: COMPLETED_REPORT_EXECUTION_ID,
        idempotent: false,
        selector: "failed",
        selectedCount: 1,
        importedCount: 1
      }
    });
    expect(result.second).toMatchObject({ ok: true, value: { idempotent: true } });
  }, 20_000);

  it("保留离线逐 Case 模型错误并拒绝无法确认的进程身份", async () => {
    const result = await importCompletedAnalysis(true);
    expect(result.first).toMatchObject({
      ok: true,
      value: { importedCount: 1, selectedCount: 1 }
    });
    expect(result.currentErrorMessage).toBe("平台本地化：Analyzer 输出结构无效");

    const locked = new ExecutionAnalysisImportService({
      stagingFactory: {} as never,
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:00:00.000Z" },
      processIdentity: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      nonce: (): string => "unused",
      errorMessage: (): string => "unused"
    });
    await expect(
      locked.importAnalysis(
        {
          contractVersion: "cortex.execution-analysis-import-request.v1",
          packagePath: "/does/not/open",
          executionId: COMPLETED_REPORT_EXECUTION_ID
        },
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_LOCKED");
  }, 20_000);
});
