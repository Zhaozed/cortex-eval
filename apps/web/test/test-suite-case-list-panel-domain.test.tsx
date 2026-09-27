// @vitest-environment jsdom
import { render, screen, type RenderResult } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TestSuiteCaseListPanel } from "../src/features/test-suites/test-suite-case-list-panel.tsx";
import { parseCaseListSearch } from "../src/lib/web-route.ts";

const timestamp = "2026-09-16T00:00:00.000Z";

/** 一行 Case 摘要，形状对齐 CaseSummaryV1Schema。 */
interface CaseSummaryRow {
  readonly id: string;
  readonly suiteId: string;
  readonly caseKey: string;
  readonly ordinal: number;
  readonly description: string;
  readonly businessModule: string;
  readonly scenarioTag: string;
  readonly assertionTypes: string[];
  readonly metrics: string[];
  readonly revision: number;
  readonly updatedAt: string;
}
const suiteId = "018f0f4e-7b7a-7cc0-8000-0000000000a1";

// 真实 v2 Case 摘要：域字母后紧跟数字（FS2-D01-01），曾经被误判为「无法归域」。
function summary(caseKey: string, ordinal: number, metrics: string[]): CaseSummaryRow {
  return {
    id: `018f0f4e-7b7a-7cc0-8000-00000000${ordinal}1`,
    suiteId,
    caseKey,
    ordinal,
    description: `${caseKey}｜描述`,
    businessModule: `飞书v2-FS2-${caseKey[4]}`,
    scenarioTag: "feishu-v2",
    assertionTypes: ["javascript"],
    metrics,
    revision: 2,
    updatedAt: timestamp
  };
}

const rows = [
  summary("FS2-D01-01", 0, [
    "【硬性】D2.3 写入次数上限｜feishu_update_doc ≤ 1 次",
    "【质量】D4.8 口语可朗读性｜时间说人话"
  ]),
  summary("FS2-V01-01", 1, ["【硬性】D4.1 纯文本无 Markdown｜播报里不能有 # ** `"]),
  summary("FS2-A04-01", 2, ["【硬性】D5.1 该出卡时必须出卡｜未出卡直接判负"]),
  summary("legacy-case-001", 3, ["quality"])
];

function renderPanel(): RenderResult {
  return render(
    <TestSuiteCaseListPanel
      items={rows}
      listState={parseCaseListSearch(new URLSearchParams())}
      nextCursor={null}
      mutationDisabled={false}
      onListStateChange={() => undefined}
      onView={vi.fn()}
      onEdit={() => undefined}
      onCopy={() => undefined}
      onDelete={() => undefined}
    />
  );
}

describe("Case 列表「域」列与断言分层徽章", () => {
  it("真实 FS2-* Case ID 渲染出中文域名徽章，而不是一律显示 —", () => {
    renderPanel();
    expect(screen.getByText("飞书文档")).toBeInTheDocument();
    expect(screen.getByText("语音播报专项")).toBeInTheDocument();
    expect(screen.getByText("A2UI 视觉专项")).toBeInTheDocument();
  });

  it("七个域前缀全部可归域（含 M/C/X/S）", () => {
    const all = [
      summary("FS2-D01-01", 0, []),
      summary("FS2-M01-01", 1, []),
      summary("FS2-C01-01", 2, []),
      summary("FS2-X01-01", 3, []),
      summary("FS2-V01-01", 4, []),
      summary("FS2-A01-01", 5, []),
      summary("FS2-S01-01", 6, [])
    ];
    render(
      <TestSuiteCaseListPanel
        items={all}
        listState={parseCaseListSearch(new URLSearchParams())}
        nextCursor={null}
        mutationDisabled={false}
        onListStateChange={() => undefined}
        onView={vi.fn()}
        onEdit={() => undefined}
        onCopy={() => undefined}
        onDelete={() => undefined}
      />
    );
    for (const label of [
      "飞书文档",
      "飞书消息与人",
      "飞书日历与会议室",
      "组合链路",
      "语音播报专项",
      "A2UI 视觉专项",
      "安全与边界"
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("旧套件 ID 仍降级为 — 且不抛错", () => {
    renderPanel();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("断言列按【硬性】/【质量】前缀分层计数，旧命名进未分类", () => {
    renderPanel();
    // 3 行各 1 条【硬性】、1 行 1 条【质量】、旧命名行进未分类
    expect(screen.getAllByText("硬性 1")).toHaveLength(3);
    expect(screen.getByText("质量 1")).toBeInTheDocument();
    expect(screen.getByText("未分类 1")).toBeInTheDocument();
  });
});
