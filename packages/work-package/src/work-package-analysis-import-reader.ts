import {
  buildAnalysisInput,
  type AnalysisCaseFacts
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-input-builder.ts";
import type {
  FrozenAnalysisAnalyzer,
  FrozenCaseAnalysisPrompt
} from "@cortex-eval/application/src/features/case-analysis/frozen-analysis-engine.ts";
import type { ImportedExecutionReportCase } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { AnalysisResultCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type {
  ExecutionV1,
  WorkPackageManifestV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import type { AnalysisSelector } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import {
  readWorkPackageAnalysisArtifact,
  type WorkPackageAnalysisArtifactSummary
} from "./work-package-analysis-artifact-reader.ts";
import { validateFileIntegrity } from "./work-package-file-integrity.ts";
import type { WorkPackageCaseDefinitionHasher } from "./work-package-input-reader.ts";
import type { WorkPackageInputReader } from "./work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "./work-package-evaluation-retry-reader.ts";
import type { PreparedWorkPackageReportImport } from "./work-package-report-import-reader.ts";
import { prepareWorkPackageReportImport } from "./work-package-report-import-reader.ts";
import type { WorkPackageRestSemanticHashing } from "./work-package-rest-retry-reader.ts";
import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";

interface AnalysisStageArtifact {
  readonly kind: "ANALYSIS_RESULTS";
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contractVersion: "cortex.analysis-results.v1";
}

/** Fully reconciled Analysis import facts with a second strict Case pass. */
export interface PreparedWorkPackageAnalysisImport {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution version identity. */
  readonly executionId: string;
  /** Existing platform Report import dependency identity. */
  readonly reportResultSetHash: string;
  /** Explicit frozen Case selector. */
  readonly selector: AnalysisSelector;
  /** Number of sparse selected Case results. */
  readonly selectedCount: number;
  /** Exact selected final Case dependency identity. */
  readonly finalCaseResultSetHash: string;
  /** Complete Analysis result version identity. */
  readonly analysisResultSetHash: string;
  /** Frozen Analyzer input used to recompute every Analysis Input Hash. */
  readonly analyzer: FrozenAnalysisAnalyzer;
  /** Frozen Prompt input used to recompute every Analysis Input Hash. */
  readonly prompt: FrozenCaseAnalysisPrompt;
  /** Frozen Analysis concurrency identity. */
  readonly analysisExecutionLimits: ExecutionV1["analysisExecutionLimits"];
  /** Exact registered Analysis Artifact identity. */
  readonly artifact: AnalysisStageArtifact;
  /** Offline Analysis completion time. */
  readonly completedAt: string;
  /** Revalidate and stream all selected Analysis Case results. */
  readonly openCases: () => AsyncIterable<AnalysisResultCaseV1>;
}

/** Locked inputs required to prepare one complete offline Analysis import. */
export interface PrepareWorkPackageAnalysisImportInput {
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

// Require the exact immutable Analysis stage slot.
function analysisArtifact(execution: ExecutionV1): AnalysisStageArtifact {
  const stage = execution.stages.ANALYSIS;
  if (stage.status !== "SUCCEEDED" || stage.completedAt === null || stage.artifacts.length !== 1) {
    throw invalid();
  }
  const artifact = stage.artifacts[0];
  if (
    artifact?.kind !== "ANALYSIS_RESULTS" ||
    artifact.contractVersion !== "cortex.analysis-results.v1"
  ) {
    throw invalid();
  }
  return { ...artifact, kind: "ANALYSIS_RESULTS", contractVersion: "cortex.analysis-results.v1" };
}

// Select only the Evaluation outcomes permitted by the explicit selector.
function selected(value: ImportedExecutionReportCase, selector: AnalysisSelector): boolean {
  if (selector === "failed") return value.evaluation.status === "FAIL";
  if (selector === "errors") return value.evaluation.status === "EVALUATION_ERROR";
  return value.evaluation.status === "FAIL" || value.evaluation.status === "EVALUATION_ERROR";
}

// Map one reconciled Report row into the pure Analysis Input builder boundary.
function analysisCase(value: ImportedExecutionReportCase): AnalysisCaseFacts {
  return {
    caseKey: value.testCase.caseKey,
    ordinal: value.testCase.ordinal,
    definitionHash: value.testCase.definitionHash,
    definition: value.testCase.definition,
    providerOutput:
      value.rest.status === "SUCCEEDED"
        ? value.rest.providerOutput
        : { ok: false, errorMessage: value.rest.errorMessage },
    evaluation: {
      status: value.evaluation.status,
      finalCaseResultHash: value.evaluation.finalCaseResultHash,
      assertions: value.evaluation.assertions,
      diffs: value.evaluation.diffs
    }
  };
}

// Reconcile the sparse Artifact against every selected Report result and frozen Analysis input.
async function* verifiedCases(
  input: PrepareWorkPackageAnalysisImportInput,
  artifact: AnalysisStageArtifact,
  report: PreparedWorkPackageReportImport,
  analyzer: FrozenAnalysisAnalyzer,
  prompt: FrozenCaseAnalysisPrompt,
  selector: AnalysisSelector
): AsyncGenerator<AnalysisResultCaseV1, WorkPackageAnalysisArtifactSummary> {
  const stored = readWorkPackageAnalysisArtifact(input.directory.streamFile(artifact.path), {
    packageId: input.manifest.packageId,
    executionId: input.execution.executionId,
    selector,
    expectedCaseKey: input.inputs.expectedCaseKey.bind(input.inputs),
    signal: input.signal
  });
  const iterator = stored[Symbol.asyncIterator]();
  let storedStep = await iterator.next();
  try {
    for await (const reportCase of report.openCases()) {
      if (!selected(reportCase, selector)) continue;
      if (storedStep.done) throw invalid();
      const value = storedStep.value;
      const built = buildAnalysisInput({
        source: analysisCase(reportCase),
        runContextHash: input.execution.executionContextHash,
        runContext: {
          packageId: input.manifest.packageId,
          executionId: input.execution.executionId,
          executionContextHash: input.execution.executionContextHash,
          reportResultSetHash: report.reportResultSetHash
        },
        analysisPromptHash: prompt.promptHash,
        analyzerConfigHash: analyzer.configHash,
        analysisExecutionLimits: input.execution.analysisExecutionLimits
      });
      if (
        value.caseKey !== reportCase.testCase.caseKey ||
        value.ordinal !== reportCase.testCase.ordinal ||
        value.finalCaseResultHash !== reportCase.evaluation.finalCaseResultHash ||
        value.analysisInputHash !== built.analysisInputHash
      ) {
        throw invalid();
      }
      yield value;
      storedStep = await iterator.next();
    }
    if (!storedStep.done) throw invalid();
    return storedStep.value;
  } finally {
    await iterator.return(undefined as never);
  }
}

// Consume one full verification pass and retain only the bounded envelope.
async function validateComplete(
  values: AsyncGenerator<AnalysisResultCaseV1, WorkPackageAnalysisArtifactSummary>
): Promise<WorkPackageAnalysisArtifactSummary> {
  for (;;) {
    const step = await values.next();
    if (step.done) return step.value;
  }
}

/** Preflight and expose a second strict pass for one complete offline Analysis import. */
export async function prepareWorkPackageAnalysisImport(
  input: PrepareWorkPackageAnalysisImportInput
): Promise<PreparedWorkPackageAnalysisImport> {
  try {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
    const artifact = analysisArtifact(input.execution);
    await validateFileIntegrity(input.directory, artifact);
    const [report, analysisInputs] = await Promise.all([
      prepareWorkPackageReportImport({
        directory: input.directory,
        manifest: input.manifest,
        execution: input.execution,
        inputs: input.inputs,
        caseHasher: input.caseHasher,
        restHashing: input.restHashing,
        evalHashing: input.evalHashing,
        signal: input.signal
      }),
      input.inputs.readAnalysisInputs()
    ]);
    const observed = await validateComplete(
      readWorkPackageAnalysisArtifact(input.directory.streamFile(artifact.path), {
        packageId: input.manifest.packageId,
        executionId: input.execution.executionId,
        expectedCaseKey: input.inputs.expectedCaseKey.bind(input.inputs),
        signal: input.signal
      })
    );
    const verified = await validateComplete(
      verifiedCases(
        input,
        artifact,
        report,
        analysisInputs.analyzer,
        analysisInputs.prompt,
        observed.selector
      )
    );
    if (
      verified.completedAt !== input.execution.stages.ANALYSIS.completedAt ||
      verified.finalCaseResultSetHash !== observed.finalCaseResultSetHash ||
      verified.analysisResultSetHash !== observed.analysisResultSetHash ||
      verified.selectedCount !== observed.selectedCount
    ) {
      throw invalid();
    }
    return {
      packageId: input.manifest.packageId,
      executionId: input.execution.executionId,
      reportResultSetHash: report.reportResultSetHash,
      selector: observed.selector,
      selectedCount: observed.selectedCount,
      finalCaseResultSetHash: observed.finalCaseResultSetHash,
      analysisResultSetHash: observed.analysisResultSetHash,
      analyzer: analysisInputs.analyzer,
      prompt: analysisInputs.prompt,
      analysisExecutionLimits: input.execution.analysisExecutionLimits,
      artifact,
      completedAt: observed.completedAt,
      openCases: () =>
        verifiedCases(
          input,
          artifact,
          report,
          analysisInputs.analyzer,
          analysisInputs.prompt,
          observed.selector
        )
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "REQUEST_ABORTED" ||
        error.message === "WORK_PACKAGE_INVALID" ||
        error.message === "WORK_PACKAGE_HASH_MISMATCH" ||
        error.message === "ARTIFACT_HASH_MISMATCH")
    ) {
      throw error;
    }
    throw invalid(error);
  }
}
