import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createLocalServerRuntime } from "../src/local-server-runtime.ts";
import { jsonStringProperty, parseJsonObject } from "./test-support/json-test-values.ts";

const host = { host: "127.0.0.1:4310" };
const jsonHeaders = { ...host, "content-type": "application/json" };

const endpointDefinition = {
  contractVersion: "cortex.endpoint-config.v1",
  urlTemplate: "https://example.test/tasks/{{vars.task}}",
  method: "POST",
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1000,
  defaultConcurrency: 2
};

const llmDefinition = {
  contractVersion: "cortex.llm-config.v1",
  providerType: "GOOGLE_GEMINI",
  model: "gemini-model",
  thinkingLevel: "OFF",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 64,
  timeoutMs: 1000,
  structuredOutput: "JSON_SCHEMA",
  apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
};

// Create one resource through the real runtime and return its validated UUID.
async function createResource(
  server: FastifyInstance,
  url: string,
  payload: Readonly<Record<string, unknown>>
): Promise<string> {
  const response = await server.inject({ method: "POST", url, headers: jsonHeaders, payload });
  expect(response.statusCode).toBe(201);
  return jsonStringProperty(parseJsonObject(response), "id");
}

// Return one versioned Case Definition transport value.
function caseDefinition(caseKey: string, rubric = false): Readonly<Record<string, unknown>> {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: caseKey,
    threshold: 1,
    vars: { task: "route", request_body: { caseKey } },
    metadata: {
      case_id: caseKey,
      req_id: `REQ-${caseKey}`,
      task_id: `TASK-${caseKey}`,
      business_module: "chat",
      scenario_tag: "smoke"
    },
    assert: [
      rubric
        ? {
            type: "llm-rubric",
            metric: "quality",
            rubricPrompt: "prompt://quality",
            weight: 1
          }
        : { type: "contains", metric: "quality", value: "ok", weight: 1 }
    ]
  };
}

describe("P3 real SQLite resource routes", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("覆盖真实仓储上的分页、CRUD、冲突、引用和 Probe 错误映射", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-resources-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({
      projectRoot,
      endpointValidator: {
        validate: (): Promise<{
          readonly ok: false;
          readonly error: {
            readonly code: "CONFIGURATION_PROBE_FAILED";
            readonly reason: "UNAVAILABLE";
          };
        }> =>
          Promise.resolve({
            ok: false,
            error: { code: "CONFIGURATION_PROBE_FAILED", reason: "UNAVAILABLE" }
          })
      },
      llmValidator: {
        validate: (): Promise<{
          readonly ok: false;
          readonly error: {
            readonly code: "CONFIGURATION_PROBE_FAILED";
            readonly reason: "TIMEOUT";
          };
        }> =>
          Promise.resolve({
            ok: false,
            error: { code: "CONFIGURATION_PROBE_FAILED", reason: "TIMEOUT" }
          })
      }
    });
    const server = runtime.server;

    const alphaSuiteId = await createResource(server, "/api/v1/test-suites", {
      name: "Alpha Suite",
      description: "Current"
    });
    await createResource(server, "/api/v1/test-suites", {
      name: "Beta Suite",
      description: "Current"
    });
    const firstSuites = await server.inject({
      method: "GET",
      url: "/api/v1/test-suites?limit=1",
      headers: host
    });
    const suiteCursor = jsonStringProperty(parseJsonObject(firstSuites), "nextCursor");
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/test-suites?limit=1&cursor=${encodeURIComponent(suiteCursor)}`,
          headers: host
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/test-suites?cursor=res_v2_e30",
          headers: host
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/test-suites?cursor=res_v1_invalid",
          headers: host
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/test-suites/018f0c8e-9f79-7abc-8def-0123456789ab",
          headers: host
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/test-suites/${alphaSuiteId}`,
          headers: jsonHeaders,
          payload: { name: "Alpha Suite", description: "Current", expectedRevision: 9 }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/test-suites",
          headers: jsonHeaders,
          payload: { name: "Alpha Suite", description: "Duplicate" }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/test-suites/${alphaSuiteId}/impact`,
          headers: host
        })
      ).statusCode
    ).toBe(200);

    for (const [index, caseKey] of ["CASE-1", "CASE-2"].entries()) {
      expect(
        (
          await server.inject({
            method: "POST",
            url: `/api/v1/test-suites/${alphaSuiteId}/cases`,
            headers: jsonHeaders,
            payload: { expectedSuiteRevision: index, definition: caseDefinition(caseKey) }
          })
        ).statusCode
      ).toBe(201);
    }
    const firstCases = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${alphaSuiteId}/cases?limit=1`,
      headers: host
    });
    const exported = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${alphaSuiteId}/export`,
      headers: host
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toHaveLength(2);
    expect(
      (await readdir(join(projectRoot, ".cortex-eval", "tmp"))).filter((name) =>
        name.startsWith("case-export-")
      )
    ).toEqual([]);
    const caseCursor = jsonStringProperty(parseJsonObject(firstCases), "nextCursor");
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/test-suites/${alphaSuiteId}/cases?limit=1&cursor=${encodeURIComponent(caseCursor)}`,
          headers: host
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/test-suites/${alphaSuiteId}/cases/MISSING`,
          headers: host
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/test-suites/${alphaSuiteId}/cases/CASE-1`,
          headers: jsonHeaders,
          payload: {
            expectedSuiteRevision: 2,
            expectedCaseRevision: 0,
            definition: caseDefinition("DIFFERENT")
          }
        })
      ).statusCode
    ).toBe(422);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/test-suites/${alphaSuiteId}/cases/CASE-1/copy`,
          headers: jsonHeaders,
          payload: { expectedSuiteRevision: 2, newCaseKey: "CASE-2" }
        })
      ).statusCode
    ).toBe(422);

    const endpointId = await createResource(server, "/api/v1/endpoint-configs", {
      name: "Endpoint Alpha",
      definition: endpointDefinition
    });
    await createResource(server, "/api/v1/endpoint-configs", {
      name: "Endpoint Beta",
      definition: endpointDefinition
    });
    const endpointPage = await server.inject({
      method: "GET",
      url: "/api/v1/endpoint-configs?limit=1",
      headers: host
    });
    const endpointCursor = jsonStringProperty(parseJsonObject(endpointPage), "nextCursor");
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/endpoint-configs?limit=1&cursor=${encodeURIComponent(endpointCursor)}`,
          headers: host
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/endpoint-configs/${endpointId}`,
          headers: jsonHeaders,
          payload: { name: "Endpoint Updated", definition: endpointDefinition, expectedRevision: 0 }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/endpoint-configs/${endpointId}`,
          headers: jsonHeaders,
          payload: { name: "Endpoint Stale", definition: endpointDefinition, expectedRevision: 0 }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/endpoint-configs/validate",
          headers: jsonHeaders,
          payload: { definition: endpointDefinition }
        })
      ).statusCode
    ).toBe(502);

    const llmId = await createResource(server, "/api/v1/llm-configs", {
      name: "LLM",
      definition: llmDefinition
    });
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/llm-configs/${llmId}`,
          headers: jsonHeaders,
          payload: { name: "LLM Updated", definition: llmDefinition, expectedRevision: 0 }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/llm-configs/validate",
          headers: jsonHeaders,
          payload: { definition: llmDefinition }
        })
      ).statusCode
    ).toBe(502);

    const rubricDefinition = {
      contractVersion: "cortex.prompt.v1",
      kind: "LLM_RUBRIC",
      promptKey: "quality",
      messages: [{ role: "SYSTEM", content: "Evaluate" }]
    };
    const rubricId = await createResource(server, "/api/v1/llm-rubric-prompts", {
      name: "Quality",
      definition: rubricDefinition
    });
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/llm-rubric-prompts/${rubricId}`,
          headers: jsonHeaders,
          payload: { name: "Quality Updated", definition: rubricDefinition, expectedRevision: 0 }
        })
      ).statusCode
    ).toBe(200);

    const analysisDefinition = {
      contractVersion: "cortex.prompt.v1",
      kind: "CASE_ANALYSIS",
      promptKey: "analysis",
      messages: [{ role: "USER", content: "{{case_definition}}" }]
    };
    const analysisId = await createResource(server, "/api/v1/case-analysis-prompts", {
      name: "Analysis",
      definition: analysisDefinition
    });
    expect(
      (
        await server.inject({
          method: "PUT",
          url: `/api/v1/case-analysis-prompts/${analysisId}`,
          headers: jsonHeaders,
          payload: { name: "Analysis Updated", definition: analysisDefinition, expectedRevision: 0 }
        })
      ).statusCode
    ).toBe(200);

    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/test-suites/${alphaSuiteId}/cases`,
          headers: jsonHeaders,
          payload: { expectedSuiteRevision: 2, definition: caseDefinition("CASE-3", true) }
        })
      ).statusCode
    ).toBe(201);
    const references = await server.inject({
      method: "GET",
      url: `/api/v1/llm-rubric-prompts/${rubricId}/references`,
      headers: host
    });
    expect(references.statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/v1/llm-rubric-prompts/${rubricId}?expectedRevision=1`,
          headers: host
        })
      ).statusCode
    ).toBe(409);

    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/v1/endpoint-configs/${endpointId}?expectedRevision=1`,
          headers: host
        })
      ).statusCode
    ).toBe(204);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/v1/llm-configs/${llmId}?expectedRevision=1`,
          headers: host
        })
      ).statusCode
    ).toBe(204);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/v1/case-analysis-prompts/${analysisId}?expectedRevision=1`,
          headers: host
        })
      ).statusCode
    ).toBe(204);

    await runtime.close();
  });
});
