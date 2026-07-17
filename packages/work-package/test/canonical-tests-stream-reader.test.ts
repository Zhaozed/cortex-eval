import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { describe, expect, it } from "vitest";

import { readCanonicalTests } from "../src/canonical-tests-stream-reader.ts";

function testCase(caseKey: string): CaseDefinitionV1 {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: "streamed case",
    threshold: 1,
    vars: { task: "evaluate", request_body: { text: "hello" } },
    metadata: {
      case_id: caseKey,
      req_id: `req-${caseKey}`,
      task_id: `task-${caseKey}`,
      business_module: "reader",
      scenario_tag: "fragmented"
    },
    assert: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
  };
}

async function* fragmented(value: Uint8Array): AsyncIterable<Uint8Array> {
  for (let index = 0; index < value.byteLength; index += 3) {
    await Promise.resolve();
    yield value.subarray(index, index + 3);
  }
}

async function collect(input: AsyncIterable<Uint8Array>): Promise<readonly CaseDefinitionV1[]> {
  const result: CaseDefinitionV1[] = [];
  for await (const item of readCanonicalTests(input)) result.push(item);
  return result;
}

describe("Canonical Tests streaming reader", () => {
  it("parses fragmented UTF-8 JSONL in exact source order", async () => {
    const cases = [testCase("case-1"), testCase("case-2")];
    const bytes = Buffer.from(`${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
    await expect(collect(fragmented(bytes))).resolves.toEqual(cases);
  });

  it("rejects truncation, trailing data and dirty Case objects", async () => {
    const valid = JSON.stringify(testCase("case-1"));
    await expect(collect(fragmented(Buffer.from(valid)))).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(collect(fragmented(Buffer.from(`${valid}\nfalse\n`)))).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    await expect(
      collect(
        fragmented(Buffer.from(`${JSON.stringify({ ...testCase("case-1"), extra: true })}\n`))
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("checks the raw Case byte ceiling before JSON materialization", async () => {
    const oversized = Buffer.alloc(WORK_PACKAGE_RUNTIME_LIMITS.canonicalCaseBytes + 1, 0x20);
    const prefix = Buffer.from('{"contractVersion":"cortex.case-definition.v1","description":"');
    const suffix = Buffer.from('"}\n');
    async function* input(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield prefix;
      yield oversized;
      yield suffix;
    }
    await expect(collect(input())).rejects.toThrow("WORK_PACKAGE_INVALID");
  });

  it("honors cancellation without parsing later bytes", async () => {
    const controller = new AbortController();
    async function* input(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from("{");
      controller.abort();
      yield Buffer.from(`${JSON.stringify(testCase("case-1"))}\n`);
    }
    const result: CaseDefinitionV1[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const item of readCanonicalTests(input(), controller.signal)) result.push(item);
      })()
    ).rejects.toThrow("REQUEST_ABORTED");
    expect(result).toEqual([]);
  });
});
