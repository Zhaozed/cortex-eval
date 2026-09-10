import { expect, it } from "vitest";
import { observedReplies, hasObservedCards } from "../src/features/runs/run-output-model.ts";
import { toolTimings, uniqueModelCalls } from "../src/features/runs/run-call-model.ts";
import { evaluationState } from "../src/features/runs/run-dashboard-model.ts";
import { runReportCase } from "./run-test-fixture.ts";

import { evidenceRow, reviewFixture } from "./run-case-drawer-fixture.ts";
it("shows all delivered replies, keeps repeated text with different IDs, excludes internal thoughts", () => {
  const row = evidenceRow({
    delivered_messages: [
      { asst_msg_id: "a", role: "assistant", text: "好的" },
      { asst_msg_id: "b", role: "assistant", text: "好的" },
      { asst_msg_id: "b", role: "assistant", text: "好的" },
      { asst_msg_id: "c", role: "user", text: "not agent" }
    ],
    final_output: { asst_msg_id: "b", text: "好的" },
    timeline: [{ type: "THINK", payload: { reason: "private" } }]
  });
  expect(observedReplies(row).map((r) => [r.text, r.source])).toEqual([
    ["好的", "DELIVERED"],
    ["好的", "DELIVERED"]
  ]);
});
it("shows generated final replies without falsely claiming they were delivered", () => {
  const notice = {
    req_id: "req",
    asst_msg_id: "ack",
    text: "这就帮你看看待办列表。",
    created_at: "2026-09-07T06:16:29Z"
  };
  const result = observedReplies(
    evidenceRow({
      delivered_messages: [notice],
      final_output: notice,
      reply_text: notice.text,
      timeline: [
        {
          req_id: "req",
          step_idx: 5,
          created_at: "2026-09-07T06:17:00Z",
          payload: { asst_msg_id: "final", reply_text: "查到了两条待办。", reason: "private" }
        }
      ]
    })
  );
  expect(result).toHaveLength(2);
  expect(result[1]).toMatchObject({ text: "查到了两条待办。", source: "GENERATED" });
});
it("preserves unknown chronology and does not invent missing replies", () => {
  expect(observedReplies(evidenceRow({}))).toEqual([]);
  expect(observedReplies(evidenceRow({ reply_text: "legacy reply" }))[0]?.source).toBe(
    "PROJECTION"
  );
  expect(
    observedReplies(
      evidenceRow({ delivered_messages: [{ text: "first" }, { text: "second" }] })
    ).map((r) => r.text)
  ).toEqual(["first", "second"]);
});
it("does not mistake requested display mode for an actually generated card", () => {
  expect(hasObservedCards(evidenceRow({ present_mode: "carousel_task" }))).toBe(false);
  expect(hasObservedCards(evidenceRow({ a2ui: [] }))).toBe(false);
  expect(
    hasObservedCards(evidenceRow({ delivered_messages: [{ a2ui: { surfaceId: "s" } }] }))
  ).toBe(true);
});
it("actual cards require review; obsolete capture states do not create a requirement", () => {
  const base = evidenceRow({});
  expect(evaluationState(base)).toBe("PASS");
  expect(evaluationState(evidenceRow({ a2ui: { surfaceId: "s" } }))).toBe("REVIEW_PENDING");
  for (const capture of ["CAPTURED", "RENDER_FAILED"] as const)
    expect(evaluationState({ ...base, review: reviewFixture({ capture }) })).toBe("PASS");
  expect(
    evaluationState({
      ...base,
      review: reviewFixture({
        capture: "NOT_APPLICABLE",
        history: [
          {
            revision: 1,
            at: "2026-09-09T00:00:00Z",
            kind: "CAPTURE",
            verdict: "PENDING",
            reviewer: "",
            rootCause: "UNCLASSIFIED",
            note: ""
          }
        ]
      })
    })
  ).toBe("PASS");
});
it("manual PASS requires matching live renderer revision and cannot cover auto FAIL", () => {
  if (runReportCase.evaluation.status !== "PASS") throw new Error("Expected PASS fixture");
  const review = reviewFixture({
    live: { required: true, available: true, rendererVersion: "b".repeat(64) },
    history: [
      {
        revision: 1,
        at: "2026-09-09T00:00:00Z",
        kind: "DECISION",
        verdict: "PASS",
        reviewer: "ui",
        rendererVersion: "b".repeat(64),
        rootCause: "UNCLASSIFIED",
        note: ""
      }
    ]
  });
  const base = { ...evidenceRow({ a2ui: { surfaceId: "s" } }), review };
  expect(evaluationState(base)).toBe("PASS");
  expect(
    evaluationState({
      ...base,
      review: {
        ...review,
        live: { required: true, available: false, rendererVersion: "b".repeat(64) }
      }
    })
  ).toBe("REVIEW_PENDING");
  expect(
    evaluationState({
      ...base,
      review: {
        ...review,
        live: { required: true, available: true, rendererVersion: "c".repeat(64) }
      }
    })
  ).toBe("REVIEW_PENDING");
  expect(
    evaluationState({
      ...base,
      evaluation: { ...runReportCase.evaluation, status: "FAIL", promptfooSuccess: false }
    })
  ).toBe("FAIL");
});
it("deduplicates audit copies, but keeps retries; tool intervals require explicit unique links", () => {
  const call = { call_id: 1, req_id: "r" },
    retry = { call_id: 2, req_id: "r", retry_of: 1 };
  expect(uniqueModelCalls(evidenceRow({ llm_calls: [call, call, retry] }))).toEqual([call, retry]);
  const p = {
    timeline: [
      {
        step_id: "start",
        req_id: "r",
        created_at: "2026-09-09T00:00:00Z",
        payload: { tool_call: { tool_request_id: "t" } }
      },
      {
        step_id: "end",
        req_id: "r",
        created_at: "2026-09-09T00:00:01Z",
        payload: { tool_ret: { tool_request_id: "t" } }
      }
    ],
    tool_executions: [
      {
        tool_request_id: "t",
        call_step_id: "start",
        terminal_step_ids: ["end"],
        calls: [{ name: "list_tasks" }]
      }
    ]
  };
  expect(toolTimings(evidenceRow(p))[0]?.durationMs).toBe(1000);
  expect(
    toolTimings(evidenceRow({ ...p, timeline: p.timeline.slice(0, 1) }))[0]?.durationMs
  ).toBeNull();
  expect(
    toolTimings(evidenceRow({ ...p, timeline: [...p.timeline, p.timeline[1]] }))[0]?.durationMs
  ).toBeNull();
});

it("does not discard different contents recorded under the same message id", () => {
  const messages = [
    { asst_msg_id: "m", text: "片段一" },
    { asst_msg_id: "m", text: "片段二" }
  ];
  expect(observedReplies(evidenceRow({ delivered_messages: messages })).map((r) => r.text)).toEqual(
    ["片段一", "片段二"]
  );
});

it("explicit capture opt-in gates automatic PASS even when no card evidence arrived", () => {
  const row = evidenceRow({});
  expect(evaluationState(row)).toBe("PASS");
  if (!row.definition) throw new Error("Missing fixture definition");
  expect(
    evaluationState({
      ...row,
      definition: {
        ...row.definition,
        metadata: { ...row.definition.metadata, a2ui_capture: true }
      }
    })
  ).toBe("REVIEW_PENDING");
});
