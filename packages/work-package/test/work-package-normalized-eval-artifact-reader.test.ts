import { describe, expect, it } from "vitest";

import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { readWorkPackageNormalizedEvalArtifact } from "../src/work-package-normalized-eval-artifact-reader.ts";

const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const HASH = "a".repeat(64);

function result(caseKey = "case-1", ordinal = 0): unknown {
  return {
    caseKey,
    ordinal,
    status: "NOT_EVALUATED",
    promptfooSuccess: null,
    score: null,
    reason: null,
    evaluationError: null,
    assertions: [],
    diffs: [],
    metrics: [{ metric: "exact", status: "NOT_EVALUATED" }],
    latencyMs: null,
    tokenUsage: null,
    cost: null,
    rawEvidence: null,
    evalResultHash: HASH,
    finalCaseResultHash: HASH,
    provenance: null
  };
}

function artifact(cases: readonly unknown[], executionId = EXECUTION_ID): string {
  return `${JSON.stringify({
    cases,
    completedAt: "2026-07-14T07:03:00.000Z",
    contractVersion: "cortex.normalized-eval.v1",
    evaluationContextHash: HASH,
    executionId,
    packageId: PACKAGE_ID,
    resultSetHash: HASH
  })}\n`;
}

function bytes(executionId = EXECUTION_ID): Buffer {
  return Buffer.from(artifact([result()], executionId), "utf8");
}

async function readAll(value: Buffer): Promise<{
  readonly cases: readonly { readonly caseKey: string; readonly status: string }[];
  readonly summary: { readonly evaluationContextHash: string; readonly resultSetHash: string };
}> {
  const reader = readWorkPackageNormalizedEvalArtifact([value], {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    expectedCaseCount: 1,
    signal: new AbortController().signal
  });
  const cases: { readonly caseKey: string; readonly status: string }[] = [];
  for (;;) {
    const item = await reader.next();
    if (item.done) return { cases, summary: item.value };
    cases.push({ caseKey: item.value.caseKey, status: item.value.status });
  }
}

async function probeCaseByteGate(payloadBytes: number, onTail: () => void): Promise<void> {
  function* input(): Generator<Uint8Array> {
    yield Buffer.from('{"cases":[{', "utf8");
    yield Buffer.alloc(payloadBytes, 0x61);
    onTail();
    yield Buffer.from("}]}", "utf8");
  }
  const reader = readWorkPackageNormalizedEvalArtifact(input(), {
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
    readonly signal?: AbortSignal;
  } = {}
): Promise<void> {
  const reader = readWorkPackageNormalizedEvalArtifact([Buffer.from(value)], {
    packageId: options.packageId ?? PACKAGE_ID,
    executionId: options.executionId ?? EXECUTION_ID,
    expectedCaseCount: options.expectedCaseCount ?? 1,
    signal: options.signal ?? new AbortController().signal
  });
  for await (const item of reader) void item;
}

describe("Work Package Normalized Eval Artifact reader", () => {
  it("streams strict Cases and returns only the bounded envelope", async () => {
    await expect(readAll(bytes())).resolves.toEqual({
      cases: [{ caseKey: "case-1", status: "NOT_EVALUATED" }],
      summary: { evaluationContextHash: HASH, resultSetHash: HASH }
    });
  });

  it("rejects a canonical Artifact owned by another Execution", async () => {
    await expect(readAll(bytes("018f22aa-33bb-7ccc-8ddd-fffffffffff2"))).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });

  it("allows exactly 32 MiB through the Case byte gate and rejects the next byte before parse", async () => {
    let exactTailRead = false;
    await expect(
      probeCaseByteGate(WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes - 1, () => {
        exactTailRead = true;
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(exactTailRead).toBe(true);

    let overTailRead = false;
    await expect(
      probeCaseByteGate(WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes, () => {
        overTailRead = true;
      })
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    expect(overTailRead).toBe(false);
  });

  it("rejects malformed expectations, Case facts, grammar and trailer facts", async () => {
    const one = artifact([result()]);
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
      `{"cases":[${JSON.stringify(result())};]}`,
      `{"cases":[${JSON.stringify(result())}`,
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
  });

  it("preserves cancellation observed after the final chunk", async () => {
    const controller = new AbortController();
    async function* cancellingInput(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from(artifact([result()]));
      controller.abort();
    }
    const reader = readWorkPackageNormalizedEvalArtifact(cancellingInput(), {
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
