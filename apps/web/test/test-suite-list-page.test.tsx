// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TestSuiteListPage } from "../src/features/test-suites/test-suite-list-page.tsx";
import { requestUrl } from "./request-fixture.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";

const suite = {
  id: "018f0f4e-7b7a-7cc0-8000-000000000001",
  name: "客服回归集",
  description: "核心客服场景",
  caseCount: 4,
  suiteHash: "a".repeat(64),
  revision: 0,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("测试集列表页面", () => {
  it("显示服务端列表并导航到详情", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        items: [
          {
            id: suite.id,
            name: suite.name,
            description: suite.description,
            caseCount: suite.caseCount,
            revision: suite.revision,
            updatedAt: suite.updatedAt
          }
        ],
        nextCursor: null
      })
    );
    const onNavigate = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TestSuiteListPage api={createResourceApi(fetcher)} onNavigate={onNavigate} />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("link", { name: "客服回归集" }));
    expect(onNavigate).toHaveBeenCalledWith(`/test-suites/${suite.id}`);
    expect(screen.getByRole("cell", { name: "4" })).toBeInTheDocument();
  });

  it("通过 Sheet 创建测试集并在成功后进入详情", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (init?.method === "POST") return Promise.resolve(response(suite, 201));
      return Promise.resolve(response({ items: [], nextCursor: null }));
    });
    const onNavigate = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TestSuiteListPage api={createResourceApi(fetcher)} onNavigate={onNavigate} />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建测试集" }));
    await userEvent.type(screen.getByRole("textbox", { name: "测试集名称" }), suite.name);
    await userEvent.type(screen.getByRole("textbox", { name: "测试集说明" }), suite.description);
    await userEvent.click(screen.getByRole("button", { name: "创建测试集" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`/test-suites/${suite.id}`));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/test-suites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: suite.name, description: suite.description })
      })
    );
  });

  it("创建请求在途冻结表单并阻止关闭 Sheet", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) =>
        init?.method === "POST"
          ? pendingCreate
          : Promise.resolve(response({ items: [], nextCursor: null }))
      );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onLeaveBlockedChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <TestSuiteListPage
          api={createResourceApi(fetcher)}
          onNavigate={vi.fn()}
          onLeaveBlockedChange={onLeaveBlockedChange}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建测试集" }));
    await userEvent.type(screen.getByRole("textbox", { name: "测试集名称" }), suite.name);
    await userEvent.click(screen.getByRole("button", { name: "创建测试集" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    );

    expect(screen.getByRole("textbox", { name: "测试集名称" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "测试集说明" })).toBeDisabled();
    expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "新建测试集" })).toBeInTheDocument();
    resolveCreate?.(response(suite, 201));
  });

  it("列表失败可重试，cursor 可前进并按历史返回", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(
          response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500)
        );
      }
      const url = requestUrl(input);
      return Promise.resolve(
        response({
          items: [
            {
              id: suite.id,
              name: suite.name,
              description: suite.description,
              caseCount: suite.caseCount,
              revision: suite.revision,
              updatedAt: suite.updatedAt
            }
          ],
          nextCursor: url.includes("cursor=next") ? null : "next"
        })
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteListPage api={createResourceApi(fetcher)} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    expect(await screen.findByText("测试集读取失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await userEvent.click(await screen.findByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("cursor=next"))).toBe(
        true
      )
    );
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(4));
  });

  it("创建失败保留 Sheet，并把必填错误关联到名称", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_UNIQUE_CONFLICT",
                message: "名称重复",
                requestId,
                field: "name"
              }
            },
            409
          )
        );
      }
      return Promise.resolve(response({ items: [], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteListPage api={createResourceApi(fetcher)} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建测试集" }));
    await userEvent.click(screen.getByRole("button", { name: "创建测试集" }));
    expect(await screen.findByText("此字段不能为空。")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "测试集名称" }), suite.name);
    await userEvent.click(screen.getByRole("button", { name: "创建测试集" }));
    expect(await screen.findByText("测试集创建失败，请检查字段或并发状态。")).toBeInTheDocument();
    expect(screen.getByText("服务端校验失败：name")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "测试集名称" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByRole("textbox", { name: "测试集名称" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "新建测试集" })).toBeInTheDocument();
  });
});
