import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  DiagnosticReportSchema,
  type DiagnosticReport,
  type DiagnosticSnapshot,
  type DiagnosisOutput
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import {
  DIAG_RUN,
  DIAG_MODEL,
  DIAG_ID,
  DIAG_HASH,
  diagnosisFixture,
  diagnosticSnapshotFixture,
  diagnosticReportFixture
} from "@cortex-eval/contracts/test-support/diagnostic-report-fixture.ts";
import { DiagnosticReportStore } from "../src/diagnostic-report-store.ts";
import {
  DiagnosticReportService,
  type DiagnosticModelConfig,
  type DiagnosticReportDependencies
} from "../src/diagnostic-report-service.ts";
import { diagnosticReportHtml, diagnosticReportMarkdown } from "../src/diagnostic-report-render.ts";
import { buildLocalServer } from "../src/local-server.ts";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("FIXTURE_MISSING");
  return value;
}
const roots: string[] = [];
const services: DiagnosticReportService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const SYNTHESIS_STUB = (): Promise<{ markdown: string }> =>
  Promise.resolve({
    markdown:
      "这轮反馈可以整理成 1 个根问题、1 个具体表现。共同原因是：结果卡片没有进入最终输出。\n\n**一、结果卡片缺失**\n\n涉及反馈：\n- C1：缺少结果卡片\n\n已确认：\n- 工具回执成功但输出卡片为空\n\n问题本质：\n> 结果卡片没有进入最终输出\n\n影响：\n- 用户看不到结果卡片\n\n修复目标：\n- 检查结果卡片组装与输出路径"
  });

async function setup(
  overrides: Partial<DiagnosticReportDependencies> = {}
): Promise<DiagnosticReportService> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-test-"));
  roots.push(root);
  const service = new DiagnosticReportService({
    store: new DiagnosticReportStore(root),
    ready: (): Promise<boolean> => Promise.resolve(true),
    snapshot: (): Promise<DiagnosticSnapshot> => Promise.resolve(diagnosticSnapshotFixture()),
    configuration: (): Promise<DiagnosticModelConfig> =>
      Promise.resolve({
        identity: diagnosticReportFixture().model,
        definition: {
          providerType: "OPENAI_COMPATIBLE",
          baseUrl: "http://127.0.0.1:1234/v1",
          auth: { kind: "NONE" },
          model: "test",
          structuredOutput: "JSON_SCHEMA",
          thinkingLevel: "OFF",
          temperature: 0,
          topP: 1,
          maxOutputTokens: 1024,
          timeoutMs: 2000
        }
      }),
    model: {
      diagnose: (): Promise<DiagnosisOutput> => Promise.resolve(diagnosisFixture()),
      synthesize: SYNTHESIS_STUB
    },
    ...overrides
  });
  services.push(service);
  return service;
}
async function finished(
  service: DiagnosticReportService,
  id: string
): Promise<ReturnType<typeof diagnosticReportFixture>> {
  await vi.waitFor(async () =>
    expect(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]).toContain(
      (await service.store.get(DIAG_RUN, id)).status
    )
  );
  return service.store.get(DIAG_RUN, id);
}

it("generates asynchronously, freezes facts, appends versions and survives restart", async () => {
  const snapshot = diagnosticSnapshotFixture();
  const service = await setup({ snapshot: () => Promise.resolve(structuredClone(snapshot)) });
  const queued = await service.start(DIAG_RUN, DIAG_MODEL);
  expect(queued.status).toBe("QUEUED");
  const report = await finished(service, queued.id);
  expect(report.status).toBe("COMPLETED");
  expect(report.snapshot?.summary).toEqual(snapshot.summary);
  expect(report.snapshot?.cases[0]?.diagnosis?.evidenceStatus).toBe("SUPPORTED");
  expect(report.snapshot?.cases[0]?.diagnosis?.attribution).toMatchObject({
    domain: "A2UI",
    location: "A2UI_PAYLOAD"
  });
  expect(report.promptVersion).toBe("diagnostic-report.v3");
  expect(report.snapshot?.narrative).toContain("这轮反馈可以整理成");
  expect(report.snapshot?.narrativeError).toBeNull();
  expect(snapshot.cases[0]?.diagnosis).toBeNull();
  const next = await service.start(DIAG_RUN, DIAG_MODEL);
  expect(next.version).toBe(2);
  await finished(service, next.id);
  expect(
    (await new DiagnosticReportStore(service.store.root).get(DIAG_RUN, queued.id)).version
  ).toBe(1);
  expect((await service.store.list(DIAG_RUN)).map((r) => r.version)).toEqual([2, 1]);
  expect(await service.store.list(DIAG_RUN)).not.toHaveProperty("0.snapshot");
});

it("deduplicates concurrent starts, bounds global jobs, and cancellation stops non-cooperative clients", async () => {
  const model = {
    diagnose: vi.fn(() => new Promise<ReturnType<typeof diagnosisFixture>>(() => undefined)),
    synthesize: SYNTHESIS_STUB
  };
  const service = await setup({ model });
  const [a, b] = await Promise.all([
    service.start(DIAG_RUN, DIAG_MODEL),
    service.start(DIAG_RUN, DIAG_MODEL)
  ]);
  expect(a.id).toBe(b.id);
  await expect(service.start(DIAG_RUN, DIAG_ID)).rejects.toThrow("DIAG_BUSY");
  await vi.waitFor(() => expect(model.diagnose).toHaveBeenCalledOnce());
  expect((await service.cancel(DIAG_RUN, a.id)).status).toBe("CANCELLED");
  expect((await service.store.get(DIAG_RUN, a.id)).snapshot?.cases[0]?.status).toBe("FAIL");
});

it("rejects bad evidence citations without losing failure facts", async () => {
  const service = await setup({
    model: {
      diagnose: () => Promise.resolve({ ...diagnosisFixture(), evidenceIds: ["invented.log:20"] }),
      synthesize: SYNTHESIS_STUB
    }
  });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.status).toBe("FAILED");
  expect(result.snapshot?.cases[0]?.diagnosis).toBeNull();
  expect(result.snapshot?.cases[0]?.diagnosisError).toContain("不存在的证据");
  expect(result.snapshot?.cases[0]?.assertions).toHaveLength(1);
});

it.each([
  [[], "INSUFFICIENT"],
  [["C1-E1"], "HYPOTHESIS"]
] as const)("downgrades unsupported certainty with refs %j", async (refs, status) => {
  const service = await setup({
    model: {
      diagnose: () => Promise.resolve({ ...diagnosisFixture(), evidenceIds: [...refs] }),
      synthesize: SYNTHESIS_STUB
    }
  });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.snapshot?.cases[0]?.diagnosis?.evidenceStatus).toBe(status);
});

it("marks partial provider failure and never exposes exception credentials", async () => {
  const snapshot = diagnosticSnapshotFixture();
  snapshot.cases.push({
    ...structuredClone(required(snapshot.cases[0])),
    caseKey: "B09",
    ordinal: 2
  });
  let count = 0;
  const service = await setup({
    snapshot: () => Promise.resolve(snapshot),
    model: {
      diagnose: () => {
        if (++count === 2) throw new Error("Bearer secret-value provider trace");
        return Promise.resolve(diagnosisFixture());
      },
      synthesize: SYNTHESIS_STUB
    }
  });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.status).toBe("PARTIAL");
  expect(result.completedCases).toBe(2);
  expect(JSON.stringify(result)).not.toContain("secret-value");
});

it("all-pass runs produce an honest report without model calls", async () => {
  const snapshot = diagnosticSnapshotFixture();
  snapshot.cases = [];
  const model = {
    diagnose: vi.fn(() => Promise.resolve(diagnosisFixture())),
    synthesize: SYNTHESIS_STUB
  };
  const service = await setup({ snapshot: () => Promise.resolve(snapshot), model });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.status).toBe("COMPLETED");
  expect(model.diagnose).not.toHaveBeenCalled();
  expect(diagnosticReportMarkdown(result)).toContain("未调用模型");
});

it("rejects incomplete reports and missing models before starting a task", async () => {
  const service = await setup({ ready: () => Promise.resolve(false) });
  await expect(service.start(DIAG_RUN, DIAG_MODEL)).rejects.toThrow("DIAG_NOT_READY");
  const noModel = await setup({ configuration: () => Promise.resolve(null) });
  await expect(noModel.start(DIAG_RUN, DIAG_MODEL)).rejects.toThrow("DIAG_MODEL_NOT_FOUND");
  expect(await noModel.store.list(DIAG_RUN)).toEqual([]);
});

it("recovers interrupted durable jobs without silently resuming paid requests", async () => {
  const service = await setup();
  const value = diagnosticReportFixture();
  value.status = "RUNNING";
  await service.store.save(value);
  await new DiagnosticReportStore(service.store.root).recover();
  const result = await service.store.get(DIAG_RUN, value.id);
  expect(result.status).toBe("FAILED");
  expect(result.error).toContain("服务中断");
  expect(result.snapshot).toEqual(value.snapshot);
});

it("exports compact readable facts without assertion/evidence dumps and escapes hostile titles", () => {
  const report = diagnosticReportFixture();
  required(report.snapshot).title = '<img src=x onerror="alert(1)">';
  required(required(required(report.snapshot).cases[0]).evidence[0]).content =
    "```\n<script>alert(2)</script>\n```";
  const markdown = diagnosticReportMarkdown(report),
    html = diagnosticReportHtml(report);
  expect(markdown).toContain("待关注项");
  expect(markdown).not.toContain("全量 Case 索引");
  expect(markdown).not.toContain("事实快照 Hash");
  expect(markdown).not.toContain("冻结证据摘录");
  expect(markdown).not.toContain("| 断言序号 |");
  expect(markdown).not.toContain("````text");
  expect(markdown).not.toContain("<script>alert(2)</script>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("@media print");
});

it("narrative export is human-readable, drops per-case machinery and stays HTML-safe", () => {
  const report = diagnosticReportFixture();
  required(report.snapshot).narrative = [
    "这轮反馈可以整理成 1 个根问题、1 个具体表现。共同原因是：结果卡片没有进入最终输出。",
    "",
    "**一、结果卡片缺失**",
    "",
    "涉及反馈：",
    "- C1：缺少结果卡片",
    "",
    "已确认：",
    "- 工具回执成功但输出卡片为空",
    "",
    "问题本质：",
    "> 结果卡片没有进入最终输出",
    "",
    "影响：",
    "- 用户看不到结果卡片",
    "",
    "修复目标：",
    "- 检查结果卡片组装与输出路径",
    "",
    "```",
    "delete_events('x')",
    "```",
    "<script>alert(3)</script>"
  ].join("\n");
  const markdown = diagnosticReportMarkdown(report);
  const html = diagnosticReportHtml(report);
  expect(markdown).toContain("这轮反馈可以整理成");
  expect(markdown).toContain("**一、结果卡片缺失**");
  expect(markdown).toContain("限制与未覆盖项");
  expect(markdown).not.toContain("问题总表");
  expect(markdown).not.toContain("问题详情与归因");
  expect(markdown).not.toContain("<!--NARRATIVE-->");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("<strong>一、结果卡片缺失</strong>");
  expect(html).toContain("<pre>");
});

it("keeps honest facts when narrative synthesis fails but per-case diagnosis succeeds", async () => {
  const service = await setup({
    model: {
      diagnose: () => Promise.resolve(diagnosisFixture()),
      synthesize: () => Promise.reject(new Error("ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED"))
    }
  });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.status).toBe("COMPLETED");
  expect(result.snapshot?.narrative).toBeNull();
  expect(result.snapshot?.narrativeError).toContain("人话版正文生成失败");
  expect(result.error).toContain("人话版正文生成失败");
  const markdown = diagnosticReportMarkdown(result);
  expect(markdown).toContain("待关注项");
  expect(markdown).toContain("缺少结果卡片");
  expect(markdown).not.toContain("归因未完成");
  expect(markdown).not.toContain("冻结证据摘录");
  expect(markdown).not.toContain("| 断言序号 |");
});

it("writes a human-readable narrative even when part of the cases fail diagnosis", async () => {
  const snapshot = diagnosticSnapshotFixture();
  const first = snapshot.cases[0];
  if (!first) throw new Error("FIXTURE_CASE_MISSING");
  snapshot.cases.push(structuredClone({ ...first, caseKey: "B08-B" }));
  const model = {
    diagnose: vi.fn(({ input }: { input: string }): Promise<DiagnosisOutput> => {
      const parsed = JSON.parse(input) as { caseKey: string };
      if (parsed.caseKey === snapshot.cases[0]?.caseKey)
        return Promise.reject(new Error("ANALYZER_SECRET_MISSING"));
      return Promise.resolve(diagnosisFixture());
    }),
    synthesize: SYNTHESIS_STUB
  };
  const service = await setup({
    snapshot: () => Promise.resolve(structuredClone(snapshot)),
    model
  });
  const report = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(report.status).toBe("PARTIAL");
  expect(report.snapshot?.cases.some((c) => c.diagnosisError !== null)).toBe(true);
  expect(report.snapshot?.narrative).toContain("这轮反馈可以整理成");
  expect(report.snapshot?.narrativeError).toBeNull();
  expect(diagnosticReportMarkdown(report)).toContain("这轮反馈可以整理成");
});

it("degraded export keeps case key and appends scenario and task type", () => {
  const report = diagnosticReportFixture();
  const s = required(report.snapshot);
  s.narrative = null;
  const c = required(s.cases[0]);
  c.evidence.push({
    id: "C1-E0",
    label: "冻结 Case（用户输入与预期）",
    source: "CASE",
    content: JSON.stringify({
      caseKey: "B07",
      description: "[用户整理]｜P0｜B07｜查询会议室空闲情况｜硬性22·质量2",
      task: "agent-e2e",
      requestBody: { text: "帮我看看今天下午会议室谁有空" }
    }),
    truncated: false
  });
  const markdown = diagnosticReportMarkdown(report);
  expect(markdown).toContain("B07 查询会议室空闲情况");
  expect(markdown).toContain("任务类型：agent-e2e");
  expect(markdown).toContain("帮我看看今天下午会议室谁有空");
});

it("narrative pass keeps case key and adds scene and task type, without hashes", async () => {
  const snapshot = diagnosticSnapshotFixture();
  const c = required(snapshot.cases[0]);
  c.evidence.push({
    id: "C1-E0",
    label: "冻结 Case（用户输入与预期）",
    source: "CASE",
    content: JSON.stringify({
      caseKey: "B07",
      description: "[用户整理]｜P0｜B07｜查询会议室空闲情况｜硬性22·质量2",
      task: "agent-e2e",
      requestBody: { text: "帮我看看今天下午会议室谁有空" }
    }),
    truncated: false
  });
  let narrativeInput = "";
  const service = await setup({
    snapshot: () => Promise.resolve(structuredClone(snapshot)),
    model: {
      diagnose: () => Promise.resolve(diagnosisFixture()),
      synthesize: (req: { input: string }) => {
        narrativeInput = req.input;
        return SYNTHESIS_STUB();
      }
    }
  });
  const result = await finished(service, (await service.start(DIAG_RUN, DIAG_MODEL)).id);
  expect(result.snapshot?.narrative).toContain("这轮反馈可以整理成");
  expect(narrativeInput).toContain('"caseKey":"B07"');
  expect(narrativeInput).toContain("查询会议室空闲情况");
  expect(narrativeInput).toContain('"taskType":"agent-e2e"');
  expect(narrativeInput).not.toMatch(new RegExp(DIAG_HASH));
});

it("HTTP routes enforce origin/contracts, expose progress and export and cancel without Run writes", async () => {
  const service = await setup();
  const server = buildLocalServer({
    diagnosticReports: service,
    requestIdGenerator: { nextId: () => DIAG_RUN },
    resourceHandlers: {
      listTestSuites: () =>
        Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
    }
  });
  const headers = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  const url = `/api/v1/runs/${DIAG_RUN}/diagnostic-reports`;
  try {
    expect(
      (
        await server.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://evil.example" },
          payload: { modelConfigId: DIAG_MODEL }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await server.inject({ method: "POST", url, headers, payload: { modelConfigId: "bad" } }))
        .statusCode
    ).toBe(400);
    const created = await server.inject({
      method: "POST",
      url,
      headers,
      payload: { modelConfigId: DIAG_MODEL }
    });
    expect(created.statusCode).toBe(202);
    const report = DiagnosticReportSchema.parse(created.json());
    await finished(service, report.id);
    expect((await server.inject({ url, headers })).json()).toHaveLength(1);
    expect(
      (await server.inject({ url: `${url}/${report.id}`, headers })).json<DiagnosticReport>().status
    ).toBe("COMPLETED");
    const exported = await server.inject({
      url: `${url}/${report.id}/export?format=html`,
      headers
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/html");
    expect(exported.headers["content-security-policy"]).toContain("sandbox");
    expect(
      (await server.inject({ url: `${url}/${report.id}/export?format=exe`, headers })).statusCode
    ).toBe(400);
    expect((await server.inject({ url: `${url}/${DIAG_ID}`, headers })).statusCode).toBe(404);
    const openapi = (await server.inject({ url: "/api/v1/openapi.json", headers })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(openapi.paths["/api/v1/runs/{runId}/diagnostic-reports"]).toBeDefined();
  } finally {
    await server.close();
  }
});
