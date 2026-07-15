import { Readable } from "node:stream";

import { CANONICAL_EXPORT_CONTENT_TYPE } from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { describe, expect, it } from "vitest";

import {
  createCanonicalExportHandler,
  type CanonicalExportPreparer
} from "../src/canonical-export-handler.ts";
import type { LocalApiHandlerInput } from "../src/local-server.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";

function input(body: unknown): LocalApiHandlerInput {
  return {
    params: {},
    query: {},
    body,
    requestId: ID,
    signal: new AbortController().signal
  };
}

describe("Canonical Export HTTP 边界", () => {
  it("应用默认 Raw=false 并返回独立 NDJSON 媒体类型", async () => {
    const body = Readable.from(["fixture"]);
    let received: unknown;
    const service: CanonicalExportPreparer = {
      prepare: (request): Promise<Readable> => {
        received = request;
        return Promise.resolve(body);
      }
    };
    await expect(createCanonicalExportHandler(service)(input({}))).resolves.toEqual({
      statusCode: 200,
      headers: { "content-type": CANONICAL_EXPORT_CONTENT_TYPE },
      body
    });
    expect(received).toEqual({ rawEvidenceIncluded: false });
  });

  it("拒绝未知字段并稳定映射取消，不暴露内部失败", async () => {
    let calls = 0;
    const service: CanonicalExportPreparer = {
      prepare: (): Promise<Readable> => {
        calls += 1;
        return Promise.reject(new Error("REQUEST_ABORTED"));
      }
    };
    await expect(
      createCanonicalExportHandler(service)(input({ rawEvidenceIncluded: false, future: true }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { code: "VALIDATION_FAILED" } } });
    expect(calls).toBe(0);
    await expect(createCanonicalExportHandler(service)(input({}))).resolves.toMatchObject({
      statusCode: 499,
      body: { error: { code: "REQUEST_ABORTED", requestId: ID } }
    });
  });
});
