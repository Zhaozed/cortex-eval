import { describe, expect, it } from "vitest";

import type {
  FrozenRunCase,
  RestCaseExecutionResult,
  RestExecutionInput,
  RestExecutor
} from "../src/features/runs/run-rest-models.ts";
import {
  OfflineRestExecutionService,
  type OfflineRestCaseResult,
  type OfflineRestExecutionInput
} from "../src/features/runs/offline-rest-execution-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function frozenCase(caseKey: string, ordinal: number, definitionHash: string): FrozenRunCase {
  return {
    caseKey,
    ordinal,
    definitionHash,
    definition: {
      caseKey,
      description: caseKey,
      threshold: 1,
      task: "reply",
      requestBody: { text: caseKey },
      metadata: {
        requestId: `request-${caseKey}`,
        taskId: `task-${caseKey}`,
        businessModule: "module",
        scenarioTag: "scenario"
      },
      assertions: [{ type: "equals", metric: "quality", weight: 1, value: caseKey }]
    }
  };
}

function success(caseKey: string, ordinal: number): RestCaseExecutionResult {
  return {
    caseKey,
    ordinal,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: {},
      parsedOutput: { text: caseKey }
    },
    errorType: undefined,
    durationMs: 10
  };
}

const endpoint = {
  urlTemplate: "https://example.com/evaluate",
  method: "POST" as const,
  headers: { "Content-Type": { kind: "LITERAL" as const, value: "application/json" } },
  bodySelector: "/request_body",
  timeoutMs: 60_000,
  defaultConcurrency: 2
};

function service(executor: RestExecutor): OfflineRestExecutionService {
  let tick = 0;
  return new OfflineRestExecutionService({
    restExecutor: executor,
    clock: { now: (): string => `2026-07-14T07:00:0${tick++}.000Z` },
    messageResolver: { message: (code): string => code }
  });
}

function input(
  onOrderedResult: (result: OfflineRestCaseResult) => Promise<void>
): OfflineRestExecutionInput {
  return {
    executionId: EXECUTION_ID,
    cases: [frozenCase("case-1", 0, HASH_A), frozenCase("case-2", 1, HASH_B)],
    expectedCaseCount: 2,
    endpoint,
    concurrency: 2,
    signal: new AbortController().signal,
    reusedResults: [],
    onOrderedResult
  };
}

describe("offline REST execution service", () => {
  it("normalizes, hashes and flushes concurrent results in frozen Case order", async () => {
    const executor: RestExecutor = {
      execute: async (execution: RestExecutionInput) => {
        const second = execution.onResult(success("case-2", 1));
        const first = execution.onResult(success("case-1", 0));
        await Promise.all([second, first]);
        return { dispatchedCount: 2 };
      }
    };
    const ordered: OfflineRestCaseResult[] = [];
    const result = await service(executor).execute(
      input((item): Promise<void> => {
        ordered.push(item);
        return Promise.resolve();
      })
    );
    expect(ordered.map((item) => item.caseKey)).toEqual(["case-1", "case-2"]);
    expect(ordered.every((item) => /^[a-f0-9]{64}$/.test(item.resultHash))).toBe(true);
    expect(result).toMatchObject({ caseCount: 2 });
    expect(result.resultSetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("backpressures an out-of-order worker until the missing ordinal is durably consumed", async () => {
    let secondSettledBeforeFirst = false;
    const executor: RestExecutor = {
      execute: async (execution: RestExecutionInput) => {
        let firstSubmitted = false;
        const second = execution.onResult(success("case-2", 1)).then(() => {
          if (!firstSubmitted) secondSettledBeforeFirst = true;
        });
        await Promise.resolve();
        firstSubmitted = true;
        const first = execution.onResult(success("case-1", 0));
        await Promise.all([second, first]);
        return { dispatchedCount: 2 };
      }
    };
    await service(executor).execute(input(() => Promise.resolve()));
    expect(secondSettledBeforeFirst).toBe(false);
  });

  it("rejects an incomplete executor result set instead of publishing a partial stage", async () => {
    const executor: RestExecutor = {
      execute: async (execution: RestExecutionInput) => {
        await execution.onResult(success("case-1", 0));
        return { dispatchedCount: 1 };
      }
    };
    await expect(service(executor).execute(input(() => Promise.resolve()))).rejects.toThrow(
      "ARTIFACT_WRITE_FAILED"
    );
  });

  it("starts bounded REST batches before consuming the complete Case stream", async () => {
    let yielded = 0;
    let firstBatchYieldedCount = 0;
    async function* cases(): AsyncGenerator<FrozenRunCase> {
      for (let ordinal = 0; ordinal < 5; ordinal += 1) {
        yielded += 1;
        yield await Promise.resolve(
          frozenCase(`case-${ordinal + 1}`, ordinal, ordinal % 2 === 0 ? HASH_A : HASH_B)
        );
      }
    }
    const executor: RestExecutor = {
      execute: async (execution: RestExecutionInput) => {
        if (firstBatchYieldedCount === 0) firstBatchYieldedCount = yielded;
        await Promise.all(
          execution.cases.map((item) => execution.onResult(success(item.caseKey, item.ordinal)))
        );
        return { dispatchedCount: execution.cases.length };
      }
    };
    await service(executor).execute({
      ...input(() => Promise.resolve()),
      cases: cases(),
      expectedCaseCount: 5
    });
    expect(firstBatchYieldedCount).toBe(2);
  });
});
