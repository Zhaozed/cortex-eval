// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useForm } from "react-hook-form";
import type { ReactElement } from "react";
import { JevEvaluationResultV1Schema } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { BriefEndpointPreset } from "../src/features/configurations/brief-endpoint-preset.tsx";
import type { EndpointFormValues } from "../src/features/configurations/configuration-form-mappers.ts";
import { summarizeBriefRows } from "../src/features/runs/run-brief-summary.tsx";
import { newBriefContract } from "../src/features/test-suites/brief-case-fields.tsx";
import { evidenceRow } from "./run-case-drawer-fixture.ts";

function PresetHarness(): ReactElement {
  const form = useForm<EndpointFormValues>({
    defaultValues: {
      name: "existing",
      urlTemplate: "https://cortex.example.test/eval/e2e/brief/replay",
      headers: [{ name: "Authorization", kind: "ENV_SECRET", value: "CORTEX_TOKEN" }],
      bodySelector: "",
      timeoutMs: 1000,
      defaultConcurrency: 4
    }
  });
  return (
    <>
      <BriefEndpointPreset form={form} />
      <output aria-label="配置值">{JSON.stringify(form.watch())}</output>
    </>
  );
}
describe("Brief preset and aggregate", () => {
  it("changes transport defaults without overriding host or auth", () => {
    render(<PresetHarness />);
    const before = screen.getByLabelText("配置值").textContent;
    fireEvent.click(screen.getByRole("button", { name: "使用 Brief replay 参数预设" }));
    const after = screen.getByLabelText("配置值").textContent;
    expect(after).toContain('"bodySelector":"/request_body"');
    expect(after).toContain('"timeoutMs":150000');
    expect(after).toContain('"defaultConcurrency":2');
    expect(before).toContain('"value":"CORTEX_TOKEN"');
    expect(after).toContain('"value":"CORTEX_TOKEN"');
    expect(after).toContain("https://cortex.example.test/eval/e2e/brief/replay");
  });
  it("separates daily/meeting and excludes judge errors from content denominators", () => {
    const base = evidenceRow({});
    if (!base.definition || !base.evaluation) throw new Error("fixture");
    const daily = {
      ...base,
      definition: { ...base.definition, semanticEvaluation: newBriefContract("daily") },
      evaluation: {
        ...base.evaluation,
        semanticEvaluation: {
          provider: "fake",
          model: "test",
          planVersion: "cortex.brief-atomic-plan.v1",
          result: JevEvaluationResultV1Schema.parse({
            contractVersion: "cortex.semantic-evaluation-contract.v1",
            passed: false,
            score: 0,
            decisions: [
              { questionId: "brief.P0.a", kind: "BOOLEAN", value: true },
              { questionId: "brief.P0.b", kind: "BOOLEAN", value: false },
              { questionId: "brief.metric.noise", kind: "SCORE", value: 0.5 },
              { questionId: "brief.grounded", kind: "BOOLEAN", value: false },
              { questionId: "brief.structure", kind: "BOOLEAN", value: false }
            ]
          })
        }
      }
    };
    const error = {
      ...base,
      definition: daily.definition,
      evaluation: {
        ...base.evaluation,
        status: "EVALUATION_ERROR" as const,
        score: null,
        promptfooSuccess: null,
        evaluationError: { code: "BRIEF_JUDGE_EVIDENCE_MISSING" }
      }
    };
    const meeting = {
      ...base,
      definition: { ...base.definition, semanticEvaluation: newBriefContract("meeting") },
      evaluation: undefined
    };
    expect(summarizeBriefRows([daily, error, meeting])).toEqual([
      {
        type: "daily",
        total: 2,
        judged: 1,
        errors: 1,
        p0: "1/2",
        p1: "—",
        noise: "50.0%",
        hallucinations: 1,
        structureFailures: 1
      },
      {
        type: "meeting",
        total: 1,
        judged: 0,
        errors: 0,
        p0: "—",
        p1: "—",
        noise: "—",
        hallucinations: 0,
        structureFailures: 0
      }
    ]);
  });
});
