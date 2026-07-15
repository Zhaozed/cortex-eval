import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashExecutionContext,
  hashFinalCaseResult,
  hashRestResult,
  OrderedEvalResultSetHasher,
  OrderedRestResultSetHasher
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { WorkPackageEvalSemanticHashing } from "./work-package-evaluation-retry-reader.ts";
import type { WorkPackageExecutionContextHasher } from "./work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "./work-package-input-reader.ts";
import type { WorkPackageRestSemanticHashing } from "./work-package-rest-retry-reader.ts";

/** Production Execution-context hashing shared by Local Server and CLI. */
export const workPackageExecutionContextHasher: WorkPackageExecutionContextHasher = {
  hash: (input): string => hashExecutionContext(input)
};

/** Production Case Definition hashing shared by every Work Package reader. */
export const workPackageCaseDefinitionHasher: WorkPackageCaseDefinitionHasher = {
  hash: (input): string =>
    hashCaseDefinition({
      contractVersion: input.contractVersion,
      caseKey: input.caseKey,
      definition: caseDefinitionJson(input.definition)
    })
};

/** Production REST semantic hashing shared by every Work Package reader. */
export const workPackageRestSemanticHashing: WorkPackageRestSemanticHashing = {
  hashResult: (value): string =>
    hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: value.caseKey,
      caseDefinitionHash: value.caseDefinitionHash,
      result:
        value.status === "SUCCEEDED"
          ? {
              status: value.status,
              httpStatus: value.httpStatus,
              providerOutput: value.providerOutput
            }
          : {
              status: value.status,
              httpStatus: value.httpStatus,
              errorType: value.errorType
            }
    }),
  createResultSetHasher: (): OrderedRestResultSetHasher => new OrderedRestResultSetHasher()
};

/** Production Evaluation and Final Case hashing shared by Work Package readers. */
export const workPackageEvalSemanticHashing: WorkPackageEvalSemanticHashing = {
  hashResult: (value): string =>
    hashEvalResult({
      contractVersion: "cortex.eval-result.v1",
      caseKey: value.caseKey,
      status: value.status,
      promptfooSuccess: value.promptfooSuccess,
      score: value.score,
      reason: value.reason,
      evaluationError: value.evaluationError,
      assertions: value.assertions,
      diffs: value.diffs,
      metrics: value.metrics
    }),
  hashFinalResult: (value): string =>
    hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      ...value
    }),
  createResultSetHasher: (expectedCaseKey): OrderedEvalResultSetHasher =>
    new OrderedEvalResultSetHasher(expectedCaseKey)
};
