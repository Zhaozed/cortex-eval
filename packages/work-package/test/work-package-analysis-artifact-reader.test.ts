import type { AnalysisResultsArtifactV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { analysisResultFromBoundary } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import {
  hashAnalysisFinalCaseResultSet,
  hashAnalysisResult,
  hashAnalysisResultSet,
  type AnalysisResultHashInput
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import {
  readWorkPackageAnalysisArtifact,
  type WorkPackageAnalysisArtifactExpectation
} from "../src/work-package-analysis-artifact-reader.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const TIME = "2026-07-15T00:00:00.000Z";

function rehashArtifact(value: AnalysisResultsArtifactV1): void {
  for (const item of value.cases) {
    const result = ((): AnalysisResultHashInput["result"] => {
      if (item.status === "ERROR") {
        return { status: item.status, errorCode: item.error.code } as const;
      }
      const mapped = analysisResultFromBoundary({
        contractVersion: "cortex.analysis-output.v1",
        classification: item.classification,
        confidence: item.confidence,
        evidence: item.evidence,
        explanation: item.explanation,
        recommendedAction: item.recommendedAction,
        proposal: item.proposal
      });
      if (mapped === null) throw new Error("TEST_ANALYSIS_OUTPUT_INVALID");
      return {
        status: item.status,
        classification: mapped.classification,
        confidence: mapped.confidence,
        evidence: mapped.evidence,
        explanation: mapped.explanation,
        recommendedAction: mapped.recommendedAction,
        proposal: mapped.proposal === undefined ? null : analysisProposalJson(mapped.proposal)
      } as const;
    })();
    item.analysisResultHash = hashAnalysisResult({
      contractVersion: "cortex.analysis-result.v1",
      caseKey: item.caseKey,
      finalCaseResultHash: item.finalCaseResultHash,
      analysisInputHash: item.analysisInputHash,
      result
    });
  }
  value.finalCaseResultSetHash = hashAnalysisFinalCaseResultSet({
    contractVersion: "cortex.analysis-final-case-result-set.v1",
    selector: value.selector,
    cases: value.cases.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      finalCaseResultHash: item.finalCaseResultHash
    }))
  });
  value.analysisResultSetHash = hashAnalysisResultSet({
    contractVersion: "cortex.analysis-result-set.v1",
    owner: { kind: "EXECUTION", id: value.executionId },
    selector: value.selector,
    finalCaseResultSetHash: value.finalCaseResultSetHash,
    cases: value.cases.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      analysisResultHash: item.analysisResultHash
    }))
  });
}

function artifact(empty = false): AnalysisResultsArtifactV1 {
  const cases: AnalysisResultsArtifactV1["cases"] = empty
    ? []
    : [
        {
          caseKey: "case-2",
          ordinal: 1,
          finalCaseResultHash: "1".repeat(64),
          analysisInputHash: "2".repeat(64),
          analysisResultHash: "0".repeat(64),
          status: "SUCCEEDED",
          classification: "NORMAL_FAILURE",
          confidence: 0.9,
          evidence: [
            {
              source: "failed_assertions",
              fieldPath: "/0",
              conclusion: "冻结断言失败"
            }
          ],
          explanation: "结果违反业务约束",
          recommendedAction: "修复被测系统",
          proposal: null,
          error: null
        },
        {
          caseKey: "case-5",
          ordinal: 4,
          finalCaseResultHash: "3".repeat(64),
          analysisInputHash: "4".repeat(64),
          analysisResultHash: "0".repeat(64),
          status: "ERROR",
          classification: null,
          confidence: null,
          evidence: [],
          explanation: null,
          recommendedAction: null,
          proposal: null,
          error: { code: "ANALYZER_OUTPUT_INVALID", message: "分析输出结构无效" }
        }
      ];
  const value: AnalysisResultsArtifactV1 = {
    cases,
    completedAt: TIME,
    contractVersion: "cortex.analysis-results.v1",
    executionId: EXECUTION_ID,
    finalCaseResultSetHash: "0".repeat(64),
    packageId: PACKAGE_ID,
    selector: "all",
    analysisResultSetHash: "0".repeat(64)
  };
  rehashArtifact(value);
  return value;
}

function chunks(value: Uint8Array, size = 7): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      for (let offset = 0; offset < value.byteLength; offset += size) {
        yield value.subarray(offset, offset + size);
      }
    }
  };
}

function expectation(
  overrides: Partial<WorkPackageAnalysisArtifactExpectation> = {}
): WorkPackageAnalysisArtifactExpectation {
  const keys = new Map([
    [1, "case-2"],
    [4, "case-5"]
  ]);
  return {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    selector: "all",
    expectedCaseKey: (ordinal) => keys.get(ordinal) ?? null,
    signal: new AbortController().signal,
    ...overrides
  };
}

async function consume(
  value: unknown,
  overrides: Partial<WorkPackageAnalysisArtifactExpectation> = {}
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  for await (const item of readWorkPackageAnalysisArtifact(chunks(bytes), expectation(overrides))) {
    void item;
  }
}

describe("Work Package Analysis Artifact 流式读取", () => {
  it("跨任意 Chunk 读取稀疏 Case，并重算每层版本 Hash", async () => {
    const value = artifact();
    const reader = readWorkPackageAnalysisArtifact(
      chunks(Buffer.from(JSON.stringify(value), "utf8")),
      expectation()
    );
    const cases = [];
    let envelope: Awaited<ReturnType<typeof reader.next>>["value"] | undefined;
    for (;;) {
      const step = await reader.next();
      if (step.done) {
        envelope = step.value;
        break;
      }
      cases.push(step.value);
    }
    expect(cases).toEqual(value.cases);
    expect(envelope).toEqual({
      completedAt: TIME,
      selector: "all",
      finalCaseResultSetHash: value.finalCaseResultSetHash,
      analysisResultSetHash: value.analysisResultSetHash,
      selectedCount: 2
    });
  });

  it("允许空选择但仍绑定 Selector 和两个 Result Set Hash", async () => {
    const value = artifact(true);
    await expect(consume(value, { expectedCaseKey: () => null })).resolves.toBeUndefined();
  });

  it("拒绝字符串 Evidence、错序身份和任一 Hash 漂移", async () => {
    const value = artifact();
    const dirtyEvidence = structuredClone(value) as unknown as {
      cases: { evidence: unknown }[];
    };
    const first = dirtyEvidence.cases[0];
    if (first === undefined) throw new Error("TEST_CASE_MISSING");
    first.evidence = ["冻结断言失败"];
    const wrongOrder = { ...value, cases: [...value.cases].reverse() };
    const hashDrift = { ...value, analysisResultSetHash: "f".repeat(64) };
    for (const dirty of [dirtyEvidence, wrongOrder, hashDrift]) {
      await expect(consume(dirty)).rejects.toThrow("WORK_PACKAGE_INVALID");
    }
  });

  it("拒绝错误单 Case Result Hash、固定身份不匹配、截断和取消", async () => {
    const value = artifact();
    const dirtyCase = structuredClone(value);
    const first = dirtyCase.cases[0];
    if (first === undefined) throw new Error("TEST_CASE_MISSING");
    first.analysisResultHash = "f".repeat(64);
    await expect(consume(dirtyCase)).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(consume(value, { packageId: EXECUTION_ID })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const truncated = async (): Promise<void> => {
      for await (const item of readWorkPackageAnalysisArtifact(
        chunks(bytes.subarray(0, -2)),
        expectation()
      )) {
        void item;
      }
    };
    await expect(truncated()).rejects.toThrow("WORK_PACKAGE_INVALID");
    const controller = new AbortController();
    controller.abort();
    await expect(consume(value, { signal: controller.signal })).rejects.toThrow("REQUEST_ABORTED");
  });

  it("读取带转义字符串和 Proposal 的成功结果并重算语义 Hash", async () => {
    const value = artifact();
    const first = value.cases[0];
    if (first?.status !== "SUCCEEDED") {
      throw new Error("TEST_SUCCESS_CASE_MISSING");
    }
    first.evidence[0] = {
      source: "case_definition",
      fieldPath: "/assert/0/value",
      conclusion: '期望包含 "引号" 与 \\ 转义符'
    };
    first.proposal = {
      action: "ADD_ASSERTION",
      baseDefinitionHash: "a".repeat(64),
      targetAssertionIndex: 1,
      assertion: { type: "equals", metric: "quality", weight: 1, value: "alternative" }
    };
    rehashArtifact(value);

    await expect(consume(value)).resolves.toBeUndefined();
  });

  it("拒绝非法期望身份、Selector、Case 对齐和 Final Result Set Hash", async () => {
    const value = artifact();
    await expect(consume(value, { packageId: "invalid" })).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(consume(value, { executionId: "invalid" })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    await expect(consume(value, { selector: "failed" })).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(consume(value, { expectedCaseKey: () => "case-drift" })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    const finalHashDrift = { ...value, finalCaseResultSetHash: "f".repeat(64) };
    await expect(consume(finalHashDrift)).rejects.toThrow("WORK_PACKAGE_INVALID");
    const executionDrift = { ...value, executionId: PACKAGE_ID };
    await expect(consume(executionDrift)).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("拒绝错误 Header、数组分隔符、尾部逗号和超深 Case", async () => {
    const serialized = JSON.stringify(artifact());
    const malformed = [
      ` ${serialized}`,
      '{"case":[]}',
      serialized.replace('{"cases":[{', '{"cases":[,'),
      serialized.replace('},{"caseKey"', '} {"caseKey"'),
      serialized.replace('],"completedAt"', ',],"completedAt"')
    ];
    for (const text of malformed) {
      const read = async (): Promise<void> => {
        for await (const item of readWorkPackageAnalysisArtifact(
          chunks(Buffer.from(text, "utf8"), 5),
          expectation()
        )) {
          void item;
        }
      };
      await expect(read()).rejects.toThrow("WORK_PACKAGE_INVALID");
    }

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 260; depth += 1) nested = { child: nested };
    const tooDeep = { ...artifact(), cases: [{ nested }] };
    await expect(consume(tooDeep)).rejects.toThrow("WORK_PACKAGE_INVALID");
  });
});
