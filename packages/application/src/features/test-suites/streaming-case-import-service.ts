import { IncrementalSuiteHasher } from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import type {
  CaseImportStagingFactory,
  CaseImportImpact,
  Clock,
  IdGenerator,
  TransactionManager
} from "../../application-ports.ts";
import { materializeStoredCase, prepareCaseDefinition } from "./case-definition-preparer.ts";
import type { BatchCaseWriteError, CaseWriteError, TestSuite } from "./test-suite-models.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

/** Streaming full-import dependencies. */
export interface StreamingCaseImportDependencies {
  /** Managed main-database transaction boundary. */
  readonly transactionManager: TransactionManager;
  /** Per-item internal identity source. */
  readonly idGenerator: IdGenerator;
  /** Import timestamp source. */
  readonly clock: Clock;
  /** External bounded staging factory. */
  readonly stagingFactory: CaseImportStagingFactory;
}

/** Streaming full-import command. */
export interface StreamingCaseImportCommand {
  /** Validate and compare without replacing Cases or advancing suite revision. */
  readonly previewOnly?: boolean;
  /** Target current Suite. */
  readonly suiteId: string;
  /** Aggregate concurrency token. */
  readonly expectedSuiteRevision: number;
  /** Backpressure-aware clean Case source. */
  readonly definitions: AsyncIterable<CaseDefinition>;
  /** Request/server-close cancellation signal. */
  readonly signal: AbortSignal;
}

/** Exact bounded streaming import result. */
export type StreamingCaseImportResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly suite: TestSuite;
      readonly preview?: CaseImportImpact;
    }
  | {
      readonly ok: false;
      readonly error:
        CaseWriteError | BatchCaseWriteError | { readonly code: "CASE_IMPORT_CANCELLED" };
    };

// Return one stable aggregate Revision conflict.
function revisionConflict(suite: TestSuite, expectedRevision: number): CaseWriteError {
  return {
    code: "RESOURCE_REVISION_CONFLICT",
    actualRevision: suite.revision,
    expectedRevision
  };
}

/** Bounded-memory full Case replacement through an isolated staging database. */
export class StreamingCaseImportService {
  readonly #dependencies: StreamingCaseImportDependencies;

  /** Create a streaming importer with explicit staging and transaction boundaries. */
  public constructor(dependencies: StreamingCaseImportDependencies) {
    this.#dependencies = dependencies;
  }

  /** Stage one Case at a time and commit the complete set atomically. */
  public async importCases(
    command: StreamingCaseImportCommand
  ): Promise<StreamingCaseImportResult> {
    const session = await this.#dependencies.stagingFactory.open();
    const hasher = new IncrementalSuiteHasher();
    const timestamp = this.#dependencies.clock.now();
    let count = 0;
    try {
      for await (const definition of command.definitions) {
        if (command.signal.aborted) {
          return { ok: false, error: { code: "CASE_IMPORT_CANCELLED" } };
        }
        const prepared = prepareCaseDefinition(
          definition,
          this.#dependencies.idGenerator.nextId(),
          timestamp
        );
        if ("code" in prepared) {
          return {
            ok: false,
            error: {
              code: "CASE_IMPORT_ITEM_INVALID",
              index: count,
              caseKey: definition.caseKey,
              cause: prepared
            }
          };
        }
        const stored = materializeStoredCase(prepared, command.suiteId, count);
        if ((await session.stage(stored)) === "CASE_ID_DUPLICATE") {
          return {
            ok: false,
            error: {
              code: "CASE_IMPORT_ITEM_INVALID",
              index: count,
              caseKey: definition.caseKey,
              cause: { code: "CASE_ID_DUPLICATE", caseKey: definition.caseKey }
            }
          };
        }
        hasher.append({
          caseKey: stored.caseKey,
          ordinal: stored.ordinal,
          definitionHash: stored.definitionHash
        });
        count += 1;
      }
      if (command.signal.aborted) {
        return { ok: false, error: { code: "CASE_IMPORT_CANCELLED" } };
      }
      const suiteHash = hasher.digest();
      return await session.withStagedTransaction(async (transaction, stagedCases) => {
        const suite = await transaction.testSuites.getSuite(command.suiteId);
        if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
        if (suite.revision !== command.expectedSuiteRevision) {
          return {
            ok: false,
            error: revisionConflict(suite, command.expectedSuiteRevision)
          };
        }
        const missing = await stagedCases.findFirstMissingRubricPrompt();
        if (missing !== null) {
          return {
            ok: false,
            error: {
              code: "CASE_IMPORT_ITEM_INVALID",
              index: missing.index,
              caseKey: missing.caseKey,
              cause: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: missing.promptKey }
            }
          };
        }
        if (command.signal.aborted) return { ok: false, error: { code: "CASE_IMPORT_CANCELLED" } };
        if (command.previewOnly) {
          const preview = await stagedCases.compareCases(command.suiteId);
          return { ok: true, count, suite, preview };
        }
        const updatedSuite = await transaction.testSuites.updateSuiteAggregate({
          suiteId: command.suiteId,
          expectedRevision: command.expectedSuiteRevision,
          caseCount: count,
          suiteHash,
          updatedAt: timestamp
        });
        if (updatedSuite === null) {
          const latest = await transaction.testSuites.getSuite(command.suiteId);
          return latest === null
            ? { ok: false, error: { code: "SUITE_NOT_FOUND" } }
            : {
                ok: false,
                error: revisionConflict(latest, command.expectedSuiteRevision)
              };
        }
        await stagedCases.replaceCases(command.suiteId);
        return { ok: true, count, suite: updatedSuite };
      });
    } finally {
      // Adapter cleanup is best-effort and must not replace an already-determined business result.
      await session.cleanup().catch(() => undefined);
    }
  }
}
