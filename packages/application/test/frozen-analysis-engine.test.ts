import { describe, expect, it } from "vitest";

import type { AnalysisModelClient } from "../src/features/case-analysis/case-analysis-model-client.ts";
import type { AnalysisCaseFacts } from "../src/features/case-analysis/case-analysis-input-builder.ts";
import {
  FrozenAnalysisEngine,
  type FrozenAnalysisCaseResult
} from "../src/features/case-analysis/frozen-analysis-engine.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function analysisCase(
  caseKey: string,
  ordinal: number,
  status: AnalysisCaseFacts["evaluation"]["status"]
): AnalysisCaseFacts {
  return {
    caseKey,
    ordinal,
    definitionHash: HASH_A,
    definition: {
      caseKey,
      description: "分析 Case",
      threshold: 1,
      task: "reply",
      requestBody: { text: caseKey },
      metadata: {
        requestId: `req-${ordinal}`,
        taskId: `task-${ordinal}`,
        businessModule: "support",
        scenarioTag: "reply"
      },
      assertions: [{ type: "equals", metric: "quality", weight: 1, value: "ok" }]
    },
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: {},
      parsedOutput: { answer: "wrong" }
    },
    evaluation: {
      status,
      finalCaseResultHash: ordinal % 2 === 0 ? HASH_B : HASH_C,
      assertions: [],
      diffs: []
    }
  };
}

function source(values: readonly AnalysisCaseFacts[]): {
  open: () => AsyncIterable<AnalysisCaseFacts>;
} {
  return {
    open: async function* (): AsyncGenerator<AnalysisCaseFacts> {
      for (const value of values) yield await Promise.resolve(value);
    }
  };
}

const analyzer = {
  configHash: HASH_B,
  definition: {
    providerType: "GOOGLE_GEMINI" as const,
    model: "analyzer",
    apiKey: { kind: "ENV_SECRET" as const, envKey: "ANALYZER_KEY" },
    thinkingLevel: "LOW" as const,
    temperature: 0,
    topP: 1,
    maxOutputTokens: 512,
    timeoutMs: 2_000,
    structuredOutput: "JSON_SCHEMA" as const
  }
};

const prompt = {
  promptHash: HASH_C,
  definition: {
    kind: "CASE_ANALYSIS" as const,
    promptKey: "analysis",
    messages: [{ role: "USER" as const, content: "{{case_definition}}" }]
  }
};

describe("Frozen Analysis Engine", () => {
  it("按冻结并发处理可分析 Case，隔离单 Case 模型错误且每 Case 只调用一次", async () => {
    const values = [
      analysisCase("case-fail-a", 0, "FAIL"),
      analysisCase("case-pass", 1, "PASS"),
      analysisCase("case-error", 2, "EVALUATION_ERROR"),
      analysisCase("case-fail-b", 3, "FAIL")
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = new Map<string, number>();
    const modelClient: AnalysisModelClient = {
      analyze: async ({ variables }) => {
        const metadata = variables.case_definition.metadata as { case_id?: unknown };
        const caseKey = String(metadata.case_id);
        calls.set(caseKey, (calls.get(caseKey) ?? 0) + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (caseKey === "case-error") {
          throw Object.assign(new Error("untrusted payload"), {
            code: "ANALYZER_OUTPUT_INVALID"
          });
        }
        return {
          classification: "NORMAL_FAILURE",
          confidence: 0.8,
          evidence: [
            {
              source: "failed_assertions",
              fieldPath: null,
              conclusion: "失败事实"
            }
          ],
          explanation: "结果不满足约束",
          recommendedAction: "修复系统"
        };
      }
    };
    const results: FrozenAnalysisCaseResult[] = [];
    const summary = await new FrozenAnalysisEngine(modelClient).execute({
      binding: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
      source: source(values),
      selector: "all",
      runContextHash: HASH_A,
      runContext: {},
      analyzer,
      prompt,
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 2
      },
      signal: new AbortController().signal,
      onResult: (result) => {
        results.push(result);
        return Promise.resolve();
      }
    });

    expect(summary).toMatchObject({ selectedCount: 3, succeededCount: 2, errorCount: 1 });
    expect(summary.finalCaseResultSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(results.map((item) => item.status).sort()).toEqual(["ERROR", "SUCCEEDED", "SUCCEEDED"]);
    expect(results.every((item) => /^[0-9a-f]{64}$/.test(item.analysisResultHash))).toBe(true);
    expect(maxInFlight).toBe(2);
    expect([...calls.values()]).toEqual([1, 1, 1]);
  });

  it("结果 Sink 失败属于 Stage 失败，停止派发且已领取的协作调用自行收口", async () => {
    const values = Array.from({ length: 5 }, (_, index) =>
      analysisCase(`case-${index}`, index, "FAIL")
    );
    let active = 0;
    const modelClient: AnalysisModelClient = {
      analyze: async () => {
        active += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          classification: "NORMAL_FAILURE",
          confidence: 1,
          evidence: [{ source: "run_context", fieldPath: null, conclusion: "失败" }],
          explanation: "失败",
          recommendedAction: "修复"
        };
      }
    };
    const engine = new FrozenAnalysisEngine(modelClient);
    await expect(
      engine.execute({
        binding: { kind: "EXECUTION", id: "01900000-0000-7000-8000-000000000001" },
        source: source(values),
        selector: "failed",
        runContextHash: HASH_A,
        runContext: {},
        analyzer,
        prompt,
        analysisExecutionLimits: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 2
        },
        signal: new AbortController().signal,
        onResult: () => Promise.reject(new Error("disk full"))
      })
    ).rejects.toMatchObject({ code: "ANALYSIS_RESULT_SINK_FAILED" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active).toBe(0);
  });

  it("模型调用前发布完整输入身份，开始 Sink 失败时不触发外部调用", async () => {
    let modelCalls = 0;
    const modelClient: AnalysisModelClient = {
      analyze: () => {
        modelCalls += 1;
        throw new Error("MUST_NOT_CALL");
      }
    };
    const engine = new FrozenAnalysisEngine(modelClient);
    await expect(
      engine.execute({
        binding: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
        source: source([analysisCase("case-1", 0, "FAIL")]),
        selector: "failed",
        runContextHash: HASH_A,
        runContext: {},
        analyzer,
        prompt,
        analysisExecutionLimits: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 1
        },
        signal: new AbortController().signal,
        onCaseStart: (started) => {
          expect(started).toMatchObject({
            caseKey: "case-1",
            ordinal: 0,
            finalCaseResultHash: HASH_B
          });
          expect(started.analysisInputHash).toMatch(/^[0-9a-f]{64}$/);
          return Promise.reject(new Error("database unavailable"));
        },
        onResult: () => Promise.resolve()
      })
    ).rejects.toMatchObject({ code: "ANALYSIS_RESULT_SINK_FAILED" });
    expect(modelCalls).toBe(0);
  });

  it("取消不发布 Case 结果并收敛为稳定 Stage 取消", async () => {
    const controller = new AbortController();
    let resultCount = 0;
    const modelClient: AnalysisModelClient = {
      analyze: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { code: "ANALYZER_CANCELLED" })),
            { once: true }
          );
        })
    };
    const execution = new FrozenAnalysisEngine(modelClient).execute({
      binding: { kind: "EXECUTION", id: "01900000-0000-7000-8000-000000000001" },
      source: source([analysisCase("case-1", 0, "FAIL")]),
      selector: "failed",
      runContextHash: HASH_A,
      runContext: {},
      analyzer,
      prompt,
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      },
      signal: controller.signal,
      onResult: () => {
        resultCount += 1;
        return Promise.resolve();
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "ANALYSIS_CANCELLED" });
    expect(resultCount).toBe(0);
  });

  it("Analyzer 忽略 Abort 且永不结束时，取消仍有界收敛", async () => {
    const controller = new AbortController();
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const modelClient: AnalysisModelClient = {
      analyze: () => {
        modelStarted?.();
        return new Promise(() => undefined);
      }
    };
    const execution = new FrozenAnalysisEngine(modelClient).execute({
      binding: { kind: "EXECUTION", id: "01900000-0000-7000-8000-000000000001" },
      source: source([analysisCase("case-1", 0, "FAIL")]),
      selector: "failed",
      runContextHash: HASH_A,
      runContext: {},
      analyzer,
      prompt,
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      },
      signal: controller.signal,
      onResult: () => Promise.resolve()
    });

    await started;
    controller.abort();
    const outcome = await Promise.race([
      execution.catch((error: unknown) => error),
      new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 50))
    ]);

    expect(outcome).toMatchObject({ code: "ANALYSIS_CANCELLED" });
  });

  it("一个结果 Sink 失败时，不等待另一个不协作的 Analyzer 调用", async () => {
    let callCount = 0;
    const modelClient: AnalysisModelClient = {
      analyze: () => {
        callCount += 1;
        if (callCount === 1) return new Promise(() => undefined);
        return Promise.resolve({
          classification: "NORMAL_FAILURE",
          confidence: 1,
          evidence: [{ source: "run_context", fieldPath: null, conclusion: "失败" }],
          explanation: "失败",
          recommendedAction: "修复"
        });
      }
    };
    const execution = new FrozenAnalysisEngine(modelClient).execute({
      binding: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
      source: source([
        analysisCase("case-never", 0, "FAIL"),
        analysisCase("case-sink-failure", 1, "FAIL")
      ]),
      selector: "failed",
      runContextHash: HASH_A,
      runContext: {},
      analyzer,
      prompt,
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 2
      },
      signal: new AbortController().signal,
      onResult: () => Promise.reject(new Error("disk full"))
    });

    const outcome = await Promise.race([
      execution.catch((error: unknown) => error),
      new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 50))
    ]);

    expect(callCount).toBe(2);
    expect(outcome).toMatchObject({ code: "ANALYSIS_RESULT_SINK_FAILED" });
  });
});
