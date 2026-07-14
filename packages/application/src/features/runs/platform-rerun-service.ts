import type { Clock, IdGenerator } from "../../application-ports.ts";

import { readArtifactBackedEvaluationResults } from "../evaluation/platform-evaluation-reuse-reader.ts";
import type { PlatformEvalTransactionManager } from "../evaluation/platform-eval-ports.ts";
import type { PlatformRun, StoredRestCaseResult } from "./platform-run-models.ts";
import type { PlatformRunTransactionManager } from "./platform-run-ports.ts";
import type { RunArtifactStore } from "./run-artifact-port.ts";
import { createRerunPlan, type RerunPlan, type RerunSourceCase } from "./platform-rerun-planner.ts";

/** Internal rerun creation request; no API is registered before P8. */
export interface CreatePlatformRerunInput {
  /** Immutable source platform Run. */
  readonly sourceRunId: string;
  /** Explicit selection behavior. */
  readonly mode: "RETRY_FAILED" | "FORCE";
}

/** Closed internal rerun creation result. */
export type CreatePlatformRerunResult =
  | { readonly ok: true; readonly run: PlatformRun; readonly plan: RerunPlan }
  | {
      readonly ok: false;
      readonly error: { readonly code: "RUN_NOT_FOUND" | "RERUN_SOURCE_INCOMPLETE" };
    };

/** Explicit dependencies for side-effectful rerun creation. */
export interface PlatformRerunServiceDependencies {
  /** Run read and atomic target insert boundary. */
  readonly runTransactionManager: PlatformRunTransactionManager;
  /** Source Evaluation read boundary. */
  readonly evalTransactionManager: PlatformEvalTransactionManager;
  /** Immutable source Artifact verification boundary. */
  readonly artifactStore: RunArtifactStore;
  /** New execution-version identity source. */
  readonly idGenerator: IdGenerator;
  /** New durable fact timestamp source. */
  readonly clock: Clock;
}

interface SourceRunFacts {
  /** Complete frozen source Run. */
  readonly run: PlatformRun;
  /** Complete ordered source REST results. */
  readonly restResults: readonly StoredRestCaseResult[];
}

// Copy a semantic REST success into the new execution version with explicit provenance.
function reusedRestResult(
  targetRunId: string,
  sourceRunId: string,
  source: StoredRestCaseResult,
  completedAt: string
): StoredRestCaseResult {
  if (source.status !== "SUCCEEDED") throw new Error("RERUN_REST_REUSE_INVALID");
  return {
    ...source,
    runId: targetRunId,
    completedAt,
    provenance: {
      sourceKind: "RUN",
      sourceId: sourceRunId,
      sourceResultHash: source.resultHash
    }
  };
}

/** Create a new immutable execution version and seed only selected reusable REST facts. */
export class PlatformRerunService {
  /** Run transaction boundary. */
  readonly #runTransactions: PlatformRunTransactionManager;
  /** Evaluation transaction boundary. */
  readonly #evalTransactions: PlatformEvalTransactionManager;
  /** Immutable source Artifact store. */
  readonly #artifacts: RunArtifactStore;
  /** Run identity source. */
  readonly #ids: IdGenerator;
  /** Timestamp source. */
  readonly #clock: Clock;

  /** Bind all internal rerun dependencies. */
  public constructor(dependencies: PlatformRerunServiceDependencies) {
    this.#runTransactions = dependencies.runTransactionManager;
    this.#evalTransactions = dependencies.evalTransactionManager;
    this.#artifacts = dependencies.artifactStore;
    this.#ids = dependencies.idGenerator;
    this.#clock = dependencies.clock;
  }

  /** Create one READY/REST Retry or Force target without mutating the source. */
  public async create(input: CreatePlatformRerunInput): Promise<CreatePlatformRerunResult> {
    const source = await this.#readSource(input.sourceRunId);
    if (source === null) return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    if (source.restResults.length !== source.run.suite.cases.length) {
      return { ok: false, error: { code: "RERUN_SOURCE_INCOMPLETE" } };
    }
    const evaluations =
      input.mode === "RETRY_FAILED"
        ? await readArtifactBackedEvaluationResults({
            sourceRunId: source.run.id,
            runTransactionManager: this.#runTransactions,
            evalTransactionManager: this.#evalTransactions,
            artifactStore: this.#artifacts
          })
        : [];
    const evaluationByCase = new Map(evaluations.map((result) => [result.caseKey, result]));
    const sourceCases: RerunSourceCase[] = source.restResults.map((rest) => ({
      caseKey: rest.caseKey,
      ordinal: rest.ordinal,
      rest,
      evaluation: evaluationByCase.get(rest.caseKey) ?? null
    }));
    const plan = createRerunPlan({
      sourceRunId: source.run.id,
      mode: input.mode,
      cases: sourceCases
    });
    const createdAt = this.#clock.now();
    const runId = this.#ids.nextId();
    const reused = plan.cases.flatMap((item) => {
      if (!item.action.startsWith("REUSE_REST")) return [];
      const rest = source.restResults[item.ordinal];
      if (rest?.caseKey !== item.caseKey) throw new Error("RERUN_REST_ALIGNMENT");
      return [reusedRestResult(runId, source.run.id, rest, createdAt)];
    });
    const run: PlatformRun = {
      ...source.run,
      id: runId,
      sourceRunId: source.run.id,
      rerunMode: input.mode,
      status: "READY",
      stage: "REST",
      lockRevision: 0,
      cancelRequestedAt: null,
      restCompletedCount: reused.length,
      restErrorCount: 0,
      evalCompletedCount: 0,
      evalPassCount: 0,
      evalFailCount: 0,
      evalErrorCount: 0,
      evalNotEvaluatedCount: 0,
      resultSetHash: null,
      artifactManifest: {
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: runId },
        artifacts: []
      },
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt
    };
    await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.insertPlatformRerun(run, reused)
    );
    return { ok: true, run, plan };
  }

  // Read the full frozen source and all REST results inside one short transaction.
  #readSource(runId: string): Promise<SourceRunFacts | null> {
    return this.#runTransactions.execute(async (transaction) => {
      const run = await transaction.runs.getPlatformRun(runId);
      if (run === null) return null;
      const restResults: StoredRestCaseResult[] = [];
      for (const frozen of run.suite.cases) {
        const result = await transaction.runs.getRestResult(run.id, frozen.caseKey);
        if (result !== null) restResults.push(result);
      }
      return { run, restResults };
    });
  }
}
