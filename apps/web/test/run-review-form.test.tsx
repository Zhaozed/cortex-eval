// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ReviewForm } from "../src/features/runs/run-case-review.tsx";
import { runReviewApi } from "../src/lib/run-review-api.ts";
import { reviewFixture } from "./run-case-drawer-fixture.ts";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";

vi.mock("../src/lib/run-review-api.ts", () => ({ runReviewApi: { save: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runReviewApi.save).mockResolvedValue(reviewFixture());
});
function mount(verdict: "PASS" | "FAIL" | "PENDING", visual = true): RunReview {
  const review = reviewFixture({
    revision: 1,
    live: { required: true, available: true, rendererVersion: "b".repeat(64) },
    history: [
      {
        revision: 1,
        at: "2026-09-09T00:00:00Z",
        kind: "DECISION",
        verdict,
        rendererVersion: "b".repeat(64),
        reviewer: "产品",
        rootCause: "PRODUCT",
        note: "历史说明"
      }
    ]
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ReviewForm review={review} visual={visual} rendererVersion={"b".repeat(64)} />
    </QueryClientProvider>
  );
  return review;
}
it("visual PASS hides attribution, preserves historical cause, and saves no current failure classification", async () => {
  const review = mount("PASS");
  expect(screen.getByRole("combobox", { name: "视觉复核结论" })).toHaveValue("PASS");
  expect(screen.queryByRole("combobox", { name: "失败归因（选填）" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "备注（选填）" })).toBeVisible();
  await userEvent.click(screen.getByText("审核历史 · 1"));
  expect(screen.getByText("当时归因：产品缺陷")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "保存复核" }));
  await waitFor(() =>
    expect(runReviewApi.save).toHaveBeenCalledWith(
      review.runId,
      review.caseKey,
      expect.objectContaining({ verdict: "PASS", rootCause: "UNCLASSIFIED" })
    )
  );
});
it("shows optional cause only for FAIL and clears it when switching away", async () => {
  mount("FAIL");
  const verdict = screen.getByRole("combobox", { name: "视觉复核结论" });
  expect(screen.getByRole("combobox", { name: "失败归因（选填）" })).toHaveValue("PRODUCT");
  expect(screen.getByRole("textbox", { name: "问题说明" })).toBeVisible();
  await userEvent.selectOptions(verdict, "PASS");
  expect(screen.queryByRole("combobox", { name: "失败归因（选填）" })).not.toBeInTheDocument();
  await userEvent.selectOptions(verdict, "FAIL");
  expect(screen.getByRole("combobox", { name: "失败归因（选填）" })).toHaveValue("UNCLASSIFIED");
  await userEvent.selectOptions(verdict, "PENDING");
  expect(screen.queryByRole("combobox", { name: "失败归因（选填）" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "保存复核" }));
  await waitFor(() =>
    expect(runReviewApi.save).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ verdict: "PENDING", rootCause: "UNCLASSIFIED" })
    )
  );
});
it("retains the separate general manual review label for nonvisual Cases", () => {
  mount("PENDING", false);
  expect(screen.getByRole("combobox", { name: "人工结论" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "失败归因（选填）" })).not.toBeInTheDocument();
});
