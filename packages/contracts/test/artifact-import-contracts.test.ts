import { describe, expect, it } from "vitest";

import {
  AnalysisResultsArtifactV1Schema,
  ArtifactManifestV1Schema,
  NormalizedEvalArtifactV1Schema,
  PlatformRestResultsArtifactV1Schema,
  RawPromptfooEvidenceArtifactV1Schema,
  ReportArtifactV1Schema,
  RestResultsArtifactV1Schema
} from "../src/artifact-contracts.ts";
import { ExecutionResultImportV1Schema } from "../src/result-import-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "b".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";
const identity = { packageId: ID, executionId: ID };

describe("阶段 Artifact v1", () => {
  it("校验 REST 成功和错误分支的互斥事实", () => {
    const success = {
      contractVersion: "cortex.rest-results.v1",
      ...identity,
      completedAt: TIME,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          caseDefinitionHash: HASH,
          status: "SUCCEEDED",
          httpStatus: 200,
          providerOutput: { ok: false, err_msg: "业务失败" },
          durationMs: 12,
          completedAt: TIME,
          resultHash: HASH,
          provenance: null
        }
      ],
      resultSetHash: HASH
    };
    expect(RestResultsArtifactV1Schema.parse(success).cases).toHaveLength(1);
    expect(
      RestResultsArtifactV1Schema.safeParse({
        ...success,
        cases: [success.cases[0], success.cases[0]]
      }).success
    ).toBe(false);
    const contradictoryError = {
      contractVersion: "cortex.rest-results.v1",
      ...identity,
      completedAt: TIME,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          caseDefinitionHash: HASH,
          status: "ERROR",
          httpStatus: null,
          providerOutput: null,
          error: { type: "HTTP_STATUS", message: "失败", httpStatus: 500 },
          durationMs: 12,
          completedAt: TIME,
          resultHash: HASH,
          provenance: null
        }
      ],
      resultSetHash: HASH
    };
    expect(RestResultsArtifactV1Schema.safeParse(contradictoryError).success).toBe(false);
    expect(
      RestResultsArtifactV1Schema.safeParse({
        ...success,
        cases: [{ ...success.cases[0], status: "ERROR", providerOutput: null }]
      }).success
    ).toBe(false);
  });

  it("平台 REST Artifact 使用 Run 身份且不伪造离线 Execution", () => {
    const value = {
      contractVersion: "cortex.platform-rest-results.v1",
      runId: ID,
      runContextHash: HASH,
      completedAt: TIME,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          caseDefinitionHash: HASH,
          status: "SUCCEEDED",
          httpStatus: 200,
          providerOutput: { ok: false, err_msg: "业务失败" },
          durationMs: 12,
          completedAt: TIME,
          resultHash: HASH,
          provenance: null
        }
      ],
      resultSetHash: HASH
    };
    expect(PlatformRestResultsArtifactV1Schema.parse(value).runId).toBe(ID);
    expect(
      PlatformRestResultsArtifactV1Schema.safeParse({
        ...value,
        packageId: ID,
        executionId: ID
      }).success
    ).toBe(false);
  });

  it("Raw Promptfoo 槽位和内容使用同一冻结版本", () => {
    const value = {
      contractVersion: "promptfoo.0.121.18",
      ...identity,
      exitCode: 100,
      durationMs: 12,
      raw: { results: [] }
    };
    expect(RawPromptfooEvidenceArtifactV1Schema.parse(value).contractVersion).toBe(
      "promptfoo.0.121.18"
    );
  });

  it("校验规范化 Eval 的断言、Diff、Metric 和最终哈希", () => {
    const value = {
      contractVersion: "cortex.normalized-eval.v1",
      ...identity,
      completedAt: TIME,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          status: "FAIL",
          promptfooSuccess: false,
          score: 0,
          reason: "schema mismatch",
          evaluationError: null,
          assertions: [
            {
              index: 0,
              definitionHash: HASH,
              type: "is-json",
              metric: "schema",
              weight: 1,
              status: "FAIL",
              score: 0,
              reason: "mismatch"
            }
          ],
          diffs: [
            {
              assertionIndex: 0,
              instancePath: "/value",
              schemaPath: "/properties/value/type",
              keyword: "type",
              expectedConstraint: "string",
              actual: 1,
              reason: "类型不匹配",
              validatorVersion: "1.0.0",
              schemaDialect: "2020-12",
              diffContractVersion: "cortex.assertion-diff.v1"
            }
          ],
          metrics: [{ metric: "schema", status: "FAIL" }],
          latencyMs: 5,
          tokenUsage: null,
          cost: null,
          rawEvidence: {
            present: true,
            path: "executions/x/promptfoo-raw.json",
            expectedSha256: HASH,
            expectedSizeBytes: 10
          },
          evalResultHash: HASH,
          finalCaseResultHash: HASH,
          provenance: null
        }
      ],
      resultSetHash: HASH
    };
    expect(NormalizedEvalArtifactV1Schema.parse(value).cases[0]?.status).toBe("FAIL");
    expect(
      NormalizedEvalArtifactV1Schema.safeParse({
        ...value,
        cases: [{ ...value.cases[0], status: "PASS", promptfooSuccess: false }]
      }).success
    ).toBe(false);
  });

  it("校验报告和分析产物的身份绑定", () => {
    const report = {
      contractVersion: "cortex.report.v1",
      ...identity,
      completedAt: TIME,
      summary: {
        total: 1,
        restSucceeded: 1,
        restError: 0,
        evalPass: 0,
        evalFail: 1,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 0,
        evaluatedPassRate: 0,
        coverageRate: 1
      },
      byMetric: [
        { metric: "schema", pass: 0, fail: 1, error: 0, skipped: 0, notEvaluated: 0, passRate: 0 }
      ],
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          restResultHash: HASH,
          evalResultHash: HASH,
          finalCaseResultHash: HASH
        }
      ],
      resultSetHash: HASH
    };
    expect(ReportArtifactV1Schema.parse(report).summary.total).toBe(1);

    const analysis = {
      contractVersion: "cortex.analysis-results.v1",
      ...identity,
      completedAt: TIME,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          finalCaseResultHash: HASH,
          analysisInputHash: HASH,
          status: "SUCCEEDED",
          classification: "NORMAL_FAILURE",
          confidence: 0.9,
          evidence: ["断言失败"],
          explanation: "结果不满足约束",
          recommendedAction: "修复系统",
          proposal: null,
          error: null
        }
      ],
      analysisResultSetHash: HASH
    };
    expect(AnalysisResultsArtifactV1Schema.parse(analysis).cases[0]?.classification).toBe(
      "NORMAL_FAILURE"
    );
  });

  it("Artifact Manifest 只保存受控相对路径和预期完整性", () => {
    const value = {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "EXECUTION", id: ID },
      artifacts: [
        {
          kind: "REPORT_JSON",
          path: "executions/x/report.json",
          expectedSha256: HASH,
          expectedSizeBytes: 10,
          contractVersion: "cortex.report.v1"
        }
      ]
    };
    expect(ArtifactManifestV1Schema.parse(value).artifacts).toHaveLength(1);
    expect(
      ArtifactManifestV1Schema.safeParse({
        ...value,
        artifacts: [{ ...value.artifacts[0], path: "../report.json" }]
      }).success
    ).toBe(false);
  });
});

describe("Execution Result Import v1", () => {
  it("报告与分析使用显式判别分支，支持分次导入", () => {
    const reportImport = {
      contractVersion: "cortex.execution-result-import.v1",
      importType: "REPORT",
      ...identity,
      resultSetHash: HASH,
      restResultsFile: { path: "executions/x/rest-results.json", sha256: HASH, sizeBytes: 1 },
      normalizedEvalFile: {
        path: "executions/x/normalized-eval.json",
        sha256: HASH,
        sizeBytes: 1
      },
      reportJsonFile: { path: "executions/x/report.json", sha256: HASH, sizeBytes: 1 },
      reportMarkdownFile: { path: "executions/x/report.md", sha256: HASH, sizeBytes: 1 },
      rawPromptfooEvidenceFile: null
    };
    const analysisImport = {
      contractVersion: "cortex.execution-result-import.v1",
      importType: "ANALYSIS",
      ...identity,
      finalCaseResultSetHash: HASH,
      analysisResultSetHash: HASH,
      analysisFile: { path: "executions/x/analysis-results.json", sha256: HASH, sizeBytes: 1 }
    };
    expect(ExecutionResultImportV1Schema.parse(reportImport).importType).toBe("REPORT");
    expect(ExecutionResultImportV1Schema.parse(analysisImport).importType).toBe("ANALYSIS");
    expect(
      ExecutionResultImportV1Schema.safeParse({ ...reportImport, apiKey: "secret" }).success
    ).toBe(false);
  });
});
