import { describe, expect, it } from "vitest";

import { hashRestResult, hashRestResultSet } from "../src/domain-hash-inputs.ts";

const CASE_HASH = "a".repeat(64);

describe("REST 结果身份", () => {
  it("单 Case 哈希排除耗时和完成时间但包含完整规范化结果", () => {
    const input = {
      contractVersion: "cortex.rest-result.v1" as const,
      caseKey: "case-1",
      caseDefinitionHash: CASE_HASH,
      result: {
        status: "SUCCEEDED" as const,
        httpStatus: 200,
        providerOutput: { ok: false as const, errorMessage: "业务失败" }
      }
    };
    expect(hashRestResult(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRestResult(input)).not.toBe(
      hashRestResult({
        ...input,
        result: {
          status: "ERROR",
          httpStatus: 500,
          errorType: "HTTP_STATUS"
        }
      })
    );
  });

  it("结果集哈希按 Ordinal 对齐且拒绝缺口和重复 Case", () => {
    const first = { caseKey: "case-1", ordinal: 0, resultHash: "b".repeat(64) };
    const second = { caseKey: "case-2", ordinal: 1, resultHash: "c".repeat(64) };
    expect(
      hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [second, first]
      })
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [{ ...second, ordinal: 2 }, first]
      })
    ).toThrow("REST_RESULT_SET_ALIGNMENT");
    expect(() =>
      hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [first, { ...second, caseKey: first.caseKey }]
      })
    ).toThrow("REST_RESULT_SET_ALIGNMENT");
  });
});
