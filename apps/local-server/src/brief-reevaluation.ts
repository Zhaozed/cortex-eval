import type { BriefReevaluationOptions } from "@cortex-eval/application/src/features/runs/brief-reevaluation-port.ts";
import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { BriefReevaluationOptionsSchema } from "@cortex-eval/contracts/src/run-api-contracts.ts";
import {
  DEFAULT_BRIEF_JUDGE_PROMPT,
  validateBriefInput
} from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { SemanticEvaluationContractV1Schema } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

/** Apply only scoring overrides, validate material references, and freeze the actual Judge instruction. */
export function freezeBriefReevaluation(
  cases: readonly FrozenRunCase[],
  options: BriefReevaluationOptions
): readonly FrozenRunCase[] | null {
  const parsed = BriefReevaluationOptionsSchema.safeParse(options);
  if (!parsed.success) return null;
  const result: FrozenRunCase[] = [];
  for (const item of cases) {
    const old = SemanticEvaluationContractV1Schema.safeParse(item.definition.semanticEvaluation);
    if (!old.success || !old.data.brief) return null;
    const brief = {
      ...old.data.brief,
      judge: "LLM" as const,
      ...(parsed.data.rubric ? { rubric: parsed.data.rubric } : {}),
      judgePrompt:
        parsed.data.judgePrompt ??
        old.data.brief.judgePrompt ??
        (old.data.brief.rubric || parsed.data.rubric
          ? DEFAULT_BRIEF_JUDGE_PROMPT
          : "你是严格的 Brief 事实核对员。仅依据提供的冻结材料与最终生成内容逐项回答。")
    };
    if (validateBriefInput(brief, item.definition.requestBody)) return null;
    if (brief.rubric && brief.rubric.minTotalScore > brief.rubric.dimensions.length * 2)
      return null;
    const semanticEvaluation = { ...old.data, brief };
    if (parsed.data.evaluatorPrompt === null) delete semanticEvaluation.evaluatorPrompt;
    else if (parsed.data.evaluatorPrompt !== undefined)
      semanticEvaluation.evaluatorPrompt = parsed.data.evaluatorPrompt;
    const definition = {
      ...item.definition,
      semanticEvaluation: JsonObjectSchema.parse(JSON.parse(JSON.stringify(semanticEvaluation)))
    };
    result.push({
      ...item,
      definition,
      definitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: item.caseKey,
        definition: caseDefinitionJson(definition)
      })
    });
  }
  return result;
}
