import { describe, expect, it } from "vitest";
import { resolveWebRoute } from "../src/lib/web-route.ts";
import { CURRENT_FEATURES } from "../src/features/feature-registry.ts";

describe("case-centric workspace navigation", () => {
  it("groups existing resource pages without adding report or analysis workspaces", () => {
    expect(CURRENT_FEATURES.map((item) => item.id)).toEqual([
      "dashboard",
      "runs",
      "test-suites",
      "endpoint-configs",
      "llm-configs",
      "rubric-prompts",
      "analysis-prompts"
    ]);
  });
  it("keeps execution details addressable", () => {
    expect(resolveWebRoute("/runs/run-1/execution")).toEqual({
      kind: "RUN_DETAIL",
      runId: "run-1"
    });
  });
  it("keeps old template bookmarks readable as archives", () => {
    expect(resolveWebRoute("/runs/templates")).toEqual({ kind: "A2UI_REVIEW", reviewId: null });
    expect(resolveWebRoute("/runs/templates/batch-1")).toEqual({
      kind: "A2UI_REVIEW",
      reviewId: "batch-1"
    });
    expect(resolveWebRoute("/a2ui-reviews/batch-1")).toEqual({
      kind: "A2UI_REVIEW",
      reviewId: "batch-1"
    });
    expect(resolveWebRoute("/runs/templates/%ZZ")).toBeNull();
    expect(resolveWebRoute("/a2ui-reviews/%ZZ")).toBeNull();
    expect(resolveWebRoute("/configurations")).toEqual({ kind: "CONFIGURATION_HOME" });
  });
});
