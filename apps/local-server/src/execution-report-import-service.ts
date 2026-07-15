import { ImportExecutionReport } from "@cortex-eval/application/src/features/execution-imports/import-execution-report.ts";
import type {
  Clock,
  IdGenerator,
  TransactionManager
} from "@cortex-eval/application/src/application-ports.ts";
import type { ExecutionReportImportRequestV1 } from "@cortex-eval/contracts/src/result-import-contracts.ts";
import type { ProcessLiveness } from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import {
  workPackageCaseDefinitionHasher,
  workPackageEvalSemanticHashing,
  workPackageExecutionContextHasher,
  workPackageRestSemanticHashing
} from "@cortex-eval/work-package/src/work-package-domain-hashing.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";

/** Complete Report import success facts before HTTP projection. */
export interface ExecutionReportImportOutcome {
  /** New or existing platform Run identity. */
  readonly runId: string;
  /** Immutable Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Whether the exact version already existed. */
  readonly idempotent: boolean;
  /** Terminal imported Run status. */
  readonly status: "COMPLETED" | "COMPLETED_WITH_ERRORS";
  /** Complete REST result-set identity. */
  readonly restResultSetHash: string;
  /** Immutable Evaluation input-context identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
}

/** Report import conflict result kept distinct from external file failures. */
export type ExecutionReportImportServiceResult =
  | { readonly ok: true; readonly value: ExecutionReportImportOutcome }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EXECUTION_RESULT_CONFLICT"; readonly executionId: string };
    };

/** Explicit dependencies for local secure Work Package Report import. */
export interface ExecutionReportImportServiceDependencies {
  /** Atomic platform import transaction manager. */
  readonly transactionManager: TransactionManager;
  /** Platform Run identity source. */
  readonly idGenerator: IdGenerator;
  /** Import registration time source. */
  readonly clock: Clock;
  /** OS process identity lookup for Work Package lock ownership. */
  readonly processIdentity: ProcessLiveness;
  /** Unpredictable file-operation nonce. */
  readonly nonce: () => string;
}

/** Secure local adapter that validates a Work Package twice around atomic persistence. */
export class ExecutionReportImportService {
  readonly #dependencies: ExecutionReportImportServiceDependencies;
  readonly #useCase: ImportExecutionReport;

  /** Bind secure file and Application transaction dependencies. */
  public constructor(dependencies: ExecutionReportImportServiceDependencies) {
    this.#dependencies = dependencies;
    this.#useCase = new ImportExecutionReport(dependencies);
  }

  /** Import one completed offline Report without depending on Raw Evidence availability. */
  public async importReport(
    request: ExecutionReportImportRequestV1,
    signal: AbortSignal
  ): Promise<ExecutionReportImportServiceResult> {
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
      const prepared = await session.prepareReportImport(
        request.executionId,
        workPackageCaseDefinitionHasher,
        workPackageRestSemanticHashing,
        workPackageEvalSemanticHashing,
        signal
      );
      const result = await this.#useCase.execute(prepared);
      if (!result.ok) return result;
      const summary = prepared.reportSummary.summary;
      return {
        ok: true,
        value: {
          runId: result.runId,
          packageId: prepared.packageId,
          executionId: prepared.executionId,
          idempotent: result.idempotent,
          status:
            summary.restError > 0 || summary.evalError > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
          restResultSetHash: prepared.restResultSetHash,
          evaluationContextHash: prepared.evaluationContextHash,
          evaluationResultSetHash: prepared.evaluationResultSetHash,
          reportResultSetHash: prepared.reportResultSetHash
        }
      };
    } finally {
      await session.close();
    }
  }
}
