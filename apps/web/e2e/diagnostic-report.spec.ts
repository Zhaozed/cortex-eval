import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeCompletedOfflineReport } from "../test-support/offline-report-e2e-fixture.ts";

/** Browser runtime failures collected independently from visible assertions. */
interface BrowserDiagnostics {
  /** Console error messages. */
  readonly consoleErrors: string[];
  /** Unhandled browser errors. */
  readonly pageErrors: string[];
}

/** One resource identity returned by the strict local API. */
interface CreatedResource {
  /** UUIDv7 resource identity. */
  readonly id: string;
}

const stubs: Server[] = [];
const packageRoots: string[] = [];

test.afterEach(async () => {
  await Promise.all([
    ...stubs.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        })
    ),
    ...packageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  ]);
});

// Collect browser failures before application scripts execute.
async function collectBrowserDiagnostics(page: Page): Promise<BrowserDiagnostics> {
  const diagnostics: BrowserDiagnostics = { consoleErrors: [], pageErrors: [] };
  page.on("console", (event) => {
    if (event.type() === "error")
      diagnostics.consoleErrors.push(`${event.text()} (${event.location().url})`);
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  await page.addInitScript(() => {
    const target = window as typeof window & { __cortexCspViolations?: string[] };
    target.__cortexCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      target.__cortexCspViolations?.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  });
  return diagnostics;
}

// Start the real REST dependency used by the browser-created platform Run.
async function startRestStub(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        task_name: "browser-e2e",
        resolved_config: { source: "stub" },
        parsed_output: { reply_text: "ok" }
      })
    );
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("E2E_STUB_ADDRESS_INVALID");
  return `http://127.0.0.1:${address.port}`;
}

// Decode only the small identity required from an untrusted setup response.
async function createdResource(
  response: Awaited<ReturnType<APIRequestContext["post"]>>
): Promise<CreatedResource> {
  expect(response.status()).toBe(201);
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("id" in body) || typeof body.id !== "string") {
    throw new Error("E2E_RESOURCE_ID_INVALID");
  }
  return { id: body.id };
}

// Decode only the imported Run identity required by browser navigation assertions.
async function importedRunId(
  response: Awaited<ReturnType<APIRequestContext["post"]>>
): Promise<string> {
  expect(response.status()).toBe(201);
  const body: unknown = await response.json();
  if (
    body === null ||
    typeof body !== "object" ||
    !("runId" in body) ||
    typeof body.runId !== "string"
  ) {
    throw new Error("E2E_IMPORTED_RUN_ID_INVALID");
  }
  return body.runId;
}

test("归因报告：平台运行全通过，无模型调用", async ({ page, request }, testInfo) => {
  const diagnostics = await collectBrowserDiagnostics(page);
  const prefix = `run-${testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase()}`;
  const suiteName = `${prefix}-suite`;
  const endpointName = `${prefix}-endpoint`;
  const evaluatorName = `${prefix}-evaluator`;
  const origin = await startRestStub();

  const suite = await createdResource(
    await request.post("/api/v1/test-suites", {
      data: { name: suiteName, description: "E2E REST 运行闭环" }
    })
  );
  await createdResource(
    await request.post("/api/v1/endpoint-configs", {
      data: {
        name: endpointName,
        definition: {
          contractVersion: "cortex.endpoint-config.v1",
          urlTemplate: `${origin}/run/{{vars.task}}`,
          method: "POST",
          headers: { "Content-Type": { kind: "LITERAL", value: "application/json" } },
          bodySelector: "/request_body",
          timeoutMs: 1_000,
          defaultConcurrency: 3
        }
      }
    })
  );
  await createdResource(
    await request.post("/api/v1/llm-configs", {
      data: {
        name: evaluatorName,
        definition: {
          contractVersion: "cortex.llm-config.v1",
          providerType: "GOOGLE_GEMINI",
          model: "gemini-e2e",
          thinkingLevel: "OFF",
          temperature: 0,
          topP: 1,
          maxOutputTokens: 128,
          timeoutMs: 1_000,
          structuredOutput: "JSON_SCHEMA",
          apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
        }
      }
    })
  );
  const caseResponse = await request.post(`/api/v1/test-suites/${suite.id}/cases`, {
    data: {
      expectedSuiteRevision: 0,
      definition: {
        contractVersion: "cortex.case-definition.v1",
        description: "浏览器真实 REST Case",
        threshold: 1,
        vars: { task: "browser-e2e", request_body: { input: "hello" } },
        metadata: {
          case_id: "browser-case",
          req_id: "browser-request",
          task_id: "browser-task",
          business_module: "e2e",
          scenario_tag: "rest"
        },
        assert: [{ type: "contains", metric: "quality", value: "ok", weight: 1 }]
      }
    }
  });
  expect(caseResponse.status()).toBe(201);

  await page.goto("/runs");
  await page.getByRole("button", { name: "新建运行" }).click();
  await page.getByLabel("测试集").selectOption({ label: suiteName });
  await page.getByLabel("Endpoint 配置").selectOption({ label: endpointName });
  await page.getByLabel("Evaluator LLM").selectOption({ label: evaluatorName });
  await page.getByRole("button", { name: "运行前检查" }).click();
  await expect(page.getByLabel("运行前检查事实")).toContainText("1 Cases");
  await expect(page.getByLabel("REST 并发")).toHaveValue("3");
  await page.getByRole("button", { name: "创建运行" }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: suiteName })).toBeVisible();
  await page.getByRole("button", { name: "继续阶段 · REST" }).click();
  await expect(page.getByRole("heading", { name: "Case 结果", exact: true })).toBeVisible();
  await expect(page.getByText("browser-case", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "评测进度" }).getByText("评测 1/1", { exact: false })
  ).toBeVisible({
    timeout: 45_000
  });
  await expect(page.getByRole("button", { name: "通过 1", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "生成归因报告", exact: true }).click();
  const diagnostic = page.getByRole("dialog", { name: "评测归因报告" });
  await expect(diagnostic.getByLabel("报告分析模型")).toHaveValue(/.+/);
  await diagnostic.getByRole("button", { name: "生成报告", exact: true }).click();
  await expect(diagnostic.getByRole("article", { name: "归因报告正文" })).toContainText(
    "本次没有待归因项，未调用模型"
  );
  await diagnostic.getByRole("button", { name: "关闭", exact: true }).click();

  expect(diagnostics.pageErrors).toEqual([]);
});

test("归因报告：真实离线失败报告、导出与历史版本", async ({ page, request }, testInfo) => {
  const diagnostics = await collectBrowserDiagnostics(page);
  const suiteName = `offline-report-${testInfo.project.name}-suite`;
  const endpointName = `offline-report-${testInfo.project.name}-endpoint`;
  const evaluatorName = `offline-report-${testInfo.project.name}-evaluator`;
  const analyzerName = `offline-report-${testInfo.project.name}-analyzer`;

  const suite = await createdResource(
    await request.post("/api/v1/test-suites", {
      data: { name: suiteName, description: "离线 Report 导入真实 E2E" }
    })
  );
  const endpoint = await createdResource(
    await request.post("/api/v1/endpoint-configs", {
      data: {
        name: endpointName,
        definition: {
          contractVersion: "cortex.endpoint-config.v1",
          urlTemplate: "https://example.test/offline/{{vars.task}}",
          method: "POST",
          headers: {},
          bodySelector: "/request_body",
          timeoutMs: 1_000,
          defaultConcurrency: 2
        }
      }
    })
  );
  const llmDefinition = {
    contractVersion: "cortex.llm-config.v1" as const,
    providerType: "GOOGLE_GEMINI" as const,
    model: "gemini-e2e",
    thinkingLevel: "OFF" as const,
    temperature: 0,
    topP: 1,
    maxOutputTokens: 128,
    timeoutMs: 1_000,
    structuredOutput: "JSON_SCHEMA" as const,
    apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
  };
  const evaluator = await createdResource(
    await request.post("/api/v1/llm-configs", {
      data: { name: evaluatorName, definition: llmDefinition }
    })
  );
  const analyzer = await createdResource(
    await request.post("/api/v1/llm-configs", {
      data: { name: analyzerName, definition: llmDefinition }
    })
  );
  const analysisPrompt = await createdResource(
    await request.post("/api/v1/case-analysis-prompts", {
      data: {
        name: `offline-report-${testInfo.project.name}-analysis`,
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "CASE_ANALYSIS",
          promptKey: `analysis-${testInfo.project.name}`,
          messages: [{ role: "USER", content: "Analyze {{run_context}}" }]
        }
      }
    })
  );
  const caseResponse = await request.post(`/api/v1/test-suites/${suite.id}/cases`, {
    data: {
      expectedSuiteRevision: 0,
      definition: {
        contractVersion: "cortex.case-definition.v1",
        description: "离线 Report E2E Case",
        threshold: 1,
        vars: { task: "offline-report", request_body: { input: "hello" } },
        metadata: {
          case_id: "offline-report-case",
          req_id: "offline-report-request",
          task_id: "offline-report-task",
          business_module: "e2e",
          scenario_tag: "offline-report"
        },
        assert: [{ type: "contains", metric: "quality", value: "ok", weight: 1 }]
      }
    }
  });
  expect(caseResponse.status()).toBe(201);

  const exportResponse = await request.post("/api/v1/work-packages/export", {
    data: {
      suiteId: suite.id,
      endpointConfigId: endpoint.id,
      evaluatorConfigId: evaluator.id,
      analyzerConfigId: analyzer.id,
      analysisPromptId: analysisPrompt.id
    }
  });
  expect(exportResponse.status()).toBe(200);
  const packageRoot = await mkdtemp(join(tmpdir(), "cortex-web-offline-report-e2e-"));
  packageRoots.push(packageRoot);
  const packagePath = join(packageRoot, "package");
  const executionId =
    testInfo.project.name === "desktop-1440"
      ? "01900000-0000-7000-8000-000000000111"
      : "01900000-0000-7000-8000-000000000112";
  await materializeCompletedOfflineReport({
    exportBody: await exportResponse.body(),
    packagePath,
    executionId,
    evaluationStatus: "FAIL"
  });
  const runId = await importedRunId(
    await request.post("/api/v1/execution-results/import", {
      data: {
        contractVersion: "cortex.execution-report-import-request.v1",
        packagePath,
        executionId
      }
    })
  );

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("heading", { name: "Case 结果", exact: true })).toBeVisible();
  // Real imported report -> durable diagnostic job -> browser preview and exports.
  await page.getByRole("button", { name: "生成归因报告", exact: true }).click();
  const diagnostic = page.getByRole("dialog", { name: "评测归因报告" });
  await diagnostic.getByLabel("报告分析模型").selectOption(analyzer.id);
  await diagnostic.getByRole("button", { name: "生成报告", exact: true }).click();
  const document = diagnostic.getByRole("article", { name: "归因报告正文" });
  await expect(document).toContainText("候选原因");
  await expect(document).toContainText("缺少结果卡片");
  await expect(document).toContainText("证据支持（AI 判断，待人工核验）");
  await expect(document).toContainText("未额外读取 Agent 项目日志或源码");
  await expect(diagnostic.getByRole("button", { name: "生成新版本" })).toBeEnabled();
  const markdownUrl = await diagnostic
    .getByRole("link", { name: "下载 Markdown" })
    .getAttribute("href");
  if (!markdownUrl) throw new Error("DIAG_EXPORT_LINK_MISSING");
  const exported = await request.get(markdownUrl);
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain("这轮反馈可以整理成");
  await page.screenshot({ path: testInfo.outputPath("diagnostic-report-preview.png") });
  expect(
    (await new AxeBuilder({ page }).include(".diagnostic-dialog").analyze()).violations
  ).toEqual([]);
  await diagnostic.getByRole("button", { name: "生成新版本" }).click();
  await expect(diagnostic.getByLabel("报告版本").locator("option")).toHaveCount(2);
  await expect(document).toContainText("EVALUATION REPORT · v2");
  await expect(diagnostic.getByRole("button", { name: "生成新版本" })).toBeEnabled();
  await diagnostic.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "生成归因报告", exact: true }).click();
  await expect(document).toContainText("EVALUATION REPORT · v2");
  await diagnostic.getByLabel("报告版本").selectOption({ index: 1 });
  await expect(document).toContainText("EVALUATION REPORT · v1");
  await diagnostic.getByRole("button", { name: "关闭", exact: true }).click();

  expect(diagnostics.pageErrors).toEqual([]);
});
