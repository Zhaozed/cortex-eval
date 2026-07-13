import { describe, expect, it } from "vitest";

import { CreateTestSuiteRequestV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";

import { projectOpenApiSchema, projectRuntimeSchema } from "../src/contract-schema-projections.ts";

describe("Zod 同源 Schema 投影", () => {
  it("从同一 Zod 源分别生成 Draft 7 Runtime 与 OpenAPI 3.0 严格对象", () => {
    const runtime = projectRuntimeSchema(CreateTestSuiteRequestV1Schema);
    const openapi = projectOpenApiSchema(CreateTestSuiteRequestV1Schema);

    expect(runtime).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "description"]
    });
    expect(openapi).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "description"]
    });
    expect(runtime).not.toHaveProperty("$schema");
    expect(openapi).not.toHaveProperty("$schema");
  });
});
