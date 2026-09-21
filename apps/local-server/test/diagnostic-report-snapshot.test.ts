import { expect, it } from "vitest";
import type { PlatformReportOverview } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import {
  run,
  successfulResult,
  NOW,
  HASH,
  RUN_ID
} from "../test-support/application-run-handlers-setup.ts";
import {
  reportedRunFixture,
  passingEvaluationFixture,
  importedReportRunFixture
} from "../test-support/application-report-handler-fixtures.ts";
import { createDiagnosticSnapshot } from "../src/diagnostic-report-snapshot.ts";

function fixture(): { overview: PlatformReportOverview; item: PlatformReportArtifactCaseInput } {
  const current = reportedRunFixture(run(), NOW),
    testCase = current.suite.cases[0];
  if (!current.reportSummary || !testCase) throw new Error("FIXTURE_INVALID");
  return {
    overview: { run: current, report: current.reportSummary, artifactAvailability: [] },
    item: {
      testCase,
      rest: successfulResult(true),
      evaluation: passingEvaluationFixture(RUN_ID, testCase.caseKey, HASH, NOW)
    }
  };
}
async function* stream(
  items: PlatformReportArtifactCaseInput[]
): AsyncGenerator<PlatformReportArtifactCaseInput> {
  for (const item of items) yield await Promise.resolve(item);
}
it("preserves PASS with quality failures and redacts input without mutating frozen facts", async () => {
  const { overview, item } = fixture();
  const assertion = item.evaluation.assertions[0];
  if (!assertion) throw new Error("FIXTURE_ASSERTION");
  const changed: PlatformReportArtifactCaseInput = {
    ...item,
    evaluation: {
      ...item.evaluation,
      reason: "Bearer abcdefgh token-private-567",
      assertions: [{ ...assertion, status: "FAIL" as const, reason: "质量告警" }]
    },
    rest: {
      ...item.rest,
      status: "SUCCEEDED" as const,
      httpStatus: 200,
      errorType: null,
      errorMessage: null,
      providerOutput: {
        ok: true,
        taskName: "route",
        resolvedConfig: { authorization: "private-key", api_key: "key-value" },
        parsedOutput: { answer: "token-private-567", log: "x".repeat(20000) }
      }
    }
  };
  const before = JSON.stringify(changed);
  const snapshot = await createDiagnosticSnapshot(
    overview,
    stream([changed]),
    new AbortController().signal,
    ["token-private-567"]
  );
  expect(snapshot.summary.evalPass).toBe(1);
  expect(snapshot.cases[0]?.status).toBe("PASS");
  expect(snapshot.cases[0]?.assertions).toHaveLength(1);
  expect(snapshot.cases[0]?.reason).toContain("[REDACTED]");
  const json = JSON.stringify(snapshot);
  expect(json).not.toContain("private-key");
  expect(json).not.toContain("token-private-567");
  expect(json).not.toContain("abcdefgh");
  expect(snapshot.cases[0]?.evidence.find((e) => e.source === "OUTPUT")?.truncated).toBe(true);
  expect(snapshot.limitations.join()).toContain("已截断");
  expect(JSON.stringify(changed)).toBe(before);
});
it("all-pass cases remain in the full index but do not incur model diagnosis", async () => {
  const { overview, item } = fixture();
  const snapshot = await createDiagnosticSnapshot(
    overview,
    stream([item]),
    new AbortController().signal
  );
  expect(snapshot.caseIndex).toHaveLength(1);
  expect(snapshot.cases).toEqual([]);
});
it("rejects incomplete streams and respects cancellation", async () => {
  const { overview, item } = fixture();
  await expect(
    createDiagnosticSnapshot(overview, stream([]), new AbortController().signal)
  ).rejects.toThrow("DIAG_SNAPSHOT_INCOMPLETE");
  await expect(
    createDiagnosticSnapshot(overview, stream([item]), AbortSignal.abort())
  ).rejects.toThrow();
});
it("imported report does not invent start time or verified deployed revision", async () => {
  const { overview, item } = fixture();
  const imported = importedReportRunFixture({
    current: reportedRunFixture(run(), NOW),
    packageId: RUN_ID,
    executionId: RUN_ID,
    fallbackHash: HASH,
    fallbackTime: NOW
  });
  const snapshot = await createDiagnosticSnapshot(
    { ...overview, run: imported },
    stream([item]),
    new AbortController().signal
  );
  expect(snapshot.startedAt).toBeNull();
  expect(snapshot.agentRevision).toBe("运行版本未验证");
});
