import type {
  ImportedAnalysisCase,
  ImportedAnalysisIdentity,
  ImportedAnalysisRunContext,
  StoredAnalysisPromptSnapshot,
  StoredAnalyzerSnapshot
} from "../case-analysis/case-analysis-models.ts";
import type { AnalysisImportStagingFactory } from "../case-analysis/case-analysis-ports.ts";
import type { FrozenAnalysisExecutionLimits } from "../case-analysis/case-analysis-input-builder.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { Clock, IdGenerator } from "../../application-ports.ts";

export type { ImportedAnalysisCase } from "../case-analysis/case-analysis-models.ts";

/** Complete cleaned Analysis import command produced by the Work Package boundary. */
export interface ImportExecutionAnalysisCommand {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Exact whole-Artifact import identity. */
  readonly identity: ImportedAnalysisIdentity;
  /** Frozen Prompt snapshot with no current resource dependency. */
  readonly prompt: StoredAnalysisPromptSnapshot;
  /** Frozen Analyzer snapshot with no current resource dependency. */
  readonly analyzer: StoredAnalyzerSnapshot;
  /** Frozen offline Analysis execution limit. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  /** Re-open the fully reconciled sparse Analysis Case stream. */
  readonly openCases: () => AsyncIterable<ImportedAnalysisCase>;
}

/** Stable Analysis first-import, idempotent, overwrite or conflict outcome. */
export type ImportExecutionAnalysisResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly idempotent: boolean;
      readonly importedCount: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EXECUTION_RESULT_CONFLICT"; readonly executionId: string };
    };

function sameIdentity(left: ImportedAnalysisIdentity, right: ImportedAnalysisIdentity): boolean {
  return canonicalJson({ ...left }) === canonicalJson({ ...right });
}

function conflict(executionId: string): ImportExecutionAnalysisResult {
  return { ok: false, error: { code: "EXECUTION_RESULT_CONFLICT", executionId } };
}

function matchesRunContext(
  context: ImportedAnalysisRunContext | null,
  command: ImportExecutionAnalysisCommand
): context is ImportedAnalysisRunContext {
  return (
    context?.packageId === command.packageId &&
    context.reportResultSetHash === command.identity.reportResultSetHash
  );
}

/** Atomic current-Analysis import use case bound to an existing imported Report Run. */
export class ImportExecutionAnalysis {
  readonly #stagingFactory: AnalysisImportStagingFactory;
  readonly #idGenerator: IdGenerator;
  readonly #clock: Clock;

  /** Bind explicit transaction, identity and time dependencies. */
  public constructor(dependencies: {
    readonly stagingFactory: AnalysisImportStagingFactory;
    readonly idGenerator: IdGenerator;
    readonly clock: Clock;
  }) {
    this.#stagingFactory = dependencies.stagingFactory;
    this.#idGenerator = dependencies.idGenerator;
    this.#clock = dependencies.clock;
  }

  /** Import or replace selected current Case analyses in one short transaction. */
  public async execute(
    command: ImportExecutionAnalysisCommand
  ): Promise<ImportExecutionAnalysisResult> {
    const timestamp = this.#clock.now();
    const session = await this.#stagingFactory.open();
    try {
      for await (const value of command.openCases()) {
        const staged = await session.stage({
          ...value,
          id: this.#idGenerator.nextId()
        });
        if (staged === "CASE_KEY_DUPLICATE") throw new Error("ANALYSIS_IMPORT_STATE_INVALID");
      }
      return await session.withStagedTransaction(async (transaction, stagedAnalyses) => {
        const context = await transaction.analyses.getImportedRunContext(command.executionId);
        if (!matchesRunContext(context, command)) return conflict(command.executionId);
        if (
          context.analysisIdentity !== null &&
          sameIdentity(context.analysisIdentity, command.identity)
        ) {
          return { ok: true, runId: context.runId, idempotent: true, importedCount: 0 };
        }
        const reconciled = await stagedAnalyses.reconcileCurrent({
          runId: context.runId,
          prompt: command.prompt,
          analyzer: command.analyzer,
          analysisExecutionLimits: command.analysisExecutionLimits,
          timestamp
        });
        if (!reconciled.ok) return conflict(command.executionId);
        if (
          !(await transaction.analyses.setImportedAnalysisIdentity(
            command.executionId,
            command.identity
          ))
        ) {
          return conflict(command.executionId);
        }
        return {
          ok: true,
          runId: context.runId,
          idempotent: false,
          importedCount: reconciled.importedCount
        };
      });
    } finally {
      await session.cleanup().catch(() => undefined);
    }
  }
}
