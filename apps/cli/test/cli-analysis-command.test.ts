import { CliExecutionEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import { describe, expect, it, vi } from "vitest";

import {
  runCli,
  type AnalysisCommandService,
  type CliDependencies,
  type CliOutput
} from "../src/cli-program.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

function output(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly port: CliOutput;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    port: {
      stdout: (value): void => {
        stdout.push(value);
      },
      stderr: (value): void => {
        stderr.push(value);
      }
    }
  };
}

function dependencies(
  analysisCommands: AnalysisCommandService,
  streams: CliOutput
): CliDependencies {
  const unused = (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"));
  return {
    packageCommands: { exportPackage: unused, validatePackage: unused },
    restCommands: { run: unused },
    evaluationCommands: { run: unused },
    reportCommands: { run: unused },
    analysisCommands,
    pipelineCommands: { run: unused },
    resultCommands: { importReport: unused, importAnalysis: unused },
    output: streams
  };
}

describe("analyze run CLI", () => {
  it("清洗 Execution、Selector 与 Env File，并输出严格机器事件", async () => {
    const run = vi.fn<AnalysisCommandService["run"]>().mockResolvedValue({
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      selector: "failed",
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0,
      finalCaseResultSetHash: HASH,
      analysisResultSetHash: HASH,
      artifactPath: `executions/${EXECUTION_ID}/analysis-results.json`
    });
    const target = output();
    const exitCode = await runCli(
      [
        "--json",
        "analyze",
        "run",
        "/tmp/package",
        "--execution-id",
        EXECUTION_ID,
        "--selector",
        "failed",
        "--env-file",
        "/tmp/owner.env"
      ],
      dependencies({ run }, target.port)
    );
    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        packagePath: "/tmp/package",
        executionId: EXECUTION_ID,
        selector: "failed",
        envFile: "/tmp/owner.env"
      })
    );
    expect(CliExecutionEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)).toEqual({
      contractVersion: "cortex.cli-execution-event.v1",
      type: "ANALYSIS_COMPLETED",
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      selector: "failed",
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0,
      finalCaseResultSetHash: HASH,
      analysisResultSetHash: HASH,
      artifactPath: `executions/${EXECUTION_ID}/analysis-results.json`
    });
  });

  it("拒绝缺失或未知 Selector，并把阶段失败映射到退出码 3", async () => {
    const target = output();
    const unused = vi.fn<AnalysisCommandService["run"]>();
    await expect(
      runCli(
        ["analyze", "run", "/tmp/package", "--execution-id", EXECUTION_ID],
        dependencies({ run: unused }, target.port)
      )
    ).resolves.toBe(2);
    expect(unused).not.toHaveBeenCalled();

    const failed = output();
    const exitCode = await runCli(
      [
        "--json",
        "analyze",
        "run",
        "/tmp/package",
        "--execution-id",
        EXECUTION_ID,
        "--selector",
        "all"
      ],
      dependencies(
        { run: (): Promise<never> => Promise.reject(new Error("ANALYSIS_STAGE_FAILED")) },
        failed.port
      )
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(failed.stdout.join("")) as unknown).toMatchObject({
      type: "COMMAND_ERROR",
      command: "analyze run",
      code: "ANALYSIS_STAGE_FAILED",
      exitCode: 3
    });
  });
});
