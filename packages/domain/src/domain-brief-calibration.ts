import { canonicalJson, type DomainJsonObject } from "./domain-canonical-hash.ts";
import { caseDefinitionJson } from "./domain-case-projection.ts";
import type { CaseDefinition } from "./domain-evaluation.ts";

/** Only these Judge fields may differ while reusing saved Brief generation evidence. */
export function sameBriefGenerationCase(before: CaseDefinition, after: CaseDefinition): boolean {
  const projection = (value: CaseDefinition): DomainJsonObject | null => {
    const json = caseDefinitionJson(value);
    const semantic = value.semanticEvaluation;
    const brief = semantic?.brief;
    if (!semantic || !brief || typeof brief !== "object" || Array.isArray(brief)) return null;
    const scoring = { ...brief };
    delete scoring.rubric;
    delete scoring.judge;
    delete scoring.judgePrompt;
    const contract: DomainJsonObject = { ...semantic, brief: scoring };
    delete contract.evaluatorPrompt;
    return { ...json, semanticEvaluation: contract };
  };
  const left = projection(before),
    right = projection(after);
  return left !== null && right !== null && canonicalJson(left) === canonicalJson(right);
}
