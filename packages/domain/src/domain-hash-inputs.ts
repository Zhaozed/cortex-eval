import { createHash, type Hash } from "node:crypto";

import {
  canonicalJson,
  sha256CanonicalJson,
  type DomainJsonObject
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
