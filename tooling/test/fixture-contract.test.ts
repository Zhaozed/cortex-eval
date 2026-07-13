import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validatePromptfooEvalFixture,
  validateRestResultFixture
} from "../src/fixture-contract.ts";

describe("真实 Fixture 契约", () => {
  it("当前 REST 与 Promptfoo 结果通过基线结构校验", async () => {
    const rest = JSON.parse(
      await readFile(resolve("test_suite/current/run_result/test_example.json"), "utf8")
    ) as unknown;
    const evaluation = JSON.parse(
      await readFile(resolve("test_suite/current/eval_result/test_example.json"), "utf8")
    ) as unknown;

    expect(validateRestResultFixture(rest).caseCount).toBeGreaterThan(0);
    expect(validatePromptfooEvalFixture(evaluation).resultCount).toBeGreaterThan(0);
  });

  it("拒绝空数组、缺失 Case ID 和未知 Promptfoo 外层", () => {
    expect(() => validateRestResultFixture([])).toThrow("FIXTURE_REST_ARRAY");
    expect(() => validateRestResultFixture([null])).toThrow("FIXTURE_REST_CASE:0");
    expect(() => validateRestResultFixture([{ metadata: {} }])).toThrow("FIXTURE_REST_CASE_ID:0");
    expect(() => validatePromptfooEvalFixture({})).toThrow("FIXTURE_PROMPTFOO_RESULTS");
    expect(() => validatePromptfooEvalFixture({ results: { results: [] } })).toThrow(
      "FIXTURE_PROMPTFOO_EMPTY"
    );
    expect(() =>
      validatePromptfooEvalFixture({ results: { results: [{ success: "yes" }] } })
    ).toThrow("FIXTURE_PROMPTFOO_ROW:0");
  });

  it("拒绝重复 Case、缺失组件和不可识别的 Assertion 组件", () => {
    expect(() =>
      validateRestResultFixture([
        { metadata: { case_id: "duplicate" } },
        { metadata: { case_id: "duplicate" } }
      ])
    ).toThrow("FIXTURE_REST_DUPLICATE_CASE_ID:1");
    expect(() =>
      validatePromptfooEvalFixture({
        results: { results: [{ success: true, gradingResult: {} }] }
      })
    ).toThrow("FIXTURE_PROMPTFOO_COMPONENTS:0");
    expect(() =>
      validatePromptfooEvalFixture({
        results: {
          results: [
            {
              success: true,
              gradingResult: {
                componentResults: [{ pass: true, score: 1, reason: "ok", assertion: {} }]
              }
            }
          ]
        }
      })
    ).toThrow("FIXTURE_PROMPTFOO_ASSERTION:0:0");
  });
});
