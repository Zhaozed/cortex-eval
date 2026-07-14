import { CliExecutionEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import { describe, expect, it } from "vitest";

import {
  runCli,
  type CliOutput,
  type EvaluationCommandService,
  type EvaluationRunCommandInput,
  type PackageCommandService,
  type PipelineCommandService,
  type RestCommandService
} from "../src/cli-program.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

function output(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly streams: CliOutput;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: (value): void => {
        stdout.push(value);
      },
      stderr: (value): void => {
        stderr.push(value);
      }
    }
  };
}

const packageCommands: PackageCommandService = {
  exportPackage: (): Promise<ReceivedWorkPackage> => Promise.reject(new Error("TEST_UNUSED")),
  validatePackage: (): Promise<WorkPackageValidationSummary> =>
    Promise.reject(new Error("TEST_UNUSED"))
};
const restCommands: RestCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};
const pipelineCommands: PipelineCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};

describe("P7 CLI Evaluation command", () => {
  it("runs one existing Execution and maps native Assertion failure to CLI exit 1", async () => {
    let observed: EvaluationRunCommandInput | null = null;
    const evaluationCommands: EvaluationCommandService = {
      run: (input) => {
        observed = input;
        return Promise.resolve({
          packageId: ID,
          executionId: ID,
          promptfooExitCode: 100,
          evalFailCount: 1,
          evalErrorCount: 0,
          resultSetHash: HASH,
          rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
          normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
        });
      }
    };
    const target = output();
    const exitCode = await runCli(
      [
        "--json",
        "eval",
        "run",
        "/tmp/package",
        "--execution-id",
        ID,
        "--env-file",
        "/tmp/secrets.env"
      ],
      {
        packageCommands,
        restCommands,
        evaluationCommands,
        pipelineCommands,
        output: target.streams
      }
    );
    expect(exitCode).toBe(1);
    expect(observed).toMatchObject({
      packagePath: "/tmp/package",
      executionId: ID,
      envFile: "/tmp/secrets.env"
    });
    expect(
      CliExecutionEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)
    ).toMatchObject({
      type: "EVALUATION_COMPLETED",
      promptfooExitCode: 100
    });
    expect(target.stderr).toEqual([]);
  });

  it("returns exit 1 for a reused normalized FAIL even when the new Promptfoo Raw is empty", async () => {
    const evaluationCommands: EvaluationCommandService = {
      run: () =>
        Promise.resolve({
          packageId: ID,
          executionId: ID,
          promptfooExitCode: 0,
          evalFailCount: 1,
          evalErrorCount: 0,
          resultSetHash: HASH,
          rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
          normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
        })
    };
    const target = output();
    await expect(
      runCli(["eval", "run", "/tmp/package", "--execution-id", ID], {
        packageCommands,
        restCommands,
        evaluationCommands,
        pipelineCommands,
        output: target.streams
      })
    ).resolves.toBe(1);
  });
});
