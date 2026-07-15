import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { generateLocalOpenApiJson } from "../src/local-openapi.ts";

describe("Local API OpenAPI drift", () => {
  it("提交的 OpenAPI JSON 与当前已闭环 Route/Schema 字节级一致", async () => {
    const generated = await generateLocalOpenApiJson();
    const committed = await readFile(
      new URL("../../apps/local-server/openapi.json", import.meta.url),
      "utf8"
    );
    expect(committed).toBe(generated);
    for (const path of [
      "/api/v1/runs",
      "/api/v1/runs/preflight",
      "/api/v1/runs/{runId}",
      "/api/v1/runs/{runId}/cases",
      "/api/v1/runs/{runId}/cases/{caseKey}",
      "/api/v1/runs/{runId}/start",
      "/api/v1/runs/{runId}/cancel",
      "/api/v1/runs/{runId}/events",
      "/api/v1/runs/{runId}/report",
      "/api/v1/runs/{runId}/report/cases",
      "/api/v1/runs/{runId}/report/cases/{caseKey}",
      "/api/v1/runs/{runId}/report/export",
      "/api/v1/runs/{runId}/reruns",
      "/api/v1/execution-results/import",
      "/api/v1/work-packages/export"
    ]) {
      expect(generated).toContain(`"${path}"`);
    }
    expect(generated).not.toMatch(/"\/api\/v1\/(?:executions|reports|analysis)\b/);
    expect(generated).not.toMatch(/\/runs\/\{runId\}\/analysis"/);
  });
});
