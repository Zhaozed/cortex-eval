import {
  buildLocalServer,
  type LocalApiHandlerResponse,
  type LocalResourceHandlers
} from "../../apps/local-server/src/local-server.ts";
import type { LocalRunHandlers } from "../../apps/local-server/src/application-run-handlers.ts";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";

// The generator never invokes resource handlers; this keeps Route capability registration exact.
function notExecutable(): Promise<LocalApiHandlerResponse> {
  return Promise.reject(new Error("OPENAPI_HANDLER_NOT_EXECUTABLE"));
}

const CAPABILITY_HANDLERS: LocalResourceHandlers = {
  listTestSuites: notExecutable,
  createTestSuite: notExecutable,
  getTestSuite: notExecutable,
  updateTestSuite: notExecutable,
  deleteTestSuite: notExecutable,
  getTestSuiteImpact: notExecutable,
  listCases: notExecutable,
  createCase: notExecutable,
  getCase: notExecutable,
  updateCase: notExecutable,
  deleteCase: notExecutable,
  copyCase: notExecutable,
  exportCases: notExecutable,
  importCases: notExecutable,
  listConfigurations: notExecutable,
  createConfiguration: notExecutable,
  getConfiguration: notExecutable,
  updateConfiguration: notExecutable,
  deleteConfiguration: notExecutable,
  validateEndpoint: notExecutable,
  validateLlm: notExecutable,
  listRubricPromptReferences: notExecutable,
  previewRubricPrompt: notExecutable,
  previewAnalysisPrompt: notExecutable
};

const RUN_CAPABILITY_HANDLERS: LocalRunHandlers = {
  preflightRun: notExecutable,
  createRun: notExecutable,
  listRuns: notExecutable,
  getRun: notExecutable,
  listRunCases: notExecutable,
  getRunCase: notExecutable,
  startRun: notExecutable,
  cancelRun: notExecutable,
  getRunProgress: notExecutable
};

// Sort object keys recursively while retaining protocol array order.
function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableObject(item)])
  );
}

/** Generate the exact stable P5 OpenAPI JSON from real Route registration. */
export async function generateLocalOpenApiJson(): Promise<string> {
  const server = buildLocalServer({
    requestIdGenerator: { nextId: () => "018f0c8e-9f79-7abc-8def-0123456789ab" },
    resourceHandlers: CAPABILITY_HANDLERS,
    runHandlers: RUN_CAPABILITY_HANDLERS
  });
  try {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    if (response.statusCode !== 200) throw new Error("OPENAPI_GENERATION_FAILED");
    const filepath = resolve("apps/local-server/openapi.json");
    const configuration = await resolveConfig(filepath);
    return await format(JSON.stringify(stableObject(response.json())), {
      ...configuration,
      parser: "json",
      filepath
    });
  } finally {
    await server.close();
  }
}
