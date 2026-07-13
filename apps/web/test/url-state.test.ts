import { describe, expect, it } from "vitest";

import { buildCaseListSearch, parseCaseListSearch, resolveWebRoute } from "../src/lib/web-route.ts";

describe("Web 路由与 Case URL 状态", () => {
  it("解析 P5 已闭环页面，未来 Report 和 Analysis 仍保持关闭", () => {
    expect(resolveWebRoute("/")).toEqual({ kind: "DASHBOARD" });
    expect(resolveWebRoute("/test-suites")).toEqual({ kind: "TEST_SUITE_LIST" });
    expect(resolveWebRoute("/test-suites/suite%201")).toEqual({
      kind: "TEST_SUITE_DETAIL",
      suiteId: "suite 1"
    });
    expect(resolveWebRoute("/endpoint-configs")).toEqual({ kind: "ENDPOINT_CONFIG_LIST" });
    expect(resolveWebRoute("/runs")).toEqual({ kind: "RUN_LIST" });
    expect(resolveWebRoute("/runs/run%201")).toEqual({ kind: "RUN_DETAIL", runId: "run 1" });
    expect(resolveWebRoute("/reports")).toBeNull();
    expect(resolveWebRoute("/analysis")).toBeNull();
  });

  it("解析搜索、同字段 OR 过滤和 cursor 历史", () => {
    const state = parseCaseListSearch(
      new URLSearchParams(
        "caseKey=case&description=%E9%97%AE%E7%AD%94&businessModule=a&businessModule=b&scenarioTag=x&assertionType=is-json&metric=quality&limit=20&cursor=case_v1_2&before=case_v1_0&before=case_v1_1"
      )
    );

    expect(state).toEqual({
      caseKey: "case",
      description: "问答",
      businessModules: ["a", "b"],
      scenarioTags: ["x"],
      assertionTypes: ["is-json"],
      metrics: ["quality"],
      limit: 20,
      cursor: "case_v1_2",
      before: ["case_v1_0", "case_v1_1"]
    });
  });

  it("丢弃空值并把非法 limit 收敛为默认值", () => {
    expect(
      parseCaseListSearch(new URLSearchParams("caseKey=&businessModule=&limit=999&cursor=&before="))
    ).toEqual({
      caseKey: "",
      description: "",
      businessModules: [],
      scenarioTags: [],
      assertionTypes: [],
      metrics: [],
      limit: 50,
      cursor: null,
      before: []
    });
  });

  it("按稳定顺序回写可刷新恢复的 URL", () => {
    const search = buildCaseListSearch({
      caseKey: "case",
      description: "",
      businessModules: ["b", "a"],
      scenarioTags: [],
      assertionTypes: ["equals"],
      metrics: ["m2", "m1"],
      limit: 20,
      cursor: "case_v1_2",
      before: ["case_v1_0", "case_v1_1"]
    });

    expect(search.toString()).toBe(
      "caseKey=case&businessModule=b&businessModule=a&assertionType=equals&metric=m2&metric=m1&limit=20&cursor=case_v1_2&before=case_v1_0&before=case_v1_1"
    );
  });
});
