import { describe, expect, it } from "vitest";

import { explainJsonSchemaResult } from "../src/json-schema-diff.ts";

describe("JSON Schema 2020-12 解释性 Diff", () => {
  it("保留 Const、Contains、Required 与 AllOf 的真实失败路径和约束", () => {
    const result = explainJsonSchemaResult({
      assertionIndex: 2,
      promptfooPassed: false,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["kind", "items"],
        allOf: [{ properties: { kind: { const: "answer" } } }],
        properties: {
          kind: { type: "string" },
          items: { type: "array", contains: { const: 42 } }
        }
      },
      actual: { kind: "other", items: [1, 2] }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diffs.map((item) => item.keyword)).toEqual([
      "const",
      "const",
      "const",
      "contains"
    ]);
    expect(result.diffs[0]).toMatchObject({
      assertionIndex: 2,
      instancePath: "/kind",
      schemaPath: "#/allOf/0/properties/kind/const",
      expectedConstraint: "answer",
      actual: "other",
      validatorVersion: "8.20.0",
      schemaDialect: "https://json-schema.org/draft/2020-12/schema",
      diffContractVersion: "cortex.assertion-diff.v1"
    });
  });

  it("Required 缺失使用显式 Missing 事实而不是 undefined", () => {
    const result = explainJsonSchemaResult({
      assertionIndex: 0,
      promptfooPassed: false,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["answer"]
      },
      actual: {}
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      instancePath: "/answer",
      keyword: "required",
      expectedConstraint: "answer",
      actual: { kind: "MISSING" }
    });
  });

  it("Validator 与 Promptfoo 判定不一致时返回稳定错误且不改写 Promptfoo 事实", () => {
    const validatorPasses = explainJsonSchemaResult({
      assertionIndex: 0,
      promptfooPassed: false,
      schema: { type: "string" },
      actual: "valid"
    });
    expect(validatorPasses).toEqual({
      ok: false,
      error: {
        code: "JSON_SCHEMA_VALIDATOR_DISAGREEMENT",
        promptfooPassed: false,
        validatorPassed: true
      }
    });

    const validatorFails = explainJsonSchemaResult({
      assertionIndex: 0,
      promptfooPassed: true,
      schema: { type: "string" },
      actual: 1
    });
    expect(validatorFails).toMatchObject({
      ok: false,
      error: {
        code: "JSON_SCHEMA_VALIDATOR_DISAGREEMENT",
        promptfooPassed: true,
        validatorPassed: false
      }
    });
  });

  it("无效 Schema 在脏数据边界返回结构化错误", () => {
    expect(
      explainJsonSchemaResult({
        assertionIndex: 0,
        promptfooPassed: false,
        schema: { type: "not-a-json-schema-type" },
        actual: "value"
      })
    ).toEqual({ ok: false, error: { code: "JSON_SCHEMA_INVALID" } });
  });
});
