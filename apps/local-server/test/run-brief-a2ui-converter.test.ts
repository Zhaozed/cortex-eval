import { expect, it } from "vitest";
import {
  briefConvertibleResults,
  convertBriefA2ui,
  cortexRootFor
} from "../src/run-brief-a2ui-converter.ts";
import { livePreviewContext } from "../src/run-live-preview-context.ts";
import { RunLivePreviewService } from "../src/run-live-preview-service.ts";
import { captureResult } from "./run-auto-capture-fixture.ts";

const briefOutput = {
  brief_type: "daily",
  generation_status: "generated",
  presentation_status: "cards",
  llm_called: true,
  delivered: false,
  output: {
    text: "每日简报",
    cards: [{ card_type: "overview" }],
    public_results: [
      { brief_status: "READY", trusted_empty_state: false, cards: [{ card_type: "overview" }] }
    ]
  }
};

it("detects only brief replay output that actually carries card results", () => {
  expect(briefConvertibleResults(briefOutput)).toMatchObject({
    briefType: "daily",
    results: [briefOutput.output.public_results[0]]
  });
  expect(briefConvertibleResults({ ...briefOutput, presentation_status: "plain_text" })).toBeNull();
  expect(briefConvertibleResults({ ...briefOutput, brief_type: "weekly" })).toBeNull();
  expect(
    briefConvertibleResults({
      ...briefOutput,
      output: { ...briefOutput.output, public_results: [] }
    })
  ).toBeNull();
  expect(briefConvertibleResults({ a2ui: [] })).toBeNull();
});

it("derives the Cortex root from the A2UI static root when no explicit env is set", () => {
  const explicit = process.env.CORTEX_EVAL_CORTEX_ROOT;
  delete process.env.CORTEX_EVAL_CORTEX_ROOT;
  try {
    expect(cortexRootFor("/opt/cortex/web_ui/static")).toBe("/opt/cortex");
    expect(cortexRootFor("/opt/cortex/web_ui/static/")).toBe("/opt/cortex");
    expect(cortexRootFor("/opt/other/static")).toBeNull();
    expect(cortexRootFor(undefined)).toBeNull();
    process.env.CORTEX_EVAL_CORTEX_ROOT = "/explicit/cortex";
    expect(cortexRootFor("/opt/cortex/web_ui/static")).toBe("/explicit/cortex");
  } finally {
    if (explicit === undefined) delete process.env.CORTEX_EVAL_CORTEX_ROOT;
    else process.env.CORTEX_EVAL_CORTEX_ROOT = explicit;
  }
});

it("reports a localized error instead of blocking the case when no Cortex root is available", async () => {
  const explicit = process.env.CORTEX_EVAL_CORTEX_ROOT;
  delete process.env.CORTEX_EVAL_CORTEX_ROOT;
  try {
    const base = captureResult(false);
    const brief = {
      ...base,
      providerOutput: { ...base.providerOutput, parsedOutput: briefOutput }
    };
    const { preview, live } = await livePreviewContext(brief, new RunLivePreviewService(undefined));
    expect(preview.payloads).toEqual([]);
    expect(preview.error).toContain("CORTEX_EVAL_CORTEX_ROOT");
    expect(live.required).toBe(false);
  } finally {
    if (explicit === undefined) delete process.env.CORTEX_EVAL_CORTEX_ROOT;
    else process.env.CORTEX_EVAL_CORTEX_ROOT = explicit;
  }
});

it("leaves non-brief evidence untouched", async () => {
  const converted = await convertBriefA2ui({ a2ui: [] }, null);
  expect(converted).toBeNull();
});
