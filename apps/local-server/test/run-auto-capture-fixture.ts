import type { StoredRestCaseSuccess } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
export const captureRunId = "018f0f4e-7b7a-7cc0-8000-000000000001";
export const captureHash = "a".repeat(64);
export const capturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCusAAAAASUVORK5CYII=";
export const capturePayload = {
  messages: [{ version: "v0.9", createSurface: { surfaceId: "test" } }]
};
export function captureResult(enabled = true): StoredRestCaseSuccess & {
  providerOutput: Extract<StoredRestCaseSuccess["providerOutput"], { ok: true }>;
} {
  return {
    runId: captureRunId,
    caseKey: "capture",
    ordinal: 0,
    caseDefinitionHash: captureHash,
    resultHash: captureHash,
    durationMs: 50,
    completedAt: "2026-09-09T00:00:00.000Z",
    provenance: null,
    status: "SUCCEEDED",
    httpStatus: 200,
    errorType: null,
    errorMessage: null,
    definition: {
      caseKey: "capture",
      description: "截图验证",
      threshold: 1,
      task: "agent-e2e",
      requestBody: {},
      metadata: {
        requestId: "test",
        taskId: "test",
        businessModule: "todo",
        scenarioTag: "query",
        ...(enabled ? { a2uiCapture: true } : {})
      },
      assertions: [{ type: "equals", metric: "ok", value: true, weight: 1 }]
    },
    providerOutput: {
      ok: true,
      taskName: "agent-e2e",
      resolvedConfig: {},
      parsedOutput: { a2ui: [capturePayload] }
    }
  };
}
