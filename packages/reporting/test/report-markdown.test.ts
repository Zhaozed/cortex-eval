import { describe, expect, it } from "vitest";

import { renderReportMarkdownCase, renderReportMarkdownHeader } from "../src/report-markdown.ts";

describe("Report Markdown 单向渲染", () => {
  it("渲染总体、By Metric、失败 Assertion、既有 Diff 和 Rubric Reason", () => {
    const header = renderReportMarkdownHeader({
      owner: { kind: "EXECUTION", id: "execution-1" },
      completedAt: "2026-07-15T00:00:00.000Z",
      summary: {
        total: 2,
        restSucceeded: 2,
        restError: 0,
        evalPass: 1,
        evalFail: 1,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 0.5,
        evaluatedPassRate: 0.5,
        coverageRate: 1
      },
      byMetric: [
        {
          metric: "quality",
          pass: 1,
          fail: 1,
          error: 0,
          skipped: 0,
          notEvaluated: 0,
          passRate: 0.5
        }
      ]
    });
    const body = renderReportMarkdownCase({
      caseKey: "case|1",
      ordinal: 1,
      status: "FAIL",
      reason: "Rubric 判断不通过",
      evaluationErrorCode: null,
      assertions: [
        {
          index: 0,
          type: "is-json",
          metric: "quality",
          status: "FAIL",
          score: 0,
          reason: "缺少 answer"
        },
        {
          index: 1,
          type: "llm-rubric",
          metric: "quality",
          status: "FAIL",
          score: 0.2,
          reason: "Rubric 判断不通过"
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
          reason: "缺少必填字段"
        }
      ]
    });

    expect(header).toContain("50.00%");
    expect(header).toContain("quality");
    expect(body).toContain("case\\|1");
    expect(body).toContain("Rubric 判断不通过");
    expect(body).toContain('`{"kind":"MISSING"}`');
    expect(body).toContain("/answer");
  });

  it("空 Rate 显示短横线，PASS Case 不生成失败正文", () => {
    expect(
      renderReportMarkdownHeader({
        owner: { kind: "RUN", id: "run-1" },
        completedAt: "2026-07-15T00:00:00.000Z",
        summary: {
          total: 1,
          restSucceeded: 0,
          restError: 1,
          evalPass: 0,
          evalFail: 0,
          evalError: 0,
          notEvaluated: 1,
          effectivePassRate: 0,
          evaluatedPassRate: null,
          coverageRate: 0
        },
        byMetric: []
      })
    ).toContain("—");
    expect(
      renderReportMarkdownCase({
        caseKey: "case-1",
        ordinal: 0,
        status: "PASS",
        reason: null,
        evaluationErrorCode: null,
        assertions: [],
        diffs: []
      })
    ).toBe("");
  });

  it("转义外部文本中的原始 HTML、反引号和所有换行形式", () => {
    const body = renderReportMarkdownCase({
      caseKey: "case-unsafe",
      ordinal: 0,
      status: "FAIL",
      reason: "<img src=x onerror=alert(1)> `case`\rfirst\r\nsecond\nthird",
      evaluationErrorCode: null,
      assertions: [
        {
          index: 0,
          type: "llm-rubric",
          metric: "quality",
          status: "FAIL",
          score: 0,
          reason: "<script>alert(1)</script> `assertion`\rline"
        }
      ],
      diffs: []
    });

    expect(body).toContain("&lt;img");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script>");
    expect(body).toContain("\\`case\\`");
    expect(body).toContain("\\`assertion\\`");
    expect(body).not.toContain("\r");
    expect(body).toContain("first second third");
  });
});
