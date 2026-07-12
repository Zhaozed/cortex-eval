import { sha256CanonicalJson, type DomainJsonObject } from "./domain-canonical-hash.ts";

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
