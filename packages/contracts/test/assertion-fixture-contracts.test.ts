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

  it("Case 构建不因比较类型或能力分类设置 Assertion 类型白名单", async () => {
    const capabilities = await loadAssertionCapabilityMatrix(process.cwd());
    const comparisonTypes = capabilities
      .filter((capability) => capability.type === "select-best" || capability.type === "max-score")
      .map((capability) => capability.schemaProbe);

    expect(comparisonTypes).toHaveLength(2);
    expect(
      comparisonTypes.every((assertion) => AssertionDefinitionV1Schema.safeParse(assertion).success)
    ).toBe(true);
  });

  it("递归拒绝 Assertion config 中的 Provider、Secret 与外部执行引用", () => {
    const unsafeConfigs = [
      { provider: "openai:gpt-4" },
      { nested: { apiKey: "must-not-persist" } },
      { nested: { "x-api-key": "must-not-persist" } },
      { nested: [{ authorization: "Bearer secret" }] },
      { nested: { accessToken: "must-not-persist" } },
      { nested: { refresh_token: "must-not-persist" } },
      { nested: { dbPassword: "must-not-persist" } },
      { nested: { authToken: "must-not-persist" } },
      { nested: { providertoken: "must-not-persist" } },
      { nested: { authorizationtoken: "must-not-persist" } },
      { nested: { credentialsecret: "must-not-persist" } },
      { nested: { passwordtoken: "must-not-persist" } },
      { nested: { clientcredential: "must-not-persist" } },
      { nested: { apiaccesskey: "must-not-persist" } },
      { nested: { clienttokenvalue: "must-not-persist" } },
      { nested: { xapikeyvalue: "must-not-persist" } },
      { nested: { oauth: "must-not-persist" } },
      { nested: { module: "must-not-persist" } },
      { nested: { dependencies: ["must-not-persist"] } },
      { nested: { loader: "Package:evil" } },
      { nested: { loader: " FILE:///tmp/outside.js" } },
      { nested: { script: "file://outside/assertion.js" } },
      { nested: { loader: "package:unsafe-grader" } }
    ];

    for (const config of unsafeConfigs) {
      expect(
        AssertionDefinitionV1Schema.safeParse({
          type: "future-assertion",
          metric: "future-metric",
          config
        }).success
      ).toBe(false);
    }

    expect(
      AssertionDefinitionV1Schema.safeParse({
        type: "future-assertion",
        metric: "future-metric",
        config: { nested: { maxTokens: 10, tokenizer: "builtin" } }
      }).success
    ).toBe(true);

    for (const executableReference of ["Package:evil", " FILE:///tmp/outside.js", "npm:evil"]) {
      expect(
        AssertionDefinitionV1Schema.safeParse({
          type: "future-assertion",
          metric: "future-metric",
          transform: executableReference
        }).success
      ).toBe(false);
      expect(
        AssertionDefinitionV1Schema.safeParse({
          type: "future-assertion",
          metric: "future-metric",
          contextTransform: executableReference
        }).success
      ).toBe(false);
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
