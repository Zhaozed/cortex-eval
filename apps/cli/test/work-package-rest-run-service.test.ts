import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OfflineRestExecutionService } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type {
  RestExecutionInput,
  RestExecutor
} from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashExecutionContext,
  hashRestResult
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkPackageRestRunService,
  type WorkPackageRestRetryResults,
  type WorkPackageStageEnvironment
} from "../src/work-package-rest-run-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const FAILURE_EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const roots: string[] = [];

const fixtureDefinition = {
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

async function packageRoot(restEnvKeys: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-rest-run-service-"));
  roots.push(root);
  await materializeWorkPackageFixture(root, {
    restEnvKeys,
    baseDefinitionHash: hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: fixtureDefinition.caseKey,
      definition: caseDefinitionJson(fixtureDefinition)
    })
  });
  return root;
}

function successfulExecutor(): RestExecutor {
  return {
    execute: async (input: RestExecutionInput): Promise<{ readonly dispatchedCount: number }> => {
      for (const item of input.cases) {
        await input.onResult({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          status: "SUCCEEDED",
          httpStatus: 200,
          providerOutput: {
            ok: true,
            taskName: "reply",
            resolvedConfig: {},
            parsedOutput: { text: "hello" }
          },
          errorType: undefined,
          durationMs: 10
        });
      }
      return { dispatchedCount: input.cases.length };
    }
  };
}

function runner(
  executionId: string,
  executor: RestExecutor,
  retryResults: WorkPackageRestRetryResults = {
    prepare: (): Promise<readonly never[]> => Promise.resolve([])
  },
  environment: WorkPackageStageEnvironment = { require: (): void => undefined },
  openSession: typeof openWorkPackageExecutionSession = openWorkPackageExecutionSession,
  cleanupFailureSink: {
    readonly record: (failure: { readonly executionId: string }) => Promise<void>;
  } = { record: (): Promise<void> => Promise.resolve() },
  restExecutionOverride?: OfflineRestExecutionService
): WorkPackageRestRunService {
  let nonce = 0;
  return new WorkPackageRestRunService({
    contextHasher,
    caseHasher,
    restExecution:
      restExecutionOverride ??
      new OfflineRestExecutionService({
        restExecutor: executor,
        clock: { now: (): string => "2026-07-14T07:01:00.000Z" },
        messageResolver: { message: (code): string => code }
      }),
    nextId: (): string => executionId,
    nonce: (): string => `rest_run_nonce_${String(++nonce).padStart(2, "0")}`,
    now: (): string => "2026-07-14T07:00:00.000Z",
    processIdentity: {
      processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
    },
    retryResults,
    environment,
    openSession,
    cleanupFailureSink
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 Work Package REST run service", () => {
  it("creates a new Execution and atomically completes its REST stage", async () => {
    const root = await packageRoot();
    const result = await runner(EXECUTION_ID, successfulExecutor()).run({
      packagePath: root,
      rerun: { mode: "NEW" },
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({
      packageId: WORK_PACKAGE_FIXTURE_ID,
      executionId: EXECUTION_ID,
      restErrorCount: 0,
      artifactPath: `executions/${EXECUTION_ID}/rest-results.jsonl`
    });

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: EXECUTION_ID,
        acquiredAt: "2026-07-14T07:03:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_verify_nonce_01"
    });
    try {
      expect(session.readExecution(EXECUTION_ID)?.stages.REST.status).toBe("SUCCEEDED");
    } finally {
      await session.close();
    }
  });

  it("records a stable stage error and leaves no committed REST Artifact on system failure", async () => {
    const root = await packageRoot();
    const failing: RestExecutor = {
      execute: (): Promise<never> => Promise.reject(new Error("PROVIDER_REQUEST_FAILED"))
    };
    await expect(
      runner(FAILURE_EXECUTION_ID, failing).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: FAILURE_EXECUTION_ID,
        acquiredAt: "2026-07-14T07:03:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_verify_nonce_02"
    });
    try {
      expect(session.readExecution(FAILURE_EXECUTION_ID)?.stages.REST).toMatchObject({
        status: "ERROR",
        errorCode: "PROVIDER_REQUEST_FAILED",
        artifacts: []
      });
    } finally {
      await session.close();
    }
  });

  it("sanitizes an unknown REST execution failure before persisting and returning it", async () => {
    const root = await packageRoot();
    const failing: RestExecutor = {
      execute: (): Promise<never> => Promise.reject(new Error("TEST_PRIVATE_FAILURE"))
    };

    await expect(
      runner(FAILURE_EXECUTION_ID, failing).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("INTERNAL_ERROR");

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: FAILURE_EXECUTION_ID,
        acquiredAt: "2026-07-14T07:03:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_verify_nonce_03"
    });
    try {
      expect(session.readExecution(FAILURE_EXECUTION_ID)?.stages.REST.errorCode).toBe(
        "INTERNAL_ERROR"
      );
    } finally {
      await session.close();
    }
  });

  it("removes a committed REST Artifact when Execution registration fails", async () => {
    const root = await packageRoot();
    const failingOpenSession: typeof openWorkPackageExecutionSession = async (input) => {
      const session = await openWorkPackageExecutionSession(input);
      Object.defineProperty(session, "completeStage", {
        value: (): Promise<never> => Promise.reject(new Error("ARTIFACT_WRITE_FAILED"))
      });
      return session;
    };
    await expect(
      runner(
        FAILURE_EXECUTION_ID,
        successfulExecutor(),
        { prepare: (): Promise<readonly never[]> => Promise.resolve([]) },
        { require: (): void => undefined },
        failingOpenSession
      ).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    await expect(
      access(join(root, "executions", FAILURE_EXECUTION_ID, "rest-results.jsonl"))
    ).rejects.toThrow();
  });

  it("preserves the registration error when immediate Artifact cleanup reporting also fails", async () => {
    const root = await packageRoot();
    let cleanupReports = 0;
    const failingOpenSession: typeof openWorkPackageExecutionSession = async (input) => {
      const session = await openWorkPackageExecutionSession(input);
      Object.defineProperties(session, {
        completeStage: {
          value: (): Promise<never> => Promise.reject(new Error("ARTIFACT_WRITE_FAILED"))
        },
        discardUnregisteredStageArtifact: {
          value: (): Promise<never> => Promise.reject(new Error("TEST_DISCARD_FAILED"))
        }
      });
      return session;
    };

    await expect(
      runner(
        FAILURE_EXECUTION_ID,
        successfulExecutor(),
        { prepare: (): Promise<readonly never[]> => Promise.resolve([]) },
        { require: (): void => undefined },
        failingOpenSession,
        {
          record: (): Promise<void> => {
            cleanupReports += 1;
            return Promise.reject(new Error("TEST_CLEANUP_REPORT_FAILED"));
          }
        }
      ).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    expect(cleanupReports).toBe(1);
  });

  it("cancels before publishing when REST completes after the stage cancellation signal", async () => {
    const root = await packageRoot();
    const controller = new AbortController();
    const baseExecution = new OfflineRestExecutionService({
      restExecutor: successfulExecutor(),
      clock: { now: (): string => "2026-07-14T07:01:00.000Z" },
      messageResolver: { message: (code): string => code }
    });
    const abortAfterExecution = {
      execute: async (
        input: Parameters<OfflineRestExecutionService["execute"]>[0]
      ): ReturnType<OfflineRestExecutionService["execute"]> => {
        const result = await baseExecution.execute(input);
        controller.abort();
        return result;
      }
    } as unknown as OfflineRestExecutionService;

    await expect(
      runner(
        FAILURE_EXECUTION_ID,
        successfulExecutor(),
        { prepare: (): Promise<readonly never[]> => Promise.resolve([]) },
        { require: (): void => undefined },
        openWorkPackageExecutionSession,
        { record: (): Promise<void> => Promise.resolve() },
        abortAfterExecution
      ).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: controller.signal
      })
    ).rejects.toThrow("REST_CANCELLED");
    expect(existsSync(join(root, "executions", FAILURE_EXECUTION_ID, "rest-results.jsonl"))).toBe(
      false
    );
    const execution = JSON.parse(
      await readFile(join(root, "executions", FAILURE_EXECUTION_ID, "execution.json"), "utf8")
    ) as { readonly stages: { readonly REST: unknown } };
    expect(execution.stages.REST).toMatchObject({
      status: "ERROR",
      errorCode: "REST_CANCELLED",
      artifacts: []
    });
  });

  it("removes a published REST Artifact when cancellation wins before registration", async () => {
    const root = await packageRoot();
    const controller = new AbortController();
    const artifactPath = join(root, "executions", FAILURE_EXECUTION_ID, "rest-results.jsonl");
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (property === "aborted" && existsSync(artifactPath)) controller.abort();
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    await expect(
      runner(FAILURE_EXECUTION_ID, successfulExecutor()).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal
      })
    ).rejects.toThrow("REST_CANCELLED");
    expect(existsSync(artifactPath)).toBe(false);
    const execution = JSON.parse(
      await readFile(join(root, "executions", FAILURE_EXECUTION_ID, "execution.json"), "utf8")
    ) as { readonly stages: { readonly REST: unknown } };
    expect(execution.stages.REST).toMatchObject({
      status: "ERROR",
      errorCode: "REST_CANCELLED",
      artifacts: []
    });
  });

  it("creates retry-failed as a new Execution and reuses only an aligned REST success", async () => {
    const root = await packageRoot();
    await runner(EXECUTION_ID, successfulExecutor()).run({
      packagePath: root,
      rerun: { mode: "NEW" },
      signal: new AbortController().signal
    });
    const sourceResultHash = hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: "case-1",
      caseDefinitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: fixtureDefinition.caseKey,
        definition: caseDefinitionJson(fixtureDefinition)
      }),
      result: {
        status: "SUCCEEDED",
        httpStatus: 200,
        providerOutput: {
          ok: true,
          taskName: "reply",
          resolvedConfig: {},
          parsedOutput: { text: "hello" }
        }
      }
    });
    const unexpected: RestExecutor = {
      execute: (): Promise<never> => Promise.reject(new Error("TEST_UNEXPECTED_REST_EXECUTION"))
    };
    const result = await runner(FAILURE_EXECUTION_ID, unexpected, {
      prepare: ({
        sourceExecutionId
      }): Promise<
        readonly [
          {
            readonly caseKey: "case-1";
            readonly ordinal: 0;
            readonly caseDefinitionHash: string;
            readonly status: "SUCCEEDED";
            readonly httpStatus: 200;
            readonly providerOutput: {
              readonly ok: true;
              readonly taskName: "reply";
              readonly resolvedConfig: Record<string, never>;
              readonly parsedOutput: { readonly text: "hello" };
            };
            readonly errorType: null;
            readonly errorMessage: null;
            readonly durationMs: 10;
            readonly completedAt: "2026-07-14T07:01:00.000Z";
            readonly resultHash: string;
            readonly provenance: {
              readonly sourceKind: "EXECUTION";
              readonly sourceId: string;
              readonly sourceResultHash: string;
            };
          }
        ]
      > =>
        Promise.resolve([
          {
            caseKey: "case-1",
            ordinal: 0,
            caseDefinitionHash: hashCaseDefinition({
              contractVersion: "cortex.case-definition.v1",
              caseKey: fixtureDefinition.caseKey,
              definition: caseDefinitionJson(fixtureDefinition)
            }),
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
            durationMs: 10,
            completedAt: "2026-07-14T07:01:00.000Z",
            resultHash: sourceResultHash,
            provenance: {
              sourceKind: "EXECUTION",
              sourceId: sourceExecutionId,
              sourceResultHash
            }
          }
        ])
    }).run({
      packagePath: root,
      rerun: { mode: "RETRY_FAILED", sourceExecutionId: EXECUTION_ID },
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ executionId: FAILURE_EXECUTION_ID, restErrorCount: 0 });
  });

  it("force creates a new Execution and does not inspect reusable REST results", async () => {
    const root = await packageRoot();
    await runner(EXECUTION_ID, successfulExecutor()).run({
      packagePath: root,
      rerun: { mode: "NEW" },
      signal: new AbortController().signal
    });
    let inspected = false;
    const result = await runner(FAILURE_EXECUTION_ID, successfulExecutor(), {
      prepare: (): Promise<readonly never[]> => {
        inspected = true;
        return Promise.resolve([]);
      }
    }).run({
      packagePath: root,
      rerun: { mode: "FORCE", sourceExecutionId: EXECUTION_ID },
      signal: new AbortController().signal
    });
    expect(result.executionId).toBe(FAILURE_EXECUTION_ID);
    expect(inspected).toBe(false);
  });

  it("rejects a missing REST Secret before creating the new Execution", async () => {
    const root = await packageRoot(["ENDPOINT_TOKEN"]);
    await expect(
      runner(
        EXECUTION_ID,
        successfulExecutor(),
        { prepare: (): Promise<readonly never[]> => Promise.resolve([]) },
        {
          require: (): never => {
            throw new Error("VALIDATION_FAILED");
          }
        }
      ).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("VALIDATION_FAILED");

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: "2026-07-14T07:03:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_env_verify_nonce"
    });
    try {
      expect(session.readExecution(EXECUTION_ID)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("rejects an invalid Endpoint with valid file integrity before creating the Execution", async () => {
    const root = await packageRoot();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      readonly inputs: {
        readonly endpoint: {
          readonly path: string;
          readonly sha256: string;
          readonly sizeBytes: number;
        };
      };
    } & Readonly<Record<string, unknown>>;
    const invalidEndpoint = Buffer.from("{}\n", "utf8");
    const endpointHash = createHash("sha256").update(invalidEndpoint).digest("hex");
    await writeFile(join(root, manifest.inputs.endpoint.path), invalidEndpoint);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        inputs: {
          ...manifest.inputs,
          endpoint: {
            ...manifest.inputs.endpoint,
            sha256: endpointHash,
            sizeBytes: invalidEndpoint.byteLength
          }
        },
        configurationHashes: {
          ...(manifest.configurationHashes as Readonly<Record<string, unknown>>),
          endpoint: endpointHash
        }
      })}\n`
    );
    let externalCalls = 0;
    const executor: RestExecutor = {
      execute: (): Promise<never> => {
        externalCalls += 1;
        return Promise.reject(new Error("TEST_EXTERNAL_CALL_MUST_NOT_START"));
      }
    };

    await expect(
      runner(EXECUTION_ID, executor).run({
        packagePath: root,
        rerun: { mode: "NEW" },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(externalCalls).toBe(0);

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: "2026-07-14T07:03:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_invalid_endpoint_verify_nonce"
    });
    try {
      expect(session.readExecution(EXECUTION_ID)).toBeNull();
    } finally {
      await session.close();
    }
  });
});
