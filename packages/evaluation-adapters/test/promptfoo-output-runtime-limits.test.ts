import { describe, expect, it } from "vitest";

import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { validatePromptfooOutputRuntimeLimits } from "../src/promptfoo-output-runtime-limits.ts";

function* chunks(values: readonly Uint8Array[]): Generator<Uint8Array> {
  for (const value of values) yield value;
}

describe("Promptfoo Raw output runtime limits", () => {
  it("finds the fixed v3 result rows across arbitrary chunk boundaries", async () => {
    const value = Buffer.from(
      JSON.stringify({
        results: {
          version: 3,
          results: [{ metadata: { case_id: "case-1" }, response: { output: "ok" } }]
        }
      }),
      "utf8"
    );
    await expect(
      validatePromptfooOutputRuntimeLimits(
        chunks([value.subarray(0, 7), value.subarray(7, 29), value.subarray(29)])
      )
    ).resolves.toBeUndefined();
  });

  it("rejects one Raw Row above 64 MiB before whole-document parsing", async () => {
    const string = Buffer.alloc(16 * 1024 * 1024, 0x61);
    function* oversized(): Generator<Uint8Array> {
      yield Buffer.from('{"results":{"version":3,"results":[{"parts":["', "utf8");
      for (let index = 0; index < 5; index += 1) {
        if (index > 0) yield Buffer.from('","', "utf8");
        yield string;
      }
      yield Buffer.from('"]}]}}', "utf8");
    }
    await expect(validatePromptfooOutputRuntimeLimits(oversized())).rejects.toThrow(
      "PROMPTFOO_PROCESS_ERROR"
    );
  });

  it("accepts a decoded JSON String at 16 MiB and rejects the next byte", async () => {
    const prefix = Buffer.from('{"results":{"version":3,"results":[{"value":"', "utf8");
    const suffix = Buffer.from('"}]}}', "utf8");
    const exact = Buffer.alloc(WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes, 0x61);
    await expect(
      validatePromptfooOutputRuntimeLimits(chunks([prefix, exact, suffix]))
    ).resolves.toBeUndefined();

    const over = Buffer.alloc(WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes + 1, 0x61);
    await expect(
      validatePromptfooOutputRuntimeLimits(chunks([prefix, over, suffix]))
    ).rejects.toThrow("PROMPTFOO_PROCESS_ERROR");
  });
});
