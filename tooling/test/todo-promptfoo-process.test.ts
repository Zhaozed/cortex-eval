import { materializeJavascriptSource } from "../../packages/application/src/features/evaluation/promptfoo-javascript-source.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { repairTodoPlannerCase } from "../../data_scripts/todo-case-repair.ts";
import {
  todoExecutionAssertion,
  todoReplyAssertion
} from "../../data_scripts/todo-e2e-assertions.ts";
import {
  type AssertionDefinitionV1,
  CaseDefinitionV1Schema
} from "../../packages/contracts/src/case-contracts.ts";
import { runBoundedProcess } from "../src/promptfoo-process-probe.ts";
import {
  executionFixture,
  executionRule,
  first,
  replyFixture
} from "../test-support/todo-regression-fixtures.ts";

it("真实Promptfoo进程：关键断言阻断最终PASS，错误类型/配置明确报错（无模型调用）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-assertions-"));
  try {
    const cases = (await readFile("tooling/test-support/todo-planner-legacy.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((s) => repairTodoPlannerCase(CaseDefinitionV1Schema.parse(JSON.parse(s))));
    const search = cases.find((c) => c.metadata.case_id === "TODO-S-02");
    const create = cases.find((c) => c.metadata.case_id === "TODO-C-01b");
    if (!search || !create) throw new Error("PLANNER_FIXTURE_REQUIRED");
    const queryPlan = {
      ok: true,
      task_name: "planner",
      parsed_output: {
        tools: [{ tool_name: "list_tasks", args_json: { status: "open" } }],
        reply_text: null,
        present_mode: "none"
      }
    };
    const createPlan = {
      ok: true,
      task_name: "planner",
      parsed_output: {
        tools: [
          {
            tool_name: "create_task",
            args_json: {
              provider: "clickup",
              title: "买咖啡",
              due: "2026-09-04T09:00:00+08:00"
            }
          }
        ],
        reply_text: null,
        present_mode: "none"
      }
    };
    const tests: {
      description: string;
      providerOutput: string;
      assert: AssertionDefinitionV1[];
      threshold: number;
    }[] = [];
    const expected: { success: boolean; error: boolean }[] = [];
    const add = (
      description: string,
      assertions: AssertionDefinitionV1[],
      output: unknown,
      success: boolean,
      error = false
    ): void => {
      tests.push({
        description,
        providerOutput: JSON.stringify(output),
        assert: assertions,
        threshold: 1
      });
      expected.push({ success, error });
    };
    add("合法默认open规划", search.assert, queryPlan, true);
    const closed = structuredClone(queryPlan);
    first(closed.parsed_output.tools).args_json.status = "closed";
    add("默认状态错误", search.assert, closed, false);
    add(
      "不可混用E2E",
      search.assert,
      {
        ...queryPlan,
        task_name: "agent-e2e",
        parsed_output: { ...queryPlan.parsed_output, tool_executions: [] }
      },
      false
    );
    const missingText = structuredClone(queryPlan);
    Reflect.deleteProperty(missingText.parsed_output, "reply_text");
    add("缺回复字段", search.assert, missingText, false);
    add(
      "泄露原weight0阻断最终结果",
      search.assert,
      { ...queryPlan, parsed_output: { ...queryPlan.parsed_output, reply_text: "task_id=hidden" } },
      false
    );
    add("合法创建规划", create.assert, createPlan, true);
    const identity = structuredClone(createPlan);
    Object.assign(first(identity.parsed_output.tools).args_json, { user_id: "1001" });
    add("Planner不得伪造执行身份", create.assert, identity, false);
    const numeric = structuredClone(createPlan);
    Object.assign(first(numeric.parsed_output.tools).args_json, { title: 123 });
    add("数字不能绕过pattern", create.assert, numeric, false);
    const duplicated = structuredClone(createPlan);
    duplicated.parsed_output.tools.push(structuredClone(first(duplicated.parsed_output.tools)));
    add("重复创建阻断最终结果", create.assert, duplicated, false);
    const noMode = structuredClone(createPlan);
    Reflect.deleteProperty(noMode.parsed_output, "present_mode");
    add("负向模式断言也必须有字段", create.assert, noMode, false);
    const execution = [todoExecutionAssertion([executionRule])];
    add("正确执行", execution, executionFixture(), true);
    add("只有规划没有执行", execution, createPlan, false);
    const failed = executionFixture();
    first(failed.parsed_output.tool_executions).status = "FAILED";
    add("工具失败不能被顶层ok掩盖", execution, failed, false);
    const due = executionFixture();
    first(first(due.parsed_output.tool_executions).terminals).tool_result.result.task.due =
      "2026-10-01T00:30:00Z";
    add("实际返回时刻错误", execution, due, false);
    const partial = executionFixture();
    Object.assign(
      first(first(partial.parsed_output.tool_executions).terminals).tool_result.result,
      { provider_errors: [{ code: "FAIL" }] }
    );
    add("Provider部分失败", execution, partial, false);
    const reply = [todoReplyAssertion({ type: "NOTICE", delivered: true })];
    add("终局交付", reply, replyFixture(), true);
    const progress = replyFixture();
    progress.parsed_output.final_output.text = "正在处理";
    add("过渡交付不是完成", reply, progress, false);
    add(
      "未知断言类型",
      [{ type: "todo-unknown-assertion", metric: "unknown", weight: 1 }],
      {},
      false,
      true
    );
    add(
      "非法schema",
      [{ type: "is-json", metric: "bad-schema", weight: 1, value: { type: "not-a-json-type" } }],
      {},
      false,
      true
    );
    for (const source of [
      "const x=1; return x===1;",
      "const x=1; x===1",
      "[1].some(x=>{return x===1})"
    ])
      add(
        "JS source: " + source,
        [
          {
            type: "javascript",
            metric: "script",
            weight: 1,
            value: materializeJavascriptSource("javascript", source)
          }
        ],
        {},
        true
      );
    const config = join(directory, "config.json");
    const output = join(directory, "report.json");
    await writeFile(
      config,
      JSON.stringify({ prompts: ["unused"], providers: [{ id: "echo" }], tests })
    );
    const result = await runBoundedProcess(
      resolve("node_modules/.bin/promptfoo"),
      [
        "eval",
        "--config",
        config,
        "--output",
        output,
        "--no-cache",
        "--no-share",
        "--no-table",
        "--no-progress-bar"
      ],
      directory,
      25000
    );
    expect(result.exitCode, result.stderr).toBe(100);
    const report = JSON.parse(await readFile(output, "utf8")) as {
      results: {
        results: {
          success: boolean;
          failureReason: number;
          testIdx: number;
          gradingResult: { reason: string };
        }[];
      };
    };
    const rows = report.results.results.toSorted((a, b) => a.testIdx - b.testIdx);
    expect(rows).toHaveLength(expected.length);
    for (const [index, row] of rows.entries()) {
      const wanted = expected[index];
      if (!wanted) throw new Error("EXPECTED_ROW_REQUIRED");
      expect(
        row.success,
        `${tests[index]?.description}: ${JSON.stringify(row.gradingResult)}`
      ).toBe(wanted.success);
      if (wanted.error) expect(row.failureReason).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
