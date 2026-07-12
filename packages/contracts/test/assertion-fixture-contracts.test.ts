import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadAssertionCapabilityMatrix } from "../../../tooling/src/promptfoo-capabilities.ts";
import {
  AssertionDefinitionV1Schema,
  parseCaseDefinitionV1FromFixture
} from "../src/case-contracts.ts";

describe("Assertion 与当前 Fixture 契约", () => {
  it("137 条能力逐条映射到命名契约探针并通过通用 Assertion Schema", async () => {
    const capabilities = await loadAssertionCapabilityMatrix(process.cwd());
    expect(capabilities).toHaveLength(137);
    for (const capability of capabilities) {
      expect(capability.probes.positive).toBe(
        `promptfoo-0.121.18:${capability.type}:legal-payload`
      );
      expect(capability.probes.invalidOrCapabilityError).toBe(
        `promptfoo-0.121.18:${capability.type}:rejection-boundary`
      );
      expect(capability.probes.importerAlignment).toBe(
        `promptfoo-0.121.18:${capability.type}:component-alignment`
      );
      expect(AssertionDefinitionV1Schema.safeParse(capability.schemaProbe).success).toBe(true);
    }
  });

  it("当前真实 Case Fixture 在边界补入版本后全部进入 v1", async () => {
    const raw: unknown = JSON.parse(
      await readFile("test_suite/current/cases/loona_promptfoo_tests.json", "utf8")
    );
    if (!Array.isArray(raw)) throw new Error("fixture must be an array");
    const cases = raw.map(parseCaseDefinitionV1FromFixture);
    expect(cases).toHaveLength(4);
    expect(cases.map((item) => item.contractVersion)).toEqual(
      Array.from({ length: 4 }, () => "cortex.case-definition.v1")
    );
  });
});
