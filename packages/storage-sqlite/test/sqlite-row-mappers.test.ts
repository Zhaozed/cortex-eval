import { describe, expect, it } from "vitest";

import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  canonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import type { Selectable } from "kysely";

import { mapStoredTestCase } from "../src/sqlite-row-mappers.ts";
import type { TestCaseTable } from "../src/sqlite-schema.ts";

function completeDefinition(): CaseDefinition {
  return {
    caseKey: "case-1",
    description: "Complete",
    threshold: 0.5,
    task: "route",
    requestBody: { nested: { value: true } },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "edge"
    },
    assertions: [
      {
        type: "assert-set",
        metric: "set",
        weight: 1,
        threshold: 0.5,
        config: { mode: "all" },
        transform: "output",
        contextTransform: "context",
        assertions: [
          {
            type: "equals",
            metric: "exact",
            weight: 2,
            value: { ok: true },
            rubricPrompt: "prompt://quality"
          }
        ]
      }
    ]
  };
}

function row(): Selectable<TestCaseTable> {
  const definition = completeDefinition();
  const definitionJson = caseDefinitionJson(definition);
  return {
    id: "internal-1",
    suite_id: "suite-1",
    case_key: definition.caseKey,
    ordinal: 0,
    description: definition.description,
    business_module: definition.metadata.businessModule,
    scenario_tag: definition.metadata.scenarioTag,
    assertion_types_json: '["assert-set","equals"]',
    metrics_json: '["exact","set"]',
    definition_json: canonicalJson(definitionJson),
    rubric_prompt_keys_json: '["quality"]',
    definition_hash: hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition: definitionJson
    }),
    revision: 2,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z"
  };
}

describe("SQLite Case 行映射", () => {
  it("完整映射递归 Assertion 与全部可选字段", () => {
    expect(mapStoredTestCase(row())).toMatchObject({
      caseKey: "case-1",
      revision: 2,
      definition: completeDefinition(),
      assertionTypes: ["assert-set", "equals"],
      metrics: ["exact", "set"],
      rubricPromptKeys: ["quality"]
    });
  });

  it.each([
    { field: "definition_json", value: "{" },
    { field: "definition_json", value: "[]" },
    { field: "definition_json", value: "{}" },
    { field: "assertion_types_json", value: "{}" },
    { field: "metrics_json", value: "[1]" },
    { field: "rubric_prompt_keys_json", value: "not-json" },
    { field: "case_key", value: "misaligned" }
  ])("拒绝脏字段 $field", ({ field, value }) => {
    expect(() => mapStoredTestCase({ ...row(), [field]: value })).toThrow(
      expect.objectContaining({ code: "SQLITE_ROW_INVALID" })
    );
  });

  it.each([
    ["threshold", "invalid"],
    ["rubricPrompt", 1],
    ["transform", 1],
    ["contextTransform", false],
    ["assert", {}]
  ])("拒绝错误类型的 Assertion 可选字段 %s", (field, value) => {
    const source = JSON.parse(row().definition_json) as {
      assert: Record<string, unknown>[];
    };
    const assertion = source.assert[0];
    if (assertion === undefined) throw new Error("TEST_ASSERTION_MISSING");
    assertion[field] = value;
    expectInvalidRow({ ...row(), definition_json: JSON.stringify(source) });
  });

  it.each([
    { field: "description", value: "Mismatch" },
    { field: "business_module", value: "mismatch" },
    { field: "scenario_tag", value: "mismatch" },
    { field: "assertion_types_json", value: '["equals"]' },
    { field: "metrics_json", value: '["wrong"]' },
    { field: "rubric_prompt_keys_json", value: "[]" },
    { field: "definition_hash", value: "b".repeat(64) }
  ])("拒绝无法从 Definition 对账的派生字段 $field", ({ field, value }) => {
    expectInvalidRow({ ...row(), [field]: value });
  });

  it.each([
    ["根", (source: Record<string, unknown>): void => void (source.unknown = true)],
    [
      "Metadata",
      (source: Record<string, unknown>): void => {
        const metadata = source.metadata as Record<string, unknown>;
        metadata.unknown = true;
      }
    ],
    [
      "Assertion",
      (source: Record<string, unknown>): void => {
        const assertions = source.assert as Record<string, unknown>[];
        const assertion = assertions[0];
        if (assertion === undefined) throw new Error("TEST_ASSERTION_MISSING");
        assertion.unknown = true;
      }
    ]
  ])("即使同步更新 Hash 也拒绝未知%s字段", (_scope, mutate) => {
    const current = row();
    const source = JSON.parse(current.definition_json) as Record<string, unknown>;
    mutate(source);
    const definitionJson = source as DomainJsonObject;
    expectInvalidRow({
      ...current,
      definition_json: canonicalJson(definitionJson),
      definition_hash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: current.case_key,
        definition: definitionJson
      })
    });
  });
});

function expectInvalidRow(value: Selectable<TestCaseTable>): void {
  expect(() => mapStoredTestCase(value)).toThrow(
    expect.objectContaining({ code: "SQLITE_ROW_INVALID" })
  );
}
