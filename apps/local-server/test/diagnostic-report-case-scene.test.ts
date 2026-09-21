import { expect, it } from "vitest";
import type { DiagnosticCase } from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { diagnosticCaseScenario } from "../src/diagnostic-report-case-scene.ts";

function caseEvidence(content: string): DiagnosticCase["evidence"][number] {
  return {
    id: "C1-E1",
    label: "冻结 Case（用户输入与预期）",
    source: "CASE",
    content,
    truncated: false
  };
}

it("extracts scene, task type and user original input from CASE evidence", () => {
  const c = {
    caseKey: "FSU24-01",
    evidence: [
      caseEvidence(
        JSON.stringify({
          caseKey: "FSU24-01",
          description: "[用户整理]｜P0｜FSU24-01｜按产品组归属找到发布方案｜硬性22·质量2",
          task: "agent-e2e",
          requestBody: { text: "帮我在飞书找一下《发布方案 V2》，我要产品组那份。" }
        })
      )
    ]
  } as unknown as DiagnosticCase;
  expect(diagnosticCaseScenario(c)).toEqual({
    scene: "按产品组归属找到发布方案",
    taskType: "agent-e2e",
    userInput: "帮我在飞书找一下《发布方案 V2》，我要产品组那份。"
  });
});

it("keeps scene when task or user input is absent", () => {
  const c = {
    caseKey: "FSU24-01",
    evidence: [
      caseEvidence(
        JSON.stringify({
          caseKey: "FSU24-01",
          description: "[用户整理]｜P0｜FSU24-01｜按产品组归属找到发布方案",
          requestBody: {}
        })
      )
    ]
  } as unknown as DiagnosticCase;
  expect(diagnosticCaseScenario(c)).toEqual({
    scene: "按产品组归属找到发布方案",
    taskType: null,
    userInput: null
  });
});

it("falls back to caseKey for missing or malformed CASE evidence", () => {
  const missing = { caseKey: "B07", evidence: [] } as unknown as DiagnosticCase;
  expect(diagnosticCaseScenario(missing)).toEqual({
    scene: "B07",
    taskType: null,
    userInput: null
  });
  const malformed = {
    caseKey: "B07",
    evidence: [caseEvidence("{not json")]
  } as unknown as DiagnosticCase;
  expect(diagnosticCaseScenario(malformed)).toEqual({
    scene: "B07",
    taskType: null,
    userInput: null
  });
});

it("extracts from a truncated CASE excerpt (snapshot head-only JSON)", () => {
  const full = JSON.stringify({
    caseKey: "FSU24-01",
    description: "[用户整理]｜P0｜FSU24-01｜按产品组归属找到发布方案｜硬性22·质量2",
    threshold: 0.975113,
    task: "agent-e2e",
    requestBody: {
      execution_mode: "isolated",
      lang: "zh-Hans",
      text: "帮我在飞书找一下《发布方案 V2》，我要产品组那份。"
    }
  });
  // 模拟 excerpt 的截断格式：头 + 截断标记 + 尾
  const truncated = `${full.slice(0, 140)}\n[中间内容截断；此摘录不是完整 JSON]\n${full.slice(-60)}`;
  const c = {
    caseKey: "FSU24-01",
    evidence: [
      {
        id: "C1-E1",
        label: "冻结 Case（用户输入与预期）",
        source: "CASE",
        content: truncated,
        truncated: true
      }
    ]
  } as unknown as DiagnosticCase;
  expect(diagnosticCaseScenario(c)).toEqual({
    scene: "按产品组归属找到发布方案",
    taskType: "agent-e2e",
    userInput: "帮我在飞书找一下《发布方案 V2》，我要产品组那份。"
  });
});
