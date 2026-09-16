import { describe, expect, it } from "vitest";

import {
  ASSERTION_DIMENSIONS,
  aggregateAssertionsByDimension,
  caseDomain,
  caseTurnCount,
  collectAssertMetrics,
  countMetricsByTier,
  parseAssertionMetric,
  softFailureCount,
  summarizeAssertionTiers,
  UNMARKED_DIMENSION_LABEL
} from "../src/lib/assertion-metric.ts";

describe("parseAssertionMetric", () => {
  it("拆出 v2 硬性 metric 的层级、判据与原文", () => {
    const parsed = parseAssertionMetric("【硬性】D2.3 写入次数上限｜create_event ≤ 1 次");
    expect(parsed.tier).toBe("HARD");
    expect(parsed.tierLabel).toBe("硬性门禁");
    expect(parsed.dimension).toBe("D2");
    expect(parsed.dimensionLabel).toBe("D2 工具编排");
    expect(parsed.code).toBe("D2.3");
    expect(parsed.title).toBe("D2.3 写入次数上限");
    expect(parsed.detail).toBe("create_event ≤ 1 次");
    expect(parsed.raw).toBe("【硬性】D2.3 写入次数上限｜create_event ≤ 1 次");
  });

  it("拆出 v2 质量 metric", () => {
    const parsed = parseAssertionMetric("【质量】D4.7 语音长度｜闲聊 ≤2句 ≤40字");
    expect(parsed.tier).toBe("SOFT");
    expect(parsed.tierLabel).toBe("质量项");
    expect(parsed.dimension).toBe("D4");
    expect(parsed.detail).toBe("闲聊 ≤2句 ≤40字");
  });

  it("旧套件 metric 降级为未分类，保留原文而不是空白", () => {
    for (const legacy of ["is-json", "assert-set", "quality", "llm-rubric 输出合规"]) {
      const parsed = parseAssertionMetric(legacy);
      expect(parsed.tier).toBe("UNMARKED");
      expect(parsed.dimension).toBeNull();
      expect(parsed.dimensionLabel).toBe(UNMARKED_DIMENSION_LABEL);
      expect(parsed.title).toBe(legacy);
      expect(parsed.raw).toBe(legacy);
    }
  });

  it("非字符串、空串、缺项名都不抛异常", () => {
    expect(parseAssertionMetric(undefined).title).toBe("未命名断言");
    expect(parseAssertionMetric(null).tier).toBe("UNMARKED");
    expect(parseAssertionMetric(42).raw).toBe("");
    expect(parseAssertionMetric("").title).toBe("未命名断言");
    expect(parseAssertionMetric("【硬性】").title).toBe("【硬性】");
    expect(parseAssertionMetric("【硬性】D9.1 越界层").dimension).toBeNull();
  });

  it("容忍半角括号、半角竖线与小写前缀", () => {
    expect(parseAssertionMetric("[硬性] D5.1 出卡｜必须有 EVENT 卡").tier).toBe("HARD");
    expect(parseAssertionMetric("【质量】D6.2 越权写入为零|write 次数 = 0").detail).toBe(
      "write 次数 = 0"
    );
    expect(parseAssertionMetric("【HARD】D1.2 澄清优先").tier).toBe("HARD");
    expect(parseAssertionMetric("【soft】D3.1 事实一致").tier).toBe("SOFT");
  });
});

describe("aggregateAssertionsByDimension", () => {
  it("始终输出 D1–D6，按断言条数而不是 case 数统计", () => {
    const rates = aggregateAssertionsByDimension([
      { metric: "【硬性】D2.1 先查后写", status: "PASS" },
      { metric: "【硬性】D2.3 写入次数上限", status: "FAIL" },
      { metric: "【质量】D4.7 语音长度", status: "FAIL" }
    ]);
    expect(rates.map((rate) => rate.dimension)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6"]);
    const d2 = rates[1];
    if (d2 === undefined) throw new Error("D2_MISSING");
    expect({ total: d2.total, pass: d2.pass, percent: d2.percent, level: d2.level }).toEqual({
      total: 2,
      pass: 1,
      percent: 50,
      level: "low"
    });
    const d1 = rates[0];
    if (d1 === undefined) throw new Error("D1_MISSING");
    expect(d1.total).toBe(0);
    expect(d1.level).toBe("none");
  });

  it("只在存在无前缀断言时追加未分类桶", () => {
    expect(
      aggregateAssertionsByDimension([{ metric: "【硬性】D1.1 单意图", status: "PASS" }])
    ).toHaveLength(6);
    const withLegacy = aggregateAssertionsByDimension([{ metric: "is-json", status: "PASS" }]);
    expect(withLegacy).toHaveLength(7);
    expect(withLegacy.at(-1)?.label).toBe(UNMARKED_DIMENSION_LABEL);
  });

  it("softFailureCount 只数【质量】失败，硬性失败不算", () => {
    expect(
      softFailureCount([
        { metric: "【质量】D4.7 语音长度", status: "FAIL" },
        { metric: "【质量】D4.3 不泄露ID", status: "FAIL" },
        { metric: "【硬性】D5.1 出卡", status: "FAIL" },
        { metric: "is-json", status: "FAIL" }
      ])
    ).toBe(2);
  });
});

describe("summarizeAssertionTiers / countMetricsByTier / collectAssertMetrics", () => {
  it("旧套件没有前缀时 marked 为 false", () => {
    expect(summarizeAssertionTiers([{ tier: "UNMARKED", status: "PASS" }]).marked).toBe(false);
    expect(summarizeAssertionTiers([{ tier: "SOFT", status: "FAIL" }]).marked).toBe(true);
  });

  it("按 metric 名统计硬性/质量/未分类条数", () => {
    expect(
      countMetricsByTier(["【硬性】D1.1 a", "【硬性】D2.1 b", "【质量】D4.1 c", "is-json"])
    ).toEqual({ hard: 2, soft: 1, unmarked: 1, total: 4 });
    expect(countMetricsByTier([])).toEqual({ hard: 0, soft: 0, unmarked: 0, total: 0 });
  });

  it("递归收集 assert-set 里的嵌套 metric，忽略异常节点", () => {
    expect(
      collectAssertMetrics([
        { metric: "【硬性】D1.1 a" },
        { metric: "assert-set", assert: [{ metric: "【质量】D4.1 c" }, null, "x", 7] },
        { metric: "   " }
      ])
    ).toEqual(["【硬性】D1.1 a", "assert-set", "【质量】D4.1 c"]);
  });
});

describe("caseDomain / caseTurnCount", () => {
  it("从 Case ID 前缀读出七个域", () => {
    expect(ASSERTION_DIMENSIONS).toHaveLength(6);
    expect(caseDomain("FS2-C-003 建日程")?.code).toBe("FS2-C");
    expect(caseDomain("fs2-a-001")?.label).toBe("A2UI 视觉专项");
    expect(caseDomain("case-001")).toBeNull();
    expect(caseDomain(undefined)).toBeNull();
    expect(caseDomain("FS2-Z-001")).toBeNull();
    // 回归：真实 Case ID 域字母后紧跟数字，必须能归域（曾经全部返回 null）
    expect(caseDomain("FS2-D01-01")?.code).toBe("FS2-D");
    expect(caseDomain("FS2-V06-01")?.label).toBe("语音播报专项");
    expect(caseDomain("FS2-S08-01")?.label).toBe("安全与边界");
    expect(caseDomain("FS2-A04-01")?.code).toBe("FS2-A");
    expect(caseDomain("FS2-M09-01")?.code).toBe("FS2-M");
    expect(caseDomain("FS2-C01-01")?.code).toBe("FS2-C");
    expect(caseDomain("FS2-X04-01")?.code).toBe("FS2-X");
    expect(caseDomain("FS2-DX01-01")).toBeNull();
  });

  it("多轮数 user 轮次，单轮为 1，未知为 null", () => {
    expect(caseTurnCount({ text: "帮我建个会" })).toBe(1);
    expect(
      caseTurnCount({
        conversation: [
          { role: "user", text: "查一下" },
          { role: "assistant", text: "查到两条" },
          { role: "user", text: "就第一场" }
        ]
      })
    ).toBe(2);
    expect(caseTurnCount({ text: "   " })).toBeNull();
    expect(caseTurnCount(null)).toBeNull();
    expect(caseTurnCount("text")).toBeNull();
  });
});
