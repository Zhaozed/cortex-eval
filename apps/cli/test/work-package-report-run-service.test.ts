import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { ReportArtifactV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { ExecutionV1Schema } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "@cortex-eval/work-package/src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "@cortex-eval/work-package/src/work-package-raw-promptfoo-artifact-writer.ts";
import { WorkPackageRestArtifactWriter } from "@cortex-eval/work-package/src/work-package-rest-artifact-writer.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../src/cli-hashing.ts";
import { WorkPackageReportRunService } from "../src/work-package-report-run-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const CREATED_AT = "2026-07-15T00:00:00.000Z";
const EVALUATION_CONTEXT_HASH = "b".repeat(64);
const roots: string[] = [];

const definition = {
  caseKey: "case-1",
  description: "fixture",
  threshold: 1,
  task: "reply",
  requestBody: { text: "hello" },
  metadata: {
    requestId: "req-1",
    taskId: "task-1",
    businessModule: "fixture",
    scenarioTag: "fixture"
  },
  assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
} as const;

async function completedEvaluation(root: string): Promise<{ readonly rawPath: string }> {
  const caseDefinitionHash = cliCaseDefinitionHasher.hash({
    contractVersion: "cortex.case-definition.v1",
    caseKey: definition.caseKey,
    definition
  });
  await materializeWorkPackageFixture(root, { baseDefinitionHash: caseDefinitionHash });
  let nonce = 0;
  const session = await openWorkPackageExecutionSession({
    rootPath: root,
    owner: {
      pid: process.pid,
      processStartedAt: "Wed Jul 15 08:00:00 2026",
      executionId: EXECUTION_ID,
      acquiredAt: CREATED_AT
    },
    contextHasher: cliExecutionContextHasher,
    nonce: (): string => `report_setup_${String(++nonce).padStart(2, "0")}`
  });
  try {
    await session.createExecution({
      executionId: EXECUTION_ID,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await session.startStage(EXECUTION_ID, "REST", CREATED_AT);
    const restPartial = {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash,
      status: "SUCCEEDED" as const,
      httpStatus: 200,
      providerOutput: {
        ok: true as const,
        taskName: "reply",
        resolvedConfig: {},
        parsedOutput: { text: "other" }
      },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: "2026-07-15T00:01:00.000Z",
      resultHash: "",
      provenance: null
    };
    const restResultHash = cliRestSemanticHashing.hashResult(restPartial);
    const restResult = { ...restPartial, resultHash: restResultHash };
    const restHasher = cliRestSemanticHashing.createResultSetHasher();
    restHasher.add({ caseKey: "case-1", ordinal: 0, resultHash: restResultHash });
    const restWriter = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
    await restWriter.append(restResult);
    const restArtifact = await restWriter.commit("2026-07-15T00:01:00.000Z", restHasher.finish());
    await session.completeStage(EXECUTION_ID, "REST", "2026-07-15T00:01:00.000Z", [restArtifact]);

    await session.startStage(EXECUTION_ID, "EVALUATION", "2026-07-15T00:02:00.000Z");
    const raw = await writeWorkPackageRawPromptfooArtifact(
      session,
      EXECUTION_ID,
      {
        promptfooVersion: "0.121.18",
        exitCode: 100,
        durationMs: 1,
        raw: { results: { version: 3, results: [] } },
        rubricPromptMaterializations: {},
        evaluationContextHash: EVALUATION_CONTEXT_HASH
      },
      new AbortController().signal
    );
    const evalPartial = {
      caseKey: "case-1",
      ordinal: 0,
      status: "FAIL" as const,
      promptfooSuccess: false,
      score: 0,
      reason: "not matched",
      evaluationError: null,
      assertions: [
        {
          index: 0,
          definitionHash: caseDefinitionHash,
          type: "equals",
          metric: "exact",
          weight: 1,
          status: "FAIL" as const,
          score: 0,
          reason: "not matched"
        }
      ],
      diffs: [],
      metrics: [{ metric: "exact", status: "FAIL" as const }],
      latencyMs: 1,
      tokenUsage: null,
      cost: null,
      rawEvidence: {
        present: true,
        path: raw.path,
        expectedSha256: raw.sha256,
        expectedSizeBytes: raw.sizeBytes
      },
      evalResultHash: "",
      finalCaseResultHash: "",
      provenance: null
    };
    const evalResultHash = cliEvalSemanticHashing.hashResult(evalPartial);
    const finalCaseResultHash = cliEvalSemanticHashing.hashFinalResult({
      caseDefinitionHash,
      restResultHash,
      evalResultHash
    });
    const evalResult: EvalCaseV1 = {
      ...evalPartial,
      evalResultHash,
      finalCaseResultHash
    };
    const evalHasher = cliEvalSemanticHashing.createResultSetHasher((ordinal): string | null =>
      ordinal === 0 ? "case-1" : null
    );
    evalHasher.add({ caseKey: "case-1", ordinal: 0, evalResultHash });
    const evaluationResultSetHash = evalHasher.finish(
      { kind: "EXECUTION", id: EXECUTION_ID },
      EVALUATION_CONTEXT_HASH
    );
    const normalizedWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
      session,
      EXECUTION_ID,
      EVALUATION_CONTEXT_HASH
    );
    await normalizedWriter.append(evalResult);
    const normalized = await normalizedWriter.commit(
      "2026-07-15T00:03:00.000Z",
      evaluationResultSetHash
    );
    await session.completeStage(EXECUTION_ID, "EVALUATION", "2026-07-15T00:03:00.000Z", [
      raw,
      normalized
    ]);
    return { rawPath: raw.path };
  } finally {
    await session.close();
  }
}

function reportService(): WorkPackageReportRunService {
  let nonce = 0;
  let minute = 4;
  return new WorkPackageReportRunService({
    contextHasher: cliExecutionContextHasher,
    caseHasher: cliCaseDefinitionHasher,
    restHashing: cliRestSemanticHashing,
    evalHashing: cliEvalSemanticHashing,
    processIdentity: {
      processStartedAt: (): Promise<string> => Promise.resolve("Wed Jul 15 08:00:00 2026")
    },
    nonce: (): string => `report_run_${String(++nonce).padStart(2, "0")}`,
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Report Run Service", () => {
  it("Raw 文件缺失仍从完整规范化事实生成并登记 JSON 与 Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-report-run-"));
    roots.push(root);
    const source = await completedEvaluation(root);
    await unlink(join(root, source.rawPath));

    const result = await reportService().run({
      packagePath: root,
      executionId: EXECUTION_ID,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      packageId: WORK_PACKAGE_FIXTURE_ID,
      executionId: EXECUTION_ID,
      summary: { total: 1, evalFail: 1 },
      reportJsonPath: `executions/${EXECUTION_ID}/report.json`,
      reportMarkdownPath: `executions/${EXECUTION_ID}/report.md`
    });
    expect(result.reportResultSetHash).not.toBe(result.evaluationResultSetHash);
    const report = ReportArtifactV1Schema.parse(
      JSON.parse(await readFile(join(root, result.reportJsonPath), "utf8")) as unknown
    );
    expect(report.cases[0]?.evaluation.rawEvidence?.present).toBe(true);
    expect(await readFile(join(root, result.reportMarkdownPath), "utf8")).toContain("not matched");
    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(join(root, `executions/${EXECUTION_ID}/execution.json`), "utf8")
      ) as unknown
    );
    expect(execution.stages.REPORT).toMatchObject({ status: "SUCCEEDED" });
    expect(execution.stages.REPORT.artifacts.map((item) => item.kind)).toEqual([
      "REPORT_JSON",
      "REPORT_MARKDOWN"
    ]);
    const importSession = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Wed Jul 15 08:00:00 2026",
        executionId: EXECUTION_ID,
        acquiredAt: "2026-07-15T00:06:00.000Z"
      },
      contextHasher: cliExecutionContextHasher,
      nonce: () => "report_import",
      validationOptions: { allowRawEvidenceUnavailable: true }
    });
    try {
      const preparedImport = await importSession.prepareReportImport(
        EXECUTION_ID,
        cliCaseDefinitionHasher,
        cliRestSemanticHashing,
        cliEvalSemanticHashing,
        new AbortController().signal
      );
      const importedCases = [];
      for await (const item of preparedImport.openCases()) importedCases.push(item);
      expect(preparedImport).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID,
        reportResultSetHash: result.reportResultSetHash,
        reportSummary: { summary: { total: 1, evalFail: 1 } }
      });
      expect(importedCases).toHaveLength(1);
      expect(importedCases[0]?.evaluation.rawEvidence?.present).toBe(true);
    } finally {
      await importSession.close();
    }
  });

  it("开始前取消不改变 Report 阶段", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-report-cancel-"));
    roots.push(root);
    await completedEvaluation(root);
    const controller = new AbortController();
    controller.abort();

    await expect(
      reportService().run({
        packagePath: root,
        executionId: EXECUTION_ID,
        signal: controller.signal
      })
    ).rejects.toThrow("REQUEST_ABORTED");
    const execution = ExecutionV1Schema.parse(
      JSON.parse(
        await readFile(join(root, `executions/${EXECUTION_ID}/execution.json`), "utf8")
      ) as unknown
    );
    expect(execution.stages.REPORT.status).toBe("PENDING");
  });
});
