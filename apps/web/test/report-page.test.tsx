// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReportPage } from "../src/features/reports/report-page.tsx";
import { createRunApi } from "../src/lib/run-api.ts";
import { requestUrl } from "./request-fixture.ts";
import { RUN_ID, runReportCase, runReportOverview } from "./run-test-fixture.ts";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const failedCase = {
  ...runReportCase,
  definition: {
    ...runReportCase.definition,
    assert: [
      {
        type: "is-json",
        metric: "quality",
        value: { type: "object", required: ["reply"] },
        weight: 1
      }
    ]
  },
  evaluation: {
    ...runReportCase.evaluation,
    status: "FAIL" as const,
    promptfooSuccess: false,
    score: 0,
    reason: "缺少 reply 字段",
    assertions: [
      {
        ...runReportCase.evaluation.assertions[0],
        type: "is-json",
        status: "FAIL" as const,
        score: 0,
        reason: "必填字段缺失"
      }
    ],
    diffs: [
      {
        assertionIndex: 0,
        instancePath: "",
        schemaPath: "#/required",
        keyword: "required",
        expectedConstraint: ["reply"],
        actual: { missing: "reply" },
        reason: "必须包含 reply",
        validatorVersion: "ajv@8",
        schemaDialect: "https://json-schema.org/draft/2020-12/schema",
        diffContractVersion: "cortex.assertion-diff.v1" as const
      }
    ],
    metrics: [{ metric: "quality", status: "FAIL" as const }]
  }
};

describe("Report 页面", () => {
  it("展示规范化统计、来源、证据、过滤、Assertion Diff 和导出入口", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) {
        return Promise.resolve(response(runReportOverview));
      }
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return Promise.resolve(response({ items: [failedCase], nextCursor: null }));
      }
      if (url === `/api/v1/runs/${RUN_ID}/report/cases/case-1`) {
        return Promise.resolve(response(failedCase));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ReportPage api={createRunApi(fetcher)} runId={RUN_ID} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "运行报告" })).toBeInTheDocument();
    expect(screen.getByText("离线导入")).toBeInTheDocument();
    expect(screen.getAllByText("100.0%").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("缺失").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: "导出 JSON" })).toHaveAttribute(
      "href",
      `/api/v1/runs/${RUN_ID}/report/export`
    );

    await userEvent.type(screen.getByLabelText("Metric"), "quality");
    await userEvent.type(screen.getByLabelText("业务模块"), "客服");
    await userEvent.click(screen.getByRole("button", { name: "应用过滤" }));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("businessModule=%E5%AE%A2%E6%9C%8D"),
        expect.anything()
      );
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("metric=quality"),
        expect.anything()
      );
    });

    await userEvent.click(await screen.findByRole("button", { name: "查看 case-1" }));
    expect(await screen.findByRole("heading", { name: "Case case-1" })).toBeInTheDocument();
    expect(screen.getByText("is-json")).toBeInTheDocument();
    expect(screen.getByText("必填字段缺失")).toBeInTheDocument();
    expect(screen.getByText("#/required")).toBeInTheDocument();
    expect(screen.getByText("必须包含 reply")).toBeInTheDocument();
  });

  it("报告读取失败后可重试，并保持服务端错误为页面事实", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("REPORT_UNAVAILABLE"));
        return Promise.resolve(response(runReportOverview));
      }
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return Promise.resolve(response({ items: [], nextCursor: null }));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ReportPage api={createRunApi(fetcher)} runId={RUN_ID} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    expect(await screen.findByText("运行报告读取失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("heading", { name: "运行报告" })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("展示空分母与全部 Evidence 状态，并按 Cursor 前后翻页和关闭 Case 详情", async () => {
    const onNavigate = vi.fn();
    const emptyCase = {
      ...runReportCase,
      evaluation: {
        ...runReportCase.evaluation,
        reason: null,
        assertions: [],
        diffs: []
      },
      rawEvidenceStatus: "PRESENT" as const
    };
    const overview = {
      ...runReportOverview,
      sourceType: "PLATFORM" as const,
      summary: {
        ...runReportOverview.summary,
        effectivePassRate: null,
        evaluatedPassRate: null,
        coverageRate: null
      },
      byMetric: [{ ...runReportOverview.byMetric[0], passRate: null }],
      context: {
        ...runReportOverview.context,
        suite: { ...runReportOverview.context.suite, name: null },
        endpoint: { ...runReportOverview.context.endpoint, name: null },
        evaluator: { ...runReportOverview.context.evaluator, name: null }
      },
      artifactAvailability: [
        { ...runReportOverview.artifactAvailability[0], status: "PRESENT" as const },
        {
          kind: "REPORT_MARKDOWN" as const,
          path: `runs/${RUN_ID}/report.md`,
          status: "CORRUPTED" as const
        }
      ]
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) return Promise.resolve(response(overview));
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`) && url.includes("cursor=next")) {
        return Promise.resolve(
          response({ items: [{ ...emptyCase, rawEvidenceStatus: "CORRUPTED" }], nextCursor: null })
        );
      }
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return Promise.resolve(response({ items: [emptyCase], nextCursor: "next" }));
      }
      if (url === `/api/v1/runs/${RUN_ID}/report/cases/case-1`) {
        return Promise.resolve(response({ ...emptyCase, rawEvidenceStatus: "ABSENT" }));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ReportPage api={createRunApi(fetcher)} runId={RUN_ID} onNavigate={onNavigate} />
      </QueryClientProvider>
    );

    expect(await screen.findByText("平台")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText("名称不可用")).toHaveLength(3);
    expect(screen.getAllByText("存在").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("损坏")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回运行" }));
    expect(onNavigate).toHaveBeenCalledWith("/runs");

    await userEvent.click(await screen.findByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("cursor=next"),
        expect.anything()
      )
    );
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    await userEvent.click(await screen.findByRole("button", { name: "查看 case-1" }));
    expect(await screen.findByText("该 Case 没有 Assertion 结果。")).toBeInTheDocument();
    expect(screen.getByText("该 Case 没有结构差异。")).toBeInTheDocument();
    expect(screen.getByText("未生成")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Case case-1" })).toBeNull());
  });

  it("Case 分页失败时显示独立错误，不污染报告统计", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) {
        return Promise.resolve(response(runReportOverview));
      }
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return Promise.reject(new Error("CASE_PAGE_FAILED"));
      }
      return Promise.reject(new Error("CASE_DETAIL_FAILED"));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ReportPage api={createRunApi(fetcher)} runId={RUN_ID} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "运行报告" })).toBeInTheDocument();
    expect(await screen.findByText("报告 Case 读取失败")).toBeInTheDocument();
  });

  it("Case 详情失败时保持 Sheet 并显示稳定错误", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) {
        return Promise.resolve(response(runReportOverview));
      }
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return Promise.resolve(response({ items: [runReportCase], nextCursor: null }));
      }
      return Promise.reject(new Error("CASE_DETAIL_FAILED"));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ReportPage api={createRunApi(fetcher)} runId={RUN_ID} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "查看 case-1" }));
    expect(await screen.findByText("Case 报告读取失败")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Case case-1" })).toBeInTheDocument();
  });
});
