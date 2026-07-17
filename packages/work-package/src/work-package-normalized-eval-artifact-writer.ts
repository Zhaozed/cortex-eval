import type { ImportedEvalCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { EvalCaseV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import {
  WorkPackageNormalizedEvalJsonlCaseV1Schema,
  WorkPackageNormalizedEvalJsonlFooterV1Schema,
  WorkPackageNormalizedEvalJsonlHeaderV1Schema
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

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
  /** Frozen Manifest identity lookup owned by the locked Session. */
  readonly #expectedCaseKey: (ordinal: number) => string | null;
  /** Next required Case ordinal. */
  #nextOrdinal = 0;
  #closed = false;

  /** Construct only through the running Evaluation stage factory. */
  private constructor(
    writer: ImmutableFileWriter,
    expectedCaseKey: (ordinal: number) => string | null
  ) {
    this.#writer = writer;
    this.#expectedCaseKey = expectedCaseKey;
  }

  /** Open the fixed Normalized Eval slot and write its JSONL header. */
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
      const header = WorkPackageNormalizedEvalJsonlHeaderV1Schema.parse({
        recordType: "HEADER",
        contractVersion: "cortex.normalized-eval-jsonl.v1",
        packageId: session.packageSummary.packageId,
        executionId,
        evaluationContextHash: cleanContextHash
      });
      await writer.append(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));
      return new WorkPackageNormalizedEvalArtifactWriter(writer, (ordinal): string | null =>
        session.inputs.expectedCaseKey(ordinal)
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
      const record = WorkPackageNormalizedEvalJsonlCaseV1Schema.parse({
        recordType: "CASE",
        value: clean
      });
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes + 1) {
        throw new Error("EVALUATION_STAGE_FAILED");
      }
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
      const footer = WorkPackageNormalizedEvalJsonlFooterV1Schema.parse({
        recordType: "FOOTER",
        completedAt: cleanCompletedAt,
        resultSetHash: cleanResultSetHash
      });
      await this.#writer.append(Buffer.from(`${JSON.stringify(footer)}\n`, "utf8"));
      const published = await this.#writer.commit();
      this.#closed = true;
      return publishedStageArtifact(
        published,
        "NORMALIZED_EVAL_RESULTS",
        "cortex.normalized-eval-jsonl.v1"
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
