import { importPromptfooResults } from "../src/features/evaluation/promptfoo-result-importer.ts";
import { expect, it } from "vitest";
import { materializeJavascriptSource } from "../src/features/evaluation/promptfoo-javascript-source.ts";

it("only normalizes explicit script returns, never callback returns or expressions", () => {
  for (const source of [
    "return true;",
    "const x=1; return x===1;",
    "if(output) return true; return false;"
  ])
    expect(materializeJavascriptSource("javascript", source)).toBe(`\n${source}`);
  for (const source of [
    "output === 'return'",
    "const x=1; x===1",
    "[1].some(x=>{return x===1})",
    "return (",
    "\nreturn true;"
  ])
    expect(materializeJavascriptSource("javascript", source)).toBe(source);
  expect(materializeJavascriptSource("python", "return True")).toBe("return True");
});

it("one interpreter error retains valid PASS/FAIL evidence and accepts exact materialized JS identity", () => {
  const definitions = [
    { type: "javascript", metric: "broken", weight: 1, value: "return (;" },
    { type: "javascript", metric: "passed", weight: 1, value: "const x=1; return x===1;" },
    { type: "equals", metric: "failed", weight: 1, value: "expected" }
  ];
  const components = definitions.map((assertion, index) => ({
    assertion: index === 1 ? { ...assertion, value: `\n${assertion.value}` } : assertion,
    pass: index === 1,
    score: index === 1 ? 1 : 0,
    reason:
      index === 0
        ? "Custom function threw error: Unexpected token\nStack Trace: private stack"
        : index === 1
          ? "valid evidence"
          : "business mismatch"
  }));
  const result = importPromptfooResults({
    promptfooVersion: "0.121.18",
    evaluationOwner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
    evaluationContextHash: "a".repeat(64),
    rubricPromptMaterializations: {},
    rawEvidence: {
      present: true,
      path: "runs/run-1/promptfoo-raw.json",
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 10
    },
    raw: {
      results: {
        version: 3,
        results: [
          {
            metadata: { case_id: "case-1" },
            response: { output: { answer: "actual" } },
            success: false,
            latencyMs: 12,
            cost: 0,
            score: 1 / 3,
            gradingResult: {
              pass: false,
              score: 1 / 3,
              reason: "failed",
              componentResults: components
            }
          }
        ]
      }
    },
    cases: [
      {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: "b".repeat(64),
        definition: {
          caseKey: "case-1",
          description: "test",
          threshold: 1,
          task: "router",
          requestBody: {},
          metadata: {
            requestId: "req",
            taskId: "task",
            businessModule: "module",
            scenarioTag: "scenario"
          },
          assertions: definitions
        },
        restResult: {
          status: "SUCCEEDED",
          resultHash: "c".repeat(64),
          providerOutput: { answer: "actual" }
        }
      }
    ]
  });
  expect(result.cases[0]).toMatchObject({
    status: "EVALUATION_ERROR",
    assertions: [
      { status: "ERROR", score: null },
      { status: "PASS", reason: "valid evidence" },
      { status: "FAIL", reason: "business mismatch" }
    ]
  });
  expect(JSON.stringify(result)).not.toContain("private stack");
});
