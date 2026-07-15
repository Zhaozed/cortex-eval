import { CliExecutionEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import { describe, expect, it } from "vitest";

import {
  runCli,
  type EvaluationCommandService,
  type PackageCommandService,
  type PipelineCommandService,
  type ReportCommandService,
  type ReportRunCommandInput,
  type RestCommandService
} from "../src/cli-program.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

const packageCommands: PackageCommandService = {
  exportPackage: (): Promise<ReceivedWorkPackage> => Promise.reject(new Error("TEST_UNUSED")),
  validatePackage: (): Promise<WorkPackageValidationSummary> =>
    Promise.reject(new Error("TEST_UNUSED"))
};
const restCommands: RestCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};
const evaluationCommands: EvaluationCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};
const pipelineCommands: PipelineCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};
const resultCommands = {
  importReport: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};

describe("P8 CLI Report command", () => {
  it("生成一个既有 Execution 的 Report 并输出严格版本事件", async () => {
    let observed: ReportRunCommandInput | null = null;
    const reportCommands: ReportCommandService = {
      run: (input) => {
        observed = input;
        return Promise.resolve({
          packageId: ID,
          executionId: ID,
          evaluationResultSetHash: HASH,
          reportResultSetHash: "b".repeat(64),
          summary: {
            total: 1,
            restSucceeded: 1,
            restError: 0,
            evalPass: 1,
            evalFail: 0,
            evalError: 0,
            notEvaluated: 0,
            effectivePassRate: 1,
            evaluatedPassRate: 1,
            coverageRate: 1
          },
          reportJsonPath: `executions/${ID}/report.json`,
          reportMarkdownPath: `executions/${ID}/report.md`
        });
      }
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["--json", "report", "build", "/tmp/package", "--execution-id", ID],
      {
        packageCommands,
        restCommands,
        evaluationCommands,
        reportCommands,
        pipelineCommands,
        resultCommands,
        output: {
          stdout: (value): void => {
            stdout.push(value);
          },
          stderr: (value): void => {
            stderr.push(value);
          }
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(observed).toMatchObject({ packagePath: "/tmp/package", executionId: ID });
    expect(CliExecutionEventV1Schema.parse(JSON.parse(stdout.join("")) as unknown)).toMatchObject({
      type: "REPORT_COMPLETED",
      reportResultSetHash: "b".repeat(64)
    });
    expect(stderr).toEqual([]);
  });

  it("对账失败使用阶段系统错误退出码 3", async () => {
    const reportCommands: ReportCommandService = {
      run: (): Promise<never> => Promise.reject(new Error("REPORT_RECONCILIATION_FAILED"))
    };
    const stderr: string[] = [];
    await expect(
      runCli(["report", "build", "/tmp/package", "--execution-id", ID], {
        packageCommands,
        restCommands,
        evaluationCommands,
        reportCommands,
        pipelineCommands,
        resultCommands,
        output: {
          stdout: (): void => undefined,
          stderr: (value): void => {
            stderr.push(value);
          }
        }
      })
    ).resolves.toBe(3);
    expect(stderr).toHaveLength(1);
  });
});
