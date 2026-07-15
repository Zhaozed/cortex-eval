import type { ReportArtifactV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { describe, expect, it } from "vitest";

import { readWorkPackageReportArtifact } from "../src/work-package-report-artifact-reader.ts";
import type { WorkPackageReportArtifactExpectation } from "../src/work-package-report-artifact-reader.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);
const TIME = "2026-07-15T00:00:00.000Z";

function report(): ReportArtifactV1 {
  return {
    contractVersion: "cortex.report.v1",
    owner: { kind: "EXECUTION", id: ID },
    packageId: PACKAGE_ID,
    completedAt: TIME,
    context: {
      contractVersion: "cortex.report-context.v1",
      runContextHash: HASH,
      suite: { sourceId: PACKAGE_ID, name: null, suiteHash: HASH },
      endpoint: {
        sourceId: null,
        name: null,
        configHash: HASH,
        config: {
          contractVersion: "cortex.endpoint-config.v1",
          urlTemplate: "https://example.test",
          method: "POST",
          headers: {},
          bodySelector: "",
          timeoutMs: 1_000,
          defaultConcurrency: 1
        }
      },
      evaluator: {
        sourceId: null,
        name: null,
        configHash: HASH,
        config: {
          contractVersion: "cortex.llm-config.v1",
          providerType: "GOOGLE_GEMINI",
          model: "gemini-test",
          apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
          thinkingLevel: "OFF",
          temperature: 0,
          topP: 1,
          maxOutputTokens: 128,
          timeoutMs: 1_000,
          structuredOutput: "JSON_OBJECT"
        }
      },
      rubricPrompts: [],
      promptfooVersion: "0.121.18",
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 1,
        evalConcurrency: 1
      }
    },
    evaluationContextHash: HASH,
    evaluationResultSetHash: HASH,
    summary: {
      total: 1,
      restSucceeded: 0,
      restError: 1,
      evalPass: 0,
      evalFail: 0,
      evalError: 0,
      notEvaluated: 1,
      effectivePassRate: 0,
      evaluatedPassRate: null,
      coverageRate: 0
    },
    byMetric: [],
    cases: [
      {
        caseKey: "case-1",
        ordinal: 0,
        definitionHash: HASH,
        definition: {
          contractVersion: "cortex.case-definition.v1",
          description: "fixture",
          threshold: 1,
          vars: { task: "reply", request_body: {} },
          metadata: {
            case_id: "case-1",
            req_id: "req-1",
            task_id: "task-1",
            business_module: "fixture",
            scenario_tag: "basic"
          },
          assert: [{ type: "contains", metric: "quality", value: "ok" }]
        },
        rest: {
          caseKey: "case-1",
          ordinal: 0,
          caseDefinitionHash: HASH,
          status: "ERROR",
          httpStatus: null,
          providerOutput: null,
          error: { type: "NETWORK", message: "network" },
          durationMs: 1,
          completedAt: TIME,
          resultHash: HASH,
          provenance: null
        },
        evaluation: {
          caseKey: "case-1",
          ordinal: 0,
          status: "NOT_EVALUATED",
          promptfooSuccess: null,
          score: null,
          reason: null,
          evaluationError: null,
          assertions: [],
          diffs: [],
          metrics: [],
          latencyMs: null,
          tokenUsage: null,
          cost: null,
          rawEvidence: null,
          evalResultHash: HASH,
          finalCaseResultHash: HASH,
          provenance: null
        }
      }
    ],
    reportResultSetHash: HASH
  };
}

function chunks(value: Uint8Array, size = 7): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      for (let offset = 0; offset < value.byteLength; offset += size) {
        yield value.subarray(offset, offset + size);
      }
    }
  };
}

async function consumeReport(
  bytes: Uint8Array,
  overrides: Partial<WorkPackageReportArtifactExpectation> = {}
): Promise<void> {
  const expectation: WorkPackageReportArtifactExpectation = {
    packageId: PACKAGE_ID,
    executionId: ID,
    expectedCaseCount: 1,
    expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-1" : null),
    signal: new AbortController().signal,
    ...overrides
  };
  for await (const item of readWorkPackageReportArtifact(chunks(bytes), expectation)) void item;
}

describe("Work Package Report Artifact 流式读取", () => {
  it("跨任意 Chunk 边界逐 Case 读取并只在完整尾部后返回外层事实", async () => {
    const value = report();
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const reader = readWorkPackageReportArtifact(chunks(bytes), {
      packageId: PACKAGE_ID,
      executionId: ID,
      expectedCaseCount: 1,
      expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-1" : null),
      signal: new AbortController().signal
    });
    const cases = [];
    let envelope: Awaited<ReturnType<typeof reader.next>>["value"] | undefined;
    for (;;) {
      const step = await reader.next();
      if (step.done) {
        envelope = step.value;
        break;
      }
      cases.push(step.value);
    }
    expect(cases).toEqual(value.cases);
    expect(envelope).toMatchObject({
      context: value.context,
      summary: value.summary,
      byMetric: value.byMetric,
      reportResultSetHash: value.reportResultSetHash
    });
  });

  it("拒绝错序身份、截断尾部和取消", async () => {
    const value = report();
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const consume = async (
      input: AsyncIterable<Uint8Array>,
      signal = new AbortController().signal
    ): Promise<void> => {
      for await (const _item of readWorkPackageReportArtifact(input, {
        packageId: PACKAGE_ID,
        executionId: ID,
        expectedCaseCount: 1,
        expectedCaseKey: () => "wrong",
        signal
      }))
        void _item;
    };
    await expect(consume(chunks(bytes))).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(consume(chunks(bytes.subarray(0, -2)))).rejects.toThrow("WORK_PACKAGE_INVALID");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(consume(chunks(bytes), cancelled.signal)).rejects.toThrow("REQUEST_ABORTED");
  });

  it("在读取前拒绝非法固定身份和 Case 数量", async () => {
    const bytes = Buffer.from(JSON.stringify(report()), "utf8");
    await expect(consumeReport(bytes, { packageId: "invalid" })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    await expect(consumeReport(bytes, { executionId: "invalid" })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
    await expect(consumeReport(bytes, { expectedCaseCount: 0 })).rejects.toThrow(
      "WORK_PACKAGE_INVALID"
    );
  });

  it("拒绝与固定执行身份或汇总数量不一致的 Report 包络", async () => {
    const value = report();
    const mismatches: ReportArtifactV1[] = [
      { ...value, owner: { kind: "RUN", id: ID } },
      { ...value, owner: { kind: "EXECUTION", id: PACKAGE_ID } },
      { ...value, packageId: ID },
      { ...value, summary: { ...value.summary, total: 2 } }
    ];
    for (const mismatch of mismatches) {
      await expect(consumeReport(Buffer.from(JSON.stringify(mismatch), "utf8"))).rejects.toThrow(
        "WORK_PACKAGE_INVALID"
      );
    }
  });

  it("拒绝非规范数组、非法 Case、过深 JSON 和不完整包络", async () => {
    const json = JSON.stringify(report());
    const malformed: readonly (readonly [string, string])[] = [
      ["非法数组成员", json.replace('"cases":[{', '"cases":[null,{')],
      ["非法 Case Schema", json.replace('"caseKey":"case-1"', '"caseKey":1')],
      ["缺少 Case 数组结尾", json.replace('}],"reportResultSetHash"', '},"reportResultSetHash"')],
      ["尾逗号", json.replace('}],"reportResultSetHash"', '},],"reportResultSetHash"')],
      ["截断 Case", json.replace('"cases":[{', '"cases":[')],
      [
        "过深 JSON",
        json.replace('"request_body":{}', `"request_body":${"[".repeat(257)}null${"]".repeat(257)}`)
      ],
      ["尾部垃圾", `${json} trailing`]
    ];
    for (const [name, invalidJson] of malformed) {
      try {
        await consumeReport(Buffer.from(invalidJson, "utf8"));
      } catch (error) {
        expect(error).toMatchObject({ message: "WORK_PACKAGE_INVALID" });
        continue;
      }
      throw new Error(`INVALID_REPORT_ACCEPTED:${name}`);
    }
  });
});
