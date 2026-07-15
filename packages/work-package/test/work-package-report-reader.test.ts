import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import { describe, expect, it } from "vitest";

import { prepareWorkPackageReport } from "../src/work-package-report-reader.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function testCase(): FrozenRunCase {
  return {
    caseKey: "case-1",
    ordinal: 0,
    definitionHash: HASH_A,
    definition: {
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
      assertions: [{ type: "is-json", metric: "schema", weight: 1, value: { type: "object" } }]
    }
  };
}

function restResult(): OfflineRestCaseResult {
  return {
    caseKey: "case-1",
    ordinal: 0,
    caseDefinitionHash: HASH_A,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: {},
      parsedOutput: {}
    },
    errorType: null,
    errorMessage: null,
    durationMs: 1,
    completedAt: "2026-07-15T00:00:00.000Z",
    resultHash: HASH_A,
    provenance: null
  };
}

function evaluation(): EvalCaseV1 {
  return {
    caseKey: "case-1",
    ordinal: 0,
    status: "FAIL",
    promptfooSuccess: false,
    score: 0,
    reason: "schema mismatch",
    evaluationError: null,
    assertions: [
      {
        index: 0,
        definitionHash: HASH_A,
        type: "is-json",
        metric: "schema",
        weight: 1,
        status: "FAIL",
        score: 0,
        reason: "schema mismatch"
      }
    ],
    diffs: [
      {
        assertionIndex: 0,
        instancePath: "/answer",
        schemaPath: "#/required",
        keyword: "required",
        expectedConstraint: "answer",
        actual: { kind: "MISSING" },
        reason: "missing",
        validatorVersion: "8.20.0",
        schemaDialect: "https://json-schema.org/draft/2020-12/schema",
        diffContractVersion: "cortex.assertion-diff.v1"
      }
    ],
    metrics: [{ metric: "schema", status: "FAIL" }],
    latencyMs: null,
    tokenUsage: null,
    cost: null,
    rawEvidence: null,
    evalResultHash: HASH_B,
    finalCaseResultHash: HASH_C,
    provenance: null
  };
}

function source<Value>(value: Value, opens: number[]): () => AsyncIterable<Value> {
  return (): AsyncIterable<Value> => {
    opens.push(1);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Value> {
        yield await Promise.resolve(value);
      }
    };
  };
}

describe("Work Package Report 三流对账", () => {
  it("第一遍增量聚合，第二遍重放完整事实且不重新生成 Diff", async () => {
    const caseOpens: number[] = [];
    const restOpens: number[] = [];
    const evalOpens: number[] = [];
    const existingDiff = evaluation().diffs[0];
    const prepared = await prepareWorkPackageReport({
      owner: { kind: "EXECUTION", id: "018f22aa-33bb-7ccc-8ddd-fffffffffff1" },
      runContextHash: HASH_A,
      evaluationContextHash: HASH_B,
      evaluationResultSetHash: HASH_C,
      expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-1" : null),
      openCases: source(testCase(), caseOpens),
      openRestResults: source(restResult(), restOpens),
      openEvaluationResults: source(evaluation(), evalOpens)
    });

    expect(prepared.aggregation).toMatchObject({
      summary: { total: 1, evalFail: 1, effectivePassRate: 0 },
      byMetric: [{ metric: "schema", fail: 1, passRate: 0 }]
    });
    expect(caseOpens).toHaveLength(1);
    const results = [];
    for await (const item of prepared.openCases()) results.push(item);
    expect(results[0]?.evaluation.diffs[0]).toEqual(existingDiff);
    expect(caseOpens).toHaveLength(2);
    expect(restOpens).toHaveLength(2);
    expect(evalOpens).toHaveLength(2);
  });

  it("任一来源缺失、额外或错序时拒绝完整报告", async () => {
    const empty = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<never>> =>
          Promise.resolve({ done: true, value: undefined as never })
      })
    });
    await expect(
      prepareWorkPackageReport({
        owner: { kind: "EXECUTION", id: "018f22aa-33bb-7ccc-8ddd-fffffffffff1" },
        runContextHash: HASH_A,
        evaluationContextHash: HASH_B,
        evaluationResultSetHash: HASH_C,
        expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-1" : null),
        openCases: source(testCase(), []),
        openRestResults: empty,
        openEvaluationResults: source(evaluation(), [])
      })
    ).rejects.toThrow("REPORT_RECONCILIATION_FAILED");

    await expect(
      prepareWorkPackageReport({
        owner: { kind: "EXECUTION", id: "018f22aa-33bb-7ccc-8ddd-fffffffffff1" },
        runContextHash: HASH_A,
        evaluationContextHash: HASH_B,
        evaluationResultSetHash: HASH_C,
        expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-1" : null),
        openCases: source({ ...testCase(), ordinal: 1 }, []),
        openRestResults: source(restResult(), []),
        openEvaluationResults: source(evaluation(), [])
      })
    ).rejects.toThrow("REPORT_CASE_ALIGNMENT");
  });
});
