import { validateRunMetadata } from "@cortex-eval/domain/src/domain-run-metadata.ts";
import { hashSuite, hashRubricPromptSet } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import { hashRunContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { Clock, IdGenerator } from "../../application-ports.ts";

import { readArtifactBackedEvaluationResults } from "../evaluation/platform-evaluation-reuse-reader.ts";
import type { PlatformEvalTransactionManager } from "../evaluation/platform-eval-ports.ts";
import type { PlatformRun, StoredRestCaseResult } from "./platform-run-models.ts";
import type { PlatformRunTransactionManager } from "./platform-run-ports.ts";
import type { RunArtifactStore } from "./run-artifact-port.ts";
import { createRerunPlan, type RerunPlan, type RerunSourceCase } from "./platform-rerun-planner.ts";

/** Internal rerun creation request; no API is registered before P8. */
export interface CreatePlatformRerunInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  /** Immutable source platform Run. */
  readonly sourceRunId: string;
  /** Explicit selection behavior. */
  readonly mode: "RETRY_FAILED" | "FORCE";
  readonly caseKey?: string | undefined;
  readonly reevaluateOnly?: boolean | undefined;
}

/** Closed internal rerun creation result. */
export type CreatePlatformRerunResult =
  | { readonly ok: true; readonly run: PlatformRun; readonly plan: RerunPlan }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "RUN_NOT_FOUND" | "RERUN_SOURCE_INCOMPLETE" | "VALIDATION_FAILED";
      };
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
    const metadata = validateRunMetadata({
      name: input.name,
      description: input.description
    });
    if (!metadata.ok) return { ok: false, error: { code: "VALIDATION_FAILED" } };
    let source = await this.#readSource(input.sourceRunId);
    if (source === null) return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    if (
      source.run.status === "READY" ||
      source.run.status === "RUNNING" ||
      source.run.stage !== "DONE" ||
      source.run.completedAt === null ||
      source.restResults.length !== source.run.suite.cases.length
    ) {
      return { ok: false, error: { code: "RERUN_SOURCE_INCOMPLETE" } };
    }
    // A single-case replay is a new one-case Run, never a mutation of the source suite.
    if (input.caseKey !== undefined) {
      const frozen = source.run.suite.cases.find((item) => item.caseKey === input.caseKey);
      const stored = source.restResults.find((item) => item.caseKey === input.caseKey);
      if (
        !frozen ||
        !stored ||
        input.mode !== "FORCE" ||
        (input.reevaluateOnly && stored.status !== "SUCCEEDED")
      )
        return { ok: false, error: { code: "RERUN_SOURCE_INCOMPLETE" } };
      const cases = [{ ...frozen, ordinal: 0 }];
      const suiteHash = hashSuite({ contractVersion: "cortex.suite.v1", cases });
      const suite = {
        ...source.run.suite,
        name: `${source.run.suite.name} · ${frozen.caseKey}`,
        cases,
        suiteHash
      };
      const runContextHash = hashRunContext({
        contractVersion: "cortex.run-context.v1",
        suiteHash,
        endpointConfigHash: source.run.endpoint.configHash,
        evaluatorConfigHash: source.run.evaluator.configHash,
        rubricPromptSetHash: hashRubricPromptSet({
          contractVersion: "cortex.rubric-prompt-set.v1",
          prompts: source.run.rubricPrompts.map((item) => ({
            promptKey: item.definition.promptKey,
            promptHash: item.promptHash
          }))
        }),
        promptfooVersion: source.run.promptfooVersion,
        runExecutionLimits: source.run.runExecutionLimits
      });
      source = {
        run: { ...source.run, suite, runContextHash },
        restResults: [{ ...stored, ordinal: 0 }]
      };
    } else if (input.reevaluateOnly)
      return { ok: false, error: { code: "RERUN_SOURCE_INCOMPLETE" } };
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
    let plan = createRerunPlan({
      sourceRunId: source.run.id,
      mode: input.mode,
      cases: sourceCases
    });
    if (input.reevaluateOnly)
      plan = {
        ...plan,
        cases: sourceCases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          action: "REUSE_REST_REEVALUATE" as const,
          restReuse: { sourceRunId: source.run.id, sourceResultHash: item.rest.resultHash }
        })),
        counts: { reuseRest: 1, executeRest: 0, reuseEval: 0, executeEval: 1 }
      };
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
      name: metadata.name ?? source.run.name ?? source.run.suite.name.slice(0, 120),
      description:
        metadata.description === undefined
          ? (source.run.description ?? null)
          : (metadata.description ?? null),
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
      evaluationContextHash: null,
      evaluationResultSetHash: null,
      reportResultSetHash: null,
      reportSummary: null,
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
