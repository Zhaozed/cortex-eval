import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import {
  RestArtifactCaseV1Schema,
  type RestArtifactCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import {
  WorkPackageRestJsonlCaseV1Schema,
  WorkPackageRestJsonlFooterV1Schema,
  WorkPackageRestJsonlHeaderV1Schema
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

import type { ImmutableFileWriter } from "./secure-work-package-directory.ts";
import type {
  PublishedStageArtifact,
  WorkPackageExecutionSession
} from "./work-package-execution-session.ts";
import { publishedStageArtifact } from "./work-package-execution-session.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

// Map clean Domain Provider Output names into the frozen Artifact transport contract.
function providerOutput(
  value: Extract<OfflineRestCaseResult, { status: "SUCCEEDED" }>["providerOutput"]
): unknown {
  if (!value.ok) return { ok: false, err_msg: value.errorMessage };
  return {
    ok: true,
    task_name: value.taskName,
    resolved_config: value.resolvedConfig,
    parsed_output: value.parsedOutput
  };
}

// Project one Application result into its strict Work Package Artifact Case contract.
export function workPackageRestArtifactCase(value: OfflineRestCaseResult): RestArtifactCaseV1 {
  const common = {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    caseDefinitionHash: value.caseDefinitionHash,
    status: value.status,
    httpStatus: value.httpStatus,
    durationMs: value.durationMs,
    completedAt: value.completedAt,
    resultHash: value.resultHash,
    provenance: value.provenance === null ? null : { ...value.provenance }
  };
  if (value.status === "SUCCEEDED") {
    return RestArtifactCaseV1Schema.parse({
      ...common,
      providerOutput: providerOutput(value.providerOutput)
    });
  }
  return RestArtifactCaseV1Schema.parse({
    ...common,
    providerOutput: null,
    error: { type: value.errorType, message: value.errorMessage }
  });
}

/** Streaming REST Artifact writer over one fixed running Execution slot. */
export class WorkPackageRestArtifactWriter {
  /** Underlying immutable file writer. */
  readonly #writer: ImmutableFileWriter;
  /** Frozen Manifest identity lookup owned by the locked Session. */
  readonly #expectedCaseKey: (ordinal: number) => string | null;
  /** Next required Case ordinal. */
  #nextOrdinal = 0;
  #closed = false;

  /** Construct only through the running REST stage factory. */
  private constructor(
    writer: ImmutableFileWriter,
    expectedCaseKey: (ordinal: number) => string | null
  ) {
    this.#writer = writer;
    this.#expectedCaseKey = expectedCaseKey;
  }

  /** Open the fixed REST Artifact slot and write its JSONL header. */
  public static async create(
    session: WorkPackageExecutionSession,
    executionId: string
  ): Promise<WorkPackageRestArtifactWriter> {
    const writer = await session.createStageArtifactWriter(
      executionId,
      "REST_RESULTS",
      Number.MAX_SAFE_INTEGER
    );
    try {
      const header = WorkPackageRestJsonlHeaderV1Schema.parse({
        recordType: "HEADER",
        contractVersion: "cortex.rest-results-jsonl.v1",
        packageId: session.packageSummary.packageId,
        executionId
      });
      await writer.append(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));
      return new WorkPackageRestArtifactWriter(writer, (ordinal): string | null =>
        session.inputs.expectedCaseKey(ordinal)
      );
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  /** Append one strict Case fact in exact frozen order. */
  public async append(value: OfflineRestCaseResult): Promise<void> {
    this.#requireOpen();
    if (
      value.ordinal !== this.#nextOrdinal ||
      this.#expectedCaseKey(this.#nextOrdinal) !== value.caseKey
    ) {
      throw new Error("ARTIFACT_WRITE_FAILED");
    }
    let clean: ReturnType<typeof RestArtifactCaseV1Schema.parse>;
    try {
      clean = workPackageRestArtifactCase(value);
      validateDecodedJsonStringBytes(clean, "ARTIFACT_WRITE_FAILED");
    } catch (error) {
      if (error instanceof Error && error.message === "ARTIFACT_WRITE_FAILED") throw error;
      throw new Error("ARTIFACT_WRITE_FAILED", { cause: error });
    }
    const record = WorkPackageRestJsonlCaseV1Schema.parse({ recordType: "CASE", value: clean });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.restResultCaseBytes + 1) {
      throw new Error("ARTIFACT_WRITE_FAILED");
    }
    await this.#writer.append(bytes);
    this.#nextOrdinal += 1;
  }

  /** Finish, fsync and exclusively publish one complete REST Artifact. */
  public async commit(completedAt: string, resultSetHash: string): Promise<PublishedStageArtifact> {
    this.#requireOpen();
    if (this.#nextOrdinal === 0 || this.#expectedCaseKey(this.#nextOrdinal) !== null) {
      throw new Error("ARTIFACT_WRITE_FAILED");
    }
    const cleanCompletedAt = UtcDateTimeSchema.parse(completedAt);
    const cleanResultSetHash = Sha256Schema.parse(resultSetHash);
    const footer = WorkPackageRestJsonlFooterV1Schema.parse({
      recordType: "FOOTER",
      completedAt: cleanCompletedAt,
      resultSetHash: cleanResultSetHash
    });
    try {
      await this.#writer.append(Buffer.from(`${JSON.stringify(footer)}\n`, "utf8"));
      const published = await this.#writer.commit();
      this.#closed = true;
      return publishedStageArtifact(published, "REST_RESULTS", "cortex.rest-results-jsonl.v1");
    } catch (error) {
      await this.#writer.abort();
      this.#closed = true;
      throw error;
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
