import type { AssertionDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { compileCaseFieldRule } from "@cortex-eval/contracts/src/assertion-rules/field-rules.ts";
export {
  compileCaseFieldRule,
  readCaseFieldRule,
  type CaseFieldRule
} from "@cortex-eval/contracts/src/assertion-rules/field-rules.ts";

/** A new check needs an explicit target; never seed a meaningless equals:true assertion. */
export function newCaseAssertion(): AssertionDefinitionV1 {
  return {
    type: "javascript",
    metric: "字段检查",
    weight: 1,
    value: compileCaseFieldRule({ operation: "exists", path: "", expected: null })
  };
}
