import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseDefinitionV1Schema, parseCaseDefinitionV1FromFixture } from "../src/case-contracts.ts";
import {
  BriefEvaluationProfileSchema,
  briefPointerExists
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
      if (!brief?.checklist[0] || !brief.checklist[1]) throw new Error("fixture");
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
  it("supports RFC6901 escaping and rejects prototype or absent sources", () => {
    expect(briefPointerExists({ "a/b": { "~x": null } }, "/a~1b/~0x")).toBe(true);
    expect(briefPointerExists({}, "/constructor")).toBe(false);
    const profile = fixture().semanticEvaluation?.brief;
    if (!profile?.checklist[0]) throw new Error("fixture");
    profile.checklist[0].sourceRefs = ["/bad~2ref"];
    expect(BriefEvaluationProfileSchema.safeParse(profile).success).toBe(false);
  });
});
