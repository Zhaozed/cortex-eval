import { access } from "node:fs/promises";

/** Frozen one-Case fixture shared by the Evaluation run service tests. */
export const evaluationFixtureDefinition = {
  caseKey: "case-1",
  description: "fixture",
  threshold: 1,
  task: "reply",
  requestBody: { text: "hello" },
  metadata: {
    requestId: "req-1",
    taskId: "task-1",
    businessModule: "fixture",
    scenarioTag: "fixture"
  },
  assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
} as const;

/** Build the minimal replayable Engine source required by fake Evaluation engines. */
export function fakeEngineCaseSource(): {
  readonly caseSource: {
    readonly open: () => AsyncIterable<never>;
  };
} {
  return {
    caseSource: {
      open: async function* (): AsyncGenerator<never> {
        yield await Promise.resolve({
          testCase: { caseKey: "case-1", ordinal: 0 },
          restResult: { caseKey: "case-1", status: "SUCCEEDED" }
        } as never);
      }
    }
  };
}

/** Wait until one real child-process marker is visible within the fixed test budget. */
export async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("TEST_PROCESS_START_TIMEOUT");
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}
