import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import type {
  AnalysisClassification,
  AnalysisEvidenceDraft,
  AnalysisProposalDraft,
  AnalysisResultDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  hashAnalysisResult,
  OrderedAnalysisFinalCaseResultSetHasher,
  type AnalysisSelector
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type {
  AnalysisPromptDefinition,
  LlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import type { AnalysisModelClient } from "./case-analysis-model-client.ts";
import {
  buildAnalysisInput,
  type AnalysisCaseFacts,
  type FrozenAnalysisExecutionLimits
} from "./case-analysis-input-builder.ts";

/** Replayable ordered source used by platform memory and offline storage boundaries. */
export interface FrozenAnalysisCaseSource {
  /** Open one fresh ordered pass over immutable Case facts. */
  readonly open: () => AsyncIterable<AnalysisCaseFacts>;
}

/** Frozen Analyzer identity and complete validated definition. */
export interface FrozenAnalysisAnalyzer {
  /** Frozen semantic Analyzer hash. */
  readonly configHash: string;
  /** Complete validated Analyzer definition. */
  readonly definition: LlmConfigDefinition;
}

/** Frozen Analysis Prompt identity and complete validated definition. */
export interface FrozenCaseAnalysisPrompt {
  /** Frozen semantic Prompt hash. */
  readonly promptHash: string;
  /** Complete validated Analysis Prompt. */
  readonly definition: AnalysisPromptDefinition;
}

interface FrozenAnalysisCaseResultBase {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Original frozen Case ordinal. */
  readonly ordinal: number;
  /** Bound final Case result. */
  readonly finalCaseResultHash: string;
  /** Complete Analysis Input identity. */
  readonly analysisInputHash: string;
  /** Complete semantic Analysis result identity. */
  readonly analysisResultHash: string;
}

/** Successful structured single-Case Analysis result. */
export interface FrozenAnalysisCaseSuccess extends FrozenAnalysisCaseResultBase {
  /** Successful result discriminator. */
  readonly status: "SUCCEEDED";
  /** Fixed Analysis classification. */
  readonly classification: AnalysisClassification;
  /** Model self-assessed confidence. */
  readonly confidence: number;
  /** Ordered structured evidence. */
  readonly evidence: readonly AnalysisEvidenceDraft[];
  /** Model explanation. */
  readonly explanation: string;
  /** Model recommended action. */
  readonly recommendedAction: string;
  /** Optional single Proposal. */
  readonly proposal: AnalysisProposalDraft | null;
}

/** Stable isolated single-Case Analyzer failure. */
export interface FrozenAnalysisCaseError extends FrozenAnalysisCaseResultBase {
  /** Failed result discriminator. */
  readonly status: "ERROR";
  /** Stable safe Analyzer error code. */
  readonly errorCode: string;
}

/** Complete single-Case Analysis result union. */
export type FrozenAnalysisCaseResult = FrozenAnalysisCaseSuccess | FrozenAnalysisCaseError;

/** Complete persisted identity available before one external Analyzer call starts. */
export interface FrozenAnalysisCaseStart {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Original frozen Case ordinal. */
  readonly ordinal: number;
  /** Bound final Case result identity. */
  readonly finalCaseResultHash: string;
  /** Complete Analysis Input identity. */
  readonly analysisInputHash: string;
}

/** Complete immutable Analysis batch input. */
export interface FrozenAnalysisEngineInput {
  /** Platform Run or offline Execution version identity. */
  readonly binding:
    | { readonly kind: "RUN"; readonly id: string }
    | { readonly kind: "EXECUTION"; readonly id: string };
  /** Replayable complete Case source. */
  readonly source: FrozenAnalysisCaseSource;
  /** Explicit analyzable Case selector. */
  readonly selector: AnalysisSelector;
  /** Frozen platform Run or offline Execution context hash. */
  readonly runContextHash: string;
  /** Redacted execution facts exposed to the model. */
  readonly runContext: DomainJsonObject;
  /** Frozen Analyzer. */
  readonly analyzer: FrozenAnalysisAnalyzer;
  /** Frozen Analysis Prompt. */
  readonly prompt: FrozenCaseAnalysisPrompt;
  /** Frozen Analysis concurrency limit. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  /** Owner cancellation signal. */
  readonly signal: AbortSignal;
  /** Persist PENDING/RUNNING identity before the external model side effect. */
  readonly onCaseStart?: ((started: FrozenAnalysisCaseStart) => Promise<void>) | undefined;
  /** Persist or stage one complete Case result. */
  readonly onResult: (result: FrozenAnalysisCaseResult) => Promise<void>;
}

/** Completed Analysis batch facts without retaining Case results. */
export interface FrozenAnalysisEngineSummary {
  /** Number of Cases selected by the explicit selector. */
  readonly selectedCount: number;
  /** Number of successful structured model outputs. */
  readonly succeededCount: number;
  /** Number of isolated Case errors. */
  readonly errorCount: number;
  /** Owner-neutral identity of the exact selected final Case facts. */
  readonly finalCaseResultSetHash: string;
}

/** Stable whole-stage Analysis failure codes. */
export type AnalysisEngineErrorCode =
  | "ANALYSIS_PRECONDITION_FAILED"
  | "ANALYSIS_STATE_CONFLICT"
  | "ANALYSIS_SOURCE_DRIFT"
  | "ANALYSIS_RESULT_SINK_FAILED"
  | "ANALYSIS_CANCELLED";

/** Sanitized whole-stage failure that does not expose Case or model content. */
export class AnalysisEngineError extends Error {
  /** Stable failure code. */
  readonly code: AnalysisEngineErrorCode;

  /** Build one safe whole-stage Analysis error. */
  constructor(code: AnalysisEngineErrorCode) {
    super(code);
    this.name = "AnalysisEngineError";
    this.code = code;
  }
}

// Return whether one Evaluation result is included by an explicit selector.
function isSelected(value: AnalysisCaseFacts, selector: AnalysisSelector): boolean {
  if (selector === "failed") return value.evaluation.status === "FAIL";
  if (selector === "errors") return value.evaluation.status === "EVALUATION_ERROR";
  return value.evaluation.status === "FAIL" || value.evaluation.status === "EVALUATION_ERROR";
}

// Map any model failure to a closed Case-level code without retaining provider details.
const SAFE_CASE_ERROR_CODES = new Set([
  "ANALYZER_CONFIG_INVALID",
  "ANALYZER_SECRET_MISSING",
  "ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED",
  "ANALYZER_PROVIDER_REQUEST_FAILED",
  "ANALYZER_INPUT_TOO_LARGE",
  "ANALYZER_OUTPUT_TOO_LARGE",
  "ANALYZER_OUTPUT_INVALID"
]);

// Collapse untrusted provider failures into the closed safe Application code family.
function caseErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as Readonly<Record<string, unknown>>).code;
    if (typeof code === "string" && SAFE_CASE_ERROR_CODES.has(code)) return code;
  }
  return "ANALYZER_PROVIDER_REQUEST_FAILED";
}

// Wait for one model call while allowing a non-cooperative late Promise to be ignored safely.
function abortableModelCall(
  operation: Promise<AnalysisResultDraft>,
  signal: AbortSignal
): Promise<AnalysisResultDraft> {
  operation.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new AnalysisEngineError("ANALYSIS_CANCELLED"));
  return new Promise((resolve, reject) => {
    const cancelled = (): void => reject(new AnalysisEngineError("ANALYSIS_CANCELLED"));
    signal.addEventListener("abort", cancelled, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
  });
}

// Re-read a mutable AbortSignal after asynchronous work without stale narrowing.
function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Read a failure holder that can be mutated by concurrently settling Case tasks.
function hasAnalysisFailure(value: { readonly error: AnalysisEngineError | null }): boolean {
  return value.error !== null;
}

// Preflight the complete selected dependency set before the first model side effect.
async function preflightSelectedCases(
  input: FrozenAnalysisEngineInput,
  signal: AbortSignal
): Promise<{ readonly count: number; readonly hash: string }> {
  const hasher = new OrderedAnalysisFinalCaseResultSetHasher();
  let count = 0;
  for await (const item of input.source.open()) {
    if (signal.aborted) throw new AnalysisEngineError("ANALYSIS_CANCELLED");
    if (!isSelected(item, input.selector)) continue;
    hasher.add({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      finalCaseResultHash: item.evaluation.finalCaseResultHash
    });
    count += 1;
  }
  return { count, hash: hasher.finish(input.selector) };
}

// Convert one successful model output into a complete semantic Case result.
function successfulResult(
  source: AnalysisCaseFacts,
  analysisInputHash: string,
  result: AnalysisResultDraft
): FrozenAnalysisCaseSuccess {
  const proposal = result.proposal ?? null;
  const analysisResultHash = hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: source.caseKey,
    finalCaseResultHash: source.evaluation.finalCaseResultHash,
    analysisInputHash,
    result: {
      status: "SUCCEEDED",
      classification: result.classification,
      confidence: result.confidence,
      evidence: result.evidence,
      explanation: result.explanation,
      recommendedAction: result.recommendedAction,
      proposal: proposal === null ? null : analysisProposalJson(proposal)
    }
  });
  return {
    caseKey: source.caseKey,
    ordinal: source.ordinal,
    finalCaseResultHash: source.evaluation.finalCaseResultHash,
    analysisInputHash,
    analysisResultHash,
    status: "SUCCEEDED",
    classification: result.classification,
    confidence: result.confidence,
    evidence: result.evidence,
    explanation: result.explanation,
    recommendedAction: result.recommendedAction,
    proposal
  };
}

// Convert one isolated model failure into a complete semantic Case error.
function failedResult(
  source: AnalysisCaseFacts,
  analysisInputHash: string,
  errorCode: string
): FrozenAnalysisCaseError {
  const analysisResultHash = hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: source.caseKey,
    finalCaseResultHash: source.evaluation.finalCaseResultHash,
    analysisInputHash,
    result: { status: "ERROR", errorCode }
  });
  return {
    caseKey: source.caseKey,
    ordinal: source.ordinal,
    finalCaseResultHash: source.evaluation.finalCaseResultHash,
    analysisInputHash,
    analysisResultHash,
    status: "ERROR",
    errorCode
  };
}

/** Bounded no-retry Analysis coordinator shared by platform and offline paths. */
export class FrozenAnalysisEngine {
  /** Provider-neutral direct Analyzer client. */
  readonly #modelClient: AnalysisModelClient;

  /** Create an Engine with an explicit official-SDK boundary. */
  public constructor(modelClient: AnalysisModelClient) {
    this.#modelClient = modelClient;
  }

  /** Analyze the selected Cases with per-Case isolation and whole-stage sink safety. */
  public async execute(input: FrozenAnalysisEngineInput): Promise<FrozenAnalysisEngineSummary> {
    const concurrency = input.analysisExecutionLimits.analysisConcurrency;
    if (
      input.binding.id.trim() === "" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8
    ) {
      throw new AnalysisEngineError("ANALYSIS_PRECONDITION_FAILED");
    }
    const internal = new AbortController();
    const signal = AbortSignal.any([input.signal, internal.signal]);
    const preflight = await preflightSelectedCases(input, signal);
    if (preflight.count === 0) {
      return {
        selectedCount: 0,
        succeededCount: 0,
        errorCount: 0,
        finalCaseResultSetHash: preflight.hash
      };
    }

    const secondPassHasher = new OrderedAnalysisFinalCaseResultSetHasher();
    const tasks = new Set<Promise<void>>();
    const failure: { error: AnalysisEngineError | null } = { error: null };
    let selectedCount = 0;
    let succeededCount = 0;
    let errorCount = 0;

    const runCase = async (source: AnalysisCaseFacts): Promise<void> => {
      const built = buildAnalysisInput({
        source,
        runContextHash: input.runContextHash,
        runContext: input.runContext,
        analysisPromptHash: input.prompt.promptHash,
        analyzerConfigHash: input.analyzer.configHash,
        analysisExecutionLimits: input.analysisExecutionLimits
      });
      if (input.onCaseStart !== undefined) {
        try {
          await input.onCaseStart({
            caseKey: source.caseKey,
            ordinal: source.ordinal,
            finalCaseResultHash: source.evaluation.finalCaseResultHash,
            analysisInputHash: built.analysisInputHash
          });
        } catch (error) {
          if (error instanceof AnalysisEngineError) throw error;
          throw new AnalysisEngineError("ANALYSIS_RESULT_SINK_FAILED");
        }
      }
      if (signal.aborted) throw new AnalysisEngineError("ANALYSIS_CANCELLED");
      let result: FrozenAnalysisCaseResult;
      try {
        const modelCall = this.#modelClient.analyze({
          analyzer: input.analyzer.definition,
          prompt: input.prompt.definition,
          variables: built.input.variables,
          signal
        });
        const output = await abortableModelCall(modelCall, signal);
        if (isSignalAborted(signal)) throw new AnalysisEngineError("ANALYSIS_CANCELLED");
        result = successfulResult(source, built.analysisInputHash, output);
      } catch (error) {
        if (
          isSignalAborted(signal) ||
          (error instanceof AnalysisEngineError && error.code === "ANALYSIS_CANCELLED")
        ) {
          throw new AnalysisEngineError("ANALYSIS_CANCELLED");
        }
        result = failedResult(source, built.analysisInputHash, caseErrorCode(error));
      }
      if (hasAnalysisFailure(failure) || isSignalAborted(signal)) return;
      try {
        await input.onResult(result);
      } catch {
        throw new AnalysisEngineError("ANALYSIS_RESULT_SINK_FAILED");
      }
      if (result.status === "SUCCEEDED") succeededCount += 1;
      else errorCount += 1;
    };

    for await (const item of input.source.open()) {
      if (isSignalAborted(signal) || hasAnalysisFailure(failure)) break;
      if (!isSelected(item, input.selector)) continue;
      secondPassHasher.add({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        finalCaseResultHash: item.evaluation.finalCaseResultHash
      });
      selectedCount += 1;
      while (
        tasks.size >= concurrency &&
        !hasAnalysisFailure(failure) &&
        !isSignalAborted(signal)
      ) {
        await Promise.race(tasks);
      }
      if (hasAnalysisFailure(failure) || isSignalAborted(signal)) break;
      const task = runCase(item).catch((error: unknown) => {
        if (failure.error === null) {
          failure.error =
            error instanceof AnalysisEngineError
              ? error
              : new AnalysisEngineError("ANALYSIS_RESULT_SINK_FAILED");
          internal.abort();
        }
      });
      tasks.add(task);
      void task.then(() => tasks.delete(task));
    }
    await Promise.all(tasks);

    if (input.signal.aborted) throw new AnalysisEngineError("ANALYSIS_CANCELLED");
    const fatal = failure.error;
    if (fatal !== null) throw fatal;
    const secondHash = secondPassHasher.finish(input.selector);
    if (selectedCount !== preflight.count || secondHash !== preflight.hash) {
      throw new AnalysisEngineError("ANALYSIS_SOURCE_DRIFT");
    }
    return {
      selectedCount,
      succeededCount,
      errorCount,
      finalCaseResultSetHash: preflight.hash
    };
  }
}
