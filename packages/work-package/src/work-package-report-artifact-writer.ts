import type { ReportAggregationResult } from "@cortex-eval/reporting/src/report-aggregation.ts";
import {
  renderReportMarkdownCase,
  renderReportMarkdownHeader
} from "@cortex-eval/reporting/src/report-markdown.ts";
import {
  MetricSummaryV1Schema,
  ReportCaseV1Schema,
  ReportContextV1Schema,
  ReportSummaryV1Schema,
  type ReportCaseV1,
  type ReportContextV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";

import type { PublishedImmutableFile } from "./secure-work-package-directory.ts";
import type {
  PublishedStageArtifact,
  WorkPackageArtifactKind
} from "./work-package-execution-session.ts";
import { publishedStageArtifact } from "./work-package-execution-session.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

/** Minimal computed file writer needed by the two-slot Report publisher. */
export interface ReportComputedFileWriter {
  /** Append one byte chunk under the writer's fixed size policy. */
  readonly append: (value: Uint8Array) => Promise<void>;
  /** Flush and exclusively publish the complete immutable file. */
  readonly commit: () => Promise<PublishedImmutableFile>;
  /** Remove the unpublished staging file. */
  readonly abort: () => Promise<void>;
}

/** Narrow locked Session boundary used by Report publication and compensation. */
export interface WorkPackageReportArtifactSession {
  /** Immutable owning Package identity. */
  readonly packageSummary: { readonly packageId: string };
  /** Frozen Case identity lookup without retaining another complete collection. */
  readonly inputs: { readonly expectedCaseKey: (ordinal: number) => string | null };
  /** Open one fixed Report Artifact slot. */
  readonly createStageArtifactWriter: (
    executionId: string,
    kind: WorkPackageArtifactKind,
    maximumBytes: number
  ) => Promise<ReportComputedFileWriter>;
  /** Atomically register both published Report slots. */
  readonly completeStage: (
    executionId: string,
    stageName: "REPORT",
    completedAt: string,
    artifacts: readonly PublishedStageArtifact[]
  ) => Promise<unknown>;
  /** Remove one exact fixed-slot publication that was never registered. */
  readonly discardUnregisteredStageArtifact: (
    executionId: string,
    stageName: "REPORT",
    artifact: PublishedStageArtifact
  ) => Promise<void>;
}

/** Safe observer for best-effort cleanup failures after a primary Report error. */
export interface ReportArtifactCleanupFailureSink {
  /** Record only a stable cleanup event without paths or report content. */
  readonly record: (event: "REPORT_ARTIFACT_CLEANUP_FAILED") => void | Promise<void>;
}

/** Fixed report-wide facts validated before either Artifact is opened. */
export interface CreateWorkPackageReportArtifactWriterInput {
  /** Locked Work Package mutation Session. */
  readonly session: WorkPackageReportArtifactSession;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Safe frozen report context. */
  readonly context: ReportContextV1;
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete preflighted report aggregation and version hash. */
  readonly aggregation: ReportAggregationResult;
  /** Stable completion timestamp shared by JSON and Markdown. */
  readonly completedAt: string;
  /** Cleanup observer that cannot replace the primary outcome. */
  readonly cleanupFailureSink: ReportArtifactCleanupFailureSink;
}

interface CleanReportHeader {
  readonly packageId: string;
  readonly executionId: string;
  readonly context: ReportContextV1;
  readonly evaluationContextHash: string;
  readonly evaluationResultSetHash: string;
  readonly aggregation: ReportAggregationResult;
  readonly completedAt: string;
}

// Validate the bounded report-wide envelope before opening either output slot.
function cleanHeader(input: CreateWorkPackageReportArtifactWriterInput): CleanReportHeader {
  return {
    packageId: UuidV7Schema.parse(input.session.packageSummary.packageId),
    executionId: UuidV7Schema.parse(input.executionId),
    context: ReportContextV1Schema.parse(input.context),
    evaluationContextHash: Sha256Schema.parse(input.evaluationContextHash),
    evaluationResultSetHash: Sha256Schema.parse(input.evaluationResultSetHash),
    aggregation: {
      summary: ReportSummaryV1Schema.parse(input.aggregation.summary),
      byMetric: input.aggregation.byMetric.map((item) => MetricSummaryV1Schema.parse(item)),
      reportResultSetHash: Sha256Schema.parse(input.aggregation.reportResultSetHash)
    },
    completedAt: UtcDateTimeSchema.parse(input.completedAt)
  };
}

// Adapt one full Report Case into the bounded Markdown renderer projection.
function markdownCase(value: ReportCaseV1): Parameters<typeof renderReportMarkdownCase>[0] {
  return {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    status: value.evaluation.status,
    reason: value.evaluation.reason,
    evaluationErrorCode: value.evaluation.evaluationError?.code ?? null,
    assertions: value.evaluation.assertions.map((item) => ({
      index: item.index,
      type: item.type,
      metric: item.metric,
      status: item.status,
      score: item.score,
      reason: item.reason
    })),
    diffs: value.evaluation.diffs.map((item) => ({
      assertionIndex: item.assertionIndex,
      instancePath: item.instancePath,
      schemaPath: item.schemaPath,
      keyword: item.keyword,
      expectedConstraint: item.expectedConstraint,
      actual: item.actual,
      reason: item.reason
    }))
  };
}

/** Streaming two-slot Report publisher with exact pre-registration compensation. */
export class WorkPackageReportArtifactWriter {
  /** Locked Session used for final registration and exact compensation. */
  readonly #session: WorkPackageReportArtifactSession;
  /** JSON Artifact staging writer. */
  readonly #jsonWriter: ReportComputedFileWriter;
  /** Markdown Artifact staging writer. */
  readonly #markdownWriter: ReportComputedFileWriter;
  /** Fully validated bounded report envelope. */
  readonly #header: CleanReportHeader;
  /** Safe cleanup failure observer. */
  readonly #cleanupFailureSink: ReportArtifactCleanupFailureSink;
  /** Next required Case ordinal. */
  #nextOrdinal = 0;
  /** Whether this writer has reached a terminal outcome. */
  #closed = false;

  /** Construct only after both fixed slots and their prefixes exist. */
  private constructor(
    session: WorkPackageReportArtifactSession,
    jsonWriter: ReportComputedFileWriter,
    markdownWriter: ReportComputedFileWriter,
    header: CleanReportHeader,
    cleanupFailureSink: ReportArtifactCleanupFailureSink
  ) {
    this.#session = session;
    this.#jsonWriter = jsonWriter;
    this.#markdownWriter = markdownWriter;
    this.#header = header;
    this.#cleanupFailureSink = cleanupFailureSink;
  }

  /** Open both fixed Report slots only after the complete first pass succeeded. */
  public static async create(
    input: CreateWorkPackageReportArtifactWriterInput
  ): Promise<WorkPackageReportArtifactWriter> {
    const header = cleanHeader(input);
    const jsonWriter = await input.session.createStageArtifactWriter(
      header.executionId,
      "REPORT_JSON",
      Number.MAX_SAFE_INTEGER
    );
    let markdownWriter: ReportComputedFileWriter | null = null;
    try {
      markdownWriter = await input.session.createStageArtifactWriter(
        header.executionId,
        "REPORT_MARKDOWN",
        Number.MAX_SAFE_INTEGER
      );
      await jsonWriter.append(
        Buffer.from(
          `${JSON.stringify({ byMetric: header.aggregation.byMetric }).slice(0, -1)},"cases":[`,
          "utf8"
        )
      );
      await markdownWriter.append(
        Buffer.from(
          renderReportMarkdownHeader({
            owner: { kind: "EXECUTION", id: header.executionId },
            completedAt: header.completedAt,
            summary: header.aggregation.summary,
            byMetric: header.aggregation.byMetric
          }),
          "utf8"
        )
      );
      return new WorkPackageReportArtifactWriter(
        input.session,
        jsonWriter,
        markdownWriter,
        header,
        input.cleanupFailureSink
      );
    } catch (error) {
      await Promise.allSettled([jsonWriter.abort(), markdownWriter?.abort()]);
      throw error;
    }
  }

  /** Append one complete Report Case to JSON and its non-PASS Markdown projection. */
  public async append(value: ReportCaseV1): Promise<void> {
    this.#requireOpen();
    try {
      const clean = ReportCaseV1Schema.parse(value);
      if (
        clean.ordinal !== this.#nextOrdinal ||
        this.#session.inputs.expectedCaseKey(clean.ordinal) !== clean.caseKey
      ) {
        throw new Error("REPORT_RECONCILIATION_FAILED");
      }
      validateDecodedJsonStringBytes(clean, "REPORT_RECONCILIATION_FAILED");
      if (this.#nextOrdinal > 0) await this.#jsonWriter.append(Buffer.from(",", "utf8"));
      await this.#jsonWriter.append(Buffer.from(JSON.stringify(clean), "utf8"));
      const markdown = renderReportMarkdownCase(markdownCase(clean));
      if (markdown !== "") await this.#markdownWriter.append(Buffer.from(markdown, "utf8"));
      this.#nextOrdinal += 1;
    } catch (error) {
      await this.abort();
      if (error instanceof Error && error.message === "REPORT_RECONCILIATION_FAILED") throw error;
      throw new Error("REPORT_RECONCILIATION_FAILED", { cause: error });
    }
  }

  /** Publish both files and register them together, compensating every unregistered file. */
  public async commitStage(): Promise<readonly PublishedStageArtifact[]> {
    this.#requireOpen();
    if (
      this.#nextOrdinal === 0 ||
      this.#session.inputs.expectedCaseKey(this.#nextOrdinal) !== null ||
      this.#nextOrdinal !== this.#header.aggregation.summary.total
    ) {
      await this.abort();
      throw new Error("REPORT_RECONCILIATION_FAILED");
    }
    const published: PublishedStageArtifact[] = [];
    try {
      await this.#jsonWriter.append(Buffer.from(this.#jsonTrailer(), "utf8"));
      await this.#markdownWriter.append(Buffer.from("\n", "utf8"));
      published.push(
        publishedStageArtifact(await this.#jsonWriter.commit(), "REPORT_JSON", "cortex.report.v1")
      );
      published.push(
        publishedStageArtifact(
          await this.#markdownWriter.commit(),
          "REPORT_MARKDOWN",
          "cortex.report-markdown.v1"
        )
      );
      await this.#session.completeStage(
        this.#header.executionId,
        "REPORT",
        this.#header.completedAt,
        published
      );
      this.#closed = true;
      return published;
    } catch (error) {
      this.#closed = true;
      await Promise.allSettled([this.#jsonWriter.abort(), this.#markdownWriter.abort()]);
      await this.#compensate(published);
      throw error;
    }
  }

  /** Remove both unpublished staging files after a failed Case stream. */
  public async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([this.#jsonWriter.abort(), this.#markdownWriter.abort()]);
  }

  // Build the bounded JSON envelope trailer after every Case has streamed.
  #jsonTrailer(): string {
    return (
      `],"completedAt":${JSON.stringify(this.#header.completedAt)},` +
      `"context":${JSON.stringify(this.#header.context)},` +
      '"contractVersion":"cortex.report.v1",' +
      `"evaluationContextHash":${JSON.stringify(this.#header.evaluationContextHash)},` +
      `"evaluationResultSetHash":${JSON.stringify(this.#header.evaluationResultSetHash)},` +
      `"owner":${JSON.stringify({ kind: "EXECUTION", id: this.#header.executionId })},` +
      `"packageId":${JSON.stringify(this.#header.packageId)},` +
      `"reportResultSetHash":${JSON.stringify(this.#header.aggregation.reportResultSetHash)},` +
      `"summary":${JSON.stringify(this.#header.aggregation.summary)}}\n`
    );
  }

  // Remove only publications from this command while preserving the primary error.
  async #compensate(artifacts: readonly PublishedStageArtifact[]): Promise<void> {
    const results = await Promise.allSettled(
      artifacts.map((artifact) =>
        this.#session.discardUnregisteredStageArtifact(this.#header.executionId, "REPORT", artifact)
      )
    );
    for (const result of results) {
      if (result.status === "rejected") {
        await this.#cleanupFailureSink.record("REPORT_ARTIFACT_CLEANUP_FAILED");
      }
    }
  }

  // Reject every operation after one terminal writer outcome.
  #requireOpen(): void {
    if (this.#closed) throw new Error("ARTIFACT_WRITER_CLOSED");
  }
}
