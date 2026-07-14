import { describe, expect, it } from "vitest";

import { WORK_PACKAGE_EXPORT_LINE_MAX_BYTES } from "../../contracts/src/work-package-runtime-contracts.ts";
import { readWorkPackageExportEvents } from "../src/work-package-export-line-reader.ts";

const HASH = "a".repeat(64);

async function* chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield* values;
}

async function read(input: AsyncIterable<Uint8Array>): Promise<readonly unknown[]> {
  const values: unknown[] = [];
  for await (const value of readWorkPackageExportEvents(input)) values.push(value);
  return values;
}

describe("Work Package export line reader", () => {
  it("parses fragmented UTF-8 NDJSON events", async () => {
    const text = `${JSON.stringify({
      type: "PACKAGE_START",
      manifest: { path: "manifest.json", sha256: HASH, sizeBytes: 10 }
    })}\n`;
    const bytes = Buffer.from(text);
    await expect(read(chunks(bytes.subarray(0, 7), bytes.subarray(7)))).resolves.toEqual([
      {
        type: "PACKAGE_START",
        manifest: { path: "manifest.json", sha256: HASH, sizeBytes: 10 }
      }
    ]);
  });

  it("accepts the exact worst-case canonical chunk line", async () => {
    const text = `${JSON.stringify({
      type: "FILE_CHUNK",
      path: Array.from({ length: 5 }, () => "a".repeat(204)).join("/"),
      sequence: Number.MAX_SAFE_INTEGER,
      dataBase64: `${"A".repeat(1_398_102)}==`
    })}\n`;
    expect(Buffer.byteLength(text)).toBe(WORK_PACKAGE_EXPORT_LINE_MAX_BYTES);
    await expect(read(chunks(Buffer.from(text)))).resolves.toHaveLength(1);
  });

  it("rejects an overlong unterminated line before JSON parsing", async () => {
    const bytes = Buffer.alloc(WORK_PACKAGE_EXPORT_LINE_MAX_BYTES + 1, 0x61);
    await expect(read(chunks(bytes))).rejects.toThrow("EXPORT_LINE_TOO_LARGE");
  });

  it("rejects a final line without LF", async () => {
    await expect(read(chunks(Buffer.from('{"type":"PACKAGE_END"}')))).rejects.toThrow(
      "EXPORT_STREAM_TRUNCATED"
    );
  });

  it("rejects malformed UTF-8 split across chunks", async () => {
    await expect(
      read(chunks(Uint8Array.from([0x7b, 0x22, 0xc3]), Uint8Array.from([0x28, 0x0a])))
    ).rejects.toThrow("EXPORT_UTF8_INVALID");
  });

  it("rejects blank lines and unknown event shapes", async () => {
    await expect(read(chunks(Buffer.from("\n")))).rejects.toThrow("EXPORT_EVENT_INVALID");
    await expect(
      read(chunks(Buffer.from(`${JSON.stringify({ type: "FUTURE_EVENT" })}\n`)))
    ).rejects.toThrow("EXPORT_EVENT_INVALID");
  });

  it("honours cancellation between chunks", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      (async (): Promise<readonly unknown[]> => {
        const values: unknown[] = [];
        for await (const value of readWorkPackageExportEvents(
          chunks(Buffer.from("{}\n")),
          controller.signal
        )) {
          values.push(value);
        }
        return values;
      })()
    ).rejects.toThrow("REQUEST_ABORTED");
  });
});
