import type { ImportedEvalCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { EvalCaseV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import type { ImmutableFileWriter } from "./secure-work-package-directory.ts";
import type {
  PublishedStageArtifact,
  WorkPackageExecutionSession
} from "./work-package-execution-session.ts";
import { publishedStageArtifact } from "./work-package-execution-session.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

/** Streaming Normalized Eval writer over one fixed running Execution slot. */
export class WorkPackageNormalizedEvalArtifactWriter {
  /** Underlying immutable file writer. */
  readonly #writer: ImmutableFileWriter;
  /** Owning immutable Package identity. */
  readonly #packageId: string;
  /** Owning immutable Execution identity. */
  readonly #executionId: string;
  /** Frozen Evaluation context identity. */
  readonly #evaluationContextHash: string;
  /** Frozen Manifest identity lookup owned by the locked Session. */
  readonly #expectedCaseKey: (ordinal: number) => string | null;
  /** Next required Case ordinal. */
  #nextOrdinal = 0;
  #closed = false;

  /** Construct only through the running Evaluation stage factory. */
  private constructor(
    writer: ImmutableFileWriter,
    packageId: string,
    executionId: string,
    evaluationContextHash: string,
    expectedCaseKey: (ordinal: number) => string | null
  ) {
    this.#writer = writer;
    this.#packageId = packageId;
    this.#executionId = executionId;
    this.#evaluationContextHash = evaluationContextHash;
    this.#expectedCaseKey = expectedCaseKey;
  }

  /** Open the fixed Normalized Eval slot and write its array prefix. */
  public static async create(
    session: WorkPackageExecutionSession,
    executionId: string,
    evaluationContextHash: string
  ): Promise<WorkPackageNormalizedEvalArtifactWriter> {
    const cleanContextHash = Sha256Schema.parse(evaluationContextHash);
    const writer = await session.createStageArtifactWriter(
      executionId,
      "NORMALIZED_EVAL_RESULTS",
      Number.MAX_SAFE_INTEGER
    );
    try {
      await writer.append(Buffer.from('{"cases":[', "utf8"));
      return new WorkPackageNormalizedEvalArtifactWriter(
        writer,
        session.packageSummary.packageId,
        executionId,
        cleanContextHash,
        (ordinal): string | null => session.inputs.expectedCaseKey(ordinal)
      );
    } catch (error) {
      await writer.abort();
      throw new Error("EVALUATION_STAGE_FAILED", { cause: error });
    }
  }

  /** Append one strict Case fact in exact frozen order. */
  public async append(value: EvalCaseV1 | ImportedEvalCase): Promise<void> {
    this.#requireOpen();
    try {
      const clean = EvalCaseV1Schema.parse(value);
      if (
        clean.ordinal !== this.#nextOrdinal ||
        this.#expectedCaseKey(this.#nextOrdinal) !== clean.caseKey
      ) {
        throw new Error("EVALUATION_STAGE_FAILED");
      }
      validateDecodedJsonStringBytes(clean, "EVALUATION_STAGE_FAILED");
      const bytes = Buffer.from(JSON.stringify(clean), "utf8");
      if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes) {
        throw new Error("EVALUATION_STAGE_FAILED");
      }
      if (this.#nextOrdinal > 0) await this.#writer.append(Buffer.from(",", "utf8"));
      await this.#writer.append(bytes);
      this.#nextOrdinal += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "EVALUATION_STAGE_FAILED") throw error;
      throw new Error("EVALUATION_STAGE_FAILED", { cause: error });
    }
  }

  /** Finish, fsync and exclusively publish one complete Normalized Eval Artifact. */
  public async commit(completedAt: string, resultSetHash: string): Promise<PublishedStageArtifact> {
    this.#requireOpen();
    try {
      if (this.#nextOrdinal === 0 || this.#expectedCaseKey(this.#nextOrdinal) !== null) {
        throw new Error("EVALUATION_STAGE_FAILED");
      }
      const cleanCompletedAt = UtcDateTimeSchema.parse(completedAt);
      const cleanResultSetHash = Sha256Schema.parse(resultSetHash);
      const trailer =
        `],"completedAt":${JSON.stringify(cleanCompletedAt)},` +
        '"contractVersion":"cortex.normalized-eval.v1",' +
        `"evaluationContextHash":${JSON.stringify(this.#evaluationContextHash)},` +
        `"executionId":${JSON.stringify(this.#executionId)},` +
        `"packageId":${JSON.stringify(this.#packageId)},` +
        `"resultSetHash":${JSON.stringify(cleanResultSetHash)}}\n`;
      await this.#writer.append(Buffer.from(trailer, "utf8"));
      const published = await this.#writer.commit();
      this.#closed = true;
      return publishedStageArtifact(
        published,
        "NORMALIZED_EVAL_RESULTS",
        "cortex.normalized-eval.v1"
      );
    } catch (error) {
      await this.#writer.abort();
      this.#closed = true;
      throw new Error("EVALUATION_STAGE_FAILED", { cause: error });
    }
  }

  /** Remove the unpublished temporary file after a failed stage. */
  public async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.abort();
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("ARTIFACT_WRITER_CLOSED");
  }
}
