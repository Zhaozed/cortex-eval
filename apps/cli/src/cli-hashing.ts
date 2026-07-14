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
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import type { WorkPackageExecutionContextHasher } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

/** Production Execution context hashing Port shared by every CLI stage. */
export const cliExecutionContextHasher: WorkPackageExecutionContextHasher = {
  hash: (input): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

/** Production Case Definition hashing Port shared by REST and Evaluation. */
export const cliCaseDefinitionHasher: WorkPackageCaseDefinitionHasher = {
  hash: (input): string =>
    hashCaseDefinition({
      contractVersion: input.contractVersion,
      caseKey: input.caseKey,
      definition: caseDefinitionJson(input.definition)
    })
};

/** Production REST semantic hashing Ports shared by command and Pipeline stages. */
export const cliRestSemanticHashing: WorkPackageRestSemanticHashing = {
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

/** Production Eval and Final Case semantic hashing Ports. */
export const cliEvalSemanticHashing: WorkPackageEvalSemanticHashing = {
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
      caseDefinitionHash: value.caseDefinitionHash,
      restResultHash: value.restResultHash,
      evalResultHash: value.evalResultHash
    }),
  createResultSetHasher: (expectedCaseKey): OrderedEvalResultSetHasher =>
    new OrderedEvalResultSetHasher(expectedCaseKey)
};
