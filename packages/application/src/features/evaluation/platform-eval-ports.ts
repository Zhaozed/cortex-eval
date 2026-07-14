import type { RunArtifactManifest } from "../runs/platform-run-models.ts";
import type {
  PlatformEvalCaseResult,
  PlatformEvalProgress,
  PlatformEvalResultPage,
  PlatformEvalResultQuery
} from "./platform-eval-models.ts";

/** Complete atomic platform Evaluation stage commit. */
export interface CompletePlatformEvalStageInput {
  /** Target platform Run. */
  readonly runId: string;
  /** Latest claimed Evaluation Revision. */
  readonly expectedRevision: number;
  /** Complete frozen Case count. */
  readonly expectedTotal: number;
  /** Complete semantic Eval result-set hash. */
  readonly resultSetHash: string;
  /** Frozen Evaluation generation, matrix and Evaluator context. */
  readonly evaluationContextHash: string;
  /** Complete ordered normalized Eval facts. */
  readonly results: readonly PlatformEvalCaseResult[];
  /** Manifest containing immutable raw and normalized Eval descriptors. */
  readonly artifactManifest: RunArtifactManifest;
  /** Commit timestamp. */
  readonly updatedAt: string;
}

/** Exact Evaluation stage commit outcome. */
export type CompletePlatformEvalStageResult =
  | { readonly ok: true; readonly progress: PlatformEvalProgress }
  | { readonly ok: false; readonly reason: "STATE_OR_REVISION" | "RESULT_ALIGNMENT" };

/** Transaction-bound Evaluation persistence operations. */
export interface PlatformEvalRepository {
  /** Atomically reconcile, persist and advance one complete Evaluation stage. */
  completeStage(input: CompletePlatformEvalStageInput): Promise<CompletePlatformEvalStageResult>;
  /** Query complete normalized Eval facts in frozen order. */
  queryResults(query: PlatformEvalResultQuery): Promise<PlatformEvalResultPage>;
}

/** Evaluation repositories exposed inside one short transaction. */
export interface PlatformEvalTransaction {
  /** Platform Evaluation persistence. */
  readonly evaluations: PlatformEvalRepository;
}

/** Dedicated managed transaction boundary for Evaluation commits and reads. */
export interface PlatformEvalTransactionManager {
  /** Execute database-only Evaluation work atomically. */
  execute<T>(work: (transaction: PlatformEvalTransaction) => Promise<T>): Promise<T>;
}
