import { describe, expect, it } from "vitest";

import {
  mapCaseDefinitionFromV1,
  mapCaseDefinitionToV1,
  mapEndpointDefinitionFromV1,
  mapLlmDefinitionFromV1
} from "../src/resource-dto-mappers.ts";

describe("P3 HTTP DTO Mapper", () => {
  it("Case v1 往返不丢失递归 Assertion 事实", () => {
    const dto = {
      contractVersion: "cortex.case-definition.v1" as const,
      description: "Nested",
      threshold: 0.8,
      vars: { task: "route", request_body: { text: "hello" } },
      metadata: {
        case_id: "CASE-1",
        req_id: "REQ-1",
        task_id: "TASK-1",
        business_module: "chat",
        scenario_tag: "edge"
      },
      assert: [
        {
          type: "assert-set",
          metric: "quality",
          assert: [{ type: "contains", metric: "content", value: "ok", weight: 1 }]
        }
      ]
    };
    const outerAssertion = dto.assert[0];
    const innerAssertion = outerAssertion?.assert[0];
    if (outerAssertion === undefined || innerAssertion === undefined) {
      throw new Error("NESTED_ASSERTION_EXPECTED");
    }

    expect(mapCaseDefinitionToV1(mapCaseDefinitionFromV1(dto))).toEqual({
      ...dto,
      assert: [
        {
          ...outerAssertion,
          weight: 1,
          assert: [{ ...innerAssertion, weight: 1 }]
        }
      ]
    });
  });

  it("Provider DTO 只剥离传输版本，不展开 EnvSecretRef", () => {
    const endpoint = {
      contractVersion: "cortex.endpoint-config.v1" as const,
      urlTemplate: "https://example.test/{{vars.task}}",
      method: "POST" as const,
      headers: { Authorization: { kind: "ENV_SECRET" as const, envKey: "SERVICE_TOKEN" } },
      bodySelector: "/request_body",
      timeoutMs: 1000,
      defaultConcurrency: 4
    };
    expect(mapEndpointDefinitionFromV1(endpoint)).toEqual({
      urlTemplate: endpoint.urlTemplate,
      method: endpoint.method,
      headers: endpoint.headers,
      bodySelector: endpoint.bodySelector,
      timeoutMs: endpoint.timeoutMs,
      defaultConcurrency: endpoint.defaultConcurrency
    });

    const llm = {
      contractVersion: "cortex.llm-config.v1" as const,
      providerType: "GOOGLE_GEMINI" as const,
      model: "gemini-model",
      thinkingLevel: "LOW" as const,
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1024,
      timeoutMs: 30_000,
      structuredOutput: "JSON_SCHEMA" as const,
      apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
    };
    expect(mapLlmDefinitionFromV1(llm)).toMatchObject({
      providerType: "GOOGLE_GEMINI",
      apiKey: { envKey: "GEMINI_API_KEY" }
    });
    expect(JSON.stringify(mapLlmDefinitionFromV1(llm))).not.toContain("contractVersion");
  });
});
