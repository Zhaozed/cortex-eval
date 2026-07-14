import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  ApiErrorResponseV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  WorkPackageExportRequestV1Schema,
  type WorkPackageExportRequestV1
} from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import type { LocalApiHandler, LocalApiHandlerResponse } from "./local-server.ts";

/** Narrow prepared-response Port consumed by the HTTP protocol mapper. */
export interface WorkPackageExportPreparer {
  /** Fully reconcile one export before the success response opens. */
  readonly prepare: (request: WorkPackageExportRequestV1, signal: AbortSignal) => Promise<Readable>;
}

type PlainCode =
  | "VALIDATION_FAILED"
  | "SUITE_NOT_FOUND"
  | "CONFIGURATION_NOT_FOUND"
  | "RUN_SUITE_EMPTY"
  | "WORK_PACKAGE_INVALID"
  | "EXPORT_REVISION_CONFLICT"
  | "REQUEST_ABORTED";

function errorBody(code: PlainCode, requestId: string, path?: string): ApiErrorResponseV1 {
  return ApiErrorResponseV1Schema.parse({
    error: {
      code,
      message: zhCnMessages[code],
      requestId,
      ...(path === undefined ? {} : { path })
    }
  });
}

function errorResponse(error: unknown, requestId: string): LocalApiHandlerResponse | null {
  const code = error instanceof Error ? error.message : null;
  if (code === "SUITE_NOT_FOUND" || code === "CONFIGURATION_NOT_FOUND") {
    return { statusCode: 404, body: errorBody(code, requestId) };
  }
  if (code === "RUN_SUITE_EMPTY" || code === "WORK_PACKAGE_INVALID") {
    return { statusCode: 422, body: errorBody(code, requestId) };
  }
  if (code === "RUBRIC_PROMPT_NOT_FOUND") {
    return { statusCode: 422, body: errorBody("WORK_PACKAGE_INVALID", requestId) };
  }
  if (code === "EXPORT_REVISION_CONFLICT") {
    return { statusCode: 409, body: errorBody(code, requestId) };
  }
  if (code === "REQUEST_ABORTED") {
    return { statusCode: 499, body: errorBody(code, requestId) };
  }
  return null;
}

/** Map the closed Work Package export use case to one strict Local API handler. */
export function createWorkPackageExportHandler(
  service: WorkPackageExportPreparer
): LocalApiHandler {
  return async (input): Promise<LocalApiHandlerResponse> => {
    const parsed = WorkPackageExportRequestV1Schema.safeParse(input.body);
    if (!parsed.success) {
      const firstPath = parsed.error.issues[0]?.path.join(".") ?? "";
      const path = firstPath.length === 0 ? "body" : firstPath;
      return { statusCode: 400, body: errorBody("VALIDATION_FAILED", input.requestId, path) };
    }
    try {
      const body = await service.prepare(parsed.data, input.signal);
      return {
        statusCode: 200,
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        body
      };
    } catch (error) {
      const response = errorResponse(error, input.requestId);
      if (response !== null) return response;
      throw error;
    }
  };
}
import type { Readable } from "node:stream";
