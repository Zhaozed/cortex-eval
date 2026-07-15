// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunDetailPage } from "../src/features/runs/run-detail-page.tsx";
import { RunListPage } from "../src/features/runs/run-list-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { requestUrl } from "./request-fixture.ts";
import {
  RUN_ID,
  RUN_TIME,
  runCasePage,
  runDetail,
  runEvalPage,
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

function inertEventSource(): {
  readonly addEventListener: (type: string, listener: (event: Event) => void) => void;
  readonly close: () => void;
} {
  return { addEventListener: () => undefined, close: () => undefined };
}

describe("Run Report 与重跑页面", () => {
  it("离线导入 Run 显示来源并直接进入完整报告", async () => {
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
    await userEvent.click(screen.getByRole("link", { name: RUN_ID }));
    expect(onNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}/report`);
  });

  it("终态平台 Run 提供 Report、Retry 和 Force，并展示新版本与复用计划", async () => {
    const completed = {
      ...runDetail({
        status: "COMPLETED",
        stage: "DONE",
        lockRevision: 4,
        rest: { total: 3, completed: 3, succeeded: 3, error: 0 },
        evaluation: {
          total: 3,
          completed: 3,
          passed: 2,
          failed: 1,
          error: 0,
          notEvaluated: 0
        }
      }),
      completedAt: RUN_TIME,
      artifactManifest: {
        contractVersion: "cortex.artifact-manifest.v1" as const,
        owner: { kind: "RUN" as const, id: RUN_ID },
        artifacts: [
          {
            kind: "REPORT_JSON" as const,
            path: `runs/${RUN_ID}/report.json`,
            expectedSha256: "a".repeat(64),
            expectedSizeBytes: 128,
            contractVersion: "cortex.report.v1"
          }
        ]
      },
      artifactAvailability: [
        {
          kind: "REPORT_JSON" as const,
          path: `runs/${RUN_ID}/report.json`,
          status: "PRESENT" as const
        }
      ]
    };
    const newRunId = "018f0f4e-7b7a-7cc0-8000-000000000009";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}`) return Promise.resolve(response(completed));
      if (url.includes("/cases?")) return Promise.resolve(response(runCasePage));
      if (url.includes("/evaluations?")) return Promise.resolve(response(runEvalPage));
      if (url.endsWith("/reruns") && init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("TEST_RERUN_BODY_INVALID");
        const mode = JSON.parse(init.body) as { readonly mode: "RETRY_FAILED" | "FORCE" };
        return Promise.resolve(
          response(
            {
              runId: newRunId,
              sourceRunId: RUN_ID,
              rerunMode: mode.mode,
              status: "READY",
              stage: "REST",
              lockRevision: 0,
              counts:
                mode.mode === "RETRY_FAILED"
                  ? { reuseRest: 2, executeRest: 1, reuseEval: 2, executeEval: 1 }
                  : { reuseRest: 0, executeRest: 3, reuseEval: 0, executeEval: 3 }
            },
            201
          )
        );
      }
      return Promise.resolve(response({ invalid: true }));
    });

    render(
      <QueryClientProvider client={client()}>
        <RunDetailPage
          api={createRunApi(fetcher, inertEventSource)}
          runId={RUN_ID}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("link", { name: "查看完整报告" })).toHaveAttribute(
      "href",
      `/runs/${RUN_ID}/report`
    );
    await userEvent.click(screen.getByRole("button", { name: "重跑系统失败" }));
    expect(await screen.findByText(/RETRY_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(RUN_ID)).toBeInTheDocument();
    expect(screen.getByText("REST 复用 2，执行 1；Eval 复用 2，执行 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: newRunId })).toHaveAttribute(
      "href",
      `/runs/${newRunId}`
    );

    await userEvent.click(screen.getByRole("button", { name: "强制全量重跑" }));
    expect(await screen.findByText(/FORCE/)).toBeInTheDocument();
    expect(screen.getByText("REST 复用 0，执行 3；Eval 复用 0，执行 3")).toBeInTheDocument();
  });
});
