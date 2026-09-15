import { expect, it } from "vitest";
import {
  agentUsage,
  observable,
  hasTrace,
  traceBranches,
  conversationTurns
} from "../src/features/runs/run-evidence-model.ts";
import {
  dashboardCounts,
  evaluationState,
  manualOverride,
  type DashboardCase
} from "../src/features/runs/run-dashboard-model.ts";
import { compareCases } from "../src/features/runs/run-comparison.tsx";
import { runReportCase } from "./run-test-fixture.ts";
function row(calls: unknown[]): DashboardCase {
  const rest = {
    ...runReportCase.rest,
    status: "SUCCEEDED" as const,
    httpStatus: 200,
    providerOutput: {
      ok: true as const,
      task_name: "EVAL_E2E",
      resolved_config: {},
      parsed_output: {
        schema_version: 1,
        llm_calls: calls,
        coverage: { source_coverage: { llm_audit: { completeness: "COMPLETE" } } }
      }
    }
  };
  return {
    caseKey: "case",
    ordinal: 0,
    definition: runReportCase.definition,
    rest: rest as DashboardCase["rest"],
    evaluation: {
      ...runReportCase.evaluation,
      status: "PASS",
      promptfooSuccess: true
    } as DashboardCase["evaluation"],
    report: runReportCase
  };
}
it("sums actual multi-model attempts, excludes cache and duplicate audit copies", () => {
  const call = { call_id: 1, token_usage: { input: 100, output: 20, cached_input: 80 } };
  const r = row([call, call, { call_id: 2, ok: false, token_usage: { input: 30, output: 0 } }]);
  expect(agentUsage([r])).toMatchObject({
    input: 130,
    output: 20,
    total: 150,
    calls: 2,
    recorded: 2
  });
  expect(hasTrace(r)).toBe(true);
});
it("missing usage is not zero; known zero remains a recorded value", () => {
  expect(agentUsage([row([{ call_id: 1 }])])).toMatchObject({ recorded: 0, complete: false });
  expect(agentUsage([row([{ call_id: 1, token_usage: { input: 0, output: 0 } }])])).toMatchObject({
    recorded: 1,
    total: 0
  });
});
it("does not display internal reasoning, including JSON encoded model outputs", () => {
  expect(
    observable({ output: '{"reason":"private","tools":[]}', reason: "private", value: 2 })
  ).toEqual({ output: { tools: [] }, value: 2 });
});
it("manual verdict decides the count: failure over automatic pass, pass over automatic failure", () => {
  const r = row([]);
  const reviewed = {
    ...r,
    review: {
      runId: "018f0f4e-7b7a-7cc0-8000-000000000001",
      caseKey: "case",
      evidenceHash: "a".repeat(64),
      revision: 1,
      capture: "NOT_COLLECTED" as const,
      captureNote: "",
      images: [],
      history: [
        {
          revision: 1,
          at: "2026-09-09T00:00:00Z",
          kind: "DECISION" as const,
          verdict: "FAIL" as const,
          reviewer: "pm",
          rootCause: "PRODUCT",
          note: ""
        }
      ]
    }
  };
  expect(evaluationState(reviewed)).toBe("FAIL");
  expect(dashboardCounts(1, [reviewed]).FAIL).toBe(1);
  const decision = reviewed.review.history[0];
  if (!decision) throw new Error("Missing test decision");
  const failed = {
    ...reviewed,
    evaluation: {
      ...runReportCase.evaluation,
      status: "FAIL",
      promptfooSuccess: false
    } as DashboardCase["evaluation"],
    review: {
      ...reviewed.review,
      history: [{ ...decision, verdict: "PASS" as const, rootCause: "CASE", note: "预期写错" }]
    }
  };
  expect(manualOverride(failed)).toBe(true);
  expect(evaluationState(failed)).toBe("PASS");
  expect(dashboardCounts(1, [failed]).PASS).toBe(1);
});
it("comparison separates added, missing and changed definitions", () => {
  const a = row([]);
  const changed = { ...a, report: { ...runReportCase, definitionHash: "b".repeat(64) } };
  expect(compareCases([a], [changed])[0]?.kind).toBe("CHANGED");
  expect(compareCases([a], [{ ...a, caseKey: "new" }]).map((c) => c.kind)).toEqual([
    "MISSING",
    "ADDED"
  ]);
  expect(compareCases([a], [a])[0]?.kind).toBe("SAME");
});

it("trace hierarchy retains siblings and does not invent links for cycles or duplicate ids", () => {
  const roots = traceBranches(
    [
      { id: "parent" },
      { id: "a", parent: "parent" },
      { id: "b", parent: "parent" },
      { id: "cycle", parent: "cycle" }
    ],
    "id",
    "parent"
  );
  expect(roots).toHaveLength(2);
  expect(roots[0]?.children.map((c) => c.record.id)).toEqual(["a", "b"]);
  expect(
    traceBranches(
      [
        { id: "a", parent: "b" },
        { id: "b", parent: "a" }
      ],
      "id",
      "parent"
    )
  ).toHaveLength(2);
});

it("keeps multi-turn user input as separate rounds and never flattens it into one paragraph", () => {
  type RequestBody = NonNullable<DashboardCase["definition"]>["vars"]["request_body"];
  function body(request_body: RequestBody): DashboardCase {
    const base = row([]);
    if (!base.definition) throw new Error("Missing fixture definition");
    return {
      ...base,
      definition: { ...base.definition, vars: { task: "route", request_body } }
    };
  }
  expect(
    conversationTurns(
      body({
        conversation: [
          { role: "user", text: "创建边界任务" },
          { role: "assistant", text: "已创建" },
          { role: "user", content: "把它删掉" },
          { role: "user", text: "   " }
        ]
      })
    )
  ).toEqual([
    { round: 1, kind: "user", role: "user", text: "创建边界任务" },
    { round: null, kind: "context", role: "assistant", text: "已创建" },
    { round: 2, kind: "user", role: "user", text: "把它删掉" }
  ]);
  expect(conversationTurns(body({ text: "我在ClickUp里有哪些任务清单？" }))).toEqual([
    { round: 1, kind: "user", role: "user", text: "我在ClickUp里有哪些任务清单？" }
  ]);
  // An unreadable body reports nothing instead of guessing a round.
  expect(conversationTurns(body({ input: "你好" }))).toEqual([]);
  expect(conversationTurns({ ...row([]), definition: undefined })).toEqual([]);
});
