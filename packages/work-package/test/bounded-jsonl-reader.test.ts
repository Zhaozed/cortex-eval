import { describe, expect, it } from "vitest";

import { jsonlTotalByteLimit, readBoundedJsonlLines } from "../src/bounded-jsonl-reader.ts";

const activeSignal = new AbortController().signal;

async function collect(
  chunks: Iterable<Uint8Array>,
  overrides: Partial<Parameters<typeof readBoundedJsonlLines>[1]> = {}
): Promise<readonly unknown[]> {
  const values: unknown[] = [];
  for await (const line of readBoundedJsonlLines(chunks, {
    maxLineBytes: 64,
    maxTotalBytes: 128,
    signal: activeSignal,
    ...overrides
  })) {
    values.push(line.value);
  }
  return values;
}

describe("Bounded JSONL reader", () => {
  it("reads fragmented canonical lines and checks the registered size", async () => {
    await expect(
      collect([Buffer.from('{"a":'), Buffer.from("1}\n")], { expectedSizeBytes: 8 })
    ).resolves.toEqual([{ a: 1 }]);
    await expect(collect([Buffer.from('{"a":1}\n')], { expectedSizeBytes: 9 })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });

  it("applies the phase-aware line limit before parsing or reading the tail", async () => {
    let tailRead = false;
    function* input(): Generator<Uint8Array> {
      yield Buffer.from('{"padding":"', "utf8");
      yield Buffer.alloc(64, 0x61);
      tailRead = true;
      yield Buffer.from('"}\n', "utf8");
    }

    await expect(
      collect(input(), {
        maxLineBytes: (lineIndex): number => (lineIndex === 0 ? 16 : 64),
        maxTotalBytes: 128
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(tailRead).toBe(false);
  });

  it.each([
    [Buffer.from("\n")],
    [Buffer.from("{}\r\n")],
    [Buffer.from([0xff, 0x0a])],
    [Buffer.from("x\n")],
    [Buffer.from("{}")],
    [Buffer.from("{}\n{}\n")]
  ])("rejects non-canonical or over-total bytes", async (...chunks) => {
    await expect(collect(chunks, { maxTotalBytes: 5 })).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it.each([
    { maxLineBytes: 0 },
    { maxLineBytes: Number.NaN },
    { maxTotalBytes: 0 },
    { maxTotalBytes: Number.NaN },
    { expectedSizeBytes: 0 },
    { expectedSizeBytes: Number.NaN },
    { expectedSizeBytes: 129 }
  ])("rejects invalid limits %#", async (overrides) => {
    await expect(collect([], overrides)).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("rejects unsafe total-limit inputs", () => {
    for (const values of [
      [0, 1],
      [Number.NaN, 1],
      [1, 0],
      [1, Number.NaN],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
    ] as const) {
      expect(() => jsonlTotalByteLimit(values[0], values[1])).toThrow("WORK_PACKAGE_INVALID");
    }
    expect(jsonlTotalByteLimit(1, 1)).toBeGreaterThan(1);
  });

  it("rejects an invalid phase-aware line limit", async () => {
    await expect(collect([Buffer.from("{}\n")], { maxLineBytes: (): number => 0 })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });
});
