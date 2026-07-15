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
    if (event.type() === "error") diagnostics.consoleErrors.push(event.text());
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

// Verify accessibility, CSP and browser runtime health at a stable UI state.
async function expectHealthyPage(page: Page, diagnostics: BrowserDiagnostics): Promise<void> {
  const csp = await page.evaluate(() => {
    const target = window as typeof window & { __cortexCspViolations?: string[] };
    return target.__cortexCspViolations ?? [];
  });
  expect(csp).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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
        parsed_output: { answer: "ok" }
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

test("平台 Run 可完成 REST 并保持未完成报告不进入最近运行", async ({ page, request }, testInfo) => {
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
  await page.getByRole("button", { name: "启动 REST 阶段" }).click();
  await expect(page.getByRole("heading", { name: "逐 Case REST 结果" })).toBeVisible();
  await expect(page.getByText("browser-case", { exact: true })).toBeVisible();
  await expect(page.getByText("Evaluation", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("browser-case", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看 browser-case" }).click();
  await expect(page.getByRole("heading", { name: "Case 结果 · browser-case" })).toBeVisible();
  await expect(page.getByText(/"answer": "ok"/)).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("link", { name: "仪表盘" }).click();
  await expect(page.getByRole("heading", { name: "最近运行" })).toBeVisible();
  await expect(page.getByText(suiteName, { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "测试集" }).click();
  const suiteRow = page.getByRole("row").filter({ hasText: suiteName });
  await expect(suiteRow).toContainText("尚无运行");
  await expectHealthyPage(page, diagnostics);
});

test("真实离线 Report 导入统一更新 Dashboard、Run 与测试集最近运行", async ({
  page,
  request
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "完整业务闭环只需一个桌面浏览器项目");
  const diagnostics = await collectBrowserDiagnostics(page);
  const suiteName = "offline-report-e2e-suite";
  const endpointName = "offline-report-e2e-endpoint";
  const evaluatorName = "offline-report-e2e-evaluator";
  const analyzerName = "offline-report-e2e-analyzer";

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
        name: "offline-report-e2e-analysis",
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "CASE_ANALYSIS",
          promptKey: "analysis",
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
  const executionId = "01900000-0000-7000-8000-000000000111";
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

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近完整报告" })).toBeVisible();
  await expect(page.getByTestId("latest-report-effective-rate")).toContainText("0.0%");
  await expect(page.getByTestId("latest-report-coverage-rate")).toContainText("100.0%");
  await expect(page.getByTestId("latest-report-primary-metric")).toContainText("quality");
  const reportHref = `/runs/${runId}/report`;
  const recentRun = page.locator(`a.dashboard-run-card[href="${reportHref}"]`);
  await expect(recentRun).toContainText("离线导入");
  await expect(recentRun).toHaveAttribute("href", reportHref);

  await page.goto("/runs");
  const runRow = page.getByRole("row").filter({ has: page.locator(`a[href="${reportHref}"]`) });
  await expect(runRow).toContainText("离线导入");
  await expect(runRow.getByRole("link")).toHaveAttribute("href", reportHref);
  await runRow.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "运行报告" })).toBeVisible();
  await expect(page.getByText("离线导入", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By Metric 统计" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "quality", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "分析失败 Case" }).click();
  await expect(page.getByRole("heading", { name: "Case Analysis 工作台" })).toBeVisible();
  await page.getByLabel("Analyzer").click();
  await page.getByRole("option", { name: analyzerName }).click();
  await page.getByLabel("Analysis Prompt").click();
  await page.getByRole("option", { name: "offline-report-e2e-analysis" }).click();
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByText("已选择 1 个 Case，成功 1 个，错误 0 个。")).toBeVisible();
  await page.getByRole("button", { name: "查看分析 offline-report-case" }).click();
  await expect(page.getByText("运行上下文确认该 Case 未通过评估")).toBeVisible();
  await expect(page.getByText("run_context", { exact: true })).toBeVisible();
  await expect(page.getByText("92% · 模型自评")).toBeVisible();

  await page.goto("/test-suites");
  const suiteRow = page.getByRole("row").filter({ hasText: suiteName });
  await expect(suiteRow).toContainText("离线导入");
  await expect(suiteRow.getByRole("link", { name: "已完成" })).toHaveAttribute("href", reportHref);
  await expectHealthyPage(page, diagnostics);
});
