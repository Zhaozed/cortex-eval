// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunListPage } from "../src/features/runs/run-list-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { RUN_ID, runPage } from "./run-test-fixture.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
}

describe("导入运行统一入口", () => {
  it("离线导入 Run 显示来源并进入统一详情", async () => {
    const importedPage = runPage();
    const item = importedPage.items[0];
    if (item === undefined) throw new Error("RUN_PAGE_FIXTURE_MISSING");
    const runFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        ...importedPage,
        items: [{ ...item, sourceType: "OFFLINE_IMPORT", status: "COMPLETED", stage: "DONE" }]
      })
    );
    const resourceFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ items: [], nextCursor: null }));
    const onNavigate = vi.fn();

    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={onNavigate}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(await screen.findByText("离线导入")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "客服回归集" }));
    expect(onNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`);
  });
});
