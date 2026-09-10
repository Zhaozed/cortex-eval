// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode, ReactElement } from "react";
import type { A2uiReview } from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { A2uiReviewPage } from "../src/features/a2ui-reviews/a2ui-review-page.tsx";
import { a2uiReviewApi } from "../src/lib/a2ui-review-api.ts";

const id = "018f0f4e-7b7a-7cc0-8000-000000000001";
const review: A2uiReview = {
  version: 1,
  id,
  title: "历史批次",
  runId: id,
  scope: "offline_web_payload",
  createdAt: "2026-09-08T02:00:00Z",
  revision: 1,
  reportHash: "a".repeat(64),
  captureHash: "b".repeat(64),
  casesHash: "c".repeat(64),
  history: [
    {
      caseId: "case-1",
      verdict: "approved",
      reviewer: "历史审核人",
      note: "之前的记录",
      at: "2026-09-08T02:01:00Z",
      revision: 1,
      imageHashes: ["d".repeat(64)]
    }
  ],
  overall: "failed",
  cases: [
    {
      caseId: "case-1",
      title: "卡片",
      automatic: "failed",
      capture: "captured",
      manual: "approved",
      images: [{ file: "case-1.png", sha256: "d".repeat(64), groupIndex: 0 }]
    }
  ]
};
afterEach(() => vi.restoreAllMocks());
function wrapper({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}
it("preserves screenshots and decisions as read-only evidence without masking automatic failure", async () => {
  vi.spyOn(a2uiReviewApi, "get").mockResolvedValue(structuredClone(review));
  render(<A2uiReviewPage reviewId={id} onNavigate={vi.fn()} />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "查看详情 case-1" }));
  expect(await screen.findByRole("img")).toHaveAttribute(
    "src",
    `/api/v1/a2ui-reviews/${id}/images/case-1.png`
  );
  expect(screen.getByText("之前的记录")).toBeVisible();
  expect(screen.getByText(/历史审核人/)).toBeVisible();
  expect(screen.getByText(/自动断言.*失败/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "人工通过" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("keeps original source downloads and explicit retired boundary", async () => {
  vi.spyOn(a2uiReviewApi, "get").mockResolvedValue(structuredClone(review));
  render(<A2uiReviewPage reviewId={id} onNavigate={vi.fn()} />, { wrapper });
  await screen.findByText("历史批次");
  fireEvent.click(screen.getByText("原始证据"));
  expect(screen.getByRole("link", { name: "report" })).toHaveAttribute(
    "href",
    `/api/v1/a2ui-reviews/${id}/evidence/report`
  );
  expect(screen.getByText(/固定模板回归已停用/)).toBeVisible();
});
it("archive list opens old batches and offers no import or regression controls", async () => {
  vi.spyOn(a2uiReviewApi, "list").mockResolvedValue([structuredClone(review)]);
  const navigate = vi.fn();
  render(<A2uiReviewPage reviewId={null} onNavigate={navigate} />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(navigate).toHaveBeenCalledWith(`/a2ui-reviews/${id}`);
  expect(screen.queryByRole("button", { name: /模板回归|导入|新建/ })).not.toBeInTheDocument();
});
it("surfaces historical screenshot failures without offering an approval", async () => {
  vi.spyOn(a2uiReviewApi, "get").mockResolvedValue(structuredClone(review));
  render(<A2uiReviewPage reviewId={id} onNavigate={vi.fn()} />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "查看详情 case-1" }));
  fireEvent.error(await screen.findByRole("img"));
  expect(screen.getByRole("alert")).toHaveTextContent("历史截图加载失败");
  expect(screen.queryByRole("button", { name: "人工通过" })).not.toBeInTheDocument();
});
it("archive read errors are not displayed as empty success", async () => {
  vi.spyOn(a2uiReviewApi, "get").mockRejectedValue(new Error("missing evidence"));
  render(<A2uiReviewPage reviewId={id} onNavigate={vi.fn()} />, { wrapper });
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
