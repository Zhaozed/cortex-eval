import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnalysisResultsArtifactV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { ExecutionV1Schema } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import type { AnalysisModelClient } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";

import { WorkPackageAnalysisRunService } from "../src/work-package-analysis-run-service.ts";
import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../src/cli-hashing.ts";
import {
  COMPLETED_REPORT_EXECUTION_ID,
  completedReportService,
  materializeCompletedEvaluation
} from "../test-support/completed-report-fixture.ts";

const roots: string[] = [];

interface AnalysisServiceOptions {
  readonly modelFails?: boolean | undefined;
  readonly modelClient?: AnalysisModelClient | undefined;
  readonly messageFails?: boolean | undefined;
  readonly processStartedAt?: string | null | undefined;
}

function analysisService(options: AnalysisServiceOptions = {}): WorkPackageAnalysisRunService {
  let minute = 6;
  let nonce = 0;
  return new WorkPackageAnalysisRunService({
    contextHasher: cliExecutionContextHasher,
    caseHasher: cliCaseDefinitionHasher,
    restHashing: cliRestSemanticHashing,
    evalHashing: cliEvalSemanticHashing,
    modelClient: options.modelClient ?? {
      analyze: (): Promise<AnalysisResultDraft> => {
        if (options.modelFails === true) {
          throw Object.assign(new Error("untrusted"), { code: "ANALYZER_OUTPUT_INVALID" });
        }
        return Promise.resolve({
          classification: "NORMAL_FAILURE",
          confidence: 0.8,
          evidence: [
            {
              source: "failed_assertions",
              fieldPath: "/0",
              conclusion: "冻结断言失败"
            }
          ],
          explanation: "结果不满足冻结约束",
          recommendedAction: "修复被测系统"
        });
      }
    },
    processIdentity: {
      processStartedAt: (): Promise<string | null> =>
        Promise.resolve(
          options.processStartedAt === undefined
            ? "Wed Jul 15 08:00:00 2026"
            : options.processStartedAt
        )
    },
    nonce: (): string => `analysis_run_${String(++nonce).padStart(2, "0")}`,
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    errorMessage: (): string => {
      if (options.messageFails === true) throw new Error("MESSAGE_LOOKUP_FAILED");
      return "分析输出无效";
    }
  });
}

async function reportedPackage(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Analysis Run Service", () => {
  it("从闭合 Report 运行显式 Selector 并登记结构化 Evidence", async () => {
    const root = await reportedPackage("cortex-analysis-run-");
    const result = await analysisService().run({
      packagePath: root,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "failed",
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0,
      artifactPath: `executions/${COMPLETED_REPORT_EXECUTION_ID}/analysis-results.json`
    });
    const artifact = AnalysisResultsArtifactV1Schema.parse(
      JSON.parse(await readFile(join(root, result.artifactPath), "utf8")) as unknown
    );
    expect(artifact.cases).toMatchObject([
      {
        status: "SUCCEEDED",
        evidence: [{ source: "failed_assertions", fieldPath: "/0", conclusion: "冻结断言失败" }]
      }
    ]);
    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(
          join(root, `executions/${COMPLETED_REPORT_EXECUTION_ID}/execution.json`),
          "utf8"
        )
      ) as unknown
    );
    expect(execution.stages.ANALYSIS).toMatchObject({ status: "SUCCEEDED" });

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Wed Jul 15 08:00:00 2026",
        executionId: COMPLETED_REPORT_EXECUTION_ID,
        acquiredAt: "2026-07-15T00:20:00.000Z"
      },
      contextHasher: cliExecutionContextHasher,
      nonce: () => "analysis_import_01",
      validationOptions: { allowRawEvidenceUnavailable: true }
    });
    try {
      const prepared = await session.prepareAnalysisImport(
        COMPLETED_REPORT_EXECUTION_ID,
        cliCaseDefinitionHasher,
        cliRestSemanticHashing,
        cliEvalSemanticHashing,
        new AbortController().signal
      );
      expect(prepared).toMatchObject({
        selector: "failed",
        selectedCount: 1,
        finalCaseResultSetHash: result.finalCaseResultSetHash,
        analysisResultSetHash: result.analysisResultSetHash
      });
      const imported = [];
      for await (const item of prepared.openCases()) imported.push(item);
      expect(imported).toMatchObject([
        {
          status: "SUCCEEDED",
          evidence: [{ source: "failed_assertions", fieldPath: "/0" }]
        }
      ]);
    } finally {
      await session.close();
    }
  });

  it("无匹配 Case 写空结果；单 Case 模型错误隔离为成功阶段", async () => {
    const emptyRoot = await reportedPackage("cortex-analysis-empty-");
    const empty = await analysisService().run({
      packagePath: emptyRoot,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "errors",
      signal: new AbortController().signal
    });
    expect(empty).toMatchObject({ selectedCount: 0, succeededCount: 0, errorCount: 0 });

    const errorRoot = await reportedPackage("cortex-analysis-error-");
    const isolated = await analysisService({ modelFails: true }).run({
      packagePath: errorRoot,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "all",
      signal: new AbortController().signal
    });
    expect(isolated).toMatchObject({ selectedCount: 1, succeededCount: 0, errorCount: 1 });
    const artifact = AnalysisResultsArtifactV1Schema.parse(
      JSON.parse(await readFile(join(errorRoot, isolated.artifactPath), "utf8")) as unknown
    );
    expect(artifact.cases[0]).toMatchObject({
      status: "ERROR",
      evidence: [],
      error: { code: "ANALYZER_OUTPUT_INVALID", message: "分析输出无效" }
    });
  });

  it("在阶段认领前拒绝进程身份缺失、取消和不存在的 Execution", async () => {
    const root = await reportedPackage("cortex-analysis-precondition-");
    const input = {
      packagePath: root,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "failed" as const,
      signal: new AbortController().signal
    };
    await expect(analysisService({ processStartedAt: null }).run(input)).rejects.toThrow(
      "WORK_PACKAGE_LOCKED"
    );

    const controller = new AbortController();
    controller.abort();
    await expect(analysisService().run({ ...input, signal: controller.signal })).rejects.toThrow(
      "REQUEST_ABORTED"
    );
    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(
          join(root, `executions/${COMPLETED_REPORT_EXECUTION_ID}/execution.json`),
          "utf8"
        )
      ) as unknown
    );
    expect(execution.stages.ANALYSIS).toMatchObject({ status: "PENDING" });
    await expect(
      analysisService().run({
        ...input,
        executionId: "018f22aa-33bb-7ccc-8ddd-fffffffffff2"
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("Artifact 写入失败时中止临时文件并把已认领阶段收敛为 ERROR", async () => {
    const root = await reportedPackage("cortex-analysis-stage-failure-");
    await expect(
      analysisService({ modelFails: true, messageFails: true }).run({
        packagePath: root,
        executionId: COMPLETED_REPORT_EXECUTION_ID,
        selector: "failed",
        signal: new AbortController().signal
      })
    ).rejects.toThrow("ANALYSIS_STAGE_FAILED");

    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(
          join(root, `executions/${COMPLETED_REPORT_EXECUTION_ID}/execution.json`),
          "utf8"
        )
      ) as unknown
    );
    expect(execution.stages.ANALYSIS).toMatchObject({
      status: "ERROR",
      errorCode: "ANALYSIS_STAGE_FAILED",
      artifacts: []
    });
    await expect(
      readFile(
        join(root, `executions/${COMPLETED_REPORT_EXECUTION_ID}/analysis-results.json`),
        "utf8"
      )
    ).rejects.toThrow();
  });

  it("阶段认领后取消写入明确终态并由 CLI 映射为退出码 130", async () => {
    const root = await reportedPackage("cortex-analysis-cancelled-");
    let announceStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const modelClient: AnalysisModelClient = {
      analyze: (request) => {
        announceStarted();
        return new Promise<AnalysisResultDraft>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { code: "ANALYSIS_CANCELLED" })),
            { once: true }
          );
        });
      }
    };
    const controller = new AbortController();
    const running = analysisService({ modelClient }).run({
      packagePath: root,
      executionId: COMPLETED_REPORT_EXECUTION_ID,
      selector: "failed",
      signal: controller.signal
    });
    await started;
    controller.abort();

    await expect(running).rejects.toThrow("ANALYSIS_CANCELLED");
    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(
          join(root, `executions/${COMPLETED_REPORT_EXECUTION_ID}/execution.json`),
          "utf8"
        )
      ) as unknown
    );
    expect(execution.stages.ANALYSIS).toMatchObject({
      status: "ERROR",
      errorCode: "ANALYSIS_CANCELLED",
      artifacts: []
    });
  });
});
