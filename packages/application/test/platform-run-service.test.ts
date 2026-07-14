import type {
  PlatformRunResourceReader,
  PlatformRunTransactionManager
} from "../src/features/runs/platform-run-ports.ts";
import type { RunArtifactStore } from "../src/features/runs/run-artifact-port.ts";
import type {
  RestExecutionErrorType,
  RestExecutionInput,
  RestExecutionSummary,
  RestExecutor
} from "../src/features/runs/run-rest-models.ts";
import {
  PlatformRunService,
  type PlatformRunMutationResult
} from "../src/features/runs/platform-run-service.ts";
import type { ConfigurationResource } from "../src/features/configurations/configuration-models.ts";
import type { StoredTestCase, TestSuite } from "../src/features/test-suites/test-suite-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import { describe, expect, it } from "vitest";

import {
  CancellationWinsCompletionRunStore,
  ClaimFailureRunStore,
  MemoryPlatformRunStore,
  PagedResultRunStore,
  ProgressConflictRunStore,
  TerminalWinsCompletionRunStore
} from "../test-support/in-memory-platform-run-store.ts";
import {
  BlockingArtifactStore,
  DelayedSuccessfulRestExecutor,
  ErrorRestExecutor,
  FailingArtifacts,
  FullReadCountingRunStore,
  MemoryArtifacts,
  MemoryRunEvents,
  MisalignedRestExecutor,
  PollReadFailureRunStore,
  SilentRestExecutor,
  SuccessfulRestExecutor,
  ThrowingRestExecutor
} from "../test-support/platform-run-resilience-fixtures.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const SUITE_ID = "01900000-0000-7000-8000-000000000100";
const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";
const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";
const NOW = "2026-07-13T00:00:00.000Z";
const HASH = "a".repeat(64);

const definition = {
  caseKey: "case-1",
  description: "Case",
  threshold: 1,
  task: "route",
  requestBody: { input: "hello" },
  metadata: {
    requestId: "request-1",
    taskId: "task-1",
    businessModule: "chat",
    scenarioTag: "smoke"
  },
  assertions: [{ type: "equals", metric: "quality", weight: 1 }]
} as const;
const definitionJson = caseDefinitionJson(definition);
const definitionHash = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: definition.caseKey,
  definition: definitionJson
});
const suiteHash = hashSuite({
  contractVersion: "cortex.suite.v1",
  cases: [{ caseKey: definition.caseKey, ordinal: 0, definitionHash }]
});
const endpointDefinition = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1_000,
  defaultConcurrency: 7
};
const evaluatorDefinition = {
  providerType: "GOOGLE_GEMINI" as const,
  apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
  model: "gemini-test",
  thinkingLevel: "OFF" as const,
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_SCHEMA" as const
};
const suite: TestSuite = {
  id: SUITE_ID,
  name: "Suite",
  description: "Suite",
  caseCount: 1,
  suiteHash,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const storedCase: StoredTestCase = {
  id: "01900000-0000-7000-8000-000000000400",
  suiteId: SUITE_ID,
  caseKey: definition.caseKey,
  ordinal: 0,
  description: definition.description,
  businessModule: "chat",
  scenarioTag: "smoke",
  assertionTypes: ["equals"],
  metrics: ["quality"],
  definition,
  definitionJson,
  rubricPromptKeys: [],
  definitionHash,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const endpoint: ConfigurationResource = {
  kind: "ENDPOINT",
  id: ENDPOINT_ID,
  name: "Endpoint",
  semanticHash: hashEndpointConfig({
    contractVersion: "cortex.endpoint-config.v1",
    config: endpointDefinition
  }),
  definition: endpointDefinition,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const evaluator: ConfigurationResource = {
  kind: "LLM",
  id: EVALUATOR_ID,
  name: "Evaluator",
  semanticHash: hashLlmConfig({
    contractVersion: "cortex.llm-config.v1",
    config: evaluatorDefinition
  }),
  definition: evaluatorDefinition,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};

class MemoryResources implements PlatformRunResourceReader {
  /** Current Suite returned to the service. */
  suiteValue: TestSuite | null = suite;
  /** Current Cases returned to the service. */
  caseValues: readonly StoredTestCase[] = [storedCase];
  /** Current Endpoint returned to the service. */
  endpointValue: ConfigurationResource | null = endpoint;
  /** Current Evaluator returned to the service. */
  evaluatorValue: ConfigurationResource | null = evaluator;
  /** Current Rubric Prompt set returned to the service. */
  rubricValues: readonly ConfigurationResource[] = [];

  /** Read the one test Suite. */
  public getSuite(id: string): Promise<TestSuite | null> {
    return Promise.resolve(id === SUITE_ID ? this.suiteValue : null);
  }

  /** Read the one test Case. */
  public listCases(id: string): Promise<readonly StoredTestCase[]> {
    return Promise.resolve(id === SUITE_ID ? this.caseValues : []);
  }

  /** Read one test Configuration. */
  public getConfiguration(
    kind: "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT",
    id: string
  ): Promise<ConfigurationResource | null> {
    if (kind === "ENDPOINT" && id === ENDPOINT_ID) return Promise.resolve(this.endpointValue);
    if (kind === "LLM" && id === EVALUATOR_ID) return Promise.resolve(this.evaluatorValue);
    return Promise.resolve(null);
  }

  /** No test Case references a Rubric Prompt. */
  public listRubricPrompts(): Promise<readonly ConfigurationResource[]> {
    return Promise.resolve(this.rubricValues);
  }
}

class BlockingRestExecutor implements RestExecutor {
  /** Emit one cancelled real result after the owner Abort signal fires. */
  public execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        input
          .onResult({
            caseKey: "case-1",
            ordinal: 0,
            status: "ERROR",
            httpStatus: null,
            providerOutput: undefined,
            errorType: "CANCELLED",
            durationMs: 1
          })
          .then(() => resolve({ dispatchedCount: 1 }), reject);
      };
      if (input.signal.aborted) finish();
      else input.signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function serviceFixture(
  restExecutor: RestExecutor,
  artifacts: RunArtifactStore = new MemoryArtifacts(),
  runs: MemoryPlatformRunStore = new MemoryPlatformRunStore(),
  resources: MemoryResources = new MemoryResources(),
  events: MemoryRunEvents = new MemoryRunEvents()
): {
  readonly service: PlatformRunService;
  readonly runs: MemoryPlatformRunStore;
  readonly events: MemoryRunEvents;
} {
  const manager: PlatformRunTransactionManager = {
    execute: (work) => work({ resources, runs })
  };
  return {
    runs,
    events,
    service: new PlatformRunService({
      transactionManager: manager,
      restExecutor,
      artifactStore: artifacts,
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code): string => code },
      eventSink: events,
      cancellationPollMs: 25
    })
  };
}

describe("PlatformRunService", () => {
  it("拒绝非法取消轮询与执行限制，并冻结合法显式限制", async () => {
    const resources = new MemoryResources();
    const runs = new MemoryPlatformRunStore();
    const manager: PlatformRunTransactionManager = {
      execute: (work) => work({ resources, runs })
    };
    const dependencies = {
      transactionManager: manager,
      restExecutor: new SuccessfulRestExecutor(),
      artifactStore: new MemoryArtifacts(),
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code: string): string => code },
      eventSink: new MemoryRunEvents()
    };
    for (const cancellationPollMs of [24, 51, 25.5]) {
      expect(() => new PlatformRunService({ ...dependencies, cancellationPollMs })).toThrow(
        "RUN_CANCELLATION_POLL_INVALID"
      );
    }
    expect(() => new PlatformRunService(dependencies)).not.toThrow();

    const invalidLimits = [
      { restConcurrency: 1.5, evalConcurrency: 2 },
      { restConcurrency: 0, evalConcurrency: 2 },
      { restConcurrency: 65, evalConcurrency: 2 },
      { restConcurrency: 4, evalConcurrency: 1.5 },
      { restConcurrency: 4, evalConcurrency: 0 },
      { restConcurrency: 4, evalConcurrency: 17 }
    ];
    for (const limits of invalidLimits) {
      const { service } = serviceFixture(new SuccessfulRestExecutor());
      expect(
        await service.create({
          suiteId: SUITE_ID,
          endpointConfigId: ENDPOINT_ID,
          evaluatorConfigId: EVALUATOR_ID,
          runMode: "STAGED",
          runExecutionLimits: {
            contractVersion: "cortex.run-execution-limits.v1",
            ...limits
          }
        })
      ).toEqual({
        ok: false,
        error: { code: "VALIDATION_FAILED", path: "runExecutionLimits" }
      });
    }
    const { service } = serviceFixture(new SuccessfulRestExecutor());
    expect(
      await service.create({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        runMode: "STAGED",
        runExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 64,
          evalConcurrency: 16
        }
      })
    ).toMatchObject({
      ok: true,
      run: { runExecutionLimits: { restConcurrency: 64, evalConcurrency: 16 } }
    });
  });

  it("预检逐项拒绝缺失资源、空 Suite 与缺失 Rubric", async () => {
    const preflight = (resources: MemoryResources): ReturnType<PlatformRunService["preflight"]> =>
      serviceFixture(
        new SuccessfulRestExecutor(),
        new MemoryArtifacts(),
        new MemoryPlatformRunStore(),
        resources
      ).service.preflight({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID
      });

    const missingSuite = new MemoryResources();
    missingSuite.suiteValue = null;
    expect(await preflight(missingSuite)).toEqual({
      ok: false,
      error: { code: "SUITE_NOT_FOUND" }
    });
    const emptySuite = new MemoryResources();
    emptySuite.caseValues = [];
    expect(await preflight(emptySuite)).toEqual({
      ok: false,
      error: { code: "RUN_SUITE_EMPTY" }
    });
    const missingEndpoint = new MemoryResources();
    missingEndpoint.endpointValue = null;
    expect(await preflight(missingEndpoint)).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_NOT_FOUND", kind: "ENDPOINT" }
    });
    const missingEvaluator = new MemoryResources();
    missingEvaluator.evaluatorValue = null;
    expect(await preflight(missingEvaluator)).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_NOT_FOUND", kind: "LLM" }
    });
    const missingRubric = new MemoryResources();
    missingRubric.caseValues = [
      {
        ...storedCase,
        definition: {
          ...storedCase.definition,
          assertions: [
            {
              type: "llm-rubric",
              metric: "quality",
              weight: 1,
              rubricPrompt: "prompt://quality"
            }
          ]
        },
        rubricPromptKeys: ["quality"]
      }
    ];
    expect(await preflight(missingRubric)).toEqual({
      ok: false,
      error: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: "quality" }
    });
  });

  it("预检冻结唯一 Rubric、Header Secret 与 OpenAI Evaluator Secret", async () => {
    const resources = new MemoryResources();
    resources.caseValues = [
      {
        ...storedCase,
        definition: {
          ...storedCase.definition,
          assertions: [
            {
              type: "llm-rubric",
              metric: "quality",
              weight: 1,
              rubricPrompt: "prompt://quality"
            },
            {
              type: "llm-rubric",
              metric: "safety",
              weight: 1,
              rubricPrompt: "prompt://quality"
            }
          ]
        },
        rubricPromptKeys: ["quality"]
      }
    ];
    resources.endpointValue = {
      ...endpoint,
      definition: {
        ...endpointDefinition,
        headers: {
          Authorization: { kind: "ENV_SECRET", envKey: "REST_TOKEN" },
          "X-Token": { kind: "ENV_SECRET", envKey: "REST_TOKEN" },
          Accept: { kind: "LITERAL", value: "application/json" }
        }
      }
    };
    resources.evaluatorValue = {
      ...evaluator,
      definition: {
        providerType: "OPENAI_COMPATIBLE",
        baseUrl: "https://llm.example.test/v1",
        auth: {
          kind: "BEARER_ENV",
          secret: { kind: "ENV_SECRET", envKey: "OPENAI_TOKEN" }
        },
        model: "openai-test",
        thinkingLevel: "LOW",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT"
      }
    };
    resources.rubricValues = [
      {
        kind: "LLM_RUBRIC_PROMPT",
        id: "01900000-0000-7000-8000-000000000500",
        name: "Quality",
        semanticHash: HASH,
        definition: {
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "SYSTEM", content: "Judge" }]
        },
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        kind: "CASE_ANALYSIS_PROMPT",
        id: "01900000-0000-7000-8000-000000000501",
        name: "Analysis",
        semanticHash: HASH,
        definition: {
          kind: "CASE_ANALYSIS",
          promptKey: "analysis",
          messages: [{ role: "USER", content: "Analyze {{case_definition}}" }]
        },
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW
      }
    ];
    const { service } = serviceFixture(
      new SuccessfulRestExecutor(),
      new MemoryArtifacts(),
      new MemoryPlatformRunStore(),
      resources
    );
    expect(
      await service.preflight({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID
      })
    ).toMatchObject({
      ok: true,
      preflight: {
        rubricPromptKeys: ["quality"],
        requiredEnvKeys: { REST: ["REST_TOKEN"], EVALUATION: ["OPENAI_TOKEN"] }
      }
    });

    resources.evaluatorValue = {
      ...resources.evaluatorValue,
      definition: { ...resources.evaluatorValue.definition, auth: { kind: "NONE" } }
    } as ConfigurationResource;
    expect(
      await service.preflight({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID
      })
    ).toMatchObject({ ok: true, preflight: { requiredEnvKeys: { EVALUATION: [] } } });
  });

  it("原子冻结资源、使用 Endpoint 默认并发，并在 Artifact 后提交 REST 阶段", async () => {
    const runs = new MemoryPlatformRunStore();
    const resources = new MemoryResources();
    const manager: PlatformRunTransactionManager = {
      execute: (work) => work({ resources, runs })
    };
    const restExecutor = new SuccessfulRestExecutor();
    const artifacts = new MemoryArtifacts();
    const service = new PlatformRunService({
      transactionManager: manager,
      restExecutor,
      artifactStore: artifacts,
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code): string => code },
      eventSink: new MemoryRunEvents(),
      cancellationPollMs: 25
    });

    const created = await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    expect(created).toMatchObject({
      ok: true,
      run: {
        status: "READY",
        stage: "REST",
        runExecutionLimits: { restConcurrency: 7, evalConcurrency: 2 }
      }
    });
    const started = await service.start({ runId: RUN_ID, expectedRevision: 0 });
    expect(started).toMatchObject({ ok: true, run: { status: "RUNNING" } });
    await service.waitForIdle();

    expect(restExecutor.concurrency).toBe(7);
    expect(artifacts.writes).toHaveLength(1);
    expect(artifacts.caseCounts[0]).toBe(1);
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "READY",
      stage: "EVALUATION",
      restCompletedCount: 1,
      artifactManifest: { artifacts: [{ kind: "REST_RESULTS" }] }
    });
  });

  it("PIPELINE 在 REST 提交后以最新 Revision 自动启动 Evaluation", async () => {
    const runs = new MemoryPlatformRunStore();
    const resources = new MemoryResources();
    const manager: PlatformRunTransactionManager = {
      execute: (work) => work({ resources, runs })
    };
    const starts: { readonly runId: string; readonly expectedRevision: number }[] = [];
    const service = new PlatformRunService({
      transactionManager: manager,
      restExecutor: new SuccessfulRestExecutor(),
      artifactStore: new MemoryArtifacts(),
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code): string => code },
      eventSink: new MemoryRunEvents(),
      cancellationPollMs: 25,
      pipelineEvaluationStarter: {
        start: (input): Promise<PlatformRunMutationResult> => {
          starts.push(input);
          const run = runs.values.get(input.runId);
          if (run === undefined) throw new Error("TEST_RUN_MISSING");
          return Promise.resolve({ ok: true, run });
        }
      }
    });

    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "PIPELINE"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await service.waitForIdle();

    expect(starts).toEqual([{ runId: RUN_ID, expectedRevision: 3 }]);
  });

  it.each([
    [
      "返回失败",
      (): Promise<PlatformRunMutationResult> =>
        Promise.resolve({
          ok: false,
          error: { code: "VALIDATION_FAILED", path: "cases[0].assertions[0]" }
        })
    ],
    ["直接拒绝", (): Promise<PlatformRunMutationResult> => Promise.reject(new Error("failed"))]
  ])("PIPELINE 自动启动 Evaluation %s 时持久化阶段失败", async (_label, start) => {
    const runs = new MemoryPlatformRunStore();
    const resources = new MemoryResources();
    const manager: PlatformRunTransactionManager = { execute: (work) => work({ resources, runs }) };
    const service = new PlatformRunService({
      transactionManager: manager,
      restExecutor: new SuccessfulRestExecutor(),
      artifactStore: new MemoryArtifacts(),
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code): string => code },
      eventSink: new MemoryRunEvents(),
      cancellationPollMs: 25,
      pipelineEvaluationStarter: { start }
    });
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "PIPELINE"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await service.waitForIdle();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "EVALUATION_STAGE_FAILED",
      errorMessage: "EVALUATION_STAGE_FAILED"
    });
  });

  it("取消先持久化请求，再收口已派发 CANCELLED 结果并提交终态", async () => {
    const { service, runs } = serviceFixture(new BlockingRestExecutor());
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "PIPELINE"
    });
    const started = await service.start({ runId: RUN_ID, expectedRevision: 0 });
    if (!started.ok) throw new Error("TEST_START_FAILED");
    const requested = await service.cancel({
      runId: RUN_ID,
      expectedRevision: started.run.lockRevision
    });
    expect(requested).toMatchObject({ ok: true, run: { cancelRequestedAt: NOW } });
    await service.waitForIdle();

    expect(runs.values.get(RUN_ID)).toMatchObject({ status: "CANCELLED", stage: "DONE" });
    expect(runs.results.get(`${RUN_ID}:case-1`)).toMatchObject({
      status: "ERROR",
      errorType: "CANCELLED",
      errorMessage: "REST_CANCELLED"
    });
  });

  it("Runtime shutdown 收敛为 INTERRUPTED，不冒充用户取消", async () => {
    const { service, runs } = serviceFixture(new BlockingRestExecutor());
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await service.shutdown();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "INTERRUPTED",
      stage: "DONE",
      cancelRequestedAt: null
    });
  });

  it("发射冻结、REST 开始/完成与取消请求/完成的安全业务事件", async () => {
    const completed = serviceFixture(new SuccessfulRestExecutor());
    await completed.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await completed.service.start({ runId: RUN_ID, expectedRevision: 0 });
    await completed.service.waitForIdle();
    expect(completed.events.values.map((item) => item.event)).toEqual([
      "RUN_INPUT_FROZEN",
      "RUN_REST_STARTED",
      "RUN_REST_COMPLETED"
    ]);

    const cancelled = serviceFixture(new BlockingRestExecutor());
    await cancelled.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    const started = await cancelled.service.start({ runId: RUN_ID, expectedRevision: 0 });
    if (!started.ok) throw new Error("TEST_START_FAILED");
    await cancelled.service.cancel({ runId: RUN_ID, expectedRevision: started.run.lockRevision });
    await cancelled.service.waitForIdle();
    expect(cancelled.events.values.map((item) => item.event)).toEqual([
      "RUN_INPUT_FROZEN",
      "RUN_REST_STARTED",
      "RUN_CANCEL_REQUESTED",
      "RUN_CANCELLED"
    ]);
  });

  it("Shutdown 在 Artifact 写入后到阶段提交前仍以 CAS 收敛 INTERRUPTED", async () => {
    const artifacts = new BlockingArtifactStore();
    const { service, runs } = serviceFixture(new SuccessfulRestExecutor(), artifacts);
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await artifacts.entered.promise;

    const shutdown = service.shutdown();
    artifacts.release.resolve();
    await expect(shutdown).resolves.toBeUndefined();

    expect(runs.values.get(RUN_ID)).toMatchObject({ status: "INTERRUPTED", stage: "DONE" });
    expect(artifacts.removed).toHaveLength(1);
  });

  it("取消轮询读取失败由后台 owner 单次收敛为 FAILED，waitForIdle 不泄漏拒绝", async () => {
    const runs = new PollReadFailureRunStore();
    const { service } = serviceFixture(
      new DelayedSuccessfulRestExecutor(),
      new MemoryArtifacts(),
      runs
    );
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });

    await expect(service.waitForIdle()).resolves.toBeUndefined();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "INTERNAL_ERROR"
    });
  });

  it("执行期间只在 Stage claim 前读取一次完整冻结快照，轮询与结果提交使用小投影", async () => {
    const runs = new FullReadCountingRunStore();
    const { service } = serviceFixture(
      new DelayedSuccessfulRestExecutor(),
      new MemoryArtifacts(),
      runs
    );
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });

    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await service.waitForIdle();

    expect(runs.fullReads).toBe(0);
  });

  it("Artifact 写失败收敛为 FAILED/DONE 并保留逐 Case 数据库事实", async () => {
    const { service, runs } = serviceFixture(new SuccessfulRestExecutor(), new FailingArtifacts());
    await service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await service.start({ runId: RUN_ID, expectedRevision: 0 });
    await service.waitForIdle();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "ARTIFACT_WRITE_FAILED",
      errorMessage: "ARTIFACT_WRITE_FAILED",
      restCompletedCount: 1
    });
  });

  it("启动区分缺失、未注册阶段、Revision 与全局运行冲突", async () => {
    const missing = serviceFixture(new SuccessfulRestExecutor()).service;
    expect(await missing.start({ runId: RUN_ID, expectedRevision: 0 })).toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });

    const stageFixture = serviceFixture(new SuccessfulRestExecutor());
    await stageFixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    const created = stageFixture.runs.values.get(RUN_ID);
    if (created === undefined) throw new Error("TEST_RUN_MISSING");
    stageFixture.runs.values.set(RUN_ID, { ...created, stage: "EVALUATION" });
    expect(await stageFixture.service.start({ runId: RUN_ID, expectedRevision: 0 })).toMatchObject({
      ok: false,
      error: { reason: "STAGE_UNAVAILABLE" }
    });
    stageFixture.runs.values.set(RUN_ID, created);
    expect(await stageFixture.service.start({ runId: RUN_ID, expectedRevision: 9 })).toMatchObject({
      ok: false,
      error: { reason: "STATE_OR_REVISION" }
    });

    for (const reason of ["NOT_FOUND", "GLOBAL_RUNNING"] as const) {
      const runs = new ClaimFailureRunStore(reason);
      const fixture = serviceFixture(new SuccessfulRestExecutor(), new MemoryArtifacts(), runs);
      await fixture.service.create({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        runMode: "STAGED"
      });
      const result = await fixture.service.start({ runId: RUN_ID, expectedRevision: 0 });
      expect(result).toMatchObject({
        ok: false,
        error:
          reason === "NOT_FOUND"
            ? { code: "RUN_NOT_FOUND" }
            : { code: "RUN_STATE_CONFLICT", reason: "GLOBAL_RUNNING" }
      });
    }
  });

  it("取消区分缺失、状态冲突，并支持由其他进程持有的 RUNNING Run", async () => {
    const fixture = serviceFixture(new SuccessfulRestExecutor());
    expect(await fixture.service.cancel({ runId: RUN_ID, expectedRevision: 0 })).toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    await fixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    expect(await fixture.service.cancel({ runId: RUN_ID, expectedRevision: 0 })).toMatchObject({
      ok: false,
      error: { reason: "STATE_OR_REVISION" }
    });
    const created = fixture.runs.values.get(RUN_ID);
    if (created === undefined) throw new Error("TEST_RUN_MISSING");
    fixture.runs.values.set(RUN_ID, { ...created, status: "RUNNING" });
    expect(await fixture.service.cancel({ runId: RUN_ID, expectedRevision: 0 })).toMatchObject({
      ok: true,
      run: { cancelRequestedAt: NOW }
    });
  });

  it("查询、Artifact 检查、恢复与初始化全部读取持久化端口事实", async () => {
    const artifacts = new MemoryArtifacts();
    const fixture = serviceFixture(new SuccessfulRestExecutor(), artifacts);
    await fixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    expect(await fixture.service.get(RUN_ID)).toMatchObject({ id: RUN_ID });
    expect(await fixture.service.get("missing")).toBeNull();
    expect(await fixture.service.queryRuns({ limit: 10 })).toMatchObject({
      items: [{ id: RUN_ID }]
    });
    expect(await fixture.service.queryRestResults({ runId: RUN_ID, limit: 10 })).toEqual({
      items: [],
      nextCursor: null
    });
    expect(await fixture.service.getRestResult(RUN_ID, "case-1")).toBeNull();
    expect(await fixture.service.inspectArtifacts("missing")).toBeNull();
    expect(await fixture.service.inspectArtifacts(RUN_ID)).toEqual([]);
    expect(await fixture.service.recover()).toEqual([]);
    expect(await fixture.service.initialize()).toEqual([]);
    expect(artifacts.cleanupInputs).toHaveLength(1);
    expect(artifacts.cleanupInputs[0]).toHaveLength(1);
  });

  it("所有 REST 错误分类均外化稳定消息并保存错误事实", async () => {
    const errorTypes: readonly RestExecutionErrorType[] = [
      "TIMEOUT",
      "NETWORK",
      "HTTP_STATUS",
      "RESPONSE_PARSE",
      "PROVIDER_OUTPUT_INVALID",
      "CANCELLED",
      "TEMPLATE_INPUT"
    ];
    for (const errorType of errorTypes) {
      const fixture = serviceFixture(new ErrorRestExecutor(errorType));
      await fixture.service.create({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        runMode: "STAGED"
      });
      await fixture.service.start({ runId: RUN_ID, expectedRevision: 0 });
      await fixture.service.waitForIdle();
      expect(fixture.runs.results.get(`${RUN_ID}:case-1`)).toMatchObject({
        status: "ERROR",
        errorType,
        errorMessage: errorType === "TEMPLATE_INPUT" ? "TEMPLATE_INPUT" : `REST_${errorType}`
      });
    }
  });

  it("执行器异常、不完整结果、错位结果和进度 CAS 丢失均收敛为内部失败", async () => {
    const scenarios: readonly [RestExecutor, MemoryPlatformRunStore][] = [
      [new ThrowingRestExecutor(), new MemoryPlatformRunStore()],
      [new SilentRestExecutor(), new MemoryPlatformRunStore()],
      [new MisalignedRestExecutor(), new MemoryPlatformRunStore()],
      [new SuccessfulRestExecutor(), new ProgressConflictRunStore()]
    ];
    for (const [executor, runs] of scenarios) {
      const fixture = serviceFixture(executor, new MemoryArtifacts(), runs);
      await fixture.service.create({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        runMode: "STAGED"
      });
      await fixture.service.start({ runId: RUN_ID, expectedRevision: 0 });
      await fixture.service.waitForIdle();
      expect(runs.values.get(RUN_ID)).toMatchObject({
        status: "FAILED",
        stage: "DONE",
        errorCode: "INTERNAL_ERROR"
      });
    }
  });

  it("REST 提交 CAS 失败时删除未提交 Artifact，并服从取消或其他终态", async () => {
    for (const runs of [
      new CancellationWinsCompletionRunStore(),
      new TerminalWinsCompletionRunStore()
    ]) {
      const artifacts = new MemoryArtifacts();
      const fixture = serviceFixture(new SuccessfulRestExecutor(), artifacts, runs);
      await fixture.service.create({
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        runMode: "STAGED"
      });
      await fixture.service.start({ runId: RUN_ID, expectedRevision: 0 });
      await fixture.service.waitForIdle();
      expect(artifacts.removed).toHaveLength(1);
    }
    const cancellationRuns = new CancellationWinsCompletionRunStore();
    const cancellationFixture = serviceFixture(
      new SuccessfulRestExecutor(),
      new MemoryArtifacts(),
      cancellationRuns
    );
    await cancellationFixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await cancellationFixture.service.start({ runId: RUN_ID, expectedRevision: 0 });
    await cancellationFixture.service.waitForIdle();
    expect(cancellationRuns.values.get(RUN_ID)).toMatchObject({
      status: "CANCELLED",
      stage: "DONE"
    });
  });

  it("轮询观察其他进程取消，并支持多页读取完整 REST 结果", async () => {
    const blocking = serviceFixture(new BlockingRestExecutor());
    await blocking.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await blocking.service.start({ runId: RUN_ID, expectedRevision: 0 });
    const running = blocking.runs.values.get(RUN_ID);
    if (running === undefined) throw new Error("TEST_RUN_MISSING");
    blocking.runs.values.set(RUN_ID, {
      ...running,
      cancelRequestedAt: NOW,
      lockRevision: running.lockRevision + 1
    });
    await blocking.service.waitForIdle();
    expect(blocking.runs.values.get(RUN_ID)).toMatchObject({ status: "CANCELLED" });

    const pagedRuns = new PagedResultRunStore();
    const paged = serviceFixture(new SuccessfulRestExecutor(), new MemoryArtifacts(), pagedRuns);
    await paged.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    await paged.service.start({ runId: RUN_ID, expectedRevision: 0 });
    await paged.service.waitForIdle();
    expect(pagedRuns.values.get(RUN_ID)).toMatchObject({ status: "READY", stage: "EVALUATION" });
  });
});
