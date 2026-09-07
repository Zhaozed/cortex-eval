import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import { materializePromptfooConfigV1 } from "../src/promptfoo-config-materializer.ts";
import {
  PROMPTFOO_CAPABILITY_MATRIX_HASH,
  promptfooAssertionRuntimeDependency,
  promptfooEvaluatorAssertionTypes
} from "../src/promptfoo-capability-projection.ts";
import { requiredPromptfooAssertionRuntimes } from "../src/promptfoo-runtime-preflight.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const TOKEN = "secret-capability-must-not-be-written";

function frozenCase(
  caseKey: string,
  assertions: FrozenRunCase["definition"]["assertions"]
): FrozenRunCase {
  return {
    caseKey,
    ordinal: caseKey === "case-1" ? 0 : 1,
    definitionHash: HASH,
    definition: {
      caseKey,
      description: caseKey,
      threshold: 0.5,
      task: "planner",
      requestBody: { text: "hello" },
      metadata: {
        requestId: `request-${caseKey}`,
        taskId: `task-${caseKey}`,
        businessModule: "module",
        scenarioTag: "scenario"
      },
      assertions
    }
  };
}

describe("Promptfoo 受控配置物化", () => {
  it("Evaluator 依赖投影与唯一能力矩阵事实一致，但不充当类型白名单", async () => {
    const bytes = await readFile(resolve("tooling/facts/promptfoo-0.121.18-capabilities.json"));
    const facts = JSON.parse(bytes.toString("utf8")) as {
      readonly capabilities: readonly {
        readonly type: string;
        readonly dependencies: readonly string[];
      }[];
    };
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PROMPTFOO_CAPABILITY_MATRIX_HASH);
    expect(promptfooEvaluatorAssertionTypes()).toEqual(
      facts.capabilities
        .filter((item) => item.dependencies.includes("PROMPTFOO_EVALUATOR_PROVIDER"))
        .map((item) => item.type)
        .sort((left, right) => left.localeCompare(right))
    );
  });

  it("解释器依赖投影覆盖正反 Assertion 并递归读取 Assertion Set", () => {
    expect(promptfooAssertionRuntimeDependency("python")).toBe("PYTHON");
    expect(promptfooAssertionRuntimeDependency("not-python")).toBe("PYTHON");
    expect(promptfooAssertionRuntimeDependency("ruby")).toBe("RUBY");
    expect(promptfooAssertionRuntimeDependency("not-ruby")).toBe("RUBY");
    expect(promptfooAssertionRuntimeDependency("future-assertion")).toBeNull();
    expect(
      requiredPromptfooAssertionRuntimes([
        frozenCase("case-1", [
          {
            type: "assert-set",
            metric: "languages",
            weight: 1,
            assertions: [
              { type: "not-ruby", metric: "ruby", weight: 1, value: "output == ''" },
              { type: "python", metric: "python", weight: 1, value: "output != ''" }
            ]
          }
        ])
      ])
    ).toEqual(["PYTHON", "RUBY"]);
  });

  it("不按 Assertion 类型设白名单，并确定性派生 Evaluation 总调用预算", () => {
    const result = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [
        {
          testCase: frozenCase("case-1", [
            { type: "select-best", metric: "selection", weight: 1, value: "prefer exact" },
            { type: "max-score", metric: "max", weight: 1 },
            { type: "llm-rubric", metric: "quality", weight: 2, value: "be correct" },
            { type: "equals", metric: "exact", weight: 1, value: "actual" }
          ]),
          restResult: {
            status: "SUCCEEDED",
            providerOutput: {
              ok: true,
              taskName: "planner",
              resolvedConfig: {},
              parsedOutput: { reply_text: "actual" }
            }
          }
        },
        {
          testCase: frozenCase("case-2", [
            { type: "llm-rubric", metric: "skipped", weight: 1, value: "unused" }
          ]),
          restResult: { status: "ERROR" }
        }
      ],
      rubricPrompts: [],
      requiresEvaluator: (type) => type === "select-best" || type === "llm-rubric"
    });

    expect(result.evaluatorCallBudget).toBe(2);
    expect(result.config.providers).toEqual([{ id: "echo" }]);
    expect(result.config.tests).toHaveLength(1);
    expect(result.config.tests[0]?.providerOutput).toEqual({
      ok: true,
      task_name: "planner",
      resolved_config: {},
      parsed_output: { reply_text: "actual" }
    });
    expect(result.config.tests[0]?.assert.map((assertion) => assertion.type)).toEqual([
      "select-best",
      "max-score",
      "llm-rubric",
      "equals"
    ]);
    expect(JSON.stringify(result.config)).not.toContain(TOKEN);
    expect(JSON.stringify(result.config)).toContain("CORTEX_EVAL_BRIDGE_CAPABILITY");
  });

  it("递归统计 Assertion Set 叶子并把 prompt:// 引用物化为内联 JSON Prompt", () => {
    const result = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [
        {
          testCase: frozenCase("case-1", [
            {
              type: "assert-set",
              metric: "set",
              weight: 1,
              assertions: [
                {
                  type: "llm-rubric",
                  metric: "quality",
                  weight: 1,
                  value: "criterion",
                  rubricPrompt: "prompt://quality"
                }
              ]
            }
          ]),
          restResult: {
            status: "SUCCEEDED",
            providerOutput: { ok: false, errorMessage: "business failure" }
          }
        }
      ],
      rubricPrompts: [
        {
          promptKey: "quality",
          messages: [
            { role: "SYSTEM", content: "judge" },
            { role: "USER", content: "{{output}} {{rubric}}" }
          ]
        }
      ],
      requiresEvaluator: (type) => type === "llm-rubric"
    });

    const set = result.config.tests[0]?.assert[0];
    const materialized = set?.assert?.[0]?.rubricPrompt;
    expect(result.evaluatorCallBudget).toBe(1);
    expect(typeof materialized).toBe("string");
    expect(JSON.parse(materialized ?? "")).toEqual([
      { role: "system", content: "judge" },
      { role: "user", content: "{{output}} {{rubric}}" }
    ]);
    expect(result.rubricPromptMaterializations).toEqual({
      "prompt://quality": materialized
    });
  });

  it("即使绕过 Contracts，也拒绝 Assertion config 注入 Provider、Secret 或外部引用", () => {
    const build =
      (
        config: NonNullable<FrozenRunCase["definition"]["assertions"][number]["config"]>
      ): (() => unknown) =>
      () =>
        materializePromptfooConfigV1({
          binding: { kind: "RUN", runId: ID },
          evaluationContextHash: HASH,
          bridgeUrl: "http://127.0.0.1:43199/evaluate",
          bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          cases: [
            {
              testCase: frozenCase("case-1", [
                { type: "future-assertion", metric: "future", weight: 1, config }
              ]),
              restResult: {
                status: "SUCCEEDED",
                providerOutput: { ok: false, errorMessage: "actual" }
              }
            }
          ],
          rubricPrompts: [],
          requiresEvaluator: () => false
        });

    expect(build({ nested: { provider: "unsafe" } })).toThrow("PROMPTFOO_ASSERTION_CONFIG_UNSAFE");
    expect(build({ nested: { apiKey: "secret" } })).toThrow("PROMPTFOO_ASSERTION_CONFIG_UNSAFE");
    expect(build({ nested: { accessToken: "secret" } })).toThrow(
      "PROMPTFOO_ASSERTION_CONFIG_UNSAFE"
    );
    expect(build({ nested: { refresh_token: "secret" } })).toThrow(
      "PROMPTFOO_ASSERTION_CONFIG_UNSAFE"
    );
    expect(build({ nested: { dbPassword: "secret" } })).toThrow(
      "PROMPTFOO_ASSERTION_CONFIG_UNSAFE"
    );
    expect(build({ nested: { authToken: "secret" } })).toThrow("PROMPTFOO_ASSERTION_CONFIG_UNSAFE");
    for (const compactKey of [
      "providertoken",
      "authorizationtoken",
      "credentialsecret",
      "passwordtoken",
      "clientcredential",
      "apiaccesskey",
      "clienttokenvalue",
      "xapikeyvalue",
      "oauth",
      "module",
      "dependencies"
    ]) {
      expect(build({ nested: { [compactKey]: "secret" } })).toThrow(
        "PROMPTFOO_ASSERTION_CONFIG_UNSAFE"
      );
    }
    expect(build({ nested: { script: "file://outside.js" } })).toThrow(
      "PROMPTFOO_ASSERTION_CONFIG_UNSAFE"
    );

    expect(build({ nested: { maxTokens: 10, tokenizer: "builtin" } })).not.toThrow();

    expect(() =>
      materializePromptfooConfigV1({
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        bridgeUrl: "http://127.0.0.1:43199/evaluate",
        bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        cases: [
          {
            testCase: frozenCase("case-1", [
              {
                type: "future-assertion",
                metric: "future",
                weight: 1,
                transform: " Package:evil"
              }
            ]),
            restResult: {
              status: "SUCCEEDED",
              providerOutput: { ok: false, errorMessage: "actual" }
            }
          }
        ],
        rubricPrompts: [],
        requiresEvaluator: () => false
      })
    ).toThrow("PROMPTFOO_ASSERTION_REFERENCE_UNSAFE");
  });
});
