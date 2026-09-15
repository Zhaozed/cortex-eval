/** Synthetic assertion checks only; no network/model calls and no business acceptance claim. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = JSON.parse(await readFile(new URL("scenarios.json", import.meta.url), "utf8"));
const cases = (await readFile(new URL("cases.draft.jsonl", import.meta.url), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(cases.length, 20);
assert.equal(new Set(cases.map((c) => c.metadata.case_id)).size, 20);
let checks = 2;
for (const c of cases) {
  const s = source.cases.find((s: any) => s.id === c.metadata.case_id);
  assert.deepEqual(c.vars.request_body.uid, { __cortex_eval_int64: source.testUid });
  assert.equal(c.threshold, 1);
  assert(c.assert.every((a: any) => a.weight > 0));
  const input = c.vars.request_body;
  assert.deepEqual(input.text ? [input.text] : input.conversation.map((m: any) => m.text), s.turns);
  assert(!(input.text && input.conversation));
  assert(!Object.hasOwn(input, "req_id")); // Let the bridge create fresh request/session IDs per run.
  checks += 6;
  const rule = c.assert.find((a: any) => a.metric === "执行｜实际终态、平台与关键参数");
  const evaluate = new Function("output", rule.value);
  assert.equal(evaluate({ ok: true, parsed_output: {} }).pass, false);
  assert.equal(evaluate({ ok: false, parsed_output: { tool_executions: [] } }).pass, false);
  assert.equal(evaluate("not-json").pass, false);
  checks += 3;
  const providers = s.provider === "both" ? ["clickup", "todo"] : [s.provider];
  const executions = s.tool
    ? providers.map((provider: string, i: number) => {
        const id = `synthetic-${i}`;
        const args: any = { provider };
        if (s.tool === "create_tasks")
          Object.assign(args, {
            collection_id: "synthetic-list",
            tasks: [{ title: "走查-产品方案", priority: "high", description: "整理用户反馈" }]
          });
        if (s.tool === "update_task")
          Object.assign(args, {
            task_id: "synthetic-task",
            title: "走查-产品方案终稿",
            priority: "normal",
            description: "准备提交评审"
          });
        if (s.tool === "delete_tasks") args.task_ids = ["synthetic-task"];
        return {
          tool_request_id: id,
          status: "SUCCEEDED",
          calls: [{ name: s.tool, param: args, tool_request_id: id }],
          terminals: [
            {
              type: "TOOL_RESULT",
              tool_result: { tool_request_id: id, name: s.tool, status: "SUCCESS", result: {} }
            }
          ]
        };
      })
    : [];
  const valid = { ok: true, parsed_output: { tool_executions: executions } };
  assert.equal(evaluate(valid).pass, true); // Only the named structural/parameter assertion, NOT whole-case pass.
  checks++;
  if (executions.length) {
    const partial = structuredClone(valid);
    partial.parsed_output.tool_executions[0].terminals[0].tool_result.result = {
      provider_errors: [{ message: "synthetic error" }]
    };
    assert.equal(evaluate(partial).pass, false);
    const wrong = structuredClone(valid);
    wrong.parsed_output.tool_executions[0].calls[0].param.provider = "wrong-provider";
    assert.equal(evaluate(wrong).pass, false);
    const missing = structuredClone(valid);
    missing.parsed_output.tool_executions[0].terminals = [];
    assert.equal(evaluate(missing).pass, false);
    const duplicate = structuredClone(valid);
    duplicate.parsed_output.tool_executions.push(duplicate.parsed_output.tool_executions[0]);
    assert.equal(evaluate(duplicate).pass, false);
    checks += 4;
  }
  const gap = c.assert.find((a: any) => a.metric === "证据不足｜多轮整例验收暂不可用");
  assert.equal(Boolean(gap), s.turns.length > 1);
  if (gap) {
    assert.throws(() => new Function("output", gap.value)(valid), /EVIDENCE_INSUFFICIENT/);
    checks++;
  }
  checks++;
}
console.log(`${checks} synthetic checks passed; no Agent/Judge/business operations performed.`);
