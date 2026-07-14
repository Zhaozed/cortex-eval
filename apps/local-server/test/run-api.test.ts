import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalServerRuntime, type LocalServerRuntime } from "../src/local-server-runtime.ts";
import { parseJsonObject, jsonStringProperty } from "./test-support/json-test-values.ts";

const host = { host: "127.0.0.1:4310" };
const jsonHeaders = { ...host, "content-type": "application/json" };
const roots: string[] = [];
const runtimes: LocalServerRuntime[] = [];
const stubs: Server[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => runtime.close()));
  await Promise.all(
    stubs
      .splice(0)
      .map(async (server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
  );
});

async function createResource(
  server: FastifyInstance,
  url: string,
  payload: Readonly<Record<string, unknown>>
): Promise<string> {
  const response = await server.inject({ method: "POST", url, headers: jsonHeaders, payload });
  expect(response.statusCode).toBe(201);
  return jsonStringProperty(parseJsonObject(response), "id");
}

async function startStub(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        task_name: "route",
        resolved_config: {},
        parsed_output: { answer: "ok" }
      })
    );
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TEST_STUB_ADDRESS_INVALID");
  return `http://127.0.0.1:${address.port}`;
}

async function waitForEvaluationCommit(
  server: FastifyInstance,
  runId: string
): Promise<Readonly<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: host
    });
    const body = parseJsonObject(response);
    if (body.stage === "REPORT") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("TEST_RUN_TIMEOUT");
}

describe("P6 real Run API", () => {
  it("真实 SQLite/HTTP 闭合 REST、Promptfoo 非模型 Assert、Evaluation Artifact 与结果查询", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-run-api-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({ projectRoot });
    runtimes.push(runtime);
    const origin = await startStub();
    const server = runtime.server;
    const suiteId = await createResource(server, "/api/v1/test-suites", {
      name: "Run Suite",
      description: "Run"
    });
    const endpointId = await createResource(server, "/api/v1/endpoint-configs", {
      name: "Run Endpoint",
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: `${origin}/run/{{vars.task}}`,
        method: "POST",
        headers: { "Content-Type": { kind: "LITERAL", value: "application/json" } },
        bodySelector: "/request_body",
        timeoutMs: 1_000,
        defaultConcurrency: 3
      }
    });
    const evaluatorId = await createResource(server, "/api/v1/llm-configs", {
      name: "Run Evaluator",
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 128,
        timeoutMs: 1_000,
        structuredOutput: "JSON_SCHEMA",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    });
    const caseResponse = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/cases`,
      headers: jsonHeaders,
      payload: {
        expectedSuiteRevision: 0,
        definition: {
          contractVersion: "cortex.case-definition.v1",
          description: "Run Case",
          threshold: 1,
          vars: { task: "route", request_body: { input: "hello" } },
          metadata: {
            case_id: "case-1",
            req_id: "request-1",
            task_id: "task-1",
            business_module: "chat",
            scenario_tag: "smoke"
          },
          assert: [{ type: "contains", metric: "quality", value: "ok", weight: 1 }]
        }
      }
    });
    expect(caseResponse.statusCode).toBe(201);
    const selection = { suiteId, endpointConfigId: endpointId, evaluatorConfigId: evaluatorId };
    const preflight = await server.inject({
      method: "POST",
      url: "/api/v1/runs/preflight",
      headers: jsonHeaders,
      payload: selection
    });
    expect(preflight.statusCode).toBe(200);
    expect(parseJsonObject(preflight)).toMatchObject({
      caseCount: 1,
      defaultRunExecutionLimits: { restConcurrency: 3, evalConcurrency: 2 }
    });
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: jsonHeaders,
      payload: { ...selection, runMode: "PIPELINE" }
    });
    expect(created.statusCode).toBe(201);
    const runId = jsonStringProperty(parseJsonObject(created), "id");
    const started = await server.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/start`,
      headers: jsonHeaders,
      payload: { expectedRevision: 0 }
    });
    expect(started.statusCode).toBe(202);
    const completed = await waitForEvaluationCommit(server, runId);
    expect(completed).toMatchObject({
      status: "READY",
      stage: "REPORT",
      rest: { total: 1, completed: 1, succeeded: 1, error: 0 },
      artifactAvailability: [
        { kind: "REST_RESULTS", status: "PRESENT" },
        { kind: "RAW_PROMPTFOO_EVIDENCE", status: "PRESENT" },
        { kind: "NORMALIZED_EVAL_RESULTS", status: "PRESENT" }
      ]
    });
    const cases = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/cases`,
      headers: host
    });
    expect(parseJsonObject(cases)).toMatchObject({
      items: [{ caseKey: "case-1", status: "SUCCEEDED" }]
    });
    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/cases/case-1`,
      headers: host
    });
    expect(parseJsonObject(detail)).toMatchObject({
      providerOutput: { ok: true, task_name: "route", parsed_output: { answer: "ok" } }
    });
    const evaluations = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evaluations`,
      headers: host
    });
    expect(evaluations.statusCode).toBe(200);
    expect(parseJsonObject(evaluations)).toMatchObject({
      items: [
        {
          runId,
          result: {
            caseKey: "case-1",
            status: "PASS",
            promptfooSuccess: true,
            assertions: [{ metric: "quality", status: "PASS" }]
          }
        }
      ],
      nextCursor: null
    });
    const listed = await server.inject({ method: "GET", url: "/api/v1/runs", headers: host });
    expect(parseJsonObject(listed)).toMatchObject({
      items: [{ id: runId, sourceType: "PLATFORM" }]
    });
  });

  it("SSE 在发送 200 前校验 Run，不存在时返回普通 JSON 404", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-run-api-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({ projectRoot });
    runtimes.push(runtime);
    const response = await runtime.server.inject({
      method: "GET",
      url: "/api/v1/runs/01900000-0000-7000-8000-000000000999/events",
      headers: host
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(parseJsonObject(response)).toMatchObject({ error: { code: "RUN_NOT_FOUND" } });
  });
});
