import { describe, expect, it } from "vitest";

import {
  transitionAnalysisState,
  type AnalysisState,
  type AnalysisStateEvent
} from "../src/domain-analysis-state.ts";

describe("Analysis 状态机", () => {
  it("成功有 Proposal 后只能进入待决策状态", () => {
    const pending: AnalysisState = {
      status: "PENDING",
      decision: "NO_PROPOSAL",
      applyStatus: "NOT_APPLICABLE",
      revision: 1
    };
    const running = transitionAnalysisState(pending, { type: "START", expectedRevision: 1 });
    expect(running).toEqual({ ok: true, state: { ...pending, status: "RUNNING", revision: 2 } });
    if (!running.ok) throw new Error("unexpected");
    expect(
      transitionAnalysisState(running.state, {
        type: "SUCCEED",
        hasProposal: true,
        expectedRevision: 2
      })
    ).toEqual({
      ok: true,
      state: { status: "SUCCEEDED", decision: "PENDING", applyStatus: "NOT_APPLIED", revision: 3 }
    });
  });

  it("错误和无 Proposal 成功收敛为不可应用", () => {
    const running: AnalysisState = {
      status: "RUNNING",
      decision: "NO_PROPOSAL",
      applyStatus: "NOT_APPLICABLE",
      revision: 2
    };
    expect(transitionAnalysisState(running, { type: "FAIL", expectedRevision: 2 })).toEqual({
      ok: true,
      state: {
        status: "ERROR",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: 3
      }
    });
    expect(
      transitionAnalysisState(running, {
        type: "SUCCEED",
        hasProposal: false,
        expectedRevision: 2
      })
    ).toEqual({
      ok: true,
      state: {
        status: "SUCCEEDED",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: 3
      }
    });
  });

  it("接受、拒绝、编辑接受和冲突均显式转换，非法事件稳定失败", () => {
    const state: AnalysisState = {
      status: "SUCCEEDED",
      decision: "PENDING",
      applyStatus: "NOT_APPLIED",
      revision: 3
    };
    const events: AnalysisStateEvent[] = [
      { type: "REJECT", expectedRevision: 3 },
      { type: "ACCEPT", edited: false, applyResult: "APPLIED", expectedRevision: 3 },
      { type: "ACCEPT", edited: true, applyResult: "CONFLICT", expectedRevision: 3 }
    ];
    expect(events.map((event) => transitionAnalysisState(state, event))).toEqual([
      {
        ok: true,
        state: {
          status: "SUCCEEDED",
          decision: "REJECTED",
          applyStatus: "NOT_APPLIED",
          revision: 4
        }
      },
      {
        ok: true,
        state: { status: "SUCCEEDED", decision: "ACCEPTED", applyStatus: "APPLIED", revision: 4 }
      },
      {
        ok: true,
        state: {
          status: "SUCCEEDED",
          decision: "EDITED_AND_ACCEPTED",
          applyStatus: "CONFLICT",
          revision: 4
        }
      }
    ]);
    expect(
      transitionAnalysisState(
        { ...state, decision: "REJECTED" },
        { type: "REJECT", expectedRevision: 3 }
      ).ok
    ).toBe(false);
    expect(transitionAnalysisState(state, { type: "REJECT", expectedRevision: 2 })).toEqual({
      ok: false,
      error: {
        code: "ANALYSIS_STATE_CONFLICT",
        event: "REJECT",
        actualRevision: 3,
        expectedRevision: 2
      }
    });
  });

  it("重新分析递增 Revision 并清除旧决策", () => {
    const state: AnalysisState = {
      status: "SUCCEEDED",
      decision: "ACCEPTED",
      applyStatus: "APPLIED",
      revision: 4
    };
    expect(transitionAnalysisState(state, { type: "REANALYZE", expectedRevision: 4 })).toEqual({
      ok: true,
      state: {
        status: "PENDING",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: 5
      }
    });
  });

  it("转换入口拒绝状态字段之间的非法组合", () => {
    const invalid = {
      status: "PENDING",
      decision: "ACCEPTED",
      applyStatus: "APPLIED",
      revision: 1
    } as unknown as AnalysisState;
    expect(transitionAnalysisState(invalid, { type: "START", expectedRevision: 1 })).toEqual({
      ok: false,
      error: {
        code: "ANALYSIS_STATE_CONFLICT",
        event: "START",
        actualRevision: 1,
        expectedRevision: 1
      }
    });
  });
});
