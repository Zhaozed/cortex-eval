import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GRADING_EVIDENCE_TRANSFORM } from "@cortex-eval/application/src/features/evaluation/promptfoo-grading-evidence.ts";
import { importPromptfooResults } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import { startEvaluatorBridgeV2 } from "../src/evaluator-bridge-v2.ts";
import {
  materializePromptfooTest,
  materializePromptfooConfigV1
} from "../src/promptfoo-config-materializer.ts";
import { runPromptfooEvaluationProcess } from "../src/promptfoo-evaluation-process.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const TOKEN = "A".repeat(43);
const parsedOutput = {
  llm_calls: [{ system_prompt: "INTERNAL_TRACE_SENTINEL" }],
  reply_text: "BUSINESS_REPLY_SENTINEL",
  tool_executions: [{ task_id: "real-id", status: "failed" }],
  turns: [{ parsed_output: { llm_calls: ["TURN_TRACE_SENTINEL"], reply_text: "TURN_REPLY" } }]
};
const testCase: FrozenRunCase = {
  caseKey: "case-1",
  ordinal: 0,
  definitionHash: HASH,
  definition: {
    caseKey: "case-1",
    description: "compact grading",
    threshold: 1,
    task: "e2e",
    requestBody: { input: "create a task" },
    metadata: { requestId: "r", taskId: "t", businessModule: "todo", scenarioTag: "e2e" },
    assertions: [
      {
        type: "javascript",
        metric: "raw",
        weight: 1,
        value:
          "(typeof output === 'string' ? JSON.parse(output) : output).parsed_output.llm_calls[0].system_prompt === 'INTERNAL_TRACE_SENTINEL'"
      },
      { type: "llm-rubric", metric: "business", weight: 1, value: "check task result" }
    ]
  }
};
const restResult = {
  status: "SUCCEEDED" as const,
  providerOutput: { ok: true as const, taskName: "e2e", resolvedConfig: {}, parsedOutput }
};

function importInput(row: unknown): Parameters<typeof importPromptfooResults>[0] {
  return {
    promptfooVersion: "0.121.18",
    evaluationOwner: { kind: "RUN", id: ID },
    evaluationContextHash: HASH,
    raw: { results: { version: 3, results: [row] } },
    cases: [
      {
        caseKey: testCase.caseKey,
        ordinal: 0,
        caseDefinitionHash: HASH,
        definition: testCase.definition,
        restResult: {
          status: "SUCCEEDED",
          resultHash: HASH,
          providerOutput: {
            ok: true,
            task_name: "e2e",
            resolved_config: {},
            parsed_output: parsedOutput
          }
        }
      }
    ],
    rawEvidence: {
      present: true,
      path: "runs/test/promptfoo-raw.json",
      expectedSha256: HASH,
      expectedSizeBytes: 10
    },
    rubricPromptMaterializations: {}
  };
}

describe("裁判精简输入与真实 Promptfoo/导入链路", () => {
  it("嵌套正反 rubric 默认裁剪；显式 transform 与普通断言不变；流式生成同样生效", () => {
    const nested: FrozenRunCase = {
      ...testCase,
      definition: {
        ...testCase.definition,
        assertions: [
          {
            type: "assert-set",
            metric: "set",
            weight: 1,
            assertions: [
              { type: "not-llm-rubric", metric: "negative", weight: 1, value: "wrong" },
              {
                type: "llm-rubric",
                metric: "specialist",
                weight: 1,
                value: "inspect calls",
                transform: "output"
              }
            ]
          },
          ...testCase.definition.assertions.slice(0, 1)
        ]
      }
    };
    const result = materializePromptfooTest({ testCase: nested, restResult }, {});
    expect(result?.assert[0]?.assert?.[0]?.transform).toBe(GRADING_EVIDENCE_TRANSFORM);
    expect(result?.assert[0]?.assert?.[1]?.transform).toBe("output");
    expect(result?.assert[1]?.transform).toBeUndefined();
    expect(result?.providerOutput.parsed_output).toEqual(parsedOutput);
  });

  it("真实子进程中仅裁判收到精简输入，规则及原始结果保留全文，导入严格识别变换", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-grading-evidence-"));
    const prompts: string[] = [];
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: createHash("sha256").update(TOKEN).digest("hex"),
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 1000,
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      createCallId: () => ID,
      evaluator: {
        generate: ({ prompt }) => {
          prompts.push(prompt);
          return Promise.resolve({
            text: JSON.stringify({ pass: true, score: 1, reason: "fixture" }),
            structured: null,
            tokenUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
          });
        }
      }
    });
    try {
      const generated = materializePromptfooConfigV1({
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        bridgeUrl: bridge.url,
        bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        cases: [{ testCase, restResult }],
        rubricPrompts: [],
        requiresEvaluator: (type) => type === "llm-rubric"
      });
      const result = await runPromptfooEvaluationProcess({
        promptfooBinary: resolve("node_modules/.bin/promptfoo"),
        config: generated.config,
        capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        rawCapability: TOKEN,
        temporaryContainmentRoot: root,
        temporaryParent: join(root, "temporary"),
        timeoutMs: 15000,
        signal: new AbortController().signal
      });
      try {
        const rows: unknown[] = [];
        for await (const row of result.raw.openRows()) rows.push(row);
        expect(result.exitCode, JSON.stringify(rows)).toBe(0);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toContain("INTERNAL_TRACE_SENTINEL");
        expect(prompts[0]).not.toContain("TURN_TRACE_SENTINEL");
        expect(prompts[0]).toContain("BUSINESS_REPLY_SENTINEL");
        expect(prompts[0]).toContain("real-id");
        expect(prompts[0]).toContain("failed");
        expect(prompts[0]).toContain("TURN_REPLY");
        const imported = importPromptfooResults(importInput(rows[0]));
        expect(imported.cases[0]?.status).toBe("PASS");
        expect(imported.cases[0]?.tokenUsage?.totalTokens).toBe(18);
        const row = rows[0] as {
          response: { output: unknown };
          gradingResult: { componentResults: { assertion: { transform?: string } }[] };
        };
        expect(JSON.stringify(row.response.output)).toContain("INTERNAL_TRACE_SENTINEL");
        const rubric = row.gradingResult.componentResults[1]?.assertion;
        if (rubric === undefined) throw new Error("Missing rubric result");
        expect(rubric.transform).toBe(GRADING_EVIDENCE_TRANSFORM);
        rubric.transform = "return 'tampered';";
        expect(() => importPromptfooResults(importInput(row))).toThrow(
          "PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT"
        );
        delete rubric.transform;
        // Historical unprojected artifacts still import against their original frozen assertions.
        expect(importPromptfooResults(importInput(row)).cases[0]?.status).toBe("PASS");
      } finally {
        await result.raw.dispose();
      }
    } finally {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
