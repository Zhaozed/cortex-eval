import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashExecutionContext,
  hashFinalCaseResult,
  hashRestResult,
  OrderedEvalResultSetHasher,
  OrderedRestResultSetHasher
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";
import { materializeWorkPackageFixture } from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalPipelineCommandService,
  type PreparedEvaluationStageCommand,
  type PreparedRestStageCommand
} from "../src/pipeline-command-service.ts";
import { LocalEvaluationCommandService } from "../src/evaluation-command-service.ts";
import { LocalRestCommandService } from "../src/rest-command-service.ts";
import type { WorkPackageEvaluationRunResult } from "../src/work-package-evaluation-run-service.ts";
import type { WorkPackageRestRunResult } from "../src/work-package-rest-run-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const RETRY_EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const HASH = "a".repeat(64);
const NOW = "2026-07-14T07:00:00.000Z";
const roots: string[] = [];

const definition = {
  caseKey: "case-1",
  description: "fixture",
  threshold: 1,
  task: "reply",
  requestBody: { text: "hello" },
  metadata: {
    requestId: "req-1",
    taskId: "task-1",
    businessModule: "fixture",
    scenarioTag: "fixture"
  },
  assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
} as const;

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

const caseHasher = {
  hash: (input: WorkPackageCaseDefinitionHashInput): string =>
    hashCaseDefinition({
      contractVersion: input.contractVersion,
      caseKey: input.caseKey,
      definition: caseDefinitionJson(input.definition)
    })
};

const restHashing: WorkPackageRestSemanticHashing = {
  hashResult: (value): string =>
    hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: value.caseKey,
      caseDefinitionHash: value.caseDefinitionHash,
      result:
        value.status === "SUCCEEDED"
          ? {
              status: value.status,
              httpStatus: value.httpStatus,
              providerOutput: value.providerOutput
            }
          : { status: value.status, httpStatus: value.httpStatus, errorType: value.errorType }
    }),
  createResultSetHasher: (): OrderedRestResultSetHasher => new OrderedRestResultSetHasher()
};

const evalHashing: WorkPackageEvalSemanticHashing = {
  hashResult: (value): string =>
    hashEvalResult({
      contractVersion: "cortex.eval-result.v1",
      caseKey: value.caseKey,
      status: value.status,
      promptfooSuccess: value.promptfooSuccess,
      score: value.score,
      reason: value.reason,
      evaluationError: value.evaluationError,
      assertions: value.assertions,
      diffs: value.diffs,
      metrics: value.metrics
    }),
  hashFinalResult: (value): string =>
    hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: value.caseDefinitionHash,
      restResultHash: value.restResultHash,
      evalResultHash: value.evalResultHash
    }),
  createResultSetHasher: (expectedCaseKey): OrderedEvalResultSetHasher =>
    new OrderedEvalResultSetHasher(expectedCaseKey)
};

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-pipeline-command-"));
  roots.push(root);
  await materializeWorkPackageFixture(root, {
    baseDefinitionHash: caseHasher.hash({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition
    })
  });
  return root;
}

function restStage(onRun: () => void): PreparedRestStageCommand {
  return {
    runWithEnvironment: (input, environment): Promise<WorkPackageRestRunResult> => {
      onRun();
      expect(environment.readSecret("GEMINI_API_KEY")).toBe("pipeline-secret");
      return Promise.resolve({
        packageId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
        executionId: EXECUTION_ID,
        restErrorCount: 0,
        resultSetHash: HASH,
        artifactPath: `executions/${EXECUTION_ID}/rest-results.json`
      });
    }
  };
}

function evaluationStage(onRun: () => void): PreparedEvaluationStageCommand {
  return {
    preflightWithEnvironment: (): Promise<void> => Promise.resolve(),
    runWithEnvironment: (input, environment): Promise<WorkPackageEvaluationRunResult> => {
      onRun();
      expect(input.executionId).toBe(EXECUTION_ID);
      expect(environment.readSecret("GEMINI_API_KEY")).toBe("pipeline-secret");
      return Promise.resolve({
        packageId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
        executionId: EXECUTION_ID,
        promptfooExitCode: 100,
        evalFailCount: 1,
        evalErrorCount: 0,
        resultSetHash: "b".repeat(64),
        rawArtifactPath: `executions/${EXECUTION_ID}/promptfoo-raw.json`,
        normalizedArtifactPath: `executions/${EXECUTION_ID}/normalized-eval.json`
      });
    }
  };
}

function service(
  inherited: Readonly<Record<string, string | undefined>>,
  restCommands: PreparedRestStageCommand,
  evaluationCommands: PreparedEvaluationStageCommand
): LocalPipelineCommandService {
  let nonce = 0;
  return new LocalPipelineCommandService({
    contextHasher,
    nonce: (): string => `pipeline_nonce_${String(++nonce).padStart(2, "0")}`,
    now: (): string => NOW,
    processIdentity: {
      processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
    },
    inheritedEnvironment: (): Readonly<Record<string, string | undefined>> => inherited,
    restCommands,
    evaluationCommands
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 local REST to Evaluation Pipeline command service", () => {
  it("preflights all selected-stage Secrets before creating an Execution", async () => {
    const root = await packageRoot();
    let stageCalls = 0;
    const pipeline = service(
      {},
      restStage(() => {
        stageCalls += 1;
      }),
      evaluationStage(() => {
        stageCalls += 1;
      })
    );

    await expect(
      pipeline.run({
        packagePath: root,
        rerun: { mode: "NEW" },
        runLimitOverrides: {},
        analysisLimitOverrides: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(stageCalls).toBe(0);

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: NOW
      },
      contextHasher,
      nonce: (): string => "pipeline_verify_nonce"
    });
    try {
      expect(session.packageSummary.executionCount).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("preflights Evaluation runtimes before REST can create an Execution", async () => {
    const root = await packageRoot();
    let restCalls = 0;
    const evaluation = evaluationStage(() => undefined) as PreparedEvaluationStageCommand & {
      preflightWithEnvironment: () => Promise<void>;
    };
    evaluation.preflightWithEnvironment = (): Promise<void> =>
      Promise.reject(new Error("VALIDATION_FAILED"));
    const pipeline = service(
      { GEMINI_API_KEY: "pipeline-secret" },
      restStage(() => {
        restCalls += 1;
      }),
      evaluation
    );

    await expect(
      pipeline.run({
        packagePath: root,
        rerun: { mode: "NEW" },
        runLimitOverrides: {},
        analysisLimitOverrides: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(restCalls).toBe(0);

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: NOW
      },
      contextHasher,
      nonce: (): string => "pipeline_runtime_preflight_verify_nonce"
    });
    try {
      expect(session.packageSummary.executionCount).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("uses one Secret snapshot and passes the new REST Execution to Evaluation", async () => {
    const root = await packageRoot();
    const order: string[] = [];
    const pipeline = service(
      { GEMINI_API_KEY: "pipeline-secret" },
      restStage(() => order.push("REST")),
      evaluationStage(() => order.push("EVALUATION"))
    );

    await expect(
      pipeline.run({
        packagePath: root,
        rerun: { mode: "NEW" },
        runLimitOverrides: { restConcurrency: 3, evalConcurrency: 2 },
        analysisLimitOverrides: { analysisConcurrency: 1 },
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({
      packageId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
      executionId: EXECUTION_ID,
      restErrorCount: 0,
      restResultSetHash: HASH,
      promptfooExitCode: 100,
      evalFailCount: 1,
      evaluationResultSetHash: "b".repeat(64)
    });
    expect(order).toEqual(["REST", "EVALUATION"]);
  });

  it("completes the real REST adapter and fixed Promptfoo process on one Execution", async () => {
    const root = await packageRoot();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "cortex-pipeline-runtime-"));
    roots.push(runtimeRoot);
    let nonce = 0;
    const nextNonce = (): string => `pipeline_real_nonce_${String(++nonce).padStart(2, "0")}`;
    const processIdentity = {
      processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
    };
    const inheritedEnvironment = (): Readonly<Record<string, string>> => ({
      GEMINI_API_KEY: "test-only-not-forwarded"
    });
    const executionIds = [EXECUTION_ID, RETRY_EXECUTION_ID];
    const restCommands = new LocalRestCommandService({
      contextHasher,
      caseHasher,
      restHashing,
      nextId: (): string => {
        const executionId = executionIds.shift();
        if (executionId === undefined) throw new Error("TEST_EXECUTION_ID_EXHAUSTED");
        return executionId;
      },
      nonce: nextNonce,
      now: (): string => NOW,
      message: (code): string => code,
      processIdentity,
      inheritedEnvironment,
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
      fetch: (): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              task_name: "reply",
              resolved_config: {},
              parsed_output: { text: "hello" }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
    });
    const evaluationCommands = new LocalEvaluationCommandService({
      contextHasher,
      caseHasher,
      restHashing,
      evalHashing,
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: runtimeRoot,
      temporaryParent: join(runtimeRoot, "promptfoo"),
      promptfooTimeoutMs: 30_000,
      runtimePreflightTimeoutMs: 10_000,
      nextId: (): string => "018f22aa-33bb-7ccc-8ddd-fffffffffff3",
      nonce: nextNonce,
      now: (): string => NOW,
      processIdentity,
      inheritedEnvironment,
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
    });
    const pipeline = new LocalPipelineCommandService({
      contextHasher,
      nonce: nextNonce,
      now: (): string => NOW,
      processIdentity,
      inheritedEnvironment,
      restCommands,
      evaluationCommands
    });

    const result = await pipeline.run({
      packagePath: root,
      rerun: { mode: "NEW" },
      runLimitOverrides: { restConcurrency: 1, evalConcurrency: 1 },
      analysisLimitOverrides: {},
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      executionId: EXECUTION_ID,
      restErrorCount: 0,
      promptfooExitCode: 100,
      evalFailCount: 1,
      evalErrorCount: 0
    });
    const retry = await pipeline.run({
      packagePath: root,
      rerun: { mode: "RETRY_FAILED", sourceExecutionId: EXECUTION_ID },
      runLimitOverrides: {},
      analysisLimitOverrides: {},
      signal: new AbortController().signal
    });
    expect(retry).toMatchObject({
      executionId: RETRY_EXECUTION_ID,
      restErrorCount: 0,
      promptfooExitCode: 0,
      evalFailCount: 1,
      evalErrorCount: 0
    });
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: NOW
      },
      contextHasher,
      nonce: nextNonce
    });
    try {
      expect(session.readExecution(EXECUTION_ID)).toMatchObject({
        stages: {
          REST: { status: "SUCCEEDED" },
          EVALUATION: { status: "SUCCEEDED" },
          REPORT: { status: "PENDING" },
          ANALYSIS: { status: "PENDING" }
        }
      });
      expect(session.readExecution(RETRY_EXECUTION_ID)).toMatchObject({
        rerun: { mode: "RETRY_FAILED", sourceExecutionId: EXECUTION_ID },
        stages: {
          REST: { status: "SUCCEEDED" },
          EVALUATION: { status: "SUCCEEDED" },
          REPORT: { status: "PENDING" },
          ANALYSIS: { status: "PENDING" }
        }
      });
    } finally {
      await session.close();
    }
  });
});
