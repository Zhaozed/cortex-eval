import { describe, expect, it } from "vitest";

import {
  hashAnalysisInput,
  hashCaseDefinition,
  hashExecutionContext,
  hashFinalCaseResult,
  hashRunContext
} from "../src/domain-hash-inputs.ts";

const HASH = "f".repeat(64);

describe("Domain 专用哈希输入", () => {
  it("Case、Run Context、Final Result 和 Analysis Input 使用各自版本化完整输入", () => {
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
      [caseHash, runHash, finalHash, analysisHash].every((item) => /^[0-9a-f]{64}$/.test(item))
    ).toBe(true);
    expect(new Set([caseHash, runHash, finalHash, analysisHash]).size).toBe(4);
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
});
