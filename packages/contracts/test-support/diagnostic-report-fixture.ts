import type {
  DiagnosticReport,
  DiagnosticSnapshot,
  DiagnosisOutput
} from "../src/diagnostic-report-contracts.ts";
export const DIAG_RUN = "01900000-0000-7000-8000-000000000001";
export const DIAG_MODEL = "01900000-0000-7000-8000-000000000300";
export const DIAG_ID = "01900000-0000-7000-8000-000000000900";
export const DIAG_HASH = "a".repeat(64);
export function diagnosisFixture(): DiagnosisOutput {
  return {
    title: "缺少结果卡片",
    category: "PRODUCT",
    evidenceStatus: "SUPPORTED",
    attribution: {
      domain: "A2UI",
      location: "A2UI_PAYLOAD",
      confidence: "MEDIUM",
      rationale:
        "工具回执成功但保存的输出 cards 为空，优先检查结果卡片是否在出站 Payload 组装阶段丢失。"
    },
    observation: "工具成功，但输出未包含结果卡",
    cause: "结果卡片没有进入最终输出，具体分支待源码验证",
    evidenceIds: ["C1-E1", "C1-E2"],
    alternatives: ["可能是证据采集遗漏"],
    recommendations: ["检查结果卡片组装与输出路径"],
    verification: ["重跑相同输入，核验工具回执和最终可见卡片"]
  };
}
export function diagnosticSnapshotFixture(): DiagnosticSnapshot {
  return {
    runId: DIAG_RUN,
    title: "飞书 Agent 回归",
    suiteName: "飞书场景测试集",
    startedAt: "2026-09-17T02:00:00.000Z",
    completedAt: "2026-09-17T02:02:00.000Z",
    reportHash: DIAG_HASH,
    agentRevision: "运行版本未验证",
    summary: {
      total: 2,
      restError: 0,
      evalPass: 1,
      evalFail: 1,
      evalError: 0,
      notEvaluated: 0,
      effectivePassRate: 0.5,
      evaluatedPassRate: 0.5,
      coverageRate: 1
    },
    caseIndex: [
      { caseKey: "B07", status: "FAIL" },
      { caseKey: "B08", status: "PASS" }
    ],
    cases: [
      {
        caseKey: "B07",
        ordinal: 0,
        status: "FAIL",
        restStatus: "SUCCEEDED",
        reason: "未输出人员忙闲结果卡",
        resultHash: DIAG_HASH,
        assertions: [
          {
            index: 0,
            metric: "【硬性】D5.1 该出卡时必须出卡｜应显示结果卡",
            type: "javascript",
            status: "FAIL",
            reason: "结果卡缺失"
          }
        ],
        evidence: [
          {
            id: "C1-E1",
            label: "断言判定",
            source: "ASSERTIONS",
            content: "结果卡缺失",
            truncated: false
          },
          {
            id: "C1-E2",
            label: "已保存的 Agent 输出",
            source: "OUTPUT",
            content: '{"cards":[],"toolResult":"success"}',
            truncated: false
          }
        ],
        diagnosis: null,
        diagnosisError: null
      }
    ],
    narrative: null,
    narrativeError: null,
    limitations: ["未额外读取 Agent 项目日志或源码。", "AI 归因不改变自动评测判定。"]
  };
}
export function diagnosticReportFixture(): DiagnosticReport {
  const snapshot = diagnosticSnapshotFixture();
  const first = snapshot.cases[0];
  if (!first) throw new Error("FIXTURE_CASE_MISSING");
  first.diagnosis = diagnosisFixture();
  return {
    id: DIAG_ID,
    runId: DIAG_RUN,
    version: 1,
    status: "COMPLETED",
    phase: "DONE",
    createdAt: "2026-09-17T03:00:00.000Z",
    completedAt: "2026-09-17T03:01:00.000Z",
    model: {
      configId: DIAG_MODEL,
      name: "已有分析模型",
      provider: "OPENAI_COMPATIBLE",
      model: "test-model",
      configHash: DIAG_HASH
    },
    promptVersion: "diagnostic-report.v1",
    completedCases: 1,
    totalCases: 1,
    error: null,
    snapshot
  };
}
