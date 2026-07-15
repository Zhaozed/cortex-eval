import {
  ImportExecutionAnalysis,
  type ImportedAnalysisCase
} from "@cortex-eval/application/src/features/execution-imports/import-execution-analysis.ts";
import { analysisResultFromBoundary } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import type { AnalysisImportStagingFactory } from "@cortex-eval/application/src/features/case-analysis/case-analysis-ports.ts";
import type { Clock, IdGenerator } from "@cortex-eval/application/src/application-ports.ts";
import type { AnalysisResultCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type { ExecutionAnalysisImportRequestV1 } from "@cortex-eval/contracts/src/result-import-contracts.ts";
import { llmConfigJson } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type { ProcessLiveness } from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import {
  workPackageCaseDefinitionHasher,
  workPackageEvalSemanticHashing,
  workPackageExecutionContextHasher,
  workPackageRestSemanticHashing
} from "@cortex-eval/work-package/src/work-package-domain-hashing.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";

/** Complete Analysis import success facts before HTTP projection. */
export interface ExecutionAnalysisImportOutcome {
  readonly runId: string;
  readonly packageId: string;
  readonly executionId: string;
  readonly idempotent: boolean;
  readonly selector: "failed" | "errors" | "all";
  readonly selectedCount: number;
  readonly importedCount: number;
  readonly finalCaseResultSetHash: string;
  readonly analysisResultSetHash: string;
}

/** Analysis import conflict kept distinct from external file failures. */
export type ExecutionAnalysisImportServiceResult =
  | { readonly ok: true; readonly value: ExecutionAnalysisImportOutcome }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EXECUTION_RESULT_CONFLICT"; readonly executionId: string };
    };

/** Explicit dependencies for secure Work Package Analysis import. */
export interface ExecutionAnalysisImportServiceDependencies {
  readonly stagingFactory: AnalysisImportStagingFactory;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly processIdentity: ProcessLiveness;
  readonly nonce: () => string;
  readonly errorMessage: (code: string) => string;
}

// Map one strict transport row into the protocol-neutral Application input.
function importedCase(
  value: AnalysisResultCaseV1,
  errorMessage: (code: string) => string
): ImportedAnalysisCase {
  if (value.status === "ERROR") {
    return {
      caseKey: value.caseKey,
      finalCaseResultHash: value.finalCaseResultHash,
      analysisInputHash: value.analysisInputHash,
      analysisResultHash: value.analysisResultHash,
      status: "ERROR",
      errorCode: value.error.code,
      errorMessage: errorMessage(value.error.code)
    };
  }
  const output = analysisResultFromBoundary({
    contractVersion: "cortex.analysis-output.v1",
    classification: value.classification,
    confidence: value.confidence,
    evidence: value.evidence,
    explanation: value.explanation,
    recommendedAction: value.recommendedAction,
    proposal: value.proposal
  });
  if (output === null) throw new Error("WORK_PACKAGE_INVALID");
  return {
    caseKey: value.caseKey,
    finalCaseResultHash: value.finalCaseResultHash,
    analysisInputHash: value.analysisInputHash,
    analysisResultHash: value.analysisResultHash,
    status: "SUCCEEDED",
    output
  };
}

/** Secure local adapter that validates Analysis twice around atomic current persistence. */
export class ExecutionAnalysisImportService {
  readonly #dependencies: ExecutionAnalysisImportServiceDependencies;
  readonly #useCase: ImportExecutionAnalysis;

  /** Bind secure file and current Analysis transaction dependencies. */
  public constructor(dependencies: ExecutionAnalysisImportServiceDependencies) {
    this.#dependencies = dependencies;
    this.#useCase = new ImportExecutionAnalysis(dependencies);
  }

  /** Import one completed offline Analysis only after its Report Run exists. */
  public async importAnalysis(
    request: ExecutionAnalysisImportRequestV1,
    signal: AbortSignal
  ): Promise<ExecutionAnalysisImportServiceResult> {
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("WORK_PACKAGE_LOCKED");
    const session = await openWorkPackageExecutionSession({
      rootPath: request.packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId: request.executionId,
        acquiredAt: this.#dependencies.clock.now()
      },
      contextHasher: workPackageExecutionContextHasher,
      nonce: this.#dependencies.nonce,
      validationOptions: { allowRawEvidenceUnavailable: true }
    });
    try {
      const prepared = await session.prepareAnalysisImport(
        request.executionId,
        workPackageCaseDefinitionHasher,
        workPackageRestSemanticHashing,
        workPackageEvalSemanticHashing,
        signal
      );
      const promptDefinition = prepared.prompt.definition;
      const analyzerDefinition = prepared.analyzer.definition;
      const errorMessage = this.#dependencies.errorMessage;
      const result = await this.#useCase.execute({
        packageId: prepared.packageId,
        executionId: prepared.executionId,
        identity: {
          selector: prepared.selector,
          reportResultSetHash: prepared.reportResultSetHash,
          finalCaseResultSetHash: prepared.finalCaseResultSetHash,
          analysisResultSetHash: prepared.analysisResultSetHash,
          artifactPath: prepared.artifact.path,
          artifactSha256: prepared.artifact.sha256,
          artifactSizeBytes: prepared.artifact.sizeBytes
        },
        prompt: {
          sourceId: null,
          promptKey: promptDefinition.promptKey,
          promptHash: prepared.prompt.promptHash,
          snapshot: {
            kind: promptDefinition.kind,
            promptKey: promptDefinition.promptKey,
            messages: promptDefinition.messages.map((message) => ({ ...message }))
          }
        },
        analyzer: {
          sourceId: null,
          configHash: prepared.analyzer.configHash,
          provider: analyzerDefinition.providerType,
          model: analyzerDefinition.model,
          snapshot: llmConfigJson(analyzerDefinition)
        },
        analysisExecutionLimits: prepared.analysisExecutionLimits,
        openCases: async function* (): AsyncGenerator<ImportedAnalysisCase> {
          for await (const value of prepared.openCases()) yield importedCase(value, errorMessage);
        }
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          runId: result.runId,
          packageId: prepared.packageId,
          executionId: prepared.executionId,
          idempotent: result.idempotent,
          selector: prepared.selector,
          selectedCount: prepared.selectedCount,
          importedCount: result.importedCount,
          finalCaseResultSetHash: prepared.finalCaseResultSetHash,
          analysisResultSetHash: prepared.analysisResultSetHash
        }
      };
    } finally {
      await session.close();
    }
  }
}
