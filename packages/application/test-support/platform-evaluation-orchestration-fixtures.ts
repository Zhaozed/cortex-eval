import type { PlatformEvalRepository } from "../src/features/evaluation/platform-eval-ports.ts";

import type {
  PlatformEvaluationEngine,
  PlatformEvaluationEngineInput,
  PlatformEvaluationEngineResult,
  PlatformEvaluationRuntimePreflight
} from "../src/features/evaluation/platform-evaluation-engine.ts";
import { type PlatformEvaluationServiceDependencies } from "../src/features/evaluation/platform-evaluation-service.ts";
import type {
  PlatformRunResourceReader,
  PlatformRunTransactionManager
} from "../src/features/runs/platform-run-ports.ts";
import type {
  PlatformNormalizedEvalArtifactInput,
  PlatformRawPromptfooArtifactInput,
  PlatformReportArtifactInput,
  PlatformReportArtifactWriteResult,
  PlatformRestArtifactWriteResult,
  PublishedRunArtifact,
  RunArtifactAvailability,
  RunArtifactStore
} from "../src/features/runs/run-artifact-port.ts";
import type {
  PlatformRunProgress,
  RunArtifactDescriptor,
  RunArtifactManifest
} from "../src/features/runs/platform-run-models.ts";

import { MemoryPlatformRunStore } from "../test-support/in-memory-platform-run-store.ts";
import {
  MemoryPlatformEvalRepository as EvalRepository,
  MemoryPlatformEvalTransactions as EvalTransactions
} from "../test-support/platform-run-resilience-fixtures.ts";
import { HASH, NOW, RUN_ID } from "../test-support/platform-evaluation-service-fixtures.ts";

export class RunTransactions implements PlatformRunTransactionManager {
  /** Whether one short transaction callback is active. */
  active = false;
  /** Backing in-memory Run facts. */
  readonly store: MemoryPlatformRunStore;
  /** Empty current-resource reader unused by Evaluation. */
  readonly resources: PlatformRunResourceReader = {
    getSuite: () => Promise.resolve(null),
    listCases: () => Promise.resolve([]),
    getConfiguration: () => Promise.resolve(null),
    listRubricPrompts: () => Promise.resolve([])
  };

  /** Bind one backing Run store. */
  public constructor(store: MemoryPlatformRunStore) {
    this.store = store;
  }

  /** Execute one synchronous-scope short transaction callback. */
  public async execute<T>(
    work: Parameters<PlatformRunTransactionManager["execute"]>[0]
  ): Promise<T> {
    this.active = true;
    try {
      return (await work({ resources: this.resources, runs: this.store })) as T;
    } finally {
      this.active = false;
    }
  }
}

export class EvaluationArtifacts implements RunArtifactStore {
  /** Written raw input. */
  rawInput: PlatformRawPromptfooArtifactInput | null = null;
  /** Written normalized input. */
  normalizedInput: PlatformNormalizedEvalArtifactInput | null = null;
  /** Removed uncommitted files. */
  readonly removed: RunArtifactDescriptor[] = [];
  /** Optional forced availability used by corruption tests. */
  availability: readonly RunArtifactAvailability[] | null = null;

  /** REST writing is not part of this test. */
  public writeRestResults(): Promise<PlatformRestArtifactWriteResult> {
    throw new Error("unexpected");
  }

  /** Capture raw evidence. */
  public writeRawPromptfooEvidence(
    input: PlatformRawPromptfooArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.rawInput = input;
    return Promise.resolve({
      descriptor: {
        kind: "RAW_PROMPTFOO_EVIDENCE",
        path: `runs/${RUN_ID}/promptfoo-raw.json`,
        expectedSha256: "d".repeat(64),
        expectedSizeBytes: 50,
        contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
      },
      publicationIdentity: "memory:raw"
    });
  }

  /** Capture and consume normalized results. */
  public async writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.normalizedInput = input;
    for await (const item of input.cases) {
      // Consume once like the real streaming writer.
      void item;
    }
    return {
      descriptor: {
        kind: "NORMALIZED_EVAL_RESULTS",
        path: `runs/${RUN_ID}/normalized-eval.json`,
        expectedSha256: "e".repeat(64),
        expectedSizeBytes: 80,
        contractVersion: "cortex.platform-normalized-eval.v1"
      },
      publicationIdentity: "memory:normalized"
    };
  }

  /** Report is outside these Evaluation tests. */
  public writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    void input;
    return Promise.reject(new Error("UNEXPECTED_REPORT_WRITE"));
  }

  /** Capture rollback removals. */
  public removeUncommitted(artifact: PublishedRunArtifact): Promise<void> {
    this.removed.push(artifact.descriptor);
    return Promise.resolve();
  }

  /** Return exact configured availability or verify every expected descriptor. */
  public inspect(manifest: RunArtifactManifest): Promise<readonly RunArtifactAvailability[]> {
    return Promise.resolve(
      this.availability ??
        manifest.artifacts.map((artifact) => ({ artifact, status: "PRESENT" as const }))
    );
  }

  /** No cleanup in this test. */
  public cleanupOrphans(): Promise<void> {
    return Promise.resolve();
  }
}

export class SuccessfulEvaluationEngine implements PlatformEvaluationEngine {
  /** Whether execution happened while a transaction callback was active. */
  observedActiveTransaction = false;
  /** Run transaction tracker. */
  readonly #transactions: RunTransactions;

  /** Bind the transaction tracker. */
  public constructor(transactions: RunTransactions) {
    this.#transactions = transactions;
  }

  /** Return one valid Promptfoo Assertion-fail raw result. */
  public execute(): Promise<PlatformEvaluationEngineResult> {
    this.observedActiveTransaction = this.#transactions.active;
    return Promise.resolve({
      promptfooVersion: "0.121.18" as const,
      exitCode: 100 as const,
      durationMs: 12,
      evaluationContextHash: "f".repeat(64),
      rubricPromptMaterializations: {},
      raw: {
        results: {
          version: 3,
          results: [
            {
              metadata: { case_id: "case-1" },
              response: { output: { ok: false, errorMessage: "business" } },
              success: false,
              score: 0,
              latencyMs: 3,
              cost: 0,
              gradingResult: {
                pass: false,
                score: 0,
                reason: "failed",
                componentResults: [
                  {
                    pass: false,
                    score: 0,
                    reason: "failed",
                    assertion: {
                      type: "equals",
                      metric: "quality",
                      value: "expected"
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    });
  }
}

export class SnakeCaseProviderOutputEngine implements PlatformEvaluationEngine {
  /** Return one Promptfoo PASS row using the external provider-output field names. */
  public execute(): Promise<PlatformEvaluationEngineResult> {
    const schema = {
      type: "object",
      required: ["parsed_output"],
      properties: {
        parsed_output: {
          type: "object",
          required: ["reply_text"],
          properties: { reply_text: { const: "actual" } }
        }
      }
    };
    return Promise.resolve({
      promptfooVersion: "0.121.18" as const,
      exitCode: 0 as const,
      durationMs: 12,
      evaluationContextHash: "f".repeat(64),
      rubricPromptMaterializations: {},
      raw: {
        results: {
          version: 3,
          results: [
            {
              metadata: { case_id: "case-1" },
              response: {
                output: {
                  ok: true,
                  task_name: "planner",
                  resolved_config: {},
                  parsed_output: { reply_text: "actual" }
                }
              },
              success: true,
              score: 1,
              latencyMs: 3,
              cost: 0,
              gradingResult: {
                pass: true,
                score: 1,
                reason: "passed",
                componentResults: [
                  {
                    pass: true,
                    score: 1,
                    reason: "Assertion passed",
                    assertion: {
                      type: "is-json",
                      metric: "json",
                      weight: 1,
                      value: schema
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    });
  }
}

export class FailingProgressStore extends MemoryPlatformRunStore {
  /** Number of small progress reads. */
  progressReads = 0;

  /** Fail the cross-process poll after the initial claim validation read. */
  public override getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null> {
    this.progressReads += 1;
    if (this.progressReads === 2) return Promise.reject(new Error("POLL_READ_FAILED"));
    return super.getPlatformRunProgress(runId);
  }
}

export class AbortAwareEvaluationEngine implements PlatformEvaluationEngine {
  /** Whether the application propagated cancellation to the engine. */
  aborted = false;
  /** Reject an otherwise pending engine call so a failed assertion cannot leak test work. */
  release: () => void = () => undefined;

  /** Wait for Abort or explicit test release. */
  public execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult> {
    if (input.signal.aborted) {
      this.aborted = true;
      return Promise.reject(new Error("ENGINE_ABORTED"));
    }
    return new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new Error("ENGINE_RELEASED"));
      this.release = fail;
      input.signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          fail();
        },
        { once: true }
      );
    });
  }
}

export class EmptyRerunEvaluationEngine implements PlatformEvaluationEngine {
  /** REST Case count observed at the external execution boundary. */
  observedCaseCount = -1;

  /** Return an empty raw result only when all Evaluation facts were reused. */
  public execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult> {
    this.observedCaseCount = input.restResults.length;
    return Promise.resolve({
      promptfooVersion: "0.121.18",
      exitCode: 0,
      durationMs: 0,
      evaluationContextHash: HASH,
      rubricPromptMaterializations: {},
      raw: { results: { version: 3, results: [] } }
    });
  }
}

export class FailingNormalizedArtifacts extends EvaluationArtifacts {
  /** Fail after raw evidence has already been created. */
  public override writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.normalizedInput = input;
    return Promise.reject(new Error("NORMALIZED_WRITE_FAILED"));
  }
}

export class RejectingEvalRepository extends EvalRepository {
  /** Reject the final atomic commit after both artifacts are written. */
  public override completeStage(): ReturnType<PlatformEvalRepository["completeStage"]> {
    return Promise.resolve({ ok: false, reason: "STATE_OR_REVISION" });
  }
}

export const successfulRuntimePreflight: PlatformEvaluationRuntimePreflight = {
  check: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};

export function evaluationDependencies(
  runs: MemoryPlatformRunStore,
  engine: PlatformEvaluationEngine,
  evaluations: PlatformEvalRepository = new EvalRepository(runs),
  artifacts: RunArtifactStore = new EvaluationArtifacts(),
  cancellationPollMs?: number
): PlatformEvaluationServiceDependencies {
  return {
    runTransactionManager: new RunTransactions(runs),
    evalTransactionManager: new EvalTransactions(evaluations),
    engine,
    runtimePreflight: successfulRuntimePreflight,
    artifactStore: artifacts,
    clock: { now: (): string => NOW },
    messageResolver: { message: (code): string => code },
    eventSink: { record: (): Promise<void> => Promise.resolve() },
    ...(cancellationPollMs === undefined ? {} : { cancellationPollMs })
  };
}
