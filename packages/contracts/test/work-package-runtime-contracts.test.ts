import { describe, expect, it } from "vitest";

import {
  CanonicalBase64ChunkSchema,
  WorkPackageExportRequestV1Schema,
  WorkPackageExportEventV1Schema,
  WorkPackageRuntimePathSchema,
  WORK_PACKAGE_EXPORT_LINE_MAX_BYTES,
  WORK_PACKAGE_RUNTIME_LIMITS
} from "../src/work-package-runtime-contracts.ts";

const HASH = "a".repeat(64);
const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";

describe("Work Package runtime contracts", () => {
  it("accepts only the complete current-resource export selection", () => {
    const request = {
      suiteId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
      endpointConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1",
      evaluatorConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2",
      analyzerConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3",
      analysisPromptId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4"
    };
    expect(WorkPackageExportRequestV1Schema.parse(request)).toEqual(request);
    expect(
      WorkPackageExportRequestV1Schema.safeParse({ ...request, resultImport: true }).success
    ).toBe(false);
  });

  it("freezes the user-confirmed byte limits without changing Manifest v1", () => {
    expect(WORK_PACKAGE_RUNTIME_LIMITS).toEqual({
      manifestBytes: 256 * 1024 * 1024,
      executionBytes: 4 * 1024 * 1024,
      configurationBytes: 8 * 1024 * 1024,
      canonicalTestsBytes: 1_280 * 1024 * 1024,
      canonicalCaseBytes: 16 * 1024 * 1024,
      restResultCaseBytes: 32 * 1024 * 1024,
      normalizedEvalCaseBytes: 32 * 1024 * 1024,
      reportCaseBytes: 80 * 1024 * 1024,
      promptfooRawRowBytes: 64 * 1024 * 1024,
      decodedJsonStringBytes: 16 * 1024 * 1024,
      decodedChunkBytes: 1024 * 1024,
      relativePathBytes: 1024,
      pathComponentBytes: 255
    });
  });

  it.each([
    "manifest.json",
    "inputs/tests.json",
    "prompts/rubric/reply_quality.json",
    "executions/018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee/execution.json"
  ])("accepts materializable ASCII path %s", (path) => {
    expect(WorkPackageRuntimePathSchema.parse(path)).toBe(path);
  });

  it.each([
    "",
    "/manifest.json",
    "../manifest.json",
    "inputs//tests.json",
    "inputs/./tests.json",
    "inputs/../tests.json",
    "inputs\\tests.json",
    "inputs/\u0000tests.json",
    'inputs/"tests.json',
    "inputs/测试.json",
    `inputs/${"a".repeat(256)}.json`,
    "a".repeat(1025)
  ])("rejects unsafe or unmaterializable path %j", (path) => {
    expect(WorkPackageRuntimePathSchema.safeParse(path).success).toBe(false);
  });

  it("accepts canonical Base64 up to a decoded 1 MiB chunk", () => {
    const encoded = Buffer.alloc(1024 * 1024, 0xa5).toString("base64");
    expect(CanonicalBase64ChunkSchema.parse(encoded)).toBe(encoded);
  });

  it.each(["AA", "A===", "AA=A", "AA-_", "AAAA\n", "===="])(
    "rejects non-canonical Base64 %j",
    (encoded) => {
      expect(CanonicalBase64ChunkSchema.safeParse(encoded).success).toBe(false);
    }
  );

  it("rejects a Base64 chunk whose decoded value exceeds 1 MiB", () => {
    const encoded = Buffer.alloc(1024 * 1024 + 1).toString("base64");
    expect(CanonicalBase64ChunkSchema.safeParse(encoded).success).toBe(false);
  });

  it("freezes the manifest-first NDJSON event union", () => {
    const events = [
      {
        type: "PACKAGE_START",
        manifest: { path: "manifest.json", sha256: HASH, sizeBytes: 1024 }
      },
      {
        type: "FILE_START",
        file: { path: "inputs/tests.json", sha256: HASH, sizeBytes: 2048 }
      },
      {
        type: "FILE_CHUNK",
        path: "inputs/tests.json",
        sequence: 0,
        dataBase64: "YQ=="
      },
      { type: "FILE_END", path: "inputs/tests.json" },
      { type: "PACKAGE_END", packageId: PACKAGE_ID }
    ];
    expect(events.map((event) => WorkPackageExportEventV1Schema.parse(event))).toEqual(events);
  });

  it("rejects unknown fields and an oversized declared manifest", () => {
    expect(
      WorkPackageExportEventV1Schema.safeParse({
        type: "PACKAGE_START",
        manifest: {
          path: "manifest.json",
          sha256: HASH,
          sizeBytes: WORK_PACKAGE_RUNTIME_LIMITS.manifestBytes + 1
        }
      }).success
    ).toBe(false);
    expect(
      WorkPackageExportEventV1Schema.safeParse({
        type: "PACKAGE_END",
        packageId: PACKAGE_ID,
        future: true
      }).success
    ).toBe(false);
  });

  it("sets the line budget from the worst canonical chunk event", () => {
    const path = Array.from({ length: 5 }, () => "a".repeat(204)).join("/");
    expect(Buffer.byteLength(path)).toBe(WORK_PACKAGE_RUNTIME_LIMITS.relativePathBytes);
    const dataBase64 = `${"A".repeat(1_398_102)}==`;
    const line = `${JSON.stringify({
      type: "FILE_CHUNK",
      path,
      sequence: Number.MAX_SAFE_INTEGER,
      dataBase64
    })}\n`;
    expect(Buffer.byteLength(line)).toBe(WORK_PACKAGE_EXPORT_LINE_MAX_BYTES);
  });
});
