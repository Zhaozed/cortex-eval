// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DiagnosticReport } from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import {
  DIAG_RUN,
  DIAG_MODEL,
  diagnosticReportFixture
} from "@cortex-eval/contracts/test-support/diagnostic-report-fixture.ts";
import { RunDiagnosticControl } from "../src/features/runs/run-diagnostic-control.tsx";
import { RunDiagnosticDocument } from "../src/features/runs/run-diagnostic-document.tsx";
import { diagnosticReportApi } from "../src/lib/diagnostic-report-api.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";

function mount(
  report: DiagnosticReport | null = null,
  hasModel = true,
  ready = true
): { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  let current = report;
  const start = vi.fn(() => {
    current = diagnosticReportFixture();
    return Promise.resolve(current);
  });
  const cancel = vi.fn(() => {
    current = { ...(current ?? diagnosticReportFixture()), status: "CANCELLED", phase: "DONE" };
    return Promise.resolve(current);
  });
  const api = {
    ...diagnosticReportApi,
    list: (): Promise<DiagnosticReport[]> => Promise.resolve(current ? [current] : []),
    get: (): Promise<DiagnosticReport> => Promise.resolve(current ?? diagnosticReportFixture()),
    start,
    cancel
  };
  const resourceApi = {
    ...createResourceApi(),
    listConfigurations: (): ReturnType<
      ReturnType<typeof createResourceApi>["listConfigurations"]
    > =>
      Promise.resolve({
        items: hasModel
          ? [
              {
                kind: "LLM" as const,
                id: DIAG_MODEL,
                name: "已有分析模型",
                revision: 0,
                updatedAt: "2026-09-17T03:00:00.000Z"
              }
            ]
          : [],
        nextCursor: null
      })
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
        })
      }
    >
      <RunDiagnosticControl runId={DIAG_RUN} ready={ready} api={api} resourceApi={resourceApi} />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "生成归因报告" }));
  return { start, cancel };
}
it("uses existing model without a basic-report mode and opens the generated document", async () => {
  const { start } = mount();
  const button = await screen.findByRole("button", { name: "生成报告" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole("article", { name: "归因报告正文" });
  expect(start).toHaveBeenCalledWith(DIAG_RUN, DIAG_MODEL);
  expect(screen.queryByText("基础报告")).toBeNull();
  expect(screen.getByRole("link", { name: "下载 Markdown" })).toHaveAttribute(
    "href",
    expect.stringContaining("format=md")
  );
  expect(screen.getByText("结果卡缺失", { exact: true, selector: "p" })).toBeVisible();
});
it("cancels an active task and keeps original facts visible", async () => {
  const report = diagnosticReportFixture();
  report.status = "RUNNING";
  report.phase = "DIAGNOSING";
  report.completedCases = 0;
  const { cancel } = mount(report);
  fireEvent.click(await screen.findByRole("button", { name: "取消生成" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(DIAG_RUN, report.id));
  await waitFor(() => expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull());
  expect(screen.getByText("结果卡缺失", { exact: true, selector: "p" })).toBeVisible();
});
it("blocks generation when no model is configured", async () => {
  const { start } = mount(null, false);
  await screen.findByText(/尚未配置模型/);
  expect(screen.getByRole("button", { name: "生成报告" })).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
});
it("allows history inspection but blocks generation before evaluation is ready", async () => {
  mount(diagnosticReportFixture(), true, false);
  await screen.findByRole("article", { name: "归因报告正文" });
  expect(screen.getByRole("button", { name: "生成新版本" })).toBeDisabled();
  expect(screen.getByText(/完整评测结果尚未就绪/)).toBeVisible();
});
it("renders narrative body as typed text, trusts no model HTML and keeps facts in the appendix", () => {
  const report = diagnosticReportFixture();
  const s = report.snapshot;
  if (!s) throw new Error("FIXTURE_MISSING");
  s.narrative = [
    "这轮反馈可以整理成 1 个根问题。",
    "",
    "**一、结果卡片缺失**",
    "",
    "涉及反馈：",
    "- C1：缺少结果卡片",
    "",
    "问题本质：",
    "> 结果卡片没有进入最终输出",
    "",
    "```",
    "<script>alert(4)</script>",
    "```"
  ].join("\n");
  const { container } = render(<RunDiagnosticDocument report={report} />);
  expect(
    screen.getByText("这轮反馈可以整理成 1 个根问题。", { exact: true, selector: "p" })
  ).toBeVisible();
  expect(screen.getByText("一、结果卡片缺失", { exact: true, selector: "strong" })).toBeVisible();
  expect(screen.getByText("结果卡片没有进入最终输出")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  const appendix = container.querySelector("details.diagnostic-appendix");
  expect(appendix?.textContent).toContain("候选原因");
  expect(container.textContent).toContain("C1-E1");
});

it("renders model output only as text, and failure assertions remain visible on diagnosis error", () => {
  const report = diagnosticReportFixture(),
    item = report.snapshot?.cases[0];
  if (!item) throw new Error("FIXTURE_MISSING");
  item.diagnosis = null;
  item.diagnosisError = '<img src=x onerror="alert(1)">';
  const { container } = render(<RunDiagnosticDocument report={report} />);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("<img");
  expect(screen.getByText("结果卡缺失", { exact: true, selector: "p" })).toBeVisible();
});
