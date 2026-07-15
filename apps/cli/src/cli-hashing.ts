import {
  workPackageCaseDefinitionHasher,
  workPackageEvalSemanticHashing,
  workPackageExecutionContextHasher,
  workPackageRestSemanticHashing
} from "@cortex-eval/work-package/src/work-package-domain-hashing.ts";

/** Production Execution context hashing Port shared by every CLI stage. */
export const cliExecutionContextHasher = workPackageExecutionContextHasher;

/** Production Case Definition hashing Port shared by REST and Evaluation. */
export const cliCaseDefinitionHasher = workPackageCaseDefinitionHasher;

/** Production REST semantic hashing Ports shared by command and Pipeline stages. */
export const cliRestSemanticHashing = workPackageRestSemanticHashing;

/** Production Eval and Final Case semantic hashing Ports. */
export const cliEvalSemanticHashing = workPackageEvalSemanticHashing;
