import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import { describe, expect, it } from "vitest";

import {
  runCli,
  type CliOutput,
  type EvaluationCommandService,
  type PackageCommandService,
  type PipelineCommandService,
  type ReportCommandService,
  type RestCommandService,
  type RestRunCommandInput
} from "../src/cli-program.ts";
import { CliExecutionEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";

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

function packages(): PackageCommandService {
  return {
    exportPackage: (): Promise<ReceivedWorkPackage> => Promise.reject(new Error("TEST_UNUSED")),
    validatePackage: (): Promise<WorkPackageValidationSummary> =>
      Promise.reject(new Error("TEST_UNUSED"))
  };
}

function evaluations(): EvaluationCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")) };
}

function pipelines(): PipelineCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")) };
}

function reports(): ReportCommandService {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")) };
}

function analyses(): { readonly run: () => Promise<never> } {
  return { run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")) };
}

function results(): {
  readonly importReport: () => Promise<never>;
  readonly importAnalysis: () => Promise<never>;
} {
  return {
    importReport: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")),
    importAnalysis: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
  };
}

describe("P7 CLI REST command", () => {
  it("registers the closed REST capability and emits one strict completion event", async () => {
    let observed: RestRunCommandInput | null = null;
    const restCommands: RestCommandService = {
      run: (
        input
      ): Promise<{
        readonly packageId: string;
        readonly executionId: string;
        readonly restErrorCount: number;
        readonly resultSetHash: string;
        readonly artifactPath: string;
      }> => {
        observed = input;
        return Promise.resolve({
          packageId: ID,
          executionId: ID,
          restErrorCount: 1,
          resultSetHash: HASH,
          artifactPath: `executions/${ID}/rest-results.json`
        });
      }
    };
    const target = output();
    const exitCode = await runCli(
      [
        "--json",
        "rest",
        "run",
        "/tmp/package",
        "--env-file",
        "/tmp/secrets.env",
        "--rest-concurrency",
        "3",
        "--eval-concurrency",
        "2",
        "--analysis-concurrency",
        "1"
      ],
      {
        packageCommands: packages(),
        restCommands,
        evaluationCommands: evaluations(),
        reportCommands: reports(),
        analysisCommands: analyses(),
        pipelineCommands: pipelines(),
        resultCommands: results(),
        output: target.streams
      }
    );
    expect(exitCode).toBe(0);
    expect(observed).toMatchObject({
      packagePath: "/tmp/package",
      envFile: "/tmp/secrets.env",
      rerun: { mode: "NEW" },
      runLimitOverrides: { restConcurrency: 3, evalConcurrency: 2 },
      analysisLimitOverrides: { analysisConcurrency: 1 }
    });
    expect(
      CliExecutionEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)
    ).toMatchObject({
      type: "REST_COMPLETED",
      restErrorCount: 1
    });
    expect(target.stderr).toEqual([]);

    const help = output();
    await runCli(["--help"], {
      packageCommands: packages(),
      restCommands,
      evaluationCommands: evaluations(),
      reportCommands: reports(),
      analysisCommands: analyses(),
      pipelineCommands: pipelines(),
      resultCommands: results(),
      output: help.streams
    });
    expect(help.stdout.join("")).toMatch(/^\s{2}rest\b/m);
    expect(help.stdout.join("")).toMatch(/^\s{2}eval\b/m);
    expect(help.stdout.join("")).toMatch(/^\s{2}report\b/m);
    expect(help.stdout.join("")).toMatch(/^\s{2}result\b/m);
    expect(help.stdout.join("")).toMatch(/^\s{2}pipeline\b/m);
    expect(help.stdout.join("")).toMatch(/^\s{2}analyze\b/m);
    expect(help.stdout.join("")).not.toMatch(/^\s{2}data\b/m);
  });

  it("maps retry provenance and rejects retry/force ambiguity before invoking the service", async () => {
    const inputs: RestRunCommandInput[] = [];
    const restCommands: RestCommandService = {
      run: (input) => {
        inputs.push(input);
        return Promise.reject(new Error("WORK_PACKAGE_INVALID"));
      }
    };
    const retry = output();
    const retryCode = await runCli(
      ["--json", "rest", "run", "/tmp/package", "--retry-failed", ID],
      {
        packageCommands: packages(),
        restCommands,
        evaluationCommands: evaluations(),
        reportCommands: reports(),
        analysisCommands: analyses(),
        pipelineCommands: pipelines(),
        resultCommands: results(),
        output: retry.streams
      }
    );
    expect(retryCode).toBe(2);
    expect(inputs[0]?.rerun).toEqual({ mode: "RETRY_FAILED", sourceExecutionId: ID });
    expect(
      CliExecutionEventV1Schema.parse(JSON.parse(retry.stdout.join("")) as unknown)
    ).toMatchObject({
      type: "COMMAND_ERROR",
      command: "rest run",
      code: "WORK_PACKAGE_INVALID"
    });

    const ambiguous = output();
    const ambiguousCode = await runCli(
      ["rest", "run", "/tmp/package", "--retry-failed", ID, "--force", ID],
      {
        packageCommands: packages(),
        restCommands,
        evaluationCommands: evaluations(),
        reportCommands: reports(),
        analysisCommands: analyses(),
        pipelineCommands: pipelines(),
        resultCommands: results(),
        output: ambiguous.streams
      }
    );
    expect(ambiguousCode).toBe(2);
    expect(inputs).toHaveLength(1);
  });

  it("emits ordinary Force output and rejects malformed limits before execution", async () => {
    const inputs: RestRunCommandInput[] = [];
    const restCommands: RestCommandService = {
      run: (input) => {
        inputs.push(input);
        return Promise.resolve({
          packageId: ID,
          executionId: ID,
          restErrorCount: 0,
          resultSetHash: HASH,
          artifactPath: `executions/${ID}/rest-results.json`
        });
      }
    };
    const ordinary = output();
    await expect(
      runCli(["rest", "run", "/tmp/package", "--force", ID], {
        packageCommands: packages(),
        restCommands,
        evaluationCommands: evaluations(),
        reportCommands: reports(),
        analysisCommands: analyses(),
        pipelineCommands: pipelines(),
        resultCommands: results(),
        output: ordinary.streams
      })
    ).resolves.toBe(0);
    expect(inputs[0]?.rerun).toEqual({ mode: "FORCE", sourceExecutionId: ID });
    expect(ordinary.stdout.join("")).toContain(ID);

    for (const arguments_ of [
      ["rest", "run", "/tmp/package", "--retry-failed", "invalid"],
      ["rest", "run", "/tmp/package", "--force", "invalid"],
      ["rest", "run", "/tmp/package", "--env-file", ""],
      ["rest", "run", "/tmp/package", "--rest-concurrency", "0"],
      ["rest", "run", "/tmp/package", "--rest-concurrency", "65"],
      ["rest", "run", "/tmp/package", "--eval-concurrency", "9007199254740992"]
    ]) {
      await expect(
        runCli(arguments_, {
          packageCommands: packages(),
          restCommands,
          evaluationCommands: evaluations(),
          reportCommands: reports(),
          analysisCommands: analyses(),
          pipelineCommands: pipelines(),
          resultCommands: results(),
          output: output().streams
        })
      ).resolves.toBe(2);
    }
    await expect(
      runCli(["unknown-command"], {
        packageCommands: packages(),
        restCommands,
        evaluationCommands: evaluations(),
        reportCommands: reports(),
        analysisCommands: analyses(),
        pipelineCommands: pipelines(),
        resultCommands: results(),
        output: output().streams
      })
    ).resolves.toBe(2);
    expect(inputs).toHaveLength(1);
  });
});
