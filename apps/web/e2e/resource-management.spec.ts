import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

interface BrowserDiagnostics {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

// Install CSP and browser-error collection before application scripts execute.
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

// Assert axe, CSP and browser runtime diagnostics together at a stable page state.
async function expectHealthyPage(page: Page, diagnostics: BrowserDiagnostics): Promise<void> {
  const csp = await page.evaluate(() => {
    const target = window as typeof window & { __cortexCspViolations?: string[] };
    return target.__cortexCspViolations ?? [];
  });
  expect(csp).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.evaluate(() => {
    const target = window as typeof window & { __cortexCspViolations?: string[] };
    target.__cortexCspViolations = [];
  });
  diagnostics.consoleErrors.splice(0);
}

// Build a deterministic import large enough to cross the 50-row UI page boundary.
function importedCases(prefix: string): readonly Record<string, unknown>[] {
  return Array.from({ length: 51 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      contractVersion: "cortex.case-definition.v1",
      description: `${prefix} Case ${number}`,
      threshold: 0.8,
      vars: { task: `task-${number}`, request_body: { input: number } },
      metadata: {
        case_id: `${prefix}-case-${number}`,
        req_id: `${prefix}-req-${number}`,
        task_id: `${prefix}-task-${number}`,
        business_module: index % 2 === 0 ? "客服" : "售后",
        scenario_tag: index % 3 === 0 ? "追问" : "正常"
      },
      assert: [
        {
          type: "equals",
          metric: index % 2 === 0 ? "quality" : "safety",
          value: "ok",
          config: { retained: true, index }
        }
      ]
    };
  });
}

test("资源 Dashboard 与测试集/Case 全流程", async ({ page }, testInfo) => {
  const diagnostics = await collectBrowserDiagnostics(page);
  const prefix = testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase();
  const suiteName = `${prefix}-suite`;
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "资源仪表盘" })).toBeVisible();
  await expect(page.getByRole("link", { name: "运行" })).toBeVisible();
  await expect(page.getByRole("link", { name: "报告" })).toHaveCount(0);
  await expectHealthyPage(page, diagnostics);

  await page.getByRole("link", { name: "测试集" }).click();
  const createSuite = page.getByRole("button", { name: "新建测试集" });
  await createSuite.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "测试集名称" })).toBeFocused();
  await page.getByRole("textbox", { name: "测试集名称" }).fill(suiteName);
  await page.getByRole("textbox", { name: "测试集说明" }).fill("E2E 资源流程");
  await page.getByRole("button", { name: "创建测试集" }).click();
  await expect(page).toHaveURL(/\/test-suites\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: suiteName })).toBeVisible();

  await page.getByLabel("导入 Cases JSON").setInputFiles({
    name: "cases.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(importedCases(prefix)))
  });
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "确认导入并替换" }).click();
  await expect(page.getByText(`${prefix}-case-01`, { exact: true })).toBeVisible();

  await page.getByRole("searchbox", { name: "Case ID 搜索" }).fill(`${prefix}-case`);
  await page.getByRole("textbox", { name: "业务模块过滤" }).fill("客服");
  await page.getByRole("button", { name: "应用过滤" }).click();
  await expect(page).toHaveURL(/caseKey=/);
  await expect(page).toHaveURL(/businessModule=/);
  await expect(page.getByText(`${prefix}-case-01`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${prefix}-case-02`, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "清空过滤" }).click();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/[?&]cursor=/);
  await page.reload();
  await expect(page).toHaveURL(/[?&]cursor=/);
  await expect(page.getByText(`${prefix}-case-51`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一页" }).click();

  await page.getByRole("button", { name: `编辑 ${prefix}-case-01` }).click();
  await page.getByRole("tab", { name: "完整 JSON" }).click();
  const fullJson = page.getByRole("textbox", { name: "完整 Case JSON" });
  const definition = JSON.parse(await fullJson.inputValue()) as Record<string, unknown>;
  definition.description = `${prefix} edited`;
  await fullJson.fill(JSON.stringify(definition, null, 2));
  await page.getByRole("tab", { name: "结构化" }).click();
  await expect(page.getByRole("textbox", { name: "Case 描述" })).toHaveValue(`${prefix} edited`);
  await page.getByRole("tab", { name: "完整 JSON" }).click();
  await expect(fullJson).toContainText("");
  expect(await fullJson.inputValue()).toContain('"retained": true');
  await page.getByRole("button", { name: "保存 Case" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: `复制 ${prefix}-case-01` }).click();
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
  const copiedKey = `${prefix}-case-copy`;
  await page.getByRole("textbox", { name: "新 Case ID" }).fill(copiedKey);
  await page.getByRole("button", { name: "复制 Case" }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked", "1");
  await page.getByRole("searchbox", { name: "Case ID 搜索" }).fill(copiedKey);
  await page.getByRole("button", { name: "应用过滤" }).click();
  await expect(page.getByText(copiedKey, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `删除 ${copiedKey}` }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText(copiedKey, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "清空过滤" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 Cases" }).click();
  expect((await download).suggestedFilename()).toBe("cases.json");
  await expectHealthyPage(page, diagnostics);
});

test("四类配置创建、预览、编辑与删除", async ({ page }, testInfo) => {
  const diagnostics = await collectBrowserDiagnostics(page);
  const prefix = testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase();
  await page.goto("/endpoint-configs");

  await page.getByRole("button", { name: "新建 Endpoint 配置" }).click();
  await page.getByRole("textbox", { name: "配置名称" }).fill(`${prefix}-endpoint`);
  await page.getByRole("textbox", { name: "URL 模板" }).fill("https://example.com/v1");
  await page.getByRole("button", { name: "验证可用性" }).click();
  await expect(page.getByText("验证通过，尚未保存。")).toBeVisible();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(`${prefix}-endpoint`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `编辑 ${prefix}-endpoint` }).click();
  await page.getByRole("textbox", { name: "配置名称" }).fill(`${prefix}-endpoint-edited`);
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(`${prefix}-endpoint-edited`, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "LLM 配置" }).click();
  await page.getByRole("button", { name: "新建 LLM 配置" }).click();
  await page.getByRole("textbox", { name: "配置名称" }).fill(`${prefix}-llm`);
  await page.getByRole("combobox", { name: "Provider 类型" }).click();
  await page.getByRole("option", { name: "OPENAI_COMPATIBLE" }).click();
  await page.getByRole("textbox", { name: "模型" }).fill("local-model");
  await page
    .getByRole("textbox", { name: "OpenAI-compatible Base URL" })
    .fill("http://127.0.0.1:11434/v1");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(`${prefix}-llm`, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Rubric 提示词" }).click();
  await page.getByRole("button", { name: "新建 Rubric 提示词" }).click();
  await page.getByRole("textbox", { name: "配置名称" }).fill(`${prefix}-rubric`);
  await page.getByRole("textbox", { name: "Prompt Key" }).fill(`${prefix}.rubric`);
  await page.getByRole("textbox", { name: "内容" }).fill("检查输出质量");
  await page.getByRole("button", { name: "预览消息" }).click();
  await expect(page.getByRole("heading", { name: "服务端预览" })).toBeVisible();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(`${prefix}-rubric`, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "分析提示词配置" }).click();
  await page.getByRole("button", { name: "新建 分析提示词配置" }).click();
  await page.getByRole("textbox", { name: "配置名称" }).fill(`${prefix}-analysis-prompt`);
  await page.getByRole("textbox", { name: "Prompt Key" }).fill(`${prefix}.analysis`);
  await page.getByRole("textbox", { name: "内容" }).fill("{{case_definition}}");
  await page.getByRole("button", { name: "预览变量引用" }).click();
  const analysisPreview = page.getByRole("heading", { name: "服务端预览" }).locator("..");
  await expect(analysisPreview.getByText("case_definition", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(`${prefix}-analysis-prompt`, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Endpoint 配置" }).click();
  await page.getByRole("button", { name: `删除 ${prefix}-endpoint-edited` }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText(`${prefix}-endpoint-edited`, { exact: true })).toHaveCount(0);
  await expectHealthyPage(page, diagnostics);
});

test("@compact 小于 1024px 只显示可读提示", async ({ page }) => {
  const diagnostics = await collectBrowserDiagnostics(page);
  await page.goto("/");
  await expect(page.getByText("当前界面需要至少 1024px 宽度，请扩大窗口后继续。")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeHidden();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.body.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await expectHealthyPage(page, diagnostics);
});
