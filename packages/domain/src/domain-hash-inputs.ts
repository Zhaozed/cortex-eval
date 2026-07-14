import { createHash, type Hash } from "node:crypto";

import {
  canonicalJson,
  sha256CanonicalJson,
  type DomainJsonObject,
  type DomainJsonValue
} from "./domain-canonical-hash.ts";
import type { ProviderOutput } from "./domain-evaluation.ts";

/** Case Definition identity input. */
export interface CaseDefinitionHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.case-definition.v1";
  /** Stable Case key. */
  readonly caseKey: string;
  /** Complete normalized definition. */
  readonly definition: DomainJsonObject;
}

/** Assertion Definition identity input. */
export interface AssertionDefinitionHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.assertion-definition.v1";
  /** Complete normalized recursive Assertion definition. */
  readonly definition: DomainJsonObject;
}

/** Frozen Run identity input. */
export interface RunContextHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.run-context.v1";
  /** Frozen Suite hash. */
  readonly suiteHash: string;
  /** Frozen Endpoint config hash. */
  readonly endpointConfigHash: string;
  /** Frozen Evaluator config hash. */
  readonly evaluatorConfigHash: string;
  /** Frozen Rubric Prompt set hash. */
  readonly rubricPromptSetHash: string;
  /** Exact Promptfoo version. */
  readonly promptfooVersion: string;
  /** Frozen REST and Eval limits. */
  readonly runExecutionLimits: {
    /** REST maximum in-flight count. */
    readonly restConcurrency: number;
    /** Eval maximum in-flight count. */
    readonly evalConcurrency: number;
  };
}

/** Frozen offline Execution identity input. */
export interface ExecutionContextHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.execution-context.v1";
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Hash of the validated Manifest file. */
  readonly manifestHash: string;
  /** Frozen REST and Eval limits. */
  readonly runExecutionLimits: {
    /** REST maximum in-flight count. */
    readonly restConcurrency: number;
    /** Eval maximum in-flight count. */
    readonly evalConcurrency: number;
  };
  /** Frozen Analysis limit. */
  readonly analysisExecutionLimits: {
    /** Analysis maximum in-flight count. */
    readonly analysisConcurrency: number;
  };
}

/** Frozen identity of one platform or offline Evaluation execution. */
export interface EvaluationContextHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.evaluation-context.v1";
  /** Immutable execution-version owner. */
  readonly executionBinding: {
    /** Platform or offline execution discriminator. */
    readonly kind: "RUN" | "EXECUTION";
    /** Run ID or Execution ID. */
    readonly id: string;
  };
  /** Frozen platform Run context or imported equivalent. */
  readonly runContextHash: string;
  /** Complete REST result-set identity consumed by Evaluation. */
  readonly restResultSetHash: string;
  /** Frozen Evaluator configuration identity. */
  readonly evaluatorConfigHash: string;
  /** Exact Promptfoo package version. */
  readonly promptfooVersion: string;
  /** Controlled Promptfoo generation contract. */
  readonly configContractVersion: string;
  /** Exact Assertion capability-matrix identity. */
  readonly capabilityMatrixHash: string;
  /** Deterministically derived maximum Evaluator calls. */
  readonly evaluatorCallBudget: number;
}

/** Final per-Case result identity input. */
export interface FinalCaseResultHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.final-case-result.v1";
  /** Frozen Case Definition hash. */
  readonly caseDefinitionHash: string;
  /** Normalized REST result hash. */
  readonly restResultHash: string;
  /** Normalized Eval result hash. */
  readonly evalResultHash: string;
}

/** Normalized successful REST fact used by one Case result hash. */
export interface RestSuccessHashFact {
  /** REST outcome discriminator. */
  readonly status: "SUCCEEDED";
  /** Observed successful HTTP status. */
  readonly httpStatus: number;
  /** Strict business Provider Output. */
  readonly providerOutput: ProviderOutput;
}

/** Normalized failed REST fact used by one Case result hash. */
export interface RestFailureHashFact {
  /** REST outcome discriminator. */
  readonly status: "ERROR";
  /** HTTP status only for HTTP or response-content failures. */
  readonly httpStatus: number | null;
  /** Stable REST error classification. */
  readonly errorType:
    | "TIMEOUT"
    | "NETWORK"
    | "HTTP_STATUS"
    | "RESPONSE_PARSE"
    | "PROVIDER_OUTPUT_INVALID"
    | "TEMPLATE_INPUT"
    | "CANCELLED";
}

/** Complete semantic identity input for one normalized REST result. */
export interface RestResultHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.rest-result.v1";
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen Case Definition identity. */
  readonly caseDefinitionHash: string;
  /** Normalized REST outcome without timing metadata. */
  readonly result: RestSuccessHashFact | RestFailureHashFact;
}

/** One ordered Case identity inside a complete REST result set. */
export interface RestResultSetCaseHashInput {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Normalized single-Case REST result hash. */
  readonly resultHash: string;
}

/** Complete REST result-set identity input. */
export interface RestResultSetHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.rest-result-set.v1";
  /** Complete Cases, accepted in any input order and normalized by Ordinal. */
  readonly cases: readonly RestResultSetCaseHashInput[];
}

/** Stable normalized Assertion fact inside one Eval result identity. */
export interface EvalAssertionHashFact {
  /** Frozen zero-based Assertion index. */
  readonly index: number;
  /** Canonical Assertion definition hash. */
  readonly definitionHash: string;
  /** Promptfoo Assertion type. */
  readonly type: string;
  /** Stable Metric name. */
  readonly metric: string;
  /** Nonnegative aggregate weight. */
  readonly weight: number;
  /** Normalized Assertion status. */
  readonly status: "PASS" | "FAIL" | "ERROR" | "SKIPPED";
  /** Observed score when available. */
  readonly score: number | null;
  /** Stable reason when available. */
  readonly reason: string | null;
}

/** Stable JSON Schema explanation fact inside one Eval result identity. */
export interface EvalDiffHashFact {
  /** Owning Assertion index. */
  readonly assertionIndex: number;
  /** JSON Pointer into the actual value. */
  readonly instancePath: string;
  /** JSON Pointer into the frozen Schema. */
  readonly schemaPath: string;
  /** JSON Schema keyword. */
  readonly keyword: string;
  /** Expected keyword constraint. */
  readonly expectedConstraint: DomainJsonValue;
  /** Actual value at the failing path. */
  readonly actual: DomainJsonValue;
  /** Stable localized explanation. */
  readonly reason: string;
  /** Exact validator package version. */
  readonly validatorVersion: string;
  /** Frozen JSON Schema dialect. */
  readonly schemaDialect: string;
  /** Diff contract identity. */
  readonly diffContractVersion: "cortex.assertion-diff.v1";
}

/** Stable Case Metric result inside one Eval result identity. */
export interface EvalMetricHashFact {
  /** Stable Metric name. */
  readonly metric: string;
  /** Case-level Metric status. */
  readonly status: "PASS" | "FAIL" | "ERROR" | "SKIPPED" | "NOT_EVALUATED";
}

/** Complete normalized per-Case Eval identity input. */
export interface EvalResultHashInput {
  /** Hash contract identity. */
  readonly contractVersion: "cortex.eval-result.v1";
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Normalized Evaluation status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Exact Promptfoo aggregate success fact when evaluated. */
  readonly promptfooSuccess: boolean | null;
  /** Exact Promptfoo aggregate score when evaluated. */
  readonly score: number | null;
  /** Stable aggregate reason when present. */
  readonly reason: string | null;
  /** Structured system evaluation error when present. */
  readonly evaluationError: {
    readonly code: string;
  } | null;
  /** Ordered normalized Assertion facts. */
  readonly assertions: readonly EvalAssertionHashFact[];
  /** Ordered stable Schema explanation facts. */
  readonly diffs: readonly EvalDiffHashFact[];
  /** Stable Case Metric facts. */
  readonly metrics: readonly EvalMetricHashFact[];
}

/** One ordered Case identity inside a complete Eval result set. */
export interface EvalResultSetCaseHashInput {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Normalized single-Case Eval result hash. */
  readonly evalResultHash: string;
}

/** Complete Eval result-set identity input. */
export interface EvalResultSetHashInput {
  /** Hash contract identity. */
  readonly contractVersion: "cortex.eval-result-set.v1";
  /** Immutable platform Run or offline Execution version identity. */
  readonly owner:
    | { readonly kind: "RUN"; readonly id: string }
    | { readonly kind: "EXECUTION"; readonly id: string };
  /** Frozen Evaluation generation, matrix and Evaluator context. */
  readonly evaluationContextHash: string;
  /** Complete Cases, normalized by frozen Ordinal. */
  readonly cases: readonly EvalResultSetCaseHashInput[];
}

/** Complete Analysis identity input. */
export interface AnalysisInputHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.analysis-input.v1";
  /** Bound final Case result. */
  readonly finalCaseResultHash: string;
  /** Bound frozen Run context. */
  readonly runContextHash: string;
  /** Diff interpretation version. */
  readonly diffContractVersion: string;
  /** Complete unrendered structured variables. */
  readonly variables: DomainJsonObject;
  /** Frozen Analysis Prompt hash. */
  readonly analysisPromptHash: string;
  /** Frozen Analyzer config hash. */
  readonly analyzerConfigHash: string;
  /** Required model output version. */
  readonly analysisOutputContractVersion: string;
  /** Frozen Analysis limit. */
  readonly analysisExecutionLimits: {
    /** Analysis maximum in-flight count. */
    readonly analysisConcurrency: number;
  };
}

/** Hash a complete Case Definition identity. */
export function hashCaseDefinition(input: CaseDefinitionHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    caseKey: input.caseKey,
    definition: input.definition
  });
}

/** Hash one normalized recursive Assertion definition. */
export function hashAssertionDefinition(input: AssertionDefinitionHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    definition: input.definition
  });
}

/** Hash a complete frozen Run context, including execution limits. */
export function hashRunContext(input: RunContextHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    suiteHash: input.suiteHash,
    endpointConfigHash: input.endpointConfigHash,
    evaluatorConfigHash: input.evaluatorConfigHash,
    rubricPromptSetHash: input.rubricPromptSetHash,
    promptfooVersion: input.promptfooVersion,
    runExecutionLimits: { ...input.runExecutionLimits }
  });
}

/** Hash a complete offline Execution context, including both limit families. */
export function hashExecutionContext(input: ExecutionContextHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    packageId: input.packageId,
    manifestHash: input.manifestHash,
    runExecutionLimits: { ...input.runExecutionLimits },
    analysisExecutionLimits: { ...input.analysisExecutionLimits }
  });
}

/** Hash one immutable Evaluation version context without creating Attempt history. */
export function hashEvaluationContext(input: EvaluationContextHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    executionBinding: { ...input.executionBinding },
    runContextHash: input.runContextHash,
    restResultSetHash: input.restResultSetHash,
    evaluatorConfigHash: input.evaluatorConfigHash,
    promptfooVersion: input.promptfooVersion,
    configContractVersion: input.configContractVersion,
    capabilityMatrixHash: input.capabilityMatrixHash,
    evaluatorCallBudget: input.evaluatorCallBudget
  });
}

/** Hash the immutable REST and Eval identity for one Case. */
export function hashFinalCaseResult(input: FinalCaseResultHashInput): string {
  return sha256CanonicalJson({ ...input });
}

// Convert the closed Provider Output union to canonical transport-neutral field names.
function providerOutputHashFact(value: ProviderOutput): DomainJsonObject {
  if (!value.ok) return { ok: false, errorMessage: value.errorMessage };
  return {
    ok: true,
    taskName: value.taskName,
    resolvedConfig: value.resolvedConfig,
    parsedOutput: value.parsedOutput
  };
}

/** Hash one normalized REST result while excluding timing and provenance metadata. */
export function hashRestResult(input: RestResultHashInput): string {
  const result =
    input.result.status === "SUCCEEDED"
      ? {
          status: input.result.status,
          httpStatus: input.result.httpStatus,
          providerOutput: providerOutputHashFact(input.result.providerOutput)
        }
      : {
          status: input.result.status,
          httpStatus: input.result.httpStatus,
          errorType: input.result.errorType
        };
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    caseKey: input.caseKey,
    caseDefinitionHash: input.caseDefinitionHash,
    result
  });
}

/** Hash one complete aligned REST result set in frozen Case order. */
export function hashRestResultSet(input: RestResultSetHashInput): string {
  const cases = [...input.cases].sort(
    (left, right) => left.ordinal - right.ordinal || left.caseKey.localeCompare(right.caseKey)
  );
  const keys = new Set<string>();
  const aligned =
    cases.length > 0 &&
    cases.every((item, index) => {
      const valid =
        item.ordinal === index &&
        item.caseKey.trim() !== "" &&
        /^[0-9a-f]{64}$/.test(item.resultHash) &&
        !keys.has(item.caseKey);
      keys.add(item.caseKey);
      return valid;
    });
  if (!aligned) throw new Error("REST_RESULT_SET_ALIGNMENT");
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    cases: cases.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      resultHash: item.resultHash
    }))
  });
}

/** Hash all stable normalized Evaluation facts for one Case. */
export function hashEvalResult(input: EvalResultHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    caseKey: input.caseKey,
    status: input.status,
    promptfooSuccess: input.promptfooSuccess,
    score: input.score,
    reason: input.reason,
    evaluationError: input.evaluationError === null ? null : { ...input.evaluationError },
    assertions: input.assertions.map((item) => ({ ...item })),
    diffs: input.diffs.map((item) => ({ ...item })),
    metrics: input.metrics.map((item) => ({ ...item }))
  });
}

/** Hash one complete aligned Eval result set in frozen Case order. */
export function hashEvalResultSet(input: EvalResultSetHashInput): string {
  const cases = [...input.cases].sort(
    (left, right) => left.ordinal - right.ordinal || left.caseKey.localeCompare(right.caseKey)
  );
  const keys = new Set<string>();
  const aligned =
    cases.length > 0 &&
    cases.every((item, index) => {
      const valid =
        item.ordinal === index &&
        item.caseKey.trim() !== "" &&
        /^[0-9a-f]{64}$/.test(item.evalResultHash) &&
        !keys.has(item.caseKey);
      keys.add(item.caseKey);
      return valid;
    });
  const ownerIsValid = input.owner.id.trim() !== "";
  const contextIsValid = /^[0-9a-f]{64}$/.test(input.evaluationContextHash);
  if (!aligned || !ownerIsValid || !contextIsValid) {
    throw new Error("EVAL_RESULT_SET_ALIGNMENT");
  }
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    owner: { ...input.owner },
    evaluationContextHash: input.evaluationContextHash,
    cases: cases.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      evalResultHash: item.evalResultHash
    }))
  });
}

/** Incremental semantic hasher for an already ordered complete Eval result set. */
export class OrderedEvalResultSetHasher {
  /** Incremental SHA-256 state over the exact canonical result-set JSON. */
  readonly #hash: Hash;
  /** Frozen Manifest identity resolver owned by the caller. */
  readonly #expectedCaseKey: (ordinal: number) => string | null;
  /** Next required zero-based Ordinal. */
  #nextOrdinal = 0;
  /** Whether the digest has already been finalized. */
  #finished = false;

  /** Start one canonical result-set object before its trailing owner facts are known. */
  public constructor(expectedCaseKey: (ordinal: number) => string | null) {
    this.#hash = createHash("sha256");
    this.#expectedCaseKey = expectedCaseKey;
    this.#hash.update('{"cases":[', "utf8");
  }

  /** Add one validated identity in exact frozen order. */
  public add(value: EvalResultSetCaseHashInput): void {
    if (
      this.#finished ||
      value.ordinal !== this.#nextOrdinal ||
      value.caseKey.trim() === "" ||
      !/^[0-9a-f]{64}$/.test(value.evalResultHash) ||
      this.#expectedCaseKey(value.ordinal) !== value.caseKey
    ) {
      throw new Error("EVAL_RESULT_SET_ALIGNMENT");
    }
    if (this.#nextOrdinal > 0) this.#hash.update(",", "utf8");
    this.#hash.update(
      canonicalJson({
        caseKey: value.caseKey,
        ordinal: value.ordinal,
        evalResultHash: value.evalResultHash
      }),
      "utf8"
    );
    this.#nextOrdinal += 1;
  }

  /** Finalize one nonempty aligned result set exactly once. */
  public finish(owner: EvalResultSetHashInput["owner"], evaluationContextHash: string): string {
    if (
      this.#finished ||
      this.#nextOrdinal === 0 ||
      this.#expectedCaseKey(this.#nextOrdinal) !== null ||
      owner.id.trim() === "" ||
      !/^[0-9a-f]{64}$/.test(evaluationContextHash)
    ) {
      throw new Error("EVAL_RESULT_SET_ALIGNMENT");
    }
    this.#finished = true;
    this.#hash.update(
      `],"contractVersion":"cortex.eval-result-set.v1",` +
        `"evaluationContextHash":${JSON.stringify(evaluationContextHash)},` +
        `"owner":${canonicalJson(owner)}}`,
      "utf8"
    );
    return this.#hash.digest("hex");
  }
}

/** Incremental semantic hasher for an already ordered complete REST result set. */
export class OrderedRestResultSetHasher {
  /** Incremental SHA-256 state over the exact canonical result-set JSON. */
  readonly #hash: Hash;
  /** Seen Case keys for uniqueness validation. */
  readonly #caseKeys = new Set<string>();
  /** Next required zero-based Ordinal. */
  #nextOrdinal = 0;
  /** Whether the digest has already been finalized. */
  #finished = false;

  /** Start one canonical result-set object. */
  public constructor() {
    this.#hash = createHash("sha256");
    this.#hash.update('{"cases":[', "utf8");
  }

  /** Add one validated identity in exact frozen order. */
  public add(value: RestResultSetCaseHashInput): void {
    if (
      this.#finished ||
      value.ordinal !== this.#nextOrdinal ||
      value.caseKey.trim() === "" ||
      !/^[0-9a-f]{64}$/.test(value.resultHash) ||
      this.#caseKeys.has(value.caseKey)
    ) {
      throw new Error("REST_RESULT_SET_ALIGNMENT");
    }
    if (this.#nextOrdinal > 0) this.#hash.update(",", "utf8");
    this.#hash.update(
      canonicalJson({
        caseKey: value.caseKey,
        ordinal: value.ordinal,
        resultHash: value.resultHash
      }),
      "utf8"
    );
    this.#caseKeys.add(value.caseKey);
    this.#nextOrdinal += 1;
  }

  /** Finalize one nonempty aligned result set exactly once. */
  public finish(): string {
    if (this.#finished || this.#nextOrdinal === 0) {
      throw new Error("REST_RESULT_SET_ALIGNMENT");
    }
    this.#finished = true;
    this.#hash.update('],"contractVersion":"cortex.rest-result-set.v1"}', "utf8");
    return this.#hash.digest("hex");
  }
}

/** Hash the complete Analysis identity, including its independent limit. */
export function hashAnalysisInput(input: AnalysisInputHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    finalCaseResultHash: input.finalCaseResultHash,
    runContextHash: input.runContextHash,
    diffContractVersion: input.diffContractVersion,
    variables: input.variables,
    analysisPromptHash: input.analysisPromptHash,
    analyzerConfigHash: input.analyzerConfigHash,
    analysisOutputContractVersion: input.analysisOutputContractVersion,
    analysisExecutionLimits: { ...input.analysisExecutionLimits }
  });
}
