// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RunRerunDialog } from "../src/features/runs/run-rerun-dialog.tsx";
import { RunWorkspacePage } from "../src/features/workspace/run-workspace-page.tsx";
import { createRunApi } from "../src/lib/run-api.ts";
import { RUN_ID, runDetail } from "./run-test-fixture.ts";
vi.mock("../src/lib/run-review-api.ts", () => ({
  runReviewApi: { list: vi.fn().mockResolvedValue([]) }
}));

it("rerun edits labels before creation, inherits defaults and never starts execution automatically", async () => {
  const api = createRunApi();
  const create = vi.spyOn(api, "createRerun").mockResolvedValue({
    runId: RUN_ID,
    sourceRunId: RUN_ID,
    rerunMode: "FORCE",
    status: "READY",
    stage: "REST",
    lockRevision: 0,
    counts: { reuseRest: 0, executeRest: 1, reuseEval: 0, executeEval: 1 }
  });
  const start = vi.spyOn(api, "start");
  const navigate = vi.fn();
  const run = { ...runDetail(), name: "原运行", description: "原测试目的" };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunRerunDialog api={api} run={run} onClose={vi.fn()} onNavigate={navigate} />
    </QueryClientProvider>
  );
  const name = screen.getByRole("textbox", { name: "运行名称" });
  const description = screen.getByRole("textbox", { name: /运行描述/ });
  expect(name).toHaveValue("原运行");
  expect(description).toHaveValue("原测试目的");
  await userEvent.clear(name);
  expect(screen.getByRole("button", { name: "创建运行" })).toBeDisabled();
  await userEvent.type(name, "新回归");
  await userEvent.clear(description);
  await userEvent.click(screen.getByRole("button", { name: "创建运行" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
  expect(create).toHaveBeenCalledWith(RUN_ID, "FORCE", expect.any(AbortSignal), {
    name: "新回归",
    description: ""
  });
  expect(start).not.toHaveBeenCalled();
  expect(run.name).toBe("原运行");
});

it("dashboard shows the saved purpose and name while retaining the suite identity", async () => {
  const api = createRunApi();
  vi.spyOn(api, "getRun").mockResolvedValue({
    ...runDetail(),
    name: "时间解析修复回归",
    description: "验证明天上午的日期解析"
  });
  vi.spyOn(api, "listCases").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, "listEvaluations").mockResolvedValue({ items: [], nextCursor: null });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RunWorkspacePage api={api} runId={RUN_ID} onNavigate={vi.fn()} />
    </QueryClientProvider>
  );
  expect(await screen.findByRole("heading", { name: "时间解析修复回归" })).toBeVisible();
  expect(screen.getByText("验证明天上午的日期解析")).toBeVisible();
  expect(screen.getByText("测试集：客服回归集")).toBeVisible();
});
