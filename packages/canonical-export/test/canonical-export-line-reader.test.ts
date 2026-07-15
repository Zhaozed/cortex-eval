import { WORK_PACKAGE_EXPORT_LINE_MAX_BYTES } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { describe, expect, it } from "vitest";

import { readCanonicalExportEvents } from "../src/canonical-export-line-reader.ts";

const EXPORT_ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const START = JSON.stringify({
  type: "EXPORT_START",
  exportId: EXPORT_ID,
  manifest: { path: "manifest.json", sha256: HASH, sizeBytes: 0 }
});

async function* chunks(...values: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield* values;
}

async function collect(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<readonly unknown[]> {
  const result: unknown[] = [];
  for await (const event of readCanonicalExportEvents(input, signal)) result.push(event);
  return result;
}

describe("Canonical Export 事件行读取", () => {
  it("支持跨 Chunk 行和同一 Chunk 多行", async () => {
    const split = Math.floor(START.length / 2);
    const first = Buffer.from(START.slice(0, split));
    const second = Buffer.from(`${START.slice(split)}\n${START}\n`);

    await expect(collect(chunks(first, second))).resolves.toEqual([
      expect.objectContaining({ type: "EXPORT_START", exportId: EXPORT_ID }),
      expect.objectContaining({ type: "EXPORT_START", exportId: EXPORT_ID })
    ]);
  });

  it("拒绝空行、非法 JSON、非法 UTF-8 和未知事件", async () => {
    await expect(collect(chunks(Buffer.from("\n")))).rejects.toThrow(
      "CANONICAL_EXPORT_EVENT_INVALID"
    );
    await expect(collect(chunks(Buffer.from("{\n")))).rejects.toThrow(
      "CANONICAL_EXPORT_EVENT_INVALID"
    );
    await expect(collect(chunks(Buffer.from([0xff, 0x0a])))).rejects.toThrow(
      "CANONICAL_EXPORT_EVENT_INVALID"
    );
    await expect(
      collect(chunks(Buffer.from(`${JSON.stringify({ type: "UNKNOWN" })}\n`)))
    ).rejects.toThrow("CANONICAL_EXPORT_EVENT_INVALID");
  });

  it("拒绝无 LF 结尾的截断流和两种超长边界", async () => {
    await expect(collect(chunks(Buffer.from(START)))).rejects.toThrow(
      "CANONICAL_EXPORT_STREAM_TRUNCATED"
    );
    const oversized = Buffer.alloc(WORK_PACKAGE_EXPORT_LINE_MAX_BYTES, 0x61);
    await expect(collect(chunks(oversized))).rejects.toThrow("CANONICAL_EXPORT_LINE_TOO_LARGE");
    await expect(collect(chunks(Buffer.concat([oversized, Buffer.from("\n")])))).rejects.toThrow(
      "CANONICAL_EXPORT_LINE_TOO_LARGE"
    );
  });

  it("在读取前和 Chunk 边界都遵守取消", async () => {
    const before = new AbortController();
    before.abort();
    await expect(collect(chunks(Buffer.from(`${START}\n`)), before.signal)).rejects.toThrow(
      "REQUEST_ABORTED"
    );

    const during = new AbortController();
    const input = async function* (): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from(`${START}\n`);
      during.abort();
      yield Buffer.from(`${START}\n`);
    };
    await expect(collect(input(), during.signal)).rejects.toThrow("REQUEST_ABORTED");
  });
});
