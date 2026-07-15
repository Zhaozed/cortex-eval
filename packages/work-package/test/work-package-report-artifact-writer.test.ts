import { createHash } from "node:crypto";

import {
  ReportArtifactV1Schema,
  type ReportCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { describe, expect, it } from "vitest";

import type { PublishedImmutableFile } from "../src/secure-work-package-directory.ts";
import type { PublishedStageArtifact } from "../src/work-package-execution-session.ts";
import {
  type ReportComputedFileWriter,
  type CreateWorkPackageReportArtifactWriterInput,
  WorkPackageReportArtifactWriter,
  type WorkPackageReportArtifactSession
} from "../src/work-package-report-artifact-writer.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);
const COMPLETED_AT = "2026-07-15T00:00:00.000Z";

class MemoryWriter implements ReportComputedFileWriter {
  readonly #path: string;
  readonly #commitError: Error | null;
  readonly chunks: Uint8Array[] = [];
  aborted = false;

  public constructor(path: string, commitError: Error | null = null) {
    this.#path = path;
    this.#commitError = commitError;
  }

  public append(value: Uint8Array): Promise<void> {
    this.chunks.push(value);
    return Promise.resolve();
  }

  public commit(): Promise<PublishedImmutableFile> {
    if (this.#commitError !== null) return Promise.reject(this.#commitError);
    const bytes = Buffer.concat(this.chunks);
    return Promise.resolve({
      integrity: {
        path: this.#path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength
      },
      publicationIdentity: { device: "1", inode: this.#path }
    });
  }

  public abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }

  public text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class FakeSession implements WorkPackageReportArtifactSession {
  readonly packageSummary = { packageId: PACKAGE_ID };
  readonly inputs = {
    expectedCaseKey: (ordinal: number): string | null => (ordinal === 0 ? "case-1" : null)
  };
  readonly writers: readonly MemoryWriter[];
  readonly discarded: PublishedStageArtifact[] = [];
  completeError: Error | null = null;
  discardError: Error | null = null;
  completed = false;
  #writerIndex = 0;

  public constructor(writers: readonly MemoryWriter[]) {
    this.writers = writers;
  }

  public createStageArtifactWriter(): Promise<ReportComputedFileWriter> {
    const writer = this.writers[this.#writerIndex];
    this.#writerIndex += 1;
    if (writer === undefined) return Promise.reject(new Error("WRITER_MISSING"));
    return Promise.resolve(writer);
  }

  public completeStage(): Promise<unknown> {
    if (this.completeError !== null) return Promise.reject(this.completeError);
    this.completed = true;
    return Promise.resolve();
  }

  public discardUnregisteredStageArtifact(
    _executionId: string,
    _stageName: "REPORT",
    artifact: PublishedStageArtifact
  ): Promise<void> {
    this.discarded.push(artifact);
    return this.discardError === null ? Promise.resolve() : Promise.reject(this.discardError);
  }
}

function reportCase(): ReportCaseV1 {
  return {
    caseKey: "case-1",
    ordinal: 0,
    definitionHash: HASH,
    definition: {
      contractVersion: "cortex.case-definition.v1",
      description: "fixture",
      threshold: 1,
      vars: { task: "reply", request_body: { text: "hello" } },
      metadata: {
        case_id: "case-1",
        req_id: "req-1",
        task_id: "task-1",
        business_module: "fixture",
        scenario_tag: "fixture"
      },
      assert: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
    },
    rest: {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash: HASH,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: {
        ok: true,
        task_name: "reply",
        resolved_config: {},
        parsed_output: { text: "other" }
      },
      durationMs: 1,
      completedAt: COMPLETED_AT,
      resultHash: HASH,
      provenance: null
    },
    evaluation: {
      caseKey: "case-1",
      ordinal: 0,
      status: "FAIL",
      promptfooSuccess: false,
      score: 0,
      reason: "not matched",
      evaluationError: null,
      assertions: [
        {
          index: 0,
          definitionHash: HASH,
          type: "equals",
          metric: "exact",
          weight: 1,
          status: "FAIL",
          score: 0,
          reason: "not matched"
        }
      ],
      diffs: [],
      metrics: [{ metric: "exact", status: "FAIL" }],
      latencyMs: 1,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      evalResultHash: HASH,
      finalCaseResultHash: HASH,
      provenance: null
    }
  };
}

function input(
  session: FakeSession,
  cleanupEvents: string[]
): CreateWorkPackageReportArtifactWriterInput {
  return {
    session,
    executionId: ID,
    context: {
      contractVersion: "cortex.report-context.v1" as const,
      runContextHash: HASH,
      suite: { sourceId: PACKAGE_ID, name: "fixture", suiteHash: HASH },
      endpoint: {
        sourceId: null,
        name: "endpoint",
        configHash: HASH,
        config: {
          contractVersion: "cortex.endpoint-config.v1" as const,
          urlTemplate: "https://example.com/evaluate",
          method: "POST" as const,
          headers: {},
          bodySelector: "",
          timeoutMs: 1_000,
          defaultConcurrency: 1
        }
      },
      evaluator: {
        sourceId: null,
        name: "evaluator",
        configHash: HASH,
        config: {
          contractVersion: "cortex.llm-config.v1" as const,
          providerType: "GOOGLE_GEMINI" as const,
          model: "gemini-test",
          apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
          thinkingLevel: "OFF" as const,
          temperature: 0,
          topP: 1,
          maxOutputTokens: 128,
          timeoutMs: 1_000,
          structuredOutput: "JSON_OBJECT" as const
        }
      },
      rubricPrompts: [],
      promptfooVersion: "0.121.18" as const,
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1" as const,
        restConcurrency: 1,
        evalConcurrency: 1
      }
    },
    evaluationContextHash: HASH,
    evaluationResultSetHash: HASH,
    aggregation: {
      summary: {
        total: 1,
        restSucceeded: 1,
        restError: 0,
        evalPass: 0,
        evalFail: 1,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 0,
        evaluatedPassRate: 0,
        coverageRate: 1
      },
      byMetric: [
        { metric: "exact", pass: 0, fail: 1, error: 0, skipped: 0, notEvaluated: 0, passRate: 0 }
      ],
      reportResultSetHash: HASH
    },
    completedAt: COMPLETED_AT,
    cleanupFailureSink: {
      record: (event: "REPORT_ARTIFACT_CLEANUP_FAILED"): void => {
        cleanupEvents.push(event);
      }
    }
  };
}

describe("Work Package Report Artifact Writer", () => {
  it("流式生成完整 JSON 与派生 Markdown，并一次登记两个槽位", async () => {
    const json = new MemoryWriter(`executions/${ID}/report.json`);
    const markdown = new MemoryWriter(`executions/${ID}/report.md`);
    const session = new FakeSession([json, markdown]);
    const writer = await WorkPackageReportArtifactWriter.create(input(session, []));
    await writer.append(reportCase());

    await expect(writer.commitStage()).resolves.toHaveLength(2);
    expect(ReportArtifactV1Schema.parse(JSON.parse(json.text()) as unknown).cases).toHaveLength(1);
    expect(markdown.text()).toContain("not matched");
    expect(session.completed).toBe(true);
  });

  it("Markdown 发布失败时精确补偿已发布 JSON", async () => {
    const json = new MemoryWriter(`executions/${ID}/report.json`);
    const markdown = new MemoryWriter(
      `executions/${ID}/report.md`,
      new Error("MARKDOWN_COMMIT_FAILED")
    );
    const session = new FakeSession([json, markdown]);
    const writer = await WorkPackageReportArtifactWriter.create(input(session, []));
    await writer.append(reportCase());

    await expect(writer.commitStage()).rejects.toThrow("MARKDOWN_COMMIT_FAILED");
    expect(session.discarded.map((item) => item.kind)).toEqual(["REPORT_JSON"]);
    expect(session.completed).toBe(false);
  });

  it("阶段登记失败时补偿两个发布物，清理失败不覆盖主错误", async () => {
    const json = new MemoryWriter(`executions/${ID}/report.json`);
    const markdown = new MemoryWriter(`executions/${ID}/report.md`);
    const session = new FakeSession([json, markdown]);
    session.completeError = new Error("REGISTER_FAILED");
    session.discardError = new Error("CLEANUP_FAILED");
    const cleanupEvents: string[] = [];
    const writer = await WorkPackageReportArtifactWriter.create(input(session, cleanupEvents));
    await writer.append(reportCase());

    await expect(writer.commitStage()).rejects.toThrow("REGISTER_FAILED");
    expect(session.discarded.map((item) => item.kind)).toEqual(["REPORT_JSON", "REPORT_MARKDOWN"]);
    expect(cleanupEvents).toEqual([
      "REPORT_ARTIFACT_CLEANUP_FAILED",
      "REPORT_ARTIFACT_CLEANUP_FAILED"
    ]);
  });
});
