import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnalysisResultsArtifactV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { hashExecutionContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import type { FrozenAnalysisCaseResult } from "../../application/src/features/case-analysis/frozen-analysis-engine.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import {
  openWorkPackageExecutionSession,
  publishedStageArtifact,
  type WorkPackageExecutionContextHashInput,
  type WorkPackageExecutionSession,
  type WorkPackageArtifactKind
} from "../src/work-package-execution-session.ts";
import { WorkPackageAnalysisArtifactWriter } from "../src/work-package-analysis-artifact-writer.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const HASH = "a".repeat(64);
const roots: string[] = [];
type WorkPackageStage = "REST" | "EVALUATION" | "REPORT" | "ANALYSIS";

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId: EXECUTION_ID,
    acquiredAt: "2026-07-14T07:00:00.000Z"
  };
}

async function publish(
  session: WorkPackageExecutionSession,
  stage: WorkPackageStage,
  kind: WorkPackageArtifactKind,
  contractVersion: string,
  timestamp: string
): Promise<void> {
  await session.startStage(EXECUTION_ID, stage, timestamp);
  const writer = await session.createStageArtifactWriter(EXECUTION_ID, kind, 1024);
  await writer.append(Buffer.from("{}\n", "utf8"));
  const artifact = publishedStageArtifact(await writer.commit(), kind, contractVersion);
  await session.completeStage(EXECUTION_ID, stage, timestamp, [artifact]);
}

async function openAnalysisSession(
  prefix: string
): Promise<{ readonly session: WorkPackageExecutionSession; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await materializeWorkPackageFixture(root);
  let nonce = 0;
  const session = await openWorkPackageExecutionSession({
    rootPath: root,
    owner: owner(),
    contextHasher,
    nonce: (): string => `${prefix}${String(++nonce).padStart(2, "0")}`
  });
  await session.createExecution({
    executionId: EXECUTION_ID,
    createdAt: "2026-07-14T07:00:00.000Z",
    rerun: { mode: "NEW" }
  });
  await publish(
    session,
    "REST",
    "REST_RESULTS",
    "cortex.rest-results-jsonl.v1",
    "2026-07-14T07:01:00.000Z"
  );
  await session.startStage(EXECUTION_ID, "EVALUATION", "2026-07-14T07:02:00.000Z");
  const rawWriter = await session.createStageArtifactWriter(
    EXECUTION_ID,
    "RAW_PROMPTFOO_EVIDENCE",
    1024
  );
  await rawWriter.append(Buffer.from("{}\n", "utf8"));
  const raw = publishedStageArtifact(
    await rawWriter.commit(),
    "RAW_PROMPTFOO_EVIDENCE",
    "promptfoo.0.121.18"
  );
  const evalWriter = await session.createStageArtifactWriter(
    EXECUTION_ID,
    "NORMALIZED_EVAL_RESULTS",
    1024
  );
  await evalWriter.append(Buffer.from("{}\n", "utf8"));
  const evaluation = publishedStageArtifact(
    await evalWriter.commit(),
    "NORMALIZED_EVAL_RESULTS",
    "cortex.normalized-eval-jsonl.v1"
  );
  await session.completeStage(EXECUTION_ID, "EVALUATION", "2026-07-14T07:03:00.000Z", [
    raw,
    evaluation
  ]);
  await session.startStage(EXECUTION_ID, "REPORT", "2026-07-14T07:04:00.000Z");
  const reportWriter = await session.createStageArtifactWriter(EXECUTION_ID, "REPORT_JSON", 1024);
  await reportWriter.append(Buffer.from("{}\n", "utf8"));
  const report = publishedStageArtifact(
    await reportWriter.commit(),
    "REPORT_JSON",
    "cortex.report.v1"
  );
  const markdownWriter = await session.createStageArtifactWriter(
    EXECUTION_ID,
    "REPORT_MARKDOWN",
    1024
  );
  await markdownWriter.append(Buffer.from("report\n", "utf8"));
  const markdown = publishedStageArtifact(
    await markdownWriter.commit(),
    "REPORT_MARKDOWN",
    "cortex.report-markdown.v1"
  );
  await session.completeStage(EXECUTION_ID, "REPORT", "2026-07-14T07:05:00.000Z", [
    report,
    markdown
  ]);
  await session.startStage(EXECUTION_ID, "ANALYSIS", "2026-07-14T07:06:00.000Z");
  return { session, root };
}

function success(): Extract<FrozenAnalysisCaseResult, { readonly status: "SUCCEEDED" }> {
  return {
    caseKey: "case-1",
    ordinal: 0,
    finalCaseResultHash: HASH,
    analysisInputHash: HASH,
    analysisResultHash: HASH,
    status: "SUCCEEDED",
    classification: "LABEL_ERROR",
    confidence: 0.9,
    evidence: [{ source: "case_definition", fieldPath: "/assert/0", conclusion: "标注错误" }],
    explanation: "Case 标注错误",
    recommendedAction: "修正 Case",
    proposal: null
  };
}

function failure(): Extract<FrozenAnalysisCaseResult, { readonly status: "ERROR" }> {
  return {
    caseKey: "case-1",
    ordinal: 0,
    finalCaseResultHash: HASH,
    analysisInputHash: HASH,
    analysisResultHash: HASH,
    status: "ERROR",
    errorCode: "ANALYZER_OUTPUT_INVALID"
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkPackageAnalysisArtifactWriter", () => {
  it("流式写入结构化 Evidence，并用 Execution Owner 生成结果集合版本", async () => {
    const { session, root } = await openAnalysisSession("cortex-analysis-artifact-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session,
        executionId: EXECUTION_ID,
        selector: "failed",
        finalCaseResultSetHash: HASH,
        errorMessage: (code) => `安全错误：${code}`
      });
      await writer.append(success());
      const committed = await writer.commit("2026-07-14T07:07:00.000Z");
      await session.completeStage(EXECUTION_ID, "ANALYSIS", "2026-07-14T07:07:00.000Z", [
        committed.artifact
      ]);

      const value = AnalysisResultsArtifactV1Schema.parse(
        JSON.parse(
          await readFile(join(root, `executions/${EXECUTION_ID}/analysis-results.json`), "utf8")
        ) as unknown
      );
      expect(value).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID,
        selector: "failed",
        finalCaseResultSetHash: HASH,
        analysisResultSetHash: committed.analysisResultSetHash,
        cases: [{ status: "SUCCEEDED", evidence: success().evidence }]
      });
    } finally {
      await session.close();
    }
  });

  it("无可分析 Case 时发布合法空结果，而不是伪造 Case", async () => {
    const { session } = await openAnalysisSession("cortex-analysis-empty-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session,
        executionId: EXECUTION_ID,
        selector: "errors",
        finalCaseResultSetHash: HASH,
        errorMessage: () => "分析失败"
      });
      const committed = await writer.commit("2026-07-14T07:07:00.000Z");
      expect(committed.analysisResultSetHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await session.close();
    }
  });

  it("分别写入带 Proposal 的成功结果与外化消息后的错误结果", async () => {
    const proposalSession = await openAnalysisSession("cortex-analysis-proposal-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session: proposalSession.session,
        executionId: EXECUTION_ID,
        selector: "all",
        finalCaseResultSetHash: HASH,
        errorMessage: (code) => code
      });
      await writer.append({
        ...success(),
        proposal: {
          action: "ADD_ASSERTION",
          baseDefinitionHash: HASH,
          targetAssertionIndex: 1,
          assertion: { type: "equals", metric: "exact", weight: 1, value: "alternative" }
        }
      });
      await writer.commit("2026-07-14T07:07:00.000Z");
      const value = AnalysisResultsArtifactV1Schema.parse(
        JSON.parse(
          await readFile(
            join(proposalSession.root, `executions/${EXECUTION_ID}/analysis-results.json`),
            "utf8"
          )
        ) as unknown
      );
      expect(value.cases[0]).toMatchObject({
        status: "SUCCEEDED",
        proposal: { action: "ADD_ASSERTION", targetAssertionIndex: 1 },
        error: null
      });
    } finally {
      await proposalSession.session.close();
    }

    const errorSession = await openAnalysisSession("cortex-analysis-error-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session: errorSession.session,
        executionId: EXECUTION_ID,
        selector: "errors",
        finalCaseResultSetHash: HASH,
        errorMessage: (code) => `安全错误：${code}`
      });
      await writer.append(failure());
      await writer.commit("2026-07-14T07:07:00.000Z");
      const value = AnalysisResultsArtifactV1Schema.parse(
        JSON.parse(
          await readFile(
            join(errorSession.root, `executions/${EXECUTION_ID}/analysis-results.json`),
            "utf8"
          )
        ) as unknown
      );
      expect(value.cases[0]).toMatchObject({
        status: "ERROR",
        evidence: [],
        error: {
          code: "ANALYZER_OUTPUT_INVALID",
          message: "安全错误：ANALYZER_OUTPUT_INVALID"
        }
      });
    } finally {
      await errorSession.session.close();
    }
  });

  it("拒绝重复 Ordinal 与 Manifest Case 身份漂移，并支持幂等中止", async () => {
    const { session } = await openAnalysisSession("cortex-analysis-order-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session,
        executionId: EXECUTION_ID,
        selector: "failed",
        finalCaseResultSetHash: HASH,
        errorMessage: (code) => code
      });
      await writer.append(success());
      await expect(writer.append(success())).rejects.toThrow("ANALYSIS_STAGE_FAILED");
      await expect(writer.append({ ...success(), ordinal: 1 })).rejects.toThrow(
        "ANALYSIS_STAGE_FAILED"
      );
      await writer.abort();
      await writer.abort();
      await expect(writer.append(success())).rejects.toThrow("ARTIFACT_WRITER_CLOSED");
    } finally {
      await session.close();
    }
  });

  it("提交时间或错误消息无效时清理临时文件并关闭 Writer", async () => {
    const timestampSession = await openAnalysisSession("cortex-analysis-timestamp-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session: timestampSession.session,
        executionId: EXECUTION_ID,
        selector: "failed",
        finalCaseResultSetHash: HASH,
        errorMessage: (code) => code
      });
      await expect(writer.commit("invalid-time")).rejects.toThrow("ANALYSIS_STAGE_FAILED");
      await writer.abort();
      await expect(writer.append(success())).rejects.toThrow("ARTIFACT_WRITER_CLOSED");
    } finally {
      await timestampSession.session.close();
    }

    const messageSession = await openAnalysisSession("cortex-analysis-message-");
    try {
      const writer = await WorkPackageAnalysisArtifactWriter.create({
        session: messageSession.session,
        executionId: EXECUTION_ID,
        selector: "errors",
        finalCaseResultSetHash: HASH,
        errorMessage: () => {
          throw new Error("MESSAGE_LOOKUP_FAILED");
        }
      });
      await expect(writer.append(failure())).rejects.toThrow("ANALYSIS_STAGE_FAILED");
      await writer.abort();
    } finally {
      await messageSession.session.close();
    }
  });
});
