import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  FrozenEvaluationEngine,
  FrozenEvaluationEngineResult
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type { ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import type { ExecutionV2 } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashEvalResultSet,
  hashExecutionContext,
  hashFinalCaseResult,
  hashRestResult,
  hashRestResultSet,
  OrderedEvalResultSetHasher,
  OrderedRestResultSetHasher
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import { WorkPackageRestArtifactWriter } from "@cortex-eval/work-package/src/work-package-rest-artifact-writer.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import { LocalEvaluationCommandService } from "../src/evaluation-command-service.ts";
import { runCli } from "../src/cli-program.ts";
import {
  WorkPackageEvaluationRunService,
  type WorkPackageEvaluationRunServiceDependencies
} from "../src/work-package-evaluation-run-service.ts";
import { WorkPackageEvaluationStagingStore } from "../src/work-package-evaluation-staging-store.ts";
import {
  evaluationFixtureDefinition as fixtureDefinition,
  fakeEngineCaseSource,
  waitForFile
} from "../test-support/evaluation-run-test-support.ts";
import { readNormalizedEvalJsonlForTest } from "../test-support/normalized-eval-jsonl-test-reader.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const CREATED_AT = "2026-07-14T07:00:00.000Z";
const REST_COMPLETED_AT = "2026-07-14T07:01:00.000Z";
const EVAL_COMPLETED_AT = "2026-07-14T07:03:00.000Z";
const EVALUATION_CONTEXT_HASH = "f".repeat(64);
const roots: string[] = [];

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
              status: "SUCCEEDED",
              httpStatus: value.httpStatus,
              providerOutput: value.providerOutput
            }
          : { status: "ERROR", httpStatus: value.httpStatus, errorType: value.errorType }
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

async function preparedPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-evaluation-run-"));
  roots.push(root);
  const caseDefinitionHash = caseHasher.hash({
    contractVersion: "cortex.case-definition.v1",
    caseKey: fixtureDefinition.caseKey,
    definition: fixtureDefinition
  });
  await materializeWorkPackageFixture(root, { baseDefinitionHash: caseDefinitionHash });
  let nonce = 0;
  const session = await openWorkPackageExecutionSession({
    rootPath: root,
    owner: {
      pid: process.pid,
      processStartedAt: "Tue Jul 14 15:00:00 2026",
      executionId: EXECUTION_ID,
      acquiredAt: CREATED_AT
    },
    contextHasher,
    nonce: (): string => `eval_prepare_nonce_${String(++nonce).padStart(2, "0")}`
  });
  try {
    await session.createExecution({
      executionId: EXECUTION_ID,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await session.startStage(EXECUTION_ID, "REST", CREATED_AT);
    const result: OfflineRestCaseResult = {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: {
        ok: true,
        taskName: "reply",
        resolvedConfig: {},
        parsedOutput: { text: "hello" }
      },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: REST_COMPLETED_AT,
      resultHash: "",
      provenance: null
    };
    const resultHash = restHashing.hashResult(result);
    const completeResult = { ...result, resultHash };
    const resultSetHash = hashRestResultSet({
      contractVersion: "cortex.rest-result-set.v1",
      cases: [{ caseKey: "case-1", ordinal: 0, resultHash }]
    });
    const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
    await writer.append(completeResult);
    const artifact = await writer.commit(REST_COMPLETED_AT, resultSetHash);
    await session.completeStage(EXECUTION_ID, "REST", REST_COMPLETED_AT, [artifact]);
  } finally {
    await session.close();
  }
  return root;
}

function fakeEngine(): FrozenEvaluationEngine {
  return {
    execute: async (input): Promise<FrozenEvaluationEngineResult> => {
      const joined: unknown[] = [];
      for await (const item of input.caseSource.open()) joined.push(item);
      expect(input).toMatchObject({ binding: { kind: "EXECUTION", id: EXECUTION_ID } });
      expect(joined).toMatchObject([
        {
          testCase: { caseKey: "case-1", ordinal: 0 },
          restResult: { caseKey: "case-1", status: "SUCCEEDED" }
        }
      ]);
      return {
        promptfooVersion: "0.121.18",
        exitCode: 100,
        durationMs: 12,
        raw: {
          results: {
            version: 3,
            results: [
              {
                metadata: { case_id: "case-1" },
                response: {
                  output: {
                    ok: true,
                    taskName: "reply",
                    resolvedConfig: {},
                    parsedOutput: { text: "hello" }
                  }
                },
                success: false,
                score: 0,
                latencyMs: 1,
                cost: 0,
                gradingResult: {
                  pass: false,
                  score: 0,
                  reason: "not equal",
                  componentResults: [
                    {
                      pass: false,
                      score: 0,
                      reason: "not equal",
                      assertion: {
                        type: "equals",
                        metric: "exact",
                        weight: 1,
                        value: "hello"
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
        rubricPromptMaterializations: {},
        evaluationContextHash: EVALUATION_CONTEXT_HASH
      };
    }
  };
}

function evaluationServiceDependencies(
  engine: FrozenEvaluationEngine
): WorkPackageEvaluationRunServiceDependencies {
  let nonce = 0;
  return {
    contextHasher,
    caseHasher,
    restHashing,
    evalHashing,
    engine,
    runtimePreflight: {
      check: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
    },
    environment: { require: (): void => undefined },
    processIdentity: {
      processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
    },
    nonce: (): string => `eval_run_nonce_${String(++nonce).padStart(2, "0")}`,
    now: (): string => EVAL_COMPLETED_AT,
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
    stagingFactory: {
      create: (): Promise<WorkPackageEvaluationStagingStore> =>
        WorkPackageEvaluationStagingStore.create(tmpdir(), join(tmpdir(), "cortex-eval-stage"))
    }
  };
}

function evaluationService(engine: FrozenEvaluationEngine): WorkPackageEvaluationRunService {
  return new WorkPackageEvaluationRunService(evaluationServiceDependencies(engine));
}

async function readExecution(root: string, executionId: string): Promise<ExecutionV2> {
  const session = await openWorkPackageExecutionSession({
    rootPath: root,
    owner: {
      pid: process.pid,
      processStartedAt: "Tue Jul 14 15:00:00 2026",
      executionId: null,
      acquiredAt: EVAL_COMPLETED_AT
    },
    contextHasher,
    nonce: (): string => "eval_run_read_execution_nonce"
  });
  try {
    const execution = session.readExecution(executionId);
    if (execution === null) throw new Error("Expected the fixture Execution to exist");
    return execution;
  } finally {
    await session.close();
  }
}

async function expectEvaluationError(root: string, errorCode: ErrorCode): Promise<void> {
  expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
    stages: { EVALUATION: { status: "ERROR", errorCode, artifacts: [] } }
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("P7 Work Package Evaluation run service", () => {
  it("preflight validates the complete frozen Evaluation inputs before any stage exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-evaluation-preflight-inputs-"));
    roots.push(root);
    const invalidEvaluator = Buffer.from("{}\n", "utf8");
    const evaluatorHash = createHash("sha256").update(invalidEvaluator).digest("hex");
    const manifest = await materializeWorkPackageFixture(root, {
      baseDefinitionHash: caseHasher.hash({
        contractVersion: "cortex.case-definition.v1",
        caseKey: fixtureDefinition.caseKey,
        definition: fixtureDefinition
      })
    });
    await writeFile(join(root, manifest.inputs.evaluator.path), invalidEvaluator);
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify({
        ...manifest,
        inputs: {
          ...manifest.inputs,
          evaluator: {
            ...manifest.inputs.evaluator,
            sha256: evaluatorHash,
            sizeBytes: invalidEvaluator.byteLength
          }
        },
        configurationHashes: {
          ...manifest.configurationHashes,
          evaluator: evaluatorHash
        }
      })}\n`
    );

    await expect(
      evaluationService(fakeEngine()).preflight({
        packagePath: root,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("reads the frozen REST version and atomically completes Raw plus Normalized Eval", async () => {
    const root = await preparedPackage();
    const service = evaluationService(fakeEngine());
    const result = await service.run({
      packagePath: root,
      executionId: EXECUTION_ID,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({
      packageId: WORK_PACKAGE_FIXTURE_ID,
      executionId: EXECUTION_ID,
      promptfooExitCode: 100,
      evalFailCount: 1,
      evalErrorCount: 0,
      rawArtifactPath: `executions/${EXECUTION_ID}/promptfoo-raw.json`,
      normalizedArtifactPath: `executions/${EXECUTION_ID}/normalized-eval.jsonl`
    });
    const normalized = await readNormalizedEvalJsonlForTest(
      join(root, `executions/${EXECUTION_ID}/normalized-eval.jsonl`)
    );
    expect(normalized).toMatchObject({
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      cases: [{ caseKey: "case-1", status: "FAIL" }]
    });
  });

  it("retry-failed skips Promptfoo rows for Raw-backed aligned Eval facts", async () => {
    const root = await preparedPackage();
    await evaluationService(fakeEngine()).run({
      packagePath: root,
      executionId: EXECUTION_ID,
      signal: new AbortController().signal
    });
    const targetExecutionId = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
    const caseDefinitionHash = caseHasher.hash({
      contractVersion: "cortex.case-definition.v1",
      caseKey: fixtureDefinition.caseKey,
      definition: fixtureDefinition
    });
    const partial: OfflineRestCaseResult = {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: {
        ok: true,
        taskName: "reply",
        resolvedConfig: {},
        parsedOutput: { text: "hello" }
      },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: REST_COMPLETED_AT,
      resultHash: "",
      provenance: null
    };
    const sourceResultHash = restHashing.hashResult(partial);
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: targetExecutionId,
        acquiredAt: EVAL_COMPLETED_AT
      },
      contextHasher,
      nonce: (): string => `eval_retry_service_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: targetExecutionId,
        createdAt: EVAL_COMPLETED_AT,
        rerun: { mode: "RETRY_FAILED", sourceExecutionId: EXECUTION_ID }
      });
      await session.startStage(targetExecutionId, "REST", EVAL_COMPLETED_AT);
      const writer = await WorkPackageRestArtifactWriter.create(session, targetExecutionId);
      await writer.append({
        ...partial,
        resultHash: sourceResultHash,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: EXECUTION_ID,
          sourceResultHash
        }
      });
      const resultSetHash = hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [{ caseKey: "case-1", ordinal: 0, resultHash: sourceResultHash }]
      });
      const artifact = await writer.commit(EVAL_COMPLETED_AT, resultSetHash);
      await session.completeStage(targetExecutionId, "REST", EVAL_COMPLETED_AT, [artifact]);
    } finally {
      await session.close();
    }

    const targetContextHash = "e".repeat(64);
    const engine: FrozenEvaluationEngine = {
      execute: async (input): Promise<FrozenEvaluationEngineResult> => {
        const pending: unknown[] = [];
        for await (const item of input.caseSource.open()) pending.push(item);
        expect(pending).toEqual([]);
        return {
          promptfooVersion: "0.121.18",
          exitCode: 0,
          durationMs: 0,
          raw: { results: { version: 3, results: [] } },
          rubricPromptMaterializations: {},
          evaluationContextHash: targetContextHash
        };
      }
    };
    const result = await evaluationService(engine).run({
      packagePath: root,
      executionId: targetExecutionId,
      signal: new AbortController().signal
    });
    const normalized = await readNormalizedEvalJsonlForTest(
      join(root, `executions/${targetExecutionId}/normalized-eval.jsonl`)
    );
    expect(normalized).toMatchObject({
      evaluationContextHash: targetContextHash,
      cases: [
        {
          caseKey: "case-1",
          status: "FAIL",
          provenance: { sourceId: EXECUTION_ID }
        }
      ]
    });
    const reused = normalized.cases[0];
    if (reused === undefined) throw new Error("TEST_REUSED_EVAL_MISSING");
    expect(result.resultSetHash).toBe(
      hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        owner: { kind: "EXECUTION", id: targetExecutionId },
        evaluationContextHash: targetContextHash,
        cases: [
          {
            caseKey: reused.caseKey,
            ordinal: reused.ordinal,
            evalResultHash: reused.evalResultHash
          }
        ]
      })
    );

    const verificationSession = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: EVAL_COMPLETED_AT
      },
      contextHasher,
      nonce: (): string => "eval_retry_verification_nonce"
    });
    try {
      const prepared = await verificationSession.prepareEvaluationResults(
        targetExecutionId,
        restHashing,
        evalHashing,
        new AbortController().signal
      );
      const verified: unknown[] = [];
      for await (const item of prepared.results) verified.push(item);
      expect(verified).toMatchObject([
        {
          caseKey: "case-1",
          status: "FAIL",
          rawEvidence: { path: `executions/${EXECUTION_ID}/promptfoo-raw.json` },
          provenance: {
            sourceKind: "EXECUTION",
            sourceId: EXECUTION_ID,
            sourceResultHash: reused.evalResultHash
          }
        }
      ]);
    } finally {
      await verificationSession.close();
    }
  });

  it("keeps Evaluation PENDING when required Secrets are missing", async () => {
    const root = await preparedPackage();
    const service = new WorkPackageEvaluationRunService({
      ...evaluationServiceDependencies(fakeEngine()),
      environment: {
        require: (): never => {
          throw new Error("VALIDATION_FAILED");
        }
      }
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
      stages: { EVALUATION: { status: "PENDING", artifacts: [] } }
    });
  });

  it("keeps Evaluation PENDING when an Assertion runtime preflight fails", async () => {
    const root = await preparedPackage();
    const service = new WorkPackageEvaluationRunService({
      ...evaluationServiceDependencies(fakeEngine()),
      runtimePreflight: {
        check: (): Promise<{ readonly ok: false; readonly path: "runtime.python" }> =>
          Promise.resolve({ ok: false, path: "runtime.python" })
      }
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
      stages: { EVALUATION: { status: "PENDING", artifacts: [] } }
    });
  });

  it("keeps Evaluation PENDING when cancellation arrives during runtime preflight", async () => {
    const root = await preparedPackage();
    const controller = new AbortController();
    let engineCalls = 0;
    const service = new WorkPackageEvaluationRunService({
      ...evaluationServiceDependencies({
        execute: (): Promise<never> => {
          engineCalls += 1;
          return Promise.reject(new Error("TEST_ENGINE_MUST_NOT_START"));
        }
      }),
      runtimePreflight: {
        check: (_cases, signal): Promise<{ readonly ok: true }> => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          return Promise.resolve({ ok: true });
        }
      }
    });

    await expect(
      service.run({ packagePath: root, executionId: EXECUTION_ID, signal: controller.signal })
    ).rejects.toThrow("REQUEST_ABORTED");
    expect(engineCalls).toBe(0);
    expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
      stages: { EVALUATION: { status: "PENDING", artifacts: [] } }
    });
  });

  it("preserves a committed success when Raw, staging, and cleanup reporting fail", async () => {
    const root = await preparedPackage();
    const raw = fakeEngine();
    const result = await raw.execute({
      binding: { kind: "EXECUTION", id: EXECUTION_ID },
      ...fakeEngineCaseSource()
    } as never);
    if (typeof result.raw !== "object" || "kind" in result.raw) {
      throw new Error("TEST_RAW_OBJECT_MISSING");
    }
    const encoded = Buffer.from(JSON.stringify(result.raw), "utf8");
    const rawResults = result.raw.results;
    if (
      rawResults === null ||
      typeof rawResults !== "object" ||
      Array.isArray(rawResults) ||
      !Array.isArray(rawResults.results)
    ) {
      throw new Error("TEST_RAW_ROWS_MISSING");
    }
    const rows = rawResults.results;
    const cleanupFailures: string[] = [];
    const dependencies = evaluationServiceDependencies({
      execute: (): Promise<FrozenEvaluationEngineResult> =>
        Promise.resolve({
          ...result,
          raw: {
            kind: "PROMPTFOO_RAW_SOURCE",
            openBytes: async function* () {
              yield await Promise.resolve(encoded);
            },
            openRows: async function* () {
              for (const row of rows) yield await Promise.resolve(row);
            },
            dispose: (): Promise<never> => Promise.reject(new Error("TEST_RAW_CLEANUP_FAILED"))
          }
        })
    });
    const createStaging = dependencies.stagingFactory.create;
    const service = new WorkPackageEvaluationRunService({
      ...dependencies,
      stagingFactory: {
        create: async (): Promise<WorkPackageEvaluationStagingStore> => {
          const staging = await createStaging();
          const dispose = staging.dispose.bind(staging);
          Object.defineProperty(staging, "dispose", {
            value: async (): Promise<never> => {
              await dispose();
              throw new Error("TEST_STAGING_CLEANUP_FAILED");
            }
          });
          return staging;
        }
      },
      cleanupFailureSink: {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.executionId);
          return Promise.reject(new Error("TEST_CLEANUP_SINK_FAILED"));
        }
      }
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ executionId: EXECUTION_ID });
    expect(cleanupFailures).toEqual([EXECUTION_ID, EXECUTION_ID]);
    expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
      stages: { EVALUATION: { status: "SUCCEEDED" } }
    });
  });

  it("preserves the primary Evaluation failure when Raw Source cleanup also fails", async () => {
    const root = await preparedPackage();
    const base = await fakeEngine().execute({
      binding: { kind: "EXECUTION", id: EXECUTION_ID },
      ...fakeEngineCaseSource()
    } as never);
    if (typeof base.raw !== "object" || "kind" in base.raw) {
      throw new Error("TEST_RAW_OBJECT_MISSING");
    }
    const cleanupFailures: string[] = [];
    const service = new WorkPackageEvaluationRunService({
      ...evaluationServiceDependencies({
        execute: (): Promise<FrozenEvaluationEngineResult> =>
          Promise.resolve({
            ...base,
            raw: {
              kind: "PROMPTFOO_RAW_SOURCE",
              openBytes: async function* () {
                yield await Promise.resolve(Buffer.from(JSON.stringify(base.raw), "utf8"));
              },
              openRows: async function* () {
                yield await Promise.reject(new Error("TEST_IMPORT_FAILED"));
              },
              dispose: (): Promise<never> => Promise.reject(new Error("TEST_RAW_CLEANUP_FAILED"))
            }
          })
      }),
      cleanupFailureSink: {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.executionId);
          return Promise.resolve();
        }
      }
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("EVALUATION_STAGE_FAILED");
    expect(existsSync(join(root, "executions", EXECUTION_ID, "promptfoo-raw.json"))).toBe(false);
    expect(cleanupFailures).toEqual([EXECUTION_ID]);
    await expectEvaluationError(root, "EVALUATION_STAGE_FAILED");
  });
  it("removes both published Evaluation artifacts when cancellation wins before registration", async () => {
    const root = await preparedPackage();
    const controller = new AbortController();
    const normalizedPath = join(root, "executions", EXECUTION_ID, "normalized-eval.jsonl");
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (property === "aborted" && existsSync(normalizedPath)) controller.abort();
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const service = evaluationService(fakeEngine());

    await expect(
      service.run({ packagePath: root, executionId: EXECUTION_ID, signal })
    ).rejects.toThrow("EVALUATOR_CANCELLED");
    expect(existsSync(normalizedPath)).toBe(false);
    expect(existsSync(join(root, "executions", EXECUTION_ID, "promptfoo-raw.json"))).toBe(false);
    await expectEvaluationError(root, "EVALUATOR_CANCELLED");
  });
  it("preserves stage cancellation when Raw Source cleanup also fails", async () => {
    const root = await preparedPackage();
    const controller = new AbortController();
    const base = await fakeEngine().execute({
      binding: { kind: "EXECUTION", id: EXECUTION_ID },
      ...fakeEngineCaseSource()
    } as never);
    const cleanupFailures: string[] = [];
    const service = new WorkPackageEvaluationRunService({
      ...evaluationServiceDependencies({
        execute: (): Promise<FrozenEvaluationEngineResult> => {
          controller.abort();
          return Promise.resolve({
            ...base,
            raw: {
              kind: "PROMPTFOO_RAW_SOURCE",
              openBytes: async function* () {
                yield await Promise.resolve(Buffer.from("{}", "utf8"));
              },
              openRows: async function* () {
                yield await Promise.resolve({});
              },
              dispose: (): Promise<never> => Promise.reject(new Error("TEST_RAW_CLEANUP_FAILED"))
            }
          });
        }
      }),
      cleanupFailureSink: {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.executionId);
          return Promise.resolve();
        }
      }
    });

    await expect(
      service.run({ packagePath: root, executionId: EXECUTION_ID, signal: controller.signal })
    ).rejects.toThrow("EVALUATOR_CANCELLED");
    expect(cleanupFailures).toEqual([EXECUTION_ID]);
    await expectEvaluationError(root, "EVALUATOR_CANCELLED");
  });

  it("marks Evaluation ERROR without registering partial Artifacts after engine failure", async () => {
    const root = await preparedPackage();
    const service = evaluationService({
      execute: (): Promise<never> => Promise.reject(new Error("PROMPTFOO_PROCESS_ERROR"))
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("PROMPTFOO_PROCESS_ERROR");
    await expectEvaluationError(root, "PROMPTFOO_PROCESS_ERROR");
  });

  it("maps an engine process cancellation to the claimed Evaluation stage", async () => {
    const root = await preparedPackage();
    const service = evaluationService({
      execute: (): Promise<never> => Promise.reject(new Error("PROMPTFOO_PROCESS_CANCELLED"))
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("EVALUATOR_CANCELLED");
    await expectEvaluationError(root, "EVALUATOR_CANCELLED");
  });

  it("rejects a missing Raw row without registering partial Artifacts", async () => {
    const root = await preparedPackage();
    const base = await fakeEngine().execute({
      binding: { kind: "EXECUTION", id: EXECUTION_ID },
      ...fakeEngineCaseSource()
    } as never);
    const service = evaluationService({
      execute: (): Promise<FrozenEvaluationEngineResult> =>
        Promise.resolve({
          ...base,
          exitCode: 0,
          raw: { results: { version: 3, results: [] } }
        })
    });

    await expect(
      service.run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("EVALUATION_STAGE_FAILED");
    await expectEvaluationError(root, "EVALUATION_STAGE_FAILED");
  });

  it("maps a real Promptfoo child cancellation through Eval CLI to exit 130", async () => {
    const root = await preparedPackage();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "cortex-evaluation-cancel-runtime-"));
    roots.push(runtimeRoot);
    const processStartedPath = join(runtimeRoot, "promptfoo-started");
    const binary = join(runtimeRoot, "fake-promptfoo");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("0.121.18\\n");
  process.exit(0);
}
writeFileSync(${JSON.stringify(processStartedPath)}, "started");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o700 }
    );
    await chmod(binary, 0o700);
    let nonce = 0;
    const evaluationCommands = new LocalEvaluationCommandService({
      contextHasher,
      caseHasher,
      restHashing,
      evalHashing,
      promptfooBinary: binary,
      temporaryContainmentRoot: runtimeRoot,
      temporaryParent: join(runtimeRoot, "promptfoo"),
      promptfooTimeoutMs: 30_000,
      runtimePreflightTimeoutMs: 10_000,
      nextId: (): string => "018f22aa-33bb-7ccc-8ddd-fffffffffff3",
      nonce: (): string => `eval_cancel_nonce_${String(++nonce).padStart(2, "0")}`,
      now: (): string => EVAL_COMPLETED_AT,
      processIdentity: {
        processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
      },
      inheritedEnvironment: (): Readonly<Record<string, string>> => ({
        GEMINI_API_KEY: "test-only-not-forwarded"
      }),
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
    });
    const controller = new AbortController();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const running = runCli(["--json", "eval", "run", root, "--execution-id", EXECUTION_ID], {
      packageCommands: {
        exportPackage: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")),
        validatePackage: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      restCommands: {
        run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      evaluationCommands,
      reportCommands: {
        run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      analysisCommands: {
        run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      pipelineCommands: {
        run: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      resultCommands: {
        importReport: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED")),
        importAnalysis: (): Promise<never> => Promise.reject(new Error("TEST_UNUSED"))
      },
      signal: controller.signal,
      output: {
        stdout: (value): void => {
          stdout.push(value);
        },
        stderr: (value): void => {
          stderr.push(value);
        }
      }
    });
    await waitForFile(processStartedPath);
    controller.abort();

    await expect(running).resolves.toBe(130);
    expect(JSON.parse(stdout.join("")) as unknown).toMatchObject({
      type: "COMMAND_ERROR",
      command: "eval run",
      code: "EVALUATOR_CANCELLED",
      exitCode: 130
    });
    expect(stderr).toHaveLength(1);
    await expectEvaluationError(root, "EVALUATOR_CANCELLED");
    expect(await readdir(join(runtimeRoot, "promptfoo"))).toEqual([]);
  }, 30_000);

  it("composes the local command through the fixed real Promptfoo process", async () => {
    const root = await preparedPackage();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "cortex-evaluation-command-runtime-"));
    roots.push(runtimeRoot);
    let nonce = 0;
    const service = new LocalEvaluationCommandService({
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
      nonce: (): string => `eval_command_nonce_${String(++nonce).padStart(2, "0")}`,
      now: (): string => EVAL_COMPLETED_AT,
      processIdentity: {
        processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
      },
      inheritedEnvironment: (): Readonly<Record<string, string>> => ({
        GEMINI_API_KEY: "test-only-not-forwarded"
      }),
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
    });

    const result = await service.run({
      packagePath: root,
      executionId: EXECUTION_ID,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      packageId: WORK_PACKAGE_FIXTURE_ID,
      executionId: EXECUTION_ID,
      promptfooExitCode: 100,
      evalFailCount: 1,
      evalErrorCount: 0
    });
    expect(await readExecution(root, EXECUTION_ID)).toMatchObject({
      stages: {
        EVALUATION: {
          status: "SUCCEEDED",
          artifacts: [{ kind: "RAW_PROMPTFOO_EVIDENCE" }, { kind: "NORMALIZED_EVAL_RESULTS" }]
        }
      }
    });
  });
});
