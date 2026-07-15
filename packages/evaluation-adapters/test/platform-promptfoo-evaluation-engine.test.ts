import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  disposeFrozenEvaluationRaw,
  isFrozenEvaluationRawSource
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import {
  hashEvaluationContext,
  hashRestResultSet
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import {
  FrozenPromptfooEvaluationEngine,
  PlatformPromptfooEvaluationEngine
} from "../src/platform-promptfoo-evaluation-engine.ts";
import { PromptfooRuntimePreflight } from "../src/promptfoo-runtime-preflight.ts";
import type { EvaluatorModelClient, EvaluatorModelResult } from "../src/evaluator-bridge-v2.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const CALL_ID = "01900000-0000-7000-8000-000000000002";
const HASH = "a".repeat(64);
const NOW = "2026-07-14T00:00:00.000Z";
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
  assertions: [{ type: "llm-rubric", metric: "quality", weight: 1, value: "be correct" }]
} as const;
const restResult: StoredRestCaseResult = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  definition,
  caseDefinitionHash: "b".repeat(64),
  status: "SUCCEEDED",
  httpStatus: 200,
  providerOutput: { ok: false, errorMessage: "business" },
  errorType: null,
  errorMessage: null,
  durationMs: 2,
  completedAt: NOW,
  resultHash: "c".repeat(64),
  provenance: null
};
const restResultSetHash = hashRestResultSet({
  contractVersion: "cortex.rest-result-set.v1",
  cases: [{ caseKey: "case-1", ordinal: 0, resultHash: restResult.resultHash }]
});

function run(): PlatformRun {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: "01900000-0000-7000-8000-000000000100",
      name: "Suite",
      suiteHash: HASH,
      cases: [{ caseKey: "case-1", ordinal: 0, definitionHash: "b".repeat(64), definition }]
    },
    endpoint: {
      sourceId: null,
      name: "Endpoint",
      configHash: HASH,
      definition: {
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 1_000,
        defaultConcurrency: 4
      }
    },
    evaluator: {
      sourceId: null,
      name: "Evaluator",
      configHash: HASH,
      definition: {
        providerType: "GOOGLE_GEMINI",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT"
      }
    },
    rubricPrompts: [],
    runContextHash: HASH,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: "RUNNING",
    stage: "EVALUATION",
    lockRevision: 3,
    cancelRequestedAt: null,
    restCompletedCount: 1,
    restErrorCount: 0,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: restResultSetHash,
    evaluationContextHash: null,
    evaluationResultSetHash: null,
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

describe("平台 Promptfoo Evaluation Engine", () => {
  it("即使 Case 不依赖脚本运行时也先拒绝不可用的固定 Promptfoo", async () => {
    const parent = join(
      tmpdir(),
      `cortex-eval-promptfoo-version-preflight-${process.pid}-${Date.now()}`
    );
    const base = run();
    const sourceCase = base.suite.cases[0];
    if (sourceCase === undefined) throw new Error("TEST_RUNTIME_CASE_MISSING");
    const preflight = new PromptfooRuntimePreflight({
      promptfooBinary: join(parent, "missing-promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: parent,
      timeoutMs: 10_000
    });

    await expect(preflight.check([sourceCase], new AbortController().signal)).resolves.toEqual({
      ok: false,
      path: "runtime.promptfoo"
    });
  });

  it("固定版本预检使用调用方取消信号并保持取消语义", async () => {
    const parent = join(
      tmpdir(),
      `cortex-eval-promptfoo-cancel-preflight-${process.pid}-${Date.now()}`
    );
    const base = run();
    const sourceCase = base.suite.cases[0];
    if (sourceCase === undefined) throw new Error("TEST_RUNTIME_CASE_MISSING");
    const controller = new AbortController();
    controller.abort();
    const preflight = new PromptfooRuntimePreflight({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: parent,
      timeoutMs: 10_000
    });

    await expect(preflight.check([sourceCase], controller.signal)).rejects.toThrow(
      "REQUEST_ABORTED"
    );
  });

  it("阶段前能力探测通过真实 Promptfoo 执行 Python 与 Ruby 内联 Assertion", async () => {
    const parent = join(tmpdir(), `cortex-eval-runtime-preflight-${process.pid}-${Date.now()}`);
    const base = run();
    const sourceCase = base.suite.cases[0];
    if (sourceCase === undefined) throw new Error("TEST_RUNTIME_CASE_MISSING");
    const runtimeRun: PlatformRun = {
      ...base,
      suite: {
        ...base.suite,
        cases: [
          {
            ...sourceCase,
            definition: {
              ...sourceCase.definition,
              assertions: [
                { type: "python", metric: "python", weight: 1, value: "output != ''" },
                { type: "ruby", metric: "ruby", weight: 1, value: "output != ''" }
              ]
            }
          }
        ]
      }
    };
    const preflight = new PromptfooRuntimePreflight({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: parent,
      timeoutMs: 10_000
    });

    await expect(
      preflight.check(runtimeRun.suite.cases, new AbortController().signal)
    ).resolves.toEqual({ ok: true });
    expect(await readdir(parent)).toEqual([]);
  }, 30_000);

  it("全部 Eval 复用时接受空子集并跳过 Promptfoo 与 Evaluator 外部调用", async () => {
    let evaluatorCreated = false;
    const engine = new PlatformPromptfooEvaluationEngine({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: tmpdir(),
      promptfooTimeoutMs: 10_000,
      capabilityMatrixHash: "d".repeat(64),
      requiresEvaluator: (): boolean => true,
      readSecret: (): undefined => undefined,
      createCallId: (): string => CALL_ID,
      createEvaluatorClient: (): EvaluatorModelClient => {
        evaluatorCreated = true;
        throw new Error("TEST_EVALUATOR_MUST_NOT_BE_CREATED");
      }
    });

    const result = await engine.execute({
      run: run(),
      restResults: [],
      restResultSetHash,
      signal: new AbortController().signal
    });

    expect(result.raw).toEqual({ results: { version: 3, results: [] } });
    expect(evaluatorCreated).toBe(false);
  });

  it("以调用期 Bridge 执行固定进程并返回版本化 Raw 事实", async () => {
    const parent = join(tmpdir(), `cortex-eval-engine-${process.pid}-${Date.now()}`);
    let calls = 0;
    const engine = new PlatformPromptfooEvaluationEngine({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: parent,
      promptfooTimeoutMs: 10_000,
      capabilityMatrixHash: "d".repeat(64),
      requiresEvaluator: (type): boolean => type === "llm-rubric",
      readSecret: (): undefined => undefined,
      createCallId: (): string => CALL_ID,
      createRawCapability: (): string => "A".repeat(43),
      now: (): Date => new Date(NOW),
      nowMilliseconds: (() => {
        let value = 1_000;
        return (): number => (value += 10);
      })(),
      createEvaluatorClient: (): EvaluatorModelClient => ({
        generate: (): Promise<EvaluatorModelResult> => {
          calls += 1;
          return Promise.resolve({
            text: JSON.stringify({ reason: "failed", score: 0, pass: false }),
            structured: null,
            tokenUsage: null
          });
        }
      })
    });

    const result = await engine.execute({
      run: run(),
      restResults: [restResult],
      restResultSetHash,
      signal: new AbortController().signal
    });

    try {
      expect(result).toMatchObject({
        promptfooVersion: "0.121.18",
        exitCode: 100,
        raw: { kind: "PROMPTFOO_RAW_SOURCE" }
      });
      if (!isFrozenEvaluationRawSource(result.raw)) throw new Error("TEST_RAW_SOURCE_MISSING");
      const rows: unknown[] = [];
      for await (const row of result.raw.openRows()) rows.push(row);
      expect(JSON.stringify(rows)).toContain('"reason":"failed"');
      expect(JSON.stringify(rows)).not.toContain("Cannot read properties of null");
      expect(result.evaluationContextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(calls).toBe(1);
    } finally {
      await disposeFrozenEvaluationRaw(result.raw);
    }
    expect(await readdir(parent)).toEqual([]);
  }, 30_000);

  it("离线 Execution 绑定独立计算 Evaluation Context 并在全 REST 错误时跳过进程", async () => {
    const engine = new FrozenPromptfooEvaluationEngine({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: tmpdir(),
      promptfooTimeoutMs: 10_000,
      capabilityMatrixHash: "d".repeat(64),
      requiresEvaluator: (): boolean => false,
      readSecret: (): undefined => undefined,
      createCallId: (): string => CALL_ID
    });
    const base = run();
    const result = await engine.execute({
      binding: { kind: "EXECUTION", id: RUN_ID },
      executionContextHash: base.runContextHash,
      caseSource: {
        open: async function* () {
          const testCase = base.suite.cases[0];
          if (testCase === undefined) throw new Error("TEST_RUNTIME_CASE_MISSING");
          yield await Promise.resolve({
            testCase,
            restResult: {
              caseKey: restResult.caseKey,
              ordinal: restResult.ordinal,
              caseDefinitionHash: restResult.caseDefinitionHash,
              status: "ERROR" as const,
              providerOutput: null
            }
          });
        }
      },
      evaluator: base.evaluator,
      rubricPrompts: base.rubricPrompts,
      promptfooVersion: base.promptfooVersion,
      evalConcurrency: base.runExecutionLimits.evalConcurrency,
      restResultSetHash,
      signal: new AbortController().signal
    });
    expect(result.raw).toEqual({ results: { version: 3, results: [] } });
    expect(result.evaluationContextHash).toBe(
      hashEvaluationContext({
        contractVersion: "cortex.evaluation-context.v1",
        executionBinding: { kind: "EXECUTION", id: RUN_ID },
        runContextHash: base.runContextHash,
        restResultSetHash,
        evaluatorConfigHash: base.evaluator.configHash,
        promptfooVersion: "0.121.18",
        configContractVersion: "cortex.promptfoo-config.v1",
        capabilityMatrixHash: "d".repeat(64),
        evaluatorCallBudget: 0
      })
    );
  });
});
