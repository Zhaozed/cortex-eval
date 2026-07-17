import { describe, expect, it } from "vitest";

import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import {
  readWorkPackageRestArtifact,
  type WorkPackageRestArtifactSummary
} from "../src/work-package-rest-artifact-reader.ts";

const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-ffffffffffff";
const HASH = "a".repeat(64);

function artifact(cases: readonly unknown[]): string {
  return (
    [
      JSON.stringify({
        recordType: "HEADER",
        contractVersion: "cortex.rest-results-jsonl.v1",
        executionId: EXECUTION_ID,
        packageId: PACKAGE_ID
      }),
      ...cases.map((value) => JSON.stringify({ recordType: "CASE", value })),
      JSON.stringify({
        recordType: "FOOTER",
        completedAt: "2026-07-14T07:01:00.000Z",
        resultSetHash: HASH
      })
    ].join("\n") + "\n"
  );
}

function result(caseKey: string, ordinal: number): unknown {
  return {
    caseKey,
    ordinal,
    caseDefinitionHash: HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: {
      ok: true,
      task_name: "reply",
      resolved_config: {},
      parsed_output: { text: caseKey }
    },
    durationMs: 10,
    completedAt: "2026-07-14T07:01:00.000Z",
    resultHash: HASH,
    provenance: null
  };
}

function* chunks(value: string, size = 7): Generator<Uint8Array> {
  const bytes = Buffer.from(value, "utf8");
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

async function collect(value: string): Promise<{
  readonly cases: readonly { readonly caseKey: string; readonly ordinal: number }[];
  readonly summary: WorkPackageRestArtifactSummary;
}> {
  const reader = readWorkPackageRestArtifact(chunks(value), {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    expectedCaseCount: 2,
    signal: new AbortController().signal
  });
  const cases: { readonly caseKey: string; readonly ordinal: number }[] = [];
  for (;;) {
    const item = await reader.next();
    if (item.done) return { cases, summary: item.value };
    cases.push({ caseKey: item.value.caseKey, ordinal: item.value.ordinal });
  }
}

async function probeCaseByteGate(lineBytes: number, onTail: () => void): Promise<void> {
  const casePrefix = Buffer.from('{"recordType":"CASE","value":{', "utf8");
  function* input(): Generator<Uint8Array> {
    yield Buffer.from(
      `${JSON.stringify({ recordType: "HEADER", contractVersion: "cortex.rest-results-jsonl.v1", packageId: PACKAGE_ID, executionId: EXECUTION_ID })}\n`,
      "utf8"
    );
    yield casePrefix;
    yield Buffer.alloc(lineBytes - casePrefix.byteLength, 0x61);
    onTail();
    yield Buffer.from("}}\n", "utf8");
  }
  const reader = readWorkPackageRestArtifact(input(), {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    expectedCaseCount: 1,
    signal: new AbortController().signal
  });
  for await (const item of reader) {
    void item;
    // The deliberately invalid probe object must never produce a parsed Case.
  }
}

async function drain(
  value: string,
  options: {
    readonly packageId?: string;
    readonly executionId?: string;
    readonly expectedCaseCount?: number;
    readonly expectedSizeBytes?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<void> {
  const reader = readWorkPackageRestArtifact(chunks(value), {
    packageId: options.packageId ?? PACKAGE_ID,
    executionId: options.executionId ?? EXECUTION_ID,
    expectedCaseCount: options.expectedCaseCount ?? 1,
    ...(options.expectedSizeBytes === undefined
      ? {}
      : { expectedSizeBytes: options.expectedSizeBytes }),
    signal: options.signal ?? new AbortController().signal
  });
  for await (const item of reader) void item;
}

describe("P7 Work Package REST Artifact reader", () => {
  it("streams strict Cases and validates the fixed outer identity after the array", async () => {
    const read = await collect(artifact([result("case-1", 0), result("case-2", 1)]));
    expect(read.cases).toEqual([
      { caseKey: "case-1", ordinal: 0 },
      { caseKey: "case-2", ordinal: 1 }
    ]);
    expect(read.summary).toEqual({
      completedAt: "2026-07-14T07:01:00.000Z",
      resultSetHash: HASH
    });
  });

  it("rejects outer identity drift and Case sequence gaps", async () => {
    const wrongIdentity = artifact([result("case-1", 0), result("case-2", 1)]).replace(
      EXECUTION_ID,
      PACKAGE_ID
    );
    await expect(collect(wrongIdentity)).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(collect(artifact([result("case-1", 0), result("case-2", 2)]))).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });

  it("allows exactly 32 MiB through the Case byte gate and rejects the next byte before parse", async () => {
    let exactTailRead = false;
    await expect(
      probeCaseByteGate(WORK_PACKAGE_RUNTIME_LIMITS.restResultCaseBytes, () => {
        exactTailRead = true;
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(exactTailRead).toBe(true);

    let overTailRead = false;
    await expect(
      probeCaseByteGate(WORK_PACKAGE_RUNTIME_LIMITS.restResultCaseBytes + 1, () => {
        overTailRead = true;
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(overTailRead).toBe(false);
  });

  it("rejects malformed expectations, stream grammar, Case facts and trailer facts", async () => {
    const one = artifact([result("case-1", 0)]);
    for (const options of [
      { packageId: "invalid" },
      { executionId: "invalid" },
      { expectedCaseCount: 0 },
      { expectedCaseCount: Number.NaN }
    ]) {
      await expect(drain(one, options)).rejects.toThrow("WORK_PACKAGE_INVALID");
    }

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(drain(one, { signal: cancelled.signal })).rejects.toThrow("REQUEST_ABORTED");

    for (const dirty of [
      "",
      "x",
      '{"cases":}',
      '{"cases":[1]}',
      `{"cases":[${JSON.stringify(result("case-1", 0))};]}`,
      `{"cases":[${JSON.stringify(result("case-1", 0))}`,
      artifact([{}]),
      one.replace('"completedAt"', '"unexpected"'),
      one.replace(PACKAGE_ID, "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1")
    ]) {
      await expect(drain(dirty)).rejects.toThrow("WORK_PACKAGE_INVALID");
    }

    await expect(
      drain(artifact([result("case-1", 0), result("case-1", 1)]), {
        expectedCaseCount: 2
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(
      drain(artifact([result("case-1", 0), result("case-2", 1)]), {
        expectedCaseCount: 1
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    const deep = `{"cases":[{"nested":${"[".repeat(257)}0${"]".repeat(257)}}]}`;
    await expect(drain(deep)).rejects.toThrow("WORK_PACKAGE_INVALID");

    const oversizedHeader = `${JSON.stringify({
      recordType: "HEADER",
      contractVersion: "cortex.rest-results-jsonl.v1",
      packageId: "x".repeat(WORK_PACKAGE_RUNTIME_LIMITS.jsonlControlLineBytes),
      executionId: EXECUTION_ID
    })}\n`;
    await expect(drain(oversizedHeader)).rejects.toThrow("WORK_PACKAGE_INVALID");

    await expect(drain(one, { expectedSizeBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });

  it("preserves cancellation observed after the last input chunk", async () => {
    const controller = new AbortController();
    async function* cancellingInput(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from(artifact([result("case-1", 0)]));
      controller.abort();
    }
    const reader = readWorkPackageRestArtifact(cancellingInput(), {
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      expectedCaseCount: 1,
      signal: controller.signal
    });
    await expect(
      (async (): Promise<void> => {
        for await (const item of reader) void item;
      })()
    ).rejects.toThrow("REQUEST_ABORTED");
  });
});
