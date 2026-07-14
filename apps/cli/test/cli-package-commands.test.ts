import { describe, expect, it } from "vitest";

import { CliPackageEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";

import {
  runCli,
  type CliOutput,
  type EvaluationCommandService,
  type PackageCommandService,
  type PipelineCommandService,
  type RestCommandService
} from "../src/cli-program.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);
const requestArguments = [
  "--suite-id",
  ID,
  "--endpoint-config-id",
  "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1",
  "--evaluator-config-id",
  "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2",
  "--analyzer-config-id",
  "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3",
  "--analysis-prompt-id",
  "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4",
  "--output",
  "/tmp/package"
] as const;

function output(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly streams: CliOutput;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const streams: CliOutput = {
    stdout: (value): void => {
      stdout.push(value);
    },
    stderr: (value): void => {
      stderr.push(value);
    }
  };
  return { stdout, stderr, streams };
}

function service(errorCode?: string): PackageCommandService {
  return {
    exportPackage: (): Promise<ReceivedWorkPackage> => {
      if (errorCode !== undefined) return Promise.reject(new Error(errorCode));
      return Promise.resolve({
        packageId: ID,
        manifestSha256: HASH,
        targetPath: "/tmp/package"
      });
    },
    validatePackage: (): Promise<WorkPackageValidationSummary> => {
      if (errorCode !== undefined) return Promise.reject(new Error(errorCode));
      return Promise.resolve({ packageId: ID, manifestSha256: HASH, executionCount: 2 });
    }
  };
}

function unusedRestService(): RestCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED_REST_COMMAND")) };
}

function unusedEvaluationService(): EvaluationCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED_EVAL_COMMAND")) };
}

function unusedPipelineService(): PipelineCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED_PIPELINE_COMMAND")) };
}

describe("P7 CLI package commands", () => {
  it("exposes only closed package, REST, Evaluation and Pipeline capabilities in Help", async () => {
    const target = output();
    const exitCode = await runCli(["--help"], {
      packageCommands: service(),
      restCommands: unusedRestService(),
      evaluationCommands: unusedEvaluationService(),
      pipelineCommands: unusedPipelineService(),
      output: target.streams
    });
    expect(exitCode).toBe(0);
    const help = target.stdout.join("");
    expect(help).toContain("package");
    expect(help).toMatch(/^\s{2}rest\b/m);
    expect(help).toMatch(/^\s{2}eval\b/m);
    expect(help).toMatch(/^\s{2}pipeline\b/m);
    expect(help).not.toMatch(/^\s{2}(?:report|analyze|result|data)\b/m);
  });

  it("exports through the package service and emits one strict NDJSON event", async () => {
    const target = output();
    const exitCode = await runCli(["--json", "package", "export", ...requestArguments], {
      packageCommands: service(),
      restCommands: unusedRestService(),
      evaluationCommands: unusedEvaluationService(),
      pipelineCommands: unusedPipelineService(),
      output: target.streams
    });
    expect(exitCode).toBe(0);
    expect(target.stderr).toEqual([]);
    const lines = target.stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(CliPackageEventV1Schema.parse(JSON.parse(lines[0] ?? "null") as unknown)).toMatchObject({
      type: "PACKAGE_EXPORTED",
      packageId: ID,
      targetPath: "/tmp/package"
    });
  });

  it("validates locally and keeps ordinary output in Chinese", async () => {
    const target = output();
    const exitCode = await runCli(["package", "validate", "/tmp/package"], {
      packageCommands: service(),
      restCommands: unusedRestService(),
      evaluationCommands: unusedEvaluationService(),
      pipelineCommands: unusedPipelineService(),
      output: target.streams
    });
    expect(exitCode).toBe(0);
    expect(target.stdout.join("")).toContain("工作包校验通过");
    expect(target.stderr).toEqual([]);
  });

  it("maps validation, lock, external and cancellation failures to stable exit codes", async () => {
    const cases = [
      ["WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_LOCKED", 4],
      ["EXECUTION_RESULT_CONFLICT", 4],
      ["ARTIFACT_ALREADY_COMMITTED", 4],
      ["EXPORT_REVISION_CONFLICT", 4],
      ["RUN_STATE_CONFLICT", 4],
      ["PROVIDER_REQUEST_FAILED", 3],
      ["PROMPTFOO_PROCESS_ERROR", 3],
      ["EVALUATION_STAGE_FAILED", 3],
      ["ARTIFACT_WRITE_FAILED", 3],
      ["INTERNAL_ERROR", 3],
      ["REQUEST_ABORTED", 130],
      ["REST_CANCELLED", 130],
      ["EVALUATOR_CANCELLED", 130]
    ] as const;
    for (const [errorCode, expectedExitCode] of cases) {
      const target = output();
      const exitCode = await runCli(["--json", "package", "validate", "/tmp/package"], {
        packageCommands: service(errorCode),
        restCommands: unusedRestService(),
        evaluationCommands: unusedEvaluationService(),
        pipelineCommands: unusedPipelineService(),
        output: target.streams
      });
      expect(exitCode).toBe(expectedExitCode);
      expect(target.stderr.join("")).not.toContain(errorCode);
      const event = CliPackageEventV1Schema.parse(
        JSON.parse(target.stdout.join("").trim()) as unknown
      );
      expect(event).toMatchObject({
        type: "COMMAND_ERROR",
        code: errorCode,
        exitCode: expectedExitCode
      });
    }
  });

  it("emits one strict execution error when a known JSON command fails argument parsing", async () => {
    const target = output();
    const exitCode = await runCli(["--json", "eval", "run"], {
      packageCommands: service(),
      restCommands: unusedRestService(),
      evaluationCommands: unusedEvaluationService(),
      pipelineCommands: unusedPipelineService(),
      output: target.streams
    });

    expect(exitCode).toBe(2);
    expect(target.stderr).toHaveLength(1);
    expect(JSON.parse(target.stdout.join("")) as unknown).toEqual({
      contractVersion: "cortex.cli-execution-event.v1",
      type: "COMMAND_ERROR",
      command: "eval run",
      code: "VALIDATION_FAILED",
      exitCode: 2
    });
  });

  it("maps private Work Package validation failures to stable public input errors", async () => {
    const cases = [
      ["WORK_PACKAGE_UNKNOWN_FILE", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_ARTIFACT_ORPHAN", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_INPUT_TOO_LARGE", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_LAYOUT_INVALID", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_FILE_TOO_LARGE", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_FILE_CHANGED", "WORK_PACKAGE_HASH_MISMATCH", 2],
      ["WORK_PACKAGE_PATH_COLLISION", "WORK_PACKAGE_PATH_INVALID", 2],
      ["WORK_PACKAGE_TARGET_INVALID", "WORK_PACKAGE_PATH_INVALID", 2],
      ["WORK_PACKAGE_FILE_INVALID", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_LOCK_INVALID", "WORK_PACKAGE_INVALID", 2],
      ["WORK_PACKAGE_TARGET_EXISTS", "EXPORT_REVISION_CONFLICT", 4],
      ["WORK_PACKAGE_STAGING_EXISTS", "EXPORT_REVISION_CONFLICT", 4],
      ["EXPORT_EVENT_INVALID", "PROVIDER_REQUEST_FAILED", 3],
      ["EXPORT_STREAM_TRUNCATED", "PROVIDER_REQUEST_FAILED", 3],
      ["EXPORT_LINE_TOO_LARGE", "PROVIDER_REQUEST_FAILED", 3],
      ["EXPORT_UTF8_INVALID", "PROVIDER_REQUEST_FAILED", 3],
      ["TEMP_CONTAINMENT_REJECTED", "WORK_PACKAGE_PATH_INVALID", 2],
      ["ARTIFACT_EXPECTATION_INVALID", "INTERNAL_ERROR", 3],
      ["WORK_PACKAGE_NATIVE_UNSUPPORTED", "INTERNAL_ERROR", 3],
      ["WORK_PACKAGE_RECOVERY_POLICY_INVALID", "INTERNAL_ERROR", 3]
    ] as const;
    for (const [privateCode, publicCode, expectedExitCode] of cases) {
      const target = output();
      const result = await runCli(["--json", "package", "validate", "/tmp/package"], {
        packageCommands: service(privateCode),
        restCommands: unusedRestService(),
        evaluationCommands: unusedEvaluationService(),
        pipelineCommands: unusedPipelineService(),
        output: target.streams
      });
      expect(result).toBe(expectedExitCode);
      expect(JSON.parse(target.stdout.join("")) as unknown).toMatchObject({
        type: "COMMAND_ERROR",
        code: publicCode,
        exitCode: expectedExitCode
      });
      expect(target.stdout.join("")).not.toContain(privateCode);
      expect(target.stderr.join("")).not.toContain(privateCode);
    }
  });

  it("propagates a process cancellation signal to the active command", async () => {
    const target = output();
    const controller = new AbortController();
    const waiting: PackageCommandService = {
      exportPackage: (_request, _path, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("REQUEST_ABORTED")), {
            once: true
          });
        }),
      validatePackage: service().validatePackage
    };
    const running = runCli(["--json", "package", "export", ...requestArguments], {
      packageCommands: waiting,
      restCommands: unusedRestService(),
      evaluationCommands: unusedEvaluationService(),
      pipelineCommands: unusedPipelineService(),
      output: target.streams,
      signal: controller.signal
    });
    controller.abort();
    await expect(running).resolves.toBe(130);
  });
});
