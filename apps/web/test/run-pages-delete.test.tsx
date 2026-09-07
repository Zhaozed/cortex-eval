// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunListPage } from "../src/features/runs/run-list-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { requestUrl } from "./request-fixture.ts";
import {
  ENDPOINT_ID,
  EVALUATOR_ID,
  RUN_ID,
  RUN_TIME,
  SUITE_ID,
  runPage
} from "./run-test-fixture.ts";

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

describe("Run 列表删除", () => {
  it("列表行删除确认后调用 DELETE 并刷新列表", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      const endpoint = url.includes("endpoint-configs");
      return Promise.resolve(
        response({
          items: [
            ...(url.includes("test-suites")
              ? [
                  {
                    id: SUITE_ID,
                    name: "客服回归集",
                    description: "核心流程",
                    caseCount: 3,
                    revision: 1,
                    updatedAt: RUN_TIME,
                    latestRun: null
                  }
                ]
              : []),
            ...(url.includes("test-suites")
              ? []
              : [
                  {
                    kind: endpoint ? "ENDPOINT" : "LLM",
                    id: endpoint ? ENDPOINT_ID : EVALUATOR_ID,
                    name: endpoint ? "客服 Endpoint" : "Gemini Evaluator",
                    revision: 0,
                    updatedAt: RUN_TIME
                  }
                ])
          ],
          nextCursor: null
        })
      );
    });
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/v1/runs?")) {
        return Promise.resolve(response(runPage()));
      }
      if (url === `/api/v1/runs/${RUN_ID}` && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={vi.fn()}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(await screen.findByText(RUN_ID)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(runFetcher).toHaveBeenCalledWith(
        `/api/v1/runs/${RUN_ID}`,
        expect.objectContaining({ method: "DELETE" })
      )
    );
    confirmSpy.mockRestore();
  });
});
