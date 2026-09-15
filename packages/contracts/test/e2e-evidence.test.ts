import { expect, it } from "vitest";
import { displayEvidence, outboundEvidenceIncomplete } from "../src/e2e-evidence.ts";
import { ProviderOutputV1Schema } from "../src/provider-contracts.ts";
it("accepts failed execution evidence without changing ok or allowing unknown envelope fields", () => {
  const value = {
    ok: false,
    err_msg: "EVAL_E2E_TIMEOUT",
    parsed_output: { timeline: [{ step_idx: 1 }] }
  };
  expect(ProviderOutputV1Schema.parse(value)).toEqual(value);
  expect(ProviderOutputV1Schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
  expect(ProviderOutputV1Schema.safeParse({ ...value, parsed_output: [] }).success).toBe(false);
});
it("uses each turn once, preserves request boundaries and does not alter the source", () => {
  const value = {
    timeline: [{ step_idx: 99 }],
    turns: [
      { req_id: "r1", parsed_output: { timeline: [{ step_idx: 3 }], llm_calls: [{ call_id: 1 }] } },
      { req_id: "r2", parsed_output: { timeline: [{ step_idx: 1 }], llm_calls: [{ call_id: 1 }] } }
    ]
  };
  expect(displayEvidence(value).timeline).toEqual([
    { step_idx: 3, req_id: "r1", _eval_turn_index: 0 },
    { step_idx: 1, req_id: "r2", _eval_turn_index: 1 }
  ]);
  expect(displayEvidence(value).llm_calls).toHaveLength(2);
  expect(value.timeline).toEqual([{ step_idx: 99 }]);
});
it("does not confuse an ended empty stream with a failed/partial capture", () => {
  expect(outboundEvidenceIncomplete({ a2ui: [] })).toBe(false); // legacy unknown, not reclassified
  expect(outboundEvidenceIncomplete({ outbound_capture: { status: "COLLECTED" } })).toBe(false);
  expect(
    outboundEvidenceIncomplete({
      turns: [{ parsed_output: { outbound_capture: { status: "PARTIAL" } } }]
    })
  ).toBe(true);
  expect(outboundEvidenceIncomplete({ conversation_execution: { complete: false } })).toBe(true);
});
