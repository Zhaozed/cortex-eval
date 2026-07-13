// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardPage } from "../src/features/dashboard/dashboard-page.tsx";
import { requestUrl } from "./request-fixture.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";

interface SuiteSummaryFixture {
  /** Test Suite identity. */
  readonly id: string;
  /** Test Suite display name. */
  readonly name: string;
  /** Empty fixture description. */
  readonly description: string;
  /** Aggregate Case count. */
  readonly caseCount: number;
  /** Fixture revision. */
  readonly revision: number;
  /** Fixture update timestamp. */
  readonly updatedAt: string;
}

interface ConfigurationSummaryFixture {
  /** Configuration discriminator. */
  readonly kind: string;
  /** Configuration identity. */
  readonly id: string;
  /** Configuration display name. */
  readonly name: string;
  /** Fixture revision. */
  readonly revision: number;
  /** Fixture update timestamp. */
  readonly updatedAt: string;
}

const suite = (id: string, name: string, caseCount: number): SuiteSummaryFixture => ({
  id,
  name,
  description: "",
  caseCount,
  revision: 0,
  updatedAt: "2026-07-13T00:00:00.000Z"
});

const config = (kind: string, id: string, name: string): ConfigurationSummaryFixture => ({
  kind,
  id,
  name,
  revision: 0,
  updatedAt: "2026-07-13T00:00:00.000Z"
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("资源 Dashboard", () => {
  it("逐页计算测试集、Case 和四类配置的精确数量", async () => {
    const ids = [
      "018f0f4e-7b7a-7cc0-8000-000000000001",
      "018f0f4e-7b7a-7cc0-8000-000000000002",
      "018f0f4e-7b7a-7cc0-8000-000000000003"
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/test-suites?limit=200") {
        return Promise.resolve(
          response({
            items: [suite(ids[0] ?? "", "A", 2), suite(ids[1] ?? "", "B", 3)],
            nextCursor: "res_v1_next"
          })
        );
      }
      if (url === "/api/v1/test-suites?cursor=res_v1_next&limit=200") {
        return Promise.resolve(
          response({ items: [suite(ids[2] ?? "", "C", 4)], nextCursor: null })
        );
      }
      const kind = url.includes("endpoint-configs")
        ? "ENDPOINT"
        : url.includes("llm-configs")
          ? "LLM"
          : url.includes("llm-rubric-prompts")
            ? "LLM_RUBRIC_PROMPT"
            : "CASE_ANALYSIS_PROMPT";
      const count =
        kind === "ENDPOINT" ? 2 : kind === "LLM" ? 1 : kind === "LLM_RUBRIC_PROMPT" ? 3 : 4;
      return Promise.resolve(
        response({
          items: Array.from({ length: count }, (_, index) =>
            config(kind, ids[index % ids.length] ?? "", `${kind}-${index}`)
          ),
          nextCursor: null
        })
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <DashboardPage api={createResourceApi(fetcher)} />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "资源仪表盘" })).toBeInTheDocument();
    expect(await screen.findByTestId("count-test-suites")).toHaveTextContent("3");
    expect(screen.getByTestId("count-cases")).toHaveTextContent("9");
    expect(screen.getByTestId("count-endpoint-configs")).toHaveTextContent("2");
    expect(screen.getByTestId("count-llm-configs")).toHaveTextContent("1");
    expect(screen.getByTestId("count-rubric-prompts")).toHaveTextContent("3");
    expect(screen.getByTestId("count-analysis-prompts")).toHaveTextContent("4");
  });

  it("请求失败时显示可重试页面错误，不永久 Loading", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { invalid: true } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <DashboardPage api={createResourceApi(fetcher)} />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("资源数量读取失败");
    expect(screen.getByRole("button", { name: "重新读取" })).toBeInTheDocument();
    expect(screen.queryByText("正在读取资源数量")).not.toBeInTheDocument();
  });
});
