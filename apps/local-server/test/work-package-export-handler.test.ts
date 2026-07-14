import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createWorkPackageExportHandler,
  type WorkPackageExportPreparer
} from "../src/work-package-export-handler.ts";
import type { LocalApiHandlerInput } from "../src/local-server.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const request = {
  suiteId: ID,
  endpointConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1",
  evaluatorConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2",
  analyzerConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3",
  analysisPromptId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4"
} as const;

function handlerInput(body: unknown): LocalApiHandlerInput {
  return {
    params: {},
    query: {},
    body,
    requestId: ID,
    signal: new AbortController().signal
  };
}

function preparer(result: unknown): WorkPackageExportPreparer {
  return {
    prepare: (): Promise<Readable> =>
      // Boundary test intentionally preserves a third-party non-Error rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      result instanceof Readable ? Promise.resolve(result) : Promise.reject(result)
  };
}

describe("P7 Work Package export HTTP handler", () => {
  it("returns the prepared NDJSON body without buffering it", async () => {
    const body = Readable.from(["fixture"]);
    await expect(
      createWorkPackageExportHandler(preparer(body))(handlerInput(request))
    ).resolves.toEqual({
      statusCode: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      body
    });
  });

  it("maps root and field validation failures before invoking the service", async () => {
    let calls = 0;
    const service: WorkPackageExportPreparer = {
      prepare: (): Promise<Readable> => {
        calls += 1;
        return Promise.resolve(Readable.from([]));
      }
    };
    const handler = createWorkPackageExportHandler(service);
    await expect(handler(handlerInput(null))).resolves.toMatchObject({
      statusCode: 400,
      body: { error: { code: "VALIDATION_FAILED", path: "body" } }
    });
    await expect(handler(handlerInput({ ...request, suiteId: "invalid" }))).resolves.toMatchObject({
      statusCode: 400,
      body: { error: { code: "VALIDATION_FAILED", path: "suiteId" } }
    });
    expect(calls).toBe(0);
  });

  it("maps every closed use-case error without exposing internal details", async () => {
    const cases = [
      ["SUITE_NOT_FOUND", 404, "SUITE_NOT_FOUND"],
      ["CONFIGURATION_NOT_FOUND", 404, "CONFIGURATION_NOT_FOUND"],
      ["RUN_SUITE_EMPTY", 422, "RUN_SUITE_EMPTY"],
      ["WORK_PACKAGE_INVALID", 422, "WORK_PACKAGE_INVALID"],
      ["RUBRIC_PROMPT_NOT_FOUND", 422, "WORK_PACKAGE_INVALID"],
      ["EXPORT_REVISION_CONFLICT", 409, "EXPORT_REVISION_CONFLICT"],
      ["REQUEST_ABORTED", 499, "REQUEST_ABORTED"]
    ] as const;
    for (const [cause, statusCode, publicCode] of cases) {
      const handler = createWorkPackageExportHandler(preparer(new Error(cause)));
      await expect(handler(handlerInput(request))).resolves.toMatchObject({
        statusCode,
        body: { error: { code: publicCode, requestId: ID } }
      });
    }
  });

  it("rethrows unknown Error and non-Error failures for the global mapper", async () => {
    const unknownError = new Error("UNKNOWN_FAILURE");
    await expect(
      createWorkPackageExportHandler(preparer(unknownError))(handlerInput(request))
    ).rejects.toBe(unknownError);
    await expect(
      createWorkPackageExportHandler(preparer("UNKNOWN_FAILURE"))(handlerInput(request))
    ).rejects.toBe("UNKNOWN_FAILURE");
  });
});
