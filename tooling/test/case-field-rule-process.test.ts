import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { compileCaseFieldRule } from "../../apps/web/src/features/test-suites/case-field-rule.ts";
import { runBoundedProcess } from "../src/promptfoo-process-probe.ts";

it("表单生成规则在真实 Promptfoo 中通过、阻断或缺证据失败（仅固定输出，无业务调用）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "case-field-rules-"));
  try {
    const value = compileCaseFieldRule({
      operation: "equals",
      path: "result.created",
      expected: true
    });
    const config = join(directory, "config.json");
    const reportPath = join(directory, "report.json");
    await writeFile(
      config,
      JSON.stringify({
        prompts: ["unused"],
        providers: [{ id: "echo" }],
        tests: [{ result: { created: true } }, { result: { created: false } }, {}].map(
          (output, index) => ({
            description: `guided-field-${index}`,
            providerOutput: JSON.stringify(output),
            threshold: 1,
            assert: [{ type: "javascript", metric: "字段检查", weight: 1, value }]
          })
        )
      })
    );
    const result = await runBoundedProcess(
      resolve("node_modules/.bin/promptfoo"),
      [
        "eval",
        "--config",
        config,
        "--output",
        reportPath,
        "--no-cache",
        "--no-share",
        "--no-table",
        "--no-progress-bar"
      ],
      directory,
      25000
    );
    expect(result.exitCode, result.stderr).toBe(100);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      results: {
        results: {
          testIdx: number;
          success: boolean;
          gradingResult: { reason: string; componentResults: { reason: string }[] };
        }[];
      };
    };
    const rows = report.results.results.toSorted((a, b) => a.testIdx - b.testIdx);
    expect(rows.map((row) => row.success)).toEqual([true, false, false]);
    expect(rows[1]?.gradingResult.componentResults[0]?.reason).toContain("不符合预期");
    expect(rows[2]?.gradingResult.componentResults[0]?.reason).toContain("缺少目标字段");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
