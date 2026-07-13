import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";

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

test.afterEach(async () => {
  await Promise.all(
    stubs.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        })
    )
  );
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

test("平台 Run 可在 Web 完成 REST 并刷新恢复真实结果", async ({ page, request }, testInfo) => {
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
  await expect(page.getByRole("heading", { name: "最近平台运行" })).toBeVisible();
  await expect(page.getByText(suiteName, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "测试集" }).click();
  const suiteRow = page.getByRole("row").filter({ hasText: suiteName });
  await expect(suiteRow).toContainText("待执行");
  await expectHealthyPage(page, diagnostics);
});
