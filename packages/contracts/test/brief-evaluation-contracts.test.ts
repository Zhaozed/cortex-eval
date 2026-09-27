import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseDefinitionV1Schema, parseCaseDefinitionV1FromFixture } from "../src/case-contracts.ts";
import {
  BriefEvaluationProfileSchema,
  BriefRubricAnswersSchema,
  briefPointerExists,
  validateBriefInput
} from "../src/brief-evaluation-contracts.ts";

function fixture(): ReturnType<typeof CaseDefinitionV1Schema.parse> {
  return CaseDefinitionV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../test_suite/brief-content/daily.case.json", import.meta.url),
        "utf8"
      )
    )
  );
}
describe("Brief case contract", () => {
  it("validates examples and preserves typed profile through fixture conversion", () => {
    const caseDef = CaseDefinitionV1Schema.parse(fixture());
    const { contractVersion: _version, ...raw } = caseDef;
    void _version;
    expect(parseCaseDefinitionV1FromFixture(raw)).toEqual(caseDef);
  });
  it.each(["mismatch", "pointer", "duplicate", "leak", "range", "statuses", "empty"])(
    "rejects %s",
    (type) => {
      const value = fixture();
      const brief = value.semanticEvaluation?.brief;
      if (!brief?.checklist?.[0] || !brief.checklist[1]) throw new Error("fixture");
      if (type === "mismatch") brief.briefType = "meeting";
      if (type === "pointer") brief.checklist[0].sourceRefs = ["/material/absent"];
      if (type === "duplicate") brief.checklist[1].id = brief.checklist[0].id;
      if (type === "leak") value.vars.request_body.ground_truth = { secret: true };
      if (type === "range") Object.assign(brief.constraints, { minCards: 3, maxCards: 1 });
      if (type === "statuses") brief.constraints.allowedGenerationStatuses = [];
      if (type === "empty") brief.checklist = [];
      expect(CaseDefinitionV1Schema.safeParse(value).success).toBe(false);
    }
  );
  it("supports explicit JEV / LLM without changing legacy Cases and rejects unknown judges", () => {
    const value = fixture();
    const brief = value.semanticEvaluation?.brief;
    if (!brief) throw new Error("fixture");
    expect(brief.judge).toBeUndefined();
    for (const judge of ["JEV", "LLM"] as const) {
      brief.judge = judge;
      expect(CaseDefinitionV1Schema.parse(value).semanticEvaluation?.brief?.judge).toBe(judge);
    }
    Object.assign(brief, { judge: "AUTO" });
    expect(CaseDefinitionV1Schema.safeParse(value).success).toBe(false);
  });
  it("supports RFC6901 escaping and rejects prototype or absent sources", () => {
    expect(briefPointerExists({ "a/b": { "~x": null } }, "/a~1b/~0x")).toBe(true);
    expect(briefPointerExists({}, "/constructor")).toBe(false);
    const profile = fixture().semanticEvaluation?.brief;
    if (!profile?.checklist?.[0]) throw new Error("fixture");
    profile.checklist[0].sourceRefs = ["/bad~2ref"];
    expect(BriefEvaluationProfileSchema.safeParse(profile).success).toBe(false);
  });
  it("accepts a rubric-only profile and rejects a profile with neither checklist nor rubric", () => {
    const brief = fixture().semanticEvaluation?.brief;
    if (!brief?.checklist?.[0]) throw new Error("fixture");
    const { checklist: items, ...rest } = brief;
    const first = items[0];
    if (!first) throw new Error("fixture");
    const rubric = {
      dimensions: [
        { id: "accuracy", assertion: "事实准确", sourceRefs: first.sourceRefs },
        { id: "ordering", assertion: "顺序合理", sourceRefs: first.sourceRefs }
      ],
      minTotalScore: 3,
      failOnZeroDimension: true,
      hardFailRules: ["捏造事实"]
    };
    const parsed = BriefEvaluationProfileSchema.safeParse({ ...rest, rubric });
    expect(parsed.success).toBe(true);
    expect(BriefEvaluationProfileSchema.safeParse(rest).success).toBe(false);
    expect(
      BriefEvaluationProfileSchema.safeParse({
        ...rest,
        rubric: { ...rubric, dimensions: [rubric.dimensions[0], rubric.dimensions[0]] }
      }).success
    ).toBe(false);
  });
  it("validates rubric judge answers strictly", () => {
    const valid = {
      scores: [
        { questionId: "brief.rubric.accuracy", score: 2, reason: "完整准确", evidence: ["原文"] }
      ],
      hard_fail_reasons: []
    };
    expect(BriefRubricAnswersSchema.safeParse(valid).success).toBe(true);
    expect(
      BriefRubricAnswersSchema.safeParse({
        ...valid,
        scores: [{ ...valid.scores[0], score: 3 }]
      }).success
    ).toBe(false);
    expect(
      BriefRubricAnswersSchema.safeParse({
        ...valid,
        scores: [{ ...valid.scores[0], reason: " " }]
      }).success
    ).toBe(false);
    expect(BriefRubricAnswersSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
  it("rejects rubric source references missing from the bundle", () => {
    const value = fixture();
    const brief = value.semanticEvaluation?.brief;
    if (!brief?.checklist?.[0]) throw new Error("fixture");
    const profile = BriefEvaluationProfileSchema.parse({
      ...brief,
      checklist: undefined,
      rubric: {
        dimensions: [{ id: "accuracy", assertion: "事实准确", sourceRefs: ["/material/absent"] }],
        minTotalScore: 1,
        failOnZeroDimension: true,
        hardFailRules: ["捏造事实"]
      }
    });
    expect(validateBriefInput(profile, value.vars.request_body)).toBe("BRIEF_SOURCE_REF_MISSING");
  });
});
