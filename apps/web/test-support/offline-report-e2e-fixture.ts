import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  workPackageCaseDefinitionHasher,
  workPackageEvalSemanticHashing,
  workPackageExecutionContextHasher,
  workPackageRestSemanticHashing
} from "../../../packages/work-package/src/work-package-domain-hashing.ts";
import { openWorkPackageExecutionSession } from "../../../packages/work-package/src/work-package-execution-session.ts";
import { receiveWorkPackageExport } from "../../../packages/work-package/src/work-package-export-receiver.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "../../../packages/work-package/src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "../../../packages/work-package/src/work-package-raw-promptfoo-artifact-writer.ts";
import { WorkPackageRestArtifactWriter } from "../../../packages/work-package/src/work-package-rest-artifact-writer.ts";

import { WorkPackageReportRunService } from "../../cli/src/work-package-report-run-service.ts";

const CREATED_AT = "2026-07-15T00:00:00.000Z";
const PROCESS_STARTED_AT = "Wed Jul 15 08:00:00 2026";
const EVALUATION_CONTEXT_HASH = "b".repeat(64);

/** Inputs required to turn one real platform export into an importable offline Report. */
export interface OfflineReportE2eFixtureInput {
  /** Complete NDJSON export response bytes returned by the real Local Server. */
  readonly exportBody: Uint8Array;
  /** New absolute package directory that will be atomically published. */
  readonly packagePath: string;
  /** Stable offline Execution version identity. */
  readonly executionId: string;
}

// Return deterministic monotonic stage timestamps while keeping file nonces unpredictable.
function reportService(): WorkPackageReportRunService {
  let minute = 4;
  return new WorkPackageReportRunService({
    contextHasher: workPackageExecutionContextHasher,
    caseHasher: workPackageCaseDefinitionHasher,
    restHashing: workPackageRestSemanticHashing,
    evalHashing: workPackageEvalSemanticHashing,
    processIdentity: {
      processStartedAt: (): Promise<string> => Promise.resolve(PROCESS_STARTED_AT)
    },
    nonce: (): string => randomUUID(),
    now: (): string => `2026-07-15T00:${String(minute++).padStart(2, "0")}:00.000Z`,
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
  });
}

/** Materialize, execute and report one single-Case package without external model calls. */
export async function materializeCompletedOfflineReport(
  input: OfflineReportE2eFixtureInput
): Promise<void> {
  await receiveWorkPackageExport(Readable.from([input.exportBody]), input.packagePath, {
    nonce: randomUUID(),
    owner: {
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      executionId: null,
      acquiredAt: CREATED_AT
    }
  });

  const session = await openWorkPackageExecutionSession({
    rootPath: input.packagePath,
    owner: {
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      executionId: input.executionId,
      acquiredAt: CREATED_AT
    },
    contextHasher: workPackageExecutionContextHasher,
    nonce: (): string => randomUUID()
  });
  try {
    const cases = [];
    for await (const item of session.inputs.streamCases(workPackageCaseDefinitionHasher)) {
      cases.push(item);
    }
    const testCase = cases[0];
    if (testCase === undefined || cases.length !== 1) {
      throw new Error("E2E_OFFLINE_REPORT_CASE_COUNT_INVALID");
    }

    await session.createExecution({
      executionId: input.executionId,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await session.startStage(input.executionId, "REST", "2026-07-15T00:00:30.000Z");
    const restPartial = {
      caseKey: testCase.caseKey,
      ordinal: testCase.ordinal,
      caseDefinitionHash: testCase.definitionHash,
      status: "SUCCEEDED" as const,
      httpStatus: 200,
      providerOutput: {
        ok: true as const,
        taskName: testCase.definition.task,
        resolvedConfig: { source: "offline-e2e" },
        parsedOutput: { answer: "ok" }
      },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: "2026-07-15T00:01:00.000Z",
      resultHash: "",
      provenance: null
    };
    const restResultHash = workPackageRestSemanticHashing.hashResult(restPartial);
    const restResult = { ...restPartial, resultHash: restResultHash };
    const restHasher = workPackageRestSemanticHashing.createResultSetHasher();
    restHasher.add({
      caseKey: testCase.caseKey,
      ordinal: testCase.ordinal,
      resultHash: restResultHash
    });
    const restWriter = await WorkPackageRestArtifactWriter.create(session, input.executionId);
    await restWriter.append(restResult);
    const restArtifact = await restWriter.commit("2026-07-15T00:01:00.000Z", restHasher.finish());
    await session.completeStage(input.executionId, "REST", "2026-07-15T00:01:00.000Z", [
      restArtifact
    ]);

    await session.startStage(input.executionId, "EVALUATION", "2026-07-15T00:02:00.000Z");
    const rawArtifact = await writeWorkPackageRawPromptfooArtifact(
      session,
      input.executionId,
      {
        promptfooVersion: "0.121.18",
        exitCode: 0,
        durationMs: 1,
        raw: { results: { version: 3, results: [] } },
        rubricPromptMaterializations: {},
        evaluationContextHash: EVALUATION_CONTEXT_HASH
      },
      new AbortController().signal
    );
    const metric = testCase.definition.assertions[0]?.metric ?? "quality";
    const evaluationPartial = {
      caseKey: testCase.caseKey,
      ordinal: testCase.ordinal,
      status: "PASS" as const,
      promptfooSuccess: true,
      score: 1,
      reason: "offline e2e passed",
      evaluationError: null,
      assertions: [],
      diffs: [],
      metrics: [{ metric, status: "PASS" as const }],
      latencyMs: 1,
      tokenUsage: null,
      cost: null,
      rawEvidence: {
        present: true as const,
        path: rawArtifact.path,
        expectedSha256: rawArtifact.sha256,
        expectedSizeBytes: rawArtifact.sizeBytes
      },
      evalResultHash: "",
      finalCaseResultHash: "",
      provenance: null
    };
    const evalResultHash = workPackageEvalSemanticHashing.hashResult(evaluationPartial);
    const evaluation: EvalCaseV1 = {
      ...evaluationPartial,
      evalResultHash,
      finalCaseResultHash: workPackageEvalSemanticHashing.hashFinalResult({
        caseDefinitionHash: testCase.definitionHash,
        restResultHash,
        evalResultHash
      })
    };
    const evalHasher = workPackageEvalSemanticHashing.createResultSetHasher(
      (ordinal): string | null => session.inputs.expectedCaseKey(ordinal)
    );
    evalHasher.add({ caseKey: testCase.caseKey, ordinal: testCase.ordinal, evalResultHash });
    const evaluationResultSetHash = evalHasher.finish(
      { kind: "EXECUTION", id: input.executionId },
      EVALUATION_CONTEXT_HASH
    );
    const evalWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
      session,
      input.executionId,
      EVALUATION_CONTEXT_HASH
    );
    await evalWriter.append(evaluation);
    const evalArtifact = await evalWriter.commit(
      "2026-07-15T00:03:00.000Z",
      evaluationResultSetHash
    );
    await session.completeStage(input.executionId, "EVALUATION", "2026-07-15T00:03:00.000Z", [
      rawArtifact,
      evalArtifact
    ]);
  } finally {
    await session.close();
  }

  await reportService().run({
    packagePath: input.packagePath,
    executionId: input.executionId,
    signal: new AbortController().signal
  });
}
