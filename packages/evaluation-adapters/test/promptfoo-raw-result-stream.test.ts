import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { streamPromptfooResultRows } from "../src/promptfoo-raw-result-stream.ts";

describe("Promptfoo Raw result stream", () => {
  it("yields one bounded Row before the remaining document is available", async () => {
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunk = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const source = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        yield Buffer.from(
          '{"results":{"version":3,"results":[{"metadata":{"case_id":"case-1"}}',
          "utf8"
        );
        yield Buffer.from(",{", "utf8");
        await secondChunk;
        yield Buffer.from('"metadata":{"case_id":"case-2"}}]}}', "utf8");
      })()
    );
    const rows = streamPromptfooResultRows(source)[Symbol.asyncIterator]();

    await expect(rows.next()).resolves.toEqual({
      done: false,
      value: { metadata: { case_id: "case-1" } }
    });
    releaseSecondChunk?.();
    await expect(rows.next()).resolves.toEqual({
      done: false,
      value: { metadata: { case_id: "case-2" } }
    });
    await expect(rows.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects an incompatible Promptfoo result version without materializing Rows", async () => {
    const source = Readable.from([Buffer.from('{"results":{"version":2,"results":[]}}', "utf8")]);
    const rows = streamPromptfooResultRows(source)[Symbol.asyncIterator]();

    await expect(rows.next()).rejects.toThrow("PROMPTFOO_PROCESS_OUTPUT_INVALID");
  });
});
