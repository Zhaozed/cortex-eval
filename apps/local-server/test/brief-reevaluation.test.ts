import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { CreatePlatformRerunRequestV1Schema } from "@cortex-eval/contracts/src/run-api-contracts.ts";
import { DEFAULT_BRIEF_JUDGE_PROMPT } from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { caseFromV1 } from "@cortex-eval/storage-sqlite/src/sqlite-platform-run-mappers.ts";
import { sameBriefGenerationCase } from "@cortex-eval/domain/src/domain-brief-calibration.ts";
import { freezeBriefReevaluation } from "../src/brief-reevaluation.ts";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture");
  return value;
}
function fixture(): FrozenRunCase {
  const input = CaseDefinitionV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../test_suite/brief-content/daily.realfree.case.json", import.meta.url),
        "utf8"
      )
    )
  );
  return {
    caseKey: input.metadata.case_id,
    ordinal: 0,
    definitionHash: "a".repeat(64),
    definition: caseFromV1(input)
  };
}

describe("Brief calibration boundary", () => {
  it.each(["daily", "meeting"])(
    "freezes the editable instruction and rubric for %s without changing generation",
    (type) => {
      const source = fixture();
      const bundle = source.definition.requestBody.bundle;
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
        throw new Error("fixture");
      bundle.brief_type = type;
      const semantic = required(source.definition.semanticEvaluation);
      const brief = semantic.brief as Record<string, unknown>;
      brief.briefType = type;
      const saved = structuredClone(source);
      const rubric = {
        dimensions: [
          { id: "grounded", assertion: "不得虚构日期", sourceRefs: ["/context/current_time"] }
        ],
        minTotalScore: 2,
        failOnZeroDimension: true,
        hardFailRules: ["编造日期"]
      };
      const result = freezeBriefReevaluation([source], {
        rubric,
        judgePrompt: "校准指令 v2",
        evaluatorPrompt: "重点审查时间"
      });
      expect(source).toEqual(saved);
      expect(result?.[0]?.definition.requestBody).toEqual(saved.definition.requestBody);
      expect(result?.[0]?.definition.semanticEvaluation).toMatchObject({
        evaluatorPrompt: "重点审查时间",
        brief: { rubric, judgePrompt: "校准指令 v2", judge: "LLM", briefType: type }
      });
      expect(result?.[0]?.definitionHash).not.toBe(source.definitionHash);
      expect(
        sameBriefGenerationCase(source.definition, required(required(result)[0]).definition)
      ).toBe(true);
      const tampered = structuredClone(required(required(result)[0]).definition);
      tampered.requestBody.timeout_seconds = 299;
      expect(sameBriefGenerationCase(source.definition, tampered)).toBe(false);
      const again = freezeBriefReevaluation(required(result), {});
      expect(again).toEqual(result);
    }
  );

  it("materializes the default prompt, can clear supplementary instructions, and rejects invalid references", () => {
    const source = fixture();
    required(source.definition.semanticEvaluation).evaluatorPrompt = "旧补充要求";
    const updated = freezeBriefReevaluation([source], { evaluatorPrompt: null });
    expect(updated?.[0]?.definition.semanticEvaluation?.evaluatorPrompt).toBeUndefined();
    expect(updated?.[0]?.definition.semanticEvaluation?.brief).toMatchObject({
      judgePrompt: DEFAULT_BRIEF_JUDGE_PROMPT
    });
    const rubric = {
      dimensions: [{ id: "one", assertion: "正确", sourceRefs: ["/missing"] }],
      minTotalScore: 2,
      hardFailRules: ["错误"]
    };
    expect(freezeBriefReevaluation([source], { rubric })).toBeNull();
    expect(
      freezeBriefReevaluation([source], {
        rubric: {
          ...rubric,
          dimensions: [{ ...required(rubric.dimensions[0]), sourceRefs: ["/context"] }],
          minTotalScore: 3
        }
      })
    ).toBeNull();
    expect(freezeBriefReevaluation([source], { judgePrompt: " " })).toBeNull();
  });

  it("supports all-case replay but rejects Judge changes on generation/retry and rejects input overrides", () => {
    expect(
      CreatePlatformRerunRequestV1Schema.safeParse({
        mode: "FORCE",
        reevaluateOnly: true,
        reevaluation: { judgePrompt: "v2" }
      }).success
    ).toBe(true);
    for (const value of [
      { mode: "FORCE", reevaluation: { judgePrompt: "v2" } },
      { mode: "RETRY_FAILED", reevaluateOnly: true },
      { mode: "FORCE", reevaluateOnly: true, reevaluation: { requestBody: {} } },
      { mode: "FORCE", reevaluateOnly: true, reevaluation: { rubric: {} } }
    ])
      expect(CreatePlatformRerunRequestV1Schema.safeParse(value).success).toBe(false);
  });
});
