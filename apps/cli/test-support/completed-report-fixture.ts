import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "@cortex-eval/work-package/src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "@cortex-eval/work-package/src/work-package-raw-promptfoo-artifact-writer.ts";
import { WorkPackageRestArtifactWriter } from "@cortex-eval/work-package/src/work-package-rest-artifact-writer.ts";
import { materializeWorkPackageFixture } from "@cortex-eval/work-package/test-support/work-package-fixture.ts";

import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../src/cli-hashing.ts";
import { WorkPackageReportRunService } from "../src/work-package-report-run-service.ts";

/** Stable Execution identity shared by full offline stage tests. */
export const COMPLETED_REPORT_EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const CREATED_AT = "2026-07-15T00:00:00.000Z";
const EVALUATION_CONTEXT_HASH = "b".repeat(64);

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

/** Materialize one real REST plus failing Evaluation Execution. */
export async function materializeCompletedEvaluation(root: string): Promise<void> {
  const executionId = COMPLETED_REPORT_EXECUTION_ID;
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
      executionId,
      acquiredAt: CREATED_AT
    },
    contextHasher: cliExecutionContextHasher,
    nonce: (): string => `analysis_setup_${String(++nonce).padStart(2, "0")}`
  });
  try {
    await session.createExecution({
      executionId,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await session.startStage(executionId, "REST", CREATED_AT);
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
    const restWriter = await WorkPackageRestArtifactWriter.create(session, executionId);
    await restWriter.append(restResult);
    const restArtifact = await restWriter.commit("2026-07-15T00:01:00.000Z", restHasher.finish());
    await session.completeStage(executionId, "REST", "2026-07-15T00:01:00.000Z", [restArtifact]);

    await session.startStage(executionId, "EVALUATION", "2026-07-15T00:02:00.000Z");
    const raw = await writeWorkPackageRawPromptfooArtifact(
      session,
      executionId,
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
        present: true as const,
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
    const evalResult: EvalCaseV1 = { ...evalPartial, evalResultHash, finalCaseResultHash };
    const evalHasher = cliEvalSemanticHashing.createResultSetHasher((ordinal): string | null =>
      ordinal === 0 ? "case-1" : null
    );
    evalHasher.add({ caseKey: "case-1", ordinal: 0, evalResultHash });
    const evaluationResultSetHash = evalHasher.finish(
      { kind: "EXECUTION", id: executionId },
      EVALUATION_CONTEXT_HASH
    );
    const normalizedWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
      session,
      executionId,
      EVALUATION_CONTEXT_HASH
    );
    await normalizedWriter.append(evalResult);
    const normalized = await normalizedWriter.commit(
      "2026-07-15T00:03:00.000Z",
      evaluationResultSetHash
    );
    await session.completeStage(executionId, "EVALUATION", "2026-07-15T00:03:00.000Z", [
      raw,
      normalized
    ]);
  } finally {
    await session.close();
  }
}

/** Build the real Report stage service used before offline Analysis. */
export function completedReportService(): WorkPackageReportRunService {
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
    nonce: (): string => `analysis_report_${String(++nonce).padStart(2, "0")}`,
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
  });
}
