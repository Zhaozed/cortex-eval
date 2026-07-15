import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  CANONICAL_EXPORT_CONTENT_TYPE,
  CanonicalExportRequestV1Schema,
  type CanonicalExportRequestV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import {
  ApiErrorResponseV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { Readable } from "node:stream";

import type { LocalApiHandler, LocalApiHandlerResponse } from "./local-server.ts";

/** Narrow fully-reconciled export boundary consumed by HTTP. */
export interface CanonicalExportPreparer {
  /** Prepare one complete response before returning HTTP success. */
  readonly prepare: (request: CanonicalExportRequestV1, signal: AbortSignal) => Promise<Readable>;
}

// Build one strict public error without caught details.
function errorBody(
  code: "VALIDATION_FAILED" | "REQUEST_ABORTED",
  requestId: string,
  path?: string
): ApiErrorResponseV1 {
  return ApiErrorResponseV1Schema.parse({
    error: {
      code,
      message: zhCnMessages[code],
      requestId,
      ...(path === undefined ? {} : { path })
    }
  });
}

/** Map the closed Canonical Export use case to one strict Local API handler. */
export function createCanonicalExportHandler(service: CanonicalExportPreparer): LocalApiHandler {
  return async (input): Promise<LocalApiHandlerResponse> => {
    const parsed = CanonicalExportRequestV1Schema.safeParse(input.body);
    if (!parsed.success) {
      const firstPath = parsed.error.issues[0]?.path.join(".") ?? "";
      return {
        statusCode: 400,
        body: errorBody(
          "VALIDATION_FAILED",
          input.requestId,
          firstPath.length === 0 ? "body" : firstPath
        )
      };
    }
    try {
      const body = await service.prepare(parsed.data, input.signal);
      return {
        statusCode: 200,
        headers: { "content-type": CANONICAL_EXPORT_CONTENT_TYPE },
        body
      };
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_ABORTED") {
        return { statusCode: 499, body: errorBody("REQUEST_ABORTED", input.requestId) };
      }
      throw error;
    }
  };
}
