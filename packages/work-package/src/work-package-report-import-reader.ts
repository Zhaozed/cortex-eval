import type {
  ImportedExecutionArtifactManifest,
  ImportedExecutionReportCase,
  ImportedRunContractVersions,
  ImportedRunSuiteSnapshot
} from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type {
  FrozenRunEndpoint,
  FrozenRunEvaluator,
  FrozenRunRubricPrompt,
  PlatformRunExecutionLimits
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { DomainJsonValue } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type {
  ExecutionV1,
  WorkPackageManifestV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import type { ReportCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import type { WorkPackageEvalSemanticHashing } from "./work-package-evaluation-retry-reader.ts";
import { prepareWorkPackageEvaluationResultsForReport } from "./work-package-evaluation-result-reader.ts";
import { validateFileIntegrity } from "./work-package-file-integrity.ts";
import type { WorkPackageCaseDefinitionHasher } from "./work-package-input-reader.ts";
import {
  workPackageCaseDefinitionFromV1,
  type WorkPackageInputReader
} from "./work-package-input-reader.ts";
import {
  readWorkPackageReportArtifact,
  type WorkPackageReportArtifactSummary
} from "./work-package-report-artifact-reader.ts";
import { prepareWorkPackageReport } from "./work-package-report-reader.ts";
import type { WorkPackageRestSemanticHashing } from "./work-package-rest-retry-reader.ts";
import {
  prepareWorkPackageRestResults,
  workPackageRestApplicationResult
} from "./work-package-rest-retry-reader.ts";

interface ReportStageArtifact {
  readonly kind: "REPORT_JSON" | "REPORT_MARKDOWN";
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contractVersion: string;
}

/** Fully preflighted complete Report import facts with a second-pass Case source. */
export interface PreparedWorkPackageReportImport {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution version identity. */
  readonly executionId: string;
  /** Complete REST result-set identity. */
  readonly restResultSetHash: string;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
  /** Recomputed report counters and Metric summaries. */
  readonly reportSummary: {
    readonly summary: WorkPackageReportArtifactSummary["summary"];
    readonly byMetric: WorkPackageReportArtifactSummary["byMetric"];
  };
  /** Compact frozen Suite snapshot; definitions remain in ordered result rows. */
  readonly suiteSnapshot: ImportedRunSuiteSnapshot;
  /** Frozen Endpoint snapshot. */
  readonly endpointSnapshot: FrozenRunEndpoint;
  /** Frozen Evaluator snapshot. */
  readonly evaluatorSnapshot: FrozenRunEvaluator;
  /** Frozen referenced Rubric Prompt snapshots. */
  readonly rubricPromptsSnapshot: readonly FrozenRunRubricPrompt[];
  /** Frozen offline Execution context identity. */
  readonly runContextHash: string;
  /** Frozen protocol version facts. */
  readonly contractVersions: ImportedRunContractVersions;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: PlatformRunExecutionLimits;
  /** Exact registered result Artifact identities. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
  /** Offline Execution creation time. */
  readonly executionCreatedAt: string;
  /** Offline Execution first-stage start time. */
  readonly executionStartedAt: string | null;
  /** Offline Report completion time. */
  readonly completedAt: string;
  /** Revalidate and stream complete imported result rows. */
  readonly openCases: () => AsyncIterable<ImportedExecutionReportCase>;
}

/** Locked inputs required to prepare one complete offline Report import. */
export interface PrepareWorkPackageReportImportInput {
  /** Stable package directory. */
  readonly directory: SecureWorkPackageDirectory;
  /** Fully validated immutable Manifest. */
  readonly manifest: WorkPackageManifestV1;
  /** Fully validated Execution state. */
  readonly execution: ExecutionV1;
  /** Narrow immutable input reader. */
  readonly inputs: WorkPackageInputReader;
  /** Pure Case Definition hashing. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST semantic hashing. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Evaluation semantic hashing. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Operation cancellation. */
  readonly signal: AbortSignal;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

// Canonically compare two already validated JSON-compatible DTOs.
function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left as DomainJsonValue) === canonicalJson(right as DomainJsonValue);
}

// Require exactly the two fixed Report stage slots.
function reportArtifacts(execution: ExecutionV1): {
  readonly json: ReportStageArtifact;
  readonly markdown: ReportStageArtifact;
} {
  const stage = execution.stages.REPORT;
  if (stage.status !== "SUCCEEDED" || stage.completedAt === null || stage.artifacts.length !== 2) {
    throw invalid();
  }
  const json = stage.artifacts.find((artifact) => artifact.kind === "REPORT_JSON");
  const markdown = stage.artifacts.find((artifact) => artifact.kind === "REPORT_MARKDOWN");
  if (json === undefined || markdown === undefined) throw invalid();
  return {
    json: { ...json, kind: "REPORT_JSON" },
    markdown: { ...markdown, kind: "REPORT_MARKDOWN" }
  };
}

// Convert all registered P8 result slots into one immutable import identity.
function artifactManifest(execution: ExecutionV1): ImportedExecutionArtifactManifest {
  const artifacts = [
    ...execution.stages.REST.artifacts,
    ...execution.stages.EVALUATION.artifacts,
    ...execution.stages.REPORT.artifacts
  ].map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    contractVersion: artifact.contractVersion
  }));
  return {
    contractVersion: "cortex.artifact-manifest.v1",
    owner: { kind: "EXECUTION", id: execution.executionId },
    artifacts
  };
}

// Map one exact reconciled Report Case into Application persistence facts.
function importedCase(value: ReportCaseV1): ImportedExecutionReportCase {
  const rawEvidence = value.evaluation.rawEvidence;
  return {
    testCase: {
      caseKey: value.caseKey,
      ordinal: value.ordinal,
      definitionHash: value.definitionHash,
      definition: workPackageCaseDefinitionFromV1(value.definition)
    },
    rest: workPackageRestApplicationResult(value.rest),
    evaluation: {
      caseKey: value.evaluation.caseKey,
      ordinal: value.evaluation.ordinal,
      status: value.evaluation.status,
      promptfooSuccess: value.evaluation.promptfooSuccess,
      score: value.evaluation.score,
      reason: value.evaluation.reason,
      evaluationError: value.evaluation.evaluationError,
      assertions: value.evaluation.assertions,
      diffs: value.evaluation.diffs,
      metrics: value.evaluation.metrics,
      latencyMs: value.evaluation.latencyMs,
      tokenUsage: value.evaluation.tokenUsage,
      cost: value.evaluation.cost,
      rawEvidence:
        rawEvidence?.present === true
          ? {
              present: true,
              path: rawEvidence.path,
              expectedSha256: rawEvidence.expectedSha256,
              expectedSizeBytes: rawEvidence.expectedSizeBytes
            }
          : null,
      evalResultHash: value.evaluation.evalResultHash,
      finalCaseResultHash: value.evaluation.finalCaseResultHash,
      provenance: value.evaluation.provenance
    }
  };
}

// Consume and compare the stored Report and independently recomputed three-source Report.
async function* verifiedCases(
  input: PrepareWorkPackageReportImportInput,
  reportPath: string,
  prepared: Awaited<ReturnType<typeof prepareWorkPackageReport>>,
  expectedContext: WorkPackageReportArtifactSummary["context"],
  expectedEvaluationContextHash: string,
  expectedEvaluationResultSetHash: string,
  expectedCompletedAt: string
): AsyncGenerator<ImportedExecutionReportCase, WorkPackageReportArtifactSummary> {
  const stored = readWorkPackageReportArtifact(input.directory.streamFile(reportPath), {
    packageId: input.manifest.packageId,
    executionId: input.execution.executionId,
    expectedCaseCount: input.inputs.expectedCaseCount,
    expectedCaseKey: input.inputs.expectedCaseKey.bind(input.inputs),
    signal: input.signal
  });
  const recomputed = prepared.openCases()[Symbol.asyncIterator]();
  try {
    for (;;) {
      const [storedStep, recomputedStep] = await Promise.all([stored.next(), recomputed.next()]);
      if (storedStep.done || recomputedStep.done) {
        if (!(storedStep.done && recomputedStep.done)) throw invalid();
        const envelope = storedStep.value;
        if (
          envelope.evaluationContextHash !== expectedEvaluationContextHash ||
          envelope.evaluationResultSetHash !== expectedEvaluationResultSetHash ||
          envelope.completedAt !== expectedCompletedAt ||
          !sameJson(envelope.context, expectedContext) ||
          !sameJson(envelope.summary, prepared.aggregation.summary) ||
          !sameJson(envelope.byMetric, prepared.aggregation.byMetric) ||
          envelope.reportResultSetHash !== prepared.aggregation.reportResultSetHash
        ) {
          throw invalid();
        }
        return envelope;
      }
      if (!sameJson(storedStep.value, recomputedStep.value)) throw invalid();
      yield importedCase(recomputedStep.value);
    }
  } finally {
    await Promise.allSettled([
      stored.return(undefined as never),
      recomputed.return?.(undefined as never)
    ]);
  }
}

// Consume one full verification pass and return its validated envelope.
async function validateComplete(
  values: AsyncGenerator<ImportedExecutionReportCase, WorkPackageReportArtifactSummary>
): Promise<WorkPackageReportArtifactSummary> {
  for (;;) {
    const step = await values.next();
    if (step.done) return step.value;
  }
}

/** Preflight and expose a second strict pass for one complete offline Report import. */
export async function prepareWorkPackageReportImport(
  input: PrepareWorkPackageReportImportInput
): Promise<PreparedWorkPackageReportImport> {
  try {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
    const artifacts = reportArtifacts(input.execution);
    await Promise.all([
      validateFileIntegrity(input.directory, artifacts.json),
      validateFileIntegrity(input.directory, artifacts.markdown)
    ]);
    const rest = await prepareWorkPackageRestResults({
      directory: input.directory,
      manifest: input.manifest,
      sourceExecution: input.execution,
      hashing: input.restHashing,
      signal: input.signal
    });
    const evaluation = await prepareWorkPackageEvaluationResultsForReport({
      directory: input.directory,
      manifest: input.manifest,
      sourceExecution: input.execution,
      readExecution: (executionId) =>
        executionId === input.execution.executionId ? input.execution : null,
      restHashing: input.restHashing,
      evalHashing: input.evalHashing,
      signal: input.signal
    });
    const openCases = (): ReturnType<typeof input.inputs.streamCases> =>
      input.inputs.streamCases(input.caseHasher, input.signal);
    const prepared = await prepareWorkPackageReport({
      owner: { kind: "EXECUTION", id: input.execution.executionId },
      runContextHash: input.execution.executionContextHash,
      evaluationContextHash: evaluation.evaluationContextHash,
      evaluationResultSetHash: evaluation.resultSetHash,
      expectedCaseKey: input.inputs.expectedCaseKey.bind(input.inputs),
      openCases,
      openRestResults: () => rest.results,
      openEvaluationResults: () => evaluation.results
    });
    const expectedContext = await input.inputs.readReportContext(
      input.execution.executionContextHash,
      input.execution.runExecutionLimits,
      openCases()
    );
    const envelope = await validateComplete(
      verifiedCases(
        input,
        artifacts.json.path,
        prepared,
        expectedContext,
        evaluation.evaluationContextHash,
        evaluation.resultSetHash,
        input.execution.stages.REPORT.completedAt ?? ""
      )
    );
    if (
      envelope.evaluationContextHash !== evaluation.evaluationContextHash ||
      envelope.evaluationResultSetHash !== evaluation.resultSetHash ||
      envelope.completedAt !== input.execution.stages.REPORT.completedAt
    ) {
      throw invalid();
    }
    const [endpoint, evaluationInputs] = await Promise.all([
      input.inputs.readEndpoint(),
      input.inputs.readEvaluationInputs(openCases())
    ]);
    return {
      packageId: input.manifest.packageId,
      executionId: input.execution.executionId,
      restResultSetHash: rest.resultSetHash,
      evaluationContextHash: evaluation.evaluationContextHash,
      evaluationResultSetHash: evaluation.resultSetHash,
      reportResultSetHash: prepared.aggregation.reportResultSetHash,
      reportSummary: {
        summary: prepared.aggregation.summary,
        byMetric: prepared.aggregation.byMetric
      },
      suiteSnapshot: {
        id: input.manifest.sourceSuite.suiteId,
        name: envelope.context.suite.name ?? input.manifest.sourceSuite.suiteId,
        suiteHash: input.manifest.sourceSuite.suiteHash,
        caseCount: input.inputs.expectedCaseCount
      },
      endpointSnapshot: {
        sourceId: null,
        name: envelope.context.endpoint.name ?? "work-package-endpoint",
        configHash: input.manifest.configurationHashes.endpoint,
        definition: endpoint
      },
      evaluatorSnapshot: {
        sourceId: null,
        name: envelope.context.evaluator.name ?? "work-package-evaluator",
        configHash: input.manifest.configurationHashes.evaluator,
        definition: evaluationInputs.evaluator.definition
      },
      rubricPromptsSnapshot: evaluationInputs.rubricPrompts,
      runContextHash: input.execution.executionContextHash,
      contractVersions: input.manifest.contractVersions,
      runExecutionLimits: input.execution.runExecutionLimits,
      artifactManifest: artifactManifest(input.execution),
      executionCreatedAt: input.execution.createdAt,
      executionStartedAt: input.execution.startedAt,
      completedAt: envelope.completedAt,
      openCases: () =>
        verifiedCases(
          input,
          artifacts.json.path,
          prepared,
          expectedContext,
          evaluation.evaluationContextHash,
          evaluation.resultSetHash,
          envelope.completedAt
        )
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "REQUEST_ABORTED" || error.message === "WORK_PACKAGE_INVALID")
    ) {
      throw error;
    }
    throw invalid(error);
  }
}
