import type { ExecutionReportImportResultV1 } from "@cortex-eval/contracts/src/result-import-contracts.ts";
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
  type RestCommandService,
  type ResultImportCommandInput,
  type ResultImportCommandService
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
const reportCommands: ReportCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};
const pipelineCommands: PipelineCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};

function imported(): ExecutionReportImportResultV1 {
  return {
    contractVersion: "cortex.execution-report-import-result.v1",
    runId: ID,
    packageId: ID,
    executionId: ID,
    idempotent: false,
    sourceType: "OFFLINE_IMPORT",
    status: "COMPLETED",
    stage: "DONE",
    restResultSetHash: HASH,
    evaluationContextHash: "b".repeat(64),
    evaluationResultSetHash: "c".repeat(64),
    reportResultSetHash: "d".repeat(64)
  };
}

describe("P8 CLI result import", () => {
  it("imports one Report Execution and emits one strict versioned event", async () => {
    let observed: ResultImportCommandInput | null = null;
    const resultCommands: ResultImportCommandService = {
      importReport: (input) => {
        observed = input;
        return Promise.resolve(imported());
      }
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["--json", "result", "import", "/tmp/package", "--execution-id", ID],
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
      type: "REPORT_IMPORTED",
      runId: ID,
      executionId: ID,
      evaluationContextHash: "b".repeat(64),
      reportResultSetHash: "d".repeat(64)
    });
    expect(stderr).toEqual([]);
  });

  it("exposes Result but keeps Analysis and Data hidden, and maps conflicts to exit 4", async () => {
    const resultCommands: ResultImportCommandService = {
      importReport: (): Promise<never> => Promise.reject(new Error("EXECUTION_RESULT_CONFLICT"))
    };
    const help: string[] = [];
    await expect(
      runCli(["--help"], {
        packageCommands,
        restCommands,
        evaluationCommands,
        reportCommands,
        pipelineCommands,
        resultCommands,
        output: {
          stdout: (value): void => {
            help.push(value);
          },
          stderr: (): void => undefined
        }
      })
    ).resolves.toBe(0);
    expect(help.join("")).toMatch(/^\s{2}result\b/m);
    expect(help.join("")).not.toMatch(/^\s{2}(?:analyze|data)\b/m);

    const stdout: string[] = [];
    await expect(
      runCli(["--json", "result", "import", "/tmp/package", "--execution-id", ID], {
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
          stderr: (): void => undefined
        }
      })
    ).resolves.toBe(4);
    expect(JSON.parse(stdout.join("")) as unknown).toMatchObject({
      type: "COMMAND_ERROR",
      command: "result import",
      code: "EXECUTION_RESULT_CONFLICT",
      exitCode: 4
    });
  });
});
