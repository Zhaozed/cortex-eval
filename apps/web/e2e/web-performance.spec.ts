import { expect, test } from "@playwright/test";

const MEASUREMENTS = 5;
const INTERACTIVE_LIMIT_MS = 2_500;

test("@performance 关键测试集列表五次可交互时间均不超过 2.5 秒", async ({
  page,
  request
}, testInfo) => {
  const prefix = testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase();
  const suiteName = `performance-${prefix}`;
  const created = await request.post("/api/v1/test-suites", {
    data: { name: suiteName, description: "P10 Web performance marker" }
  });
  expect(created.status()).toBe(201);

  const samplesMs: number[] = [];
  for (let index = 0; index < MEASUREMENTS; index += 1) {
    const startedAt = performance.now();
    await page.goto(`/test-suites?performanceSample=${index}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText(suiteName, { exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "正在读取测试集" })).toHaveCount(0);
    await expect(page.getByText("测试集读取失败", { exact: true })).toHaveCount(0);
    samplesMs.push(performance.now() - startedAt);
  }

  expect(samplesMs).toHaveLength(MEASUREMENTS);
  expect(Math.max(...samplesMs)).toBeLessThanOrEqual(INTERACTIVE_LIMIT_MS);
  process.stdout.write(
    `${JSON.stringify({
      gate: "P10_WEB_PERFORMANCE",
      project: testInfo.project.name,
      viewport: page.viewportSize(),
      samplesMs,
      maximumMs: Math.max(...samplesMs)
    })}\n`
  );
  await testInfo.attach("web-performance.json", {
    body: Buffer.from(
      JSON.stringify({
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        samplesMs,
        maximumMs: Math.max(...samplesMs)
      })
    ),
    contentType: "application/json"
  });
});
