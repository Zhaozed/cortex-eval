import { describe, expect, it } from "vitest";

import {
  hashAnalysisInput,
  hashAssertionDefinition,
  hashCaseDefinition,
  hashEvaluationContext,
  hashExecutionContext,
  hashEvalResult,
  hashEvalResultSet,
  hashFinalCaseResult,
  hashRunContext
} from "../src/domain-hash-inputs.ts";

const HASH = "f".repeat(64);

describe("Domain 专用哈希输入", () => {
  it("Case、Run Context、Final Result 和 Analysis Input 使用各自版本化完整输入", () => {
    const assertionHash = hashAssertionDefinition({
      contractVersion: "cortex.assertion-definition.v1",
      definition: { type: "equals", metric: "quality", weight: 1, value: "ok" }
    });
    const caseHash = hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: "case-1",
      definition: { task: "route" }
    });
    const runHash = hashRunContext({
      contractVersion: "cortex.run-context.v1",
      suiteHash: HASH,
      endpointConfigHash: HASH,
      evaluatorConfigHash: HASH,
      rubricPromptSetHash: HASH,
      promptfooVersion: "0.121.18",
      runExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 }
    });
    const finalHash = hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: caseHash,
      restResultHash: HASH,
      evalResultHash: HASH
    });
    const analysisHash = hashAnalysisInput({
      contractVersion: "cortex.analysis-input.v1",
      finalCaseResultHash: finalHash,
      runContextHash: runHash,
      diffContractVersion: "cortex.assertion-diff.v1",
      variables: { case_definition: { task: "route" } },
      analysisPromptHash: HASH,
      analyzerConfigHash: HASH,
      analysisOutputContractVersion: "cortex.analysis-output.v1",
      analysisExecutionLimits: { analysisConcurrency: 1 }
    });
    expect(
      [assertionHash, caseHash, runHash, finalHash, analysisHash].every((item) =>
        /^[0-9a-f]{64}$/.test(item)
      )
    ).toBe(true);
    expect(new Set([assertionHash, caseHash, runHash, finalHash, analysisHash]).size).toBe(5);
  });

  it("执行限制属于对应身份哈希", () => {
    const base = {
      contractVersion: "cortex.run-context.v1" as const,
      suiteHash: HASH,
      endpointConfigHash: HASH,
      evaluatorConfigHash: HASH,
      rubricPromptSetHash: HASH,
      promptfooVersion: "0.121.18",
      runExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 }
    };
    expect(hashRunContext(base)).not.toBe(
      hashRunContext({
        ...base,
        runExecutionLimits: { ...base.runExecutionLimits, restConcurrency: 5 }
      })
    );
  });

  it("Evaluation Context 绑定执行版本、REST 事实、能力矩阵和确定性调用预算", () => {
    const input = {
      contractVersion: "cortex.evaluation-context.v1" as const,
      executionBinding: { kind: "RUN" as const, id: "018f1e2d-3c4b-7abc-8def-0123456789ab" },
      runContextHash: HASH,
      restResultSetHash: "a".repeat(64),
      evaluatorConfigHash: "b".repeat(64),
      promptfooVersion: "0.121.18",
      configContractVersion: "cortex.promptfoo-config.v1",
      capabilityMatrixHash: "c".repeat(64),
      evaluatorCallBudget: 3
    };

    const hash = hashEvaluationContext(input);
    expect(hash).not.toBe(
      hashEvaluationContext({ ...input, evaluatorCallBudget: input.evaluatorCallBudget + 1 })
    );
    expect(hash).not.toBe(
      hashEvaluationContext({
        ...input,
        executionBinding: { kind: "EXECUTION", id: input.executionBinding.id }
      })
    );
  });

  it("离线 Execution Context 同时包含 Manifest 与两类执行限制", () => {
    const input = {
      contractVersion: "cortex.execution-context.v1" as const,
      packageId: "package-1",
      manifestHash: HASH,
      runExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 },
      analysisExecutionLimits: { analysisConcurrency: 1 }
    };
    const hash = hashExecutionContext(input);
    expect(hash).not.toBe(
      hashExecutionContext({
        ...input,
        analysisExecutionLimits: { analysisConcurrency: 2 }
      })
    );
    expect(hash).not.toBe(
      hashExecutionContext({
        ...input,
        runExecutionLimits: { ...input.runExecutionLimits, evalConcurrency: 3 }
      })
    );
  });

  it("Eval Hash 包含规范化语义事实并排除执行观测与 Artifact 完整性", () => {
    const input = {
      contractVersion: "cortex.eval-result.v1" as const,
      caseKey: "case-1",
      status: "FAIL" as const,
      promptfooSuccess: false,
      score: 0,
      reason: "schema mismatch",
      evaluationError: null,
      assertions: [
        {
          index: 0,
          definitionHash: HASH,
          type: "is-json",
          metric: "schema",
          weight: 1,
          status: "FAIL" as const,
          score: 0,
          reason: "mismatch"
        }
      ],
      diffs: [
        {
          assertionIndex: 0,
          instancePath: "/value",
          schemaPath: "/properties/value/type",
          keyword: "type",
          expectedConstraint: "string",
          actual: 1,
          reason: "类型不匹配",
          validatorVersion: "8.17.1",
          schemaDialect: "https://json-schema.org/draft/2020-12/schema",
          diffContractVersion: "cortex.assertion-diff.v1" as const
        }
      ],
      metrics: [{ metric: "schema", status: "FAIL" as const }],
      latencyMs: 12,
      tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      cost: 0.01,
      rawEvidence: { present: true, expectedSha256: HASH, expectedSizeBytes: 10 }
    };
    const firstAssertion = input.assertions[0];
    if (firstAssertion === undefined) throw new Error("TEST_ASSERTION_MISSING");
    const value = hashEvalResult(input);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const changedExecutionObservations = {
      ...input,
      latencyMs: 13,
      tokenUsage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      cost: 0.5,
      rawEvidence: {
        present: false,
        expectedSha256: "2".repeat(64),
        expectedSizeBytes: 99
      }
    };
    expect(value).toBe(hashEvalResult(changedExecutionObservations));
    expect(value).not.toBe(
      hashEvalResult({
        ...input,
        assertions: [{ ...firstAssertion, metric: "other" }]
      })
    );
  });

  it("Eval Result Set 按冻结 Ordinal 归一并拒绝缺口与重复 Case", () => {
    const second = { caseKey: "case-2", ordinal: 1, evalResultHash: "2".repeat(64) };
    const first = { caseKey: "case-1", ordinal: 0, evalResultHash: "1".repeat(64) };
    const cases = [second, first];
    const version = {
      owner: { kind: "RUN" as const, id: "01900000-0000-7000-8000-000000000001" },
      evaluationContextHash: HASH
    };
    expect(
      hashEvalResultSet({ contractVersion: "cortex.eval-result-set.v1", ...version, cases })
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        ...version,
        cases: [{ ...second, ordinal: 2 }]
      })
    ).toThrow("EVAL_RESULT_SET_ALIGNMENT");
    expect(() =>
      hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        ...version,
        cases: [first, { ...first, ordinal: 1 }]
      })
    ).toThrow("EVAL_RESULT_SET_ALIGNMENT");
  });

  it("Eval Result Set 绑定执行身份与 Evaluation Context", () => {
    const cases = [{ caseKey: "case-1", ordinal: 0, evalResultHash: "1".repeat(64) }];
    const source = hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
      evaluationContextHash: "a".repeat(64),
      cases
    });
    const retry = hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000002" },
      evaluationContextHash: "a".repeat(64),
      cases
    });

    expect(retry).not.toBe(source);
  });
});
