import { CliExecutionEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import { describe, expect, it } from "vitest";

import {
  runCli,
  type CliOutput,
  type EvaluationCommandService,
  type PackageCommandService,
  type PipelineCommandService,
  type PipelineRunCommandInput,
  type RestCommandService
} from "../src/cli-program.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const SOURCE_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
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
const evaluationCommands: EvaluationCommandService = {
  run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
};

describe("P7 CLI REST to Evaluation Pipeline", () => {
  it("creates one retry Execution, emits one strict completion event and preserves Eval exit 1", async () => {
    let observed: PipelineRunCommandInput | null = null;
    const pipelineCommands: PipelineCommandService = {
      run: (input) => {
        observed = input;
        return Promise.resolve({
          packageId: ID,
          executionId: ID,
          restErrorCount: 0,
          restResultSetHash: HASH,
          restArtifactPath: `executions/${ID}/rest-results.json`,
          promptfooExitCode: 0,
          evalFailCount: 1,
          evalErrorCount: 0,
          evaluationResultSetHash: "b".repeat(64),
          rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
          normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
        });
      }
    };
    const target = output();
    const exitCode = await runCli(
      [
        "--json",
        "pipeline",
        "run",
        "/tmp/package",
        "--env-file",
        "/tmp/secrets.env",
        "--retry-failed",
        SOURCE_ID,
        "--rest-concurrency",
        "3",
        "--eval-concurrency",
        "2"
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
      envFile: "/tmp/secrets.env",
      rerun: { mode: "RETRY_FAILED", sourceExecutionId: SOURCE_ID },
      runLimitOverrides: { restConcurrency: 3, evalConcurrency: 2 }
    });
    expect(
      CliExecutionEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)
    ).toMatchObject({
      type: "PIPELINE_COMPLETED",
      executionId: ID,
      promptfooExitCode: 0,
      evalFailCount: 1
    });
    expect(target.stderr).toEqual([]);
  });

  it("emits the ordinary completed Pipeline summary", async () => {
    const pipelineCommands: PipelineCommandService = {
      run: () =>
        Promise.resolve({
          packageId: ID,
          executionId: ID,
          restErrorCount: 0,
          restResultSetHash: HASH,
          restArtifactPath: `executions/${ID}/rest-results.json`,
          promptfooExitCode: 0,
          evalFailCount: 0,
          evalErrorCount: 0,
          evaluationResultSetHash: HASH,
          rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
          normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
        })
    };
    const target = output();
    await expect(
      runCli(["pipeline", "run", "/tmp/package"], {
        packageCommands,
        restCommands,
        evaluationCommands,
        pipelineCommands,
        output: target.streams
      })
    ).resolves.toBe(0);
    expect(target.stdout.join("")).toContain(ID);
  });
});
