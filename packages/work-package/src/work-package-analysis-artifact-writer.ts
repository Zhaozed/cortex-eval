import type { FrozenAnalysisCaseResult } from "@cortex-eval/application/src/features/case-analysis/frozen-analysis-engine.ts";
import {
  AnalysisResultCaseV1Schema,
  type AnalysisResultCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import {
  OrderedAnalysisResultSetHasher,
  type AnalysisSelector
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { ImmutableFileWriter } from "./secure-work-package-directory.ts";
import type {
  PublishedStageArtifact,
  WorkPackageExecutionSession
} from "./work-package-execution-session.ts";
import { publishedStageArtifact } from "./work-package-execution-session.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

/** Complete committed Analysis Artifact and its independently reusable result-set identity. */
export interface CommittedAnalysisArtifact {
  /** Newly published fixed Analysis slot. */
  readonly artifact: PublishedStageArtifact;
  /** Complete Execution-owned Analysis result version. */
  readonly analysisResultSetHash: string;
}

/** Inputs fixed before the first selected Analysis Case is written. */
export interface CreateWorkPackageAnalysisArtifactWriterInput {
  /** Locked Work Package mutation session. */
  readonly session: WorkPackageExecutionSession;
  /** Immutable offline Execution version. */
  readonly executionId: string;
  /** Explicit selected analyzable result family. */
  readonly selector: AnalysisSelector;
  /** Exact owner-neutral selected final-result dependency set. */
  readonly finalCaseResultSetHash: string;
  /** Externalized safe message lookup for isolated Analyzer errors. */
  readonly errorMessage: (code: string) => string;
}

// Map one Domain result into the strict offline Artifact boundary.
function artifactCase(
  result: FrozenAnalysisCaseResult,
  errorMessage: (code: string) => string
): AnalysisResultCaseV1 {
  const common = {
    caseKey: result.caseKey,
    ordinal: result.ordinal,
    finalCaseResultHash: result.finalCaseResultHash,
    analysisInputHash: result.analysisInputHash,
    analysisResultHash: result.analysisResultHash
  };
  if (result.status === "ERROR") {
    return AnalysisResultCaseV1Schema.parse({
      ...common,
      status: result.status,
      classification: null,
      confidence: null,
      evidence: [],
      explanation: null,
      recommendedAction: null,
      proposal: null,
      error: { code: result.errorCode, message: errorMessage(result.errorCode) }
    });
  }
  return AnalysisResultCaseV1Schema.parse({
    ...common,
    status: result.status,
    classification: result.classification,
    confidence: result.confidence,
    evidence: result.evidence.map((item) => ({ ...item })),
    explanation: result.explanation,
    recommendedAction: result.recommendedAction,
    proposal: result.proposal === null ? null : analysisProposalJson(result.proposal),
    error: null
  });
}

/** Streaming writer for one immutable, possibly empty offline Analysis result set. */
export class WorkPackageAnalysisArtifactWriter {
  /** Underlying immutable fixed-slot file writer. */
  readonly #writer: ImmutableFileWriter;
  /** Owning immutable Package identity. */
  readonly #packageId: string;
  /** Owning immutable Execution identity. */
  readonly #executionId: string;
  /** Explicit selection rule. */
  readonly #selector: AnalysisSelector;
  /** Exact selected final-result dependency identity. */
  readonly #finalCaseResultSetHash: string;
  /** Expected Manifest Case identity lookup. */
  readonly #expectedCaseKey: (ordinal: number) => string | null;
  /** Safe error message resolver. */
  readonly #errorMessage: (code: string) => string;
  /** Incremental result-set identity. */
  readonly #resultSetHasher: OrderedAnalysisResultSetHasher;
  /** Last written sparse original Ordinal. */
  #priorOrdinal = -1;
  /** Number of written selected Cases. */
  #count = 0;
  #closed = false;

  /** Construct only after the fixed Analysis slot is opened successfully. */
  private constructor(
    writer: ImmutableFileWriter,
    input: CreateWorkPackageAnalysisArtifactWriterInput,
    packageId: string,
    executionId: string,
    finalCaseResultSetHash: string
  ) {
    this.#writer = writer;
    this.#packageId = packageId;
    this.#executionId = executionId;
    this.#selector = input.selector;
    this.#finalCaseResultSetHash = finalCaseResultSetHash;
    this.#expectedCaseKey = (ordinal): string | null =>
      input.session.inputs.expectedCaseKey(ordinal);
    this.#errorMessage = input.errorMessage;
    this.#resultSetHasher = new OrderedAnalysisResultSetHasher(
      { kind: "EXECUTION", id: executionId },
      input.selector,
      finalCaseResultSetHash
    );
  }

  /** Open the fixed Analysis slot and write its streaming array prefix. */
  public static async create(
    input: CreateWorkPackageAnalysisArtifactWriterInput
  ): Promise<WorkPackageAnalysisArtifactWriter> {
    const executionId = UuidV7Schema.parse(input.executionId);
    const finalCaseResultSetHash = Sha256Schema.parse(input.finalCaseResultSetHash);
    const writer = await input.session.createStageArtifactWriter(
      executionId,
      "ANALYSIS_RESULTS",
      Number.MAX_SAFE_INTEGER
    );
    try {
      await writer.append(Buffer.from('{"cases":[', "utf8"));
      return new WorkPackageAnalysisArtifactWriter(
        writer,
        input,
        input.session.packageSummary.packageId,
        executionId,
        finalCaseResultSetHash
      );
    } catch (error) {
      await writer.abort();
      throw new Error("ANALYSIS_STAGE_FAILED", { cause: error });
    }
  }

  /** Append one selected Case in strictly increasing original Manifest order. */
  public async append(result: FrozenAnalysisCaseResult): Promise<void> {
    this.#requireOpen();
    try {
      if (
        result.ordinal <= this.#priorOrdinal ||
        this.#expectedCaseKey(result.ordinal) !== result.caseKey
      ) {
        throw new Error("ANALYSIS_STAGE_FAILED");
      }
      const clean = artifactCase(result, this.#errorMessage);
      validateDecodedJsonStringBytes(clean, "ANALYSIS_STAGE_FAILED");
      const bytes = Buffer.from(JSON.stringify(clean), "utf8");
      if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.analysisResultCaseBytes) {
        throw new Error("ANALYSIS_STAGE_FAILED");
      }
      if (this.#count > 0) await this.#writer.append(Buffer.from(",", "utf8"));
      await this.#writer.append(bytes);
      this.#resultSetHasher.add({
        caseKey: clean.caseKey,
        ordinal: clean.ordinal,
        analysisResultHash: clean.analysisResultHash
      });
      this.#priorOrdinal = clean.ordinal;
      this.#count += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "ANALYSIS_STAGE_FAILED") throw error;
      throw new Error("ANALYSIS_STAGE_FAILED", { cause: error });
    }
  }

  /** Finish, fsync and exclusively publish the complete Analysis Artifact. */
  public async commit(completedAt: string): Promise<CommittedAnalysisArtifact> {
    this.#requireOpen();
    try {
      const timestamp = UtcDateTimeSchema.parse(completedAt);
      const analysisResultSetHash = this.#resultSetHasher.finish();
      const trailer =
        `],"completedAt":${JSON.stringify(timestamp)},` +
        '"contractVersion":"cortex.analysis-results.v1",' +
        `"executionId":${JSON.stringify(this.#executionId)},` +
        `"finalCaseResultSetHash":${JSON.stringify(this.#finalCaseResultSetHash)},` +
        `"packageId":${JSON.stringify(this.#packageId)},` +
        `"selector":${JSON.stringify(this.#selector)},` +
        `"analysisResultSetHash":${JSON.stringify(analysisResultSetHash)}}\n`;
      await this.#writer.append(Buffer.from(trailer, "utf8"));
      const published = await this.#writer.commit();
      this.#closed = true;
      return {
        artifact: publishedStageArtifact(
          published,
          "ANALYSIS_RESULTS",
          "cortex.analysis-results.v1"
        ),
        analysisResultSetHash
      };
    } catch (error) {
      await this.#writer.abort();
      this.#closed = true;
      throw new Error("ANALYSIS_STAGE_FAILED", { cause: error });
    }
  }

  /** Remove the unpublished temporary file after a failed or cancelled stage. */
  public async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.abort();
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("ARTIFACT_WRITER_CLOSED");
  }
}
