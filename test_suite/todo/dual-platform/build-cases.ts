/** Product-case fixture builder only. Does not call services, create tasks, or change the evaluator. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CASE_DEFINITION_V1 } from "../../../packages/contracts/src/case-contracts.ts";
import { CaseAuthoringV1Schema } from "../../../packages/contracts/src/case-authoring-contracts.ts";
import { compileCaseFieldRule } from "../../../packages/contracts/src/assertion-rules/field-rules.ts";
import { agentCallPolicyAssertion } from "../../../packages/contracts/src/assertion-rules/agent-rule-authoring.ts";

type Scenario = {
  id: string;
  name: string;
  provider: string;
  phase: string;
  turns: string[];
  precondition: string;
  expected: string;
  manual: string;
  write: boolean;
  tool: string | null;
  reportedIssue: string | null;
};
const directory = new URL("./", import.meta.url);
const source = JSON.parse(await readFile(new URL("scenarios.json", directory), "utf8")) as {
  cases: Scenario[];
  testUid: string;
};

function evidence(s: Scenario): string {
  // This is a bounded task-product assertion, not a new generic rule or engine.
  return `const rule = ${JSON.stringify({ id: s.id, tool: s.tool, provider: s.provider })};
const fail = reason => ({pass:false,score:0,reason});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
let root = output;
if (typeof root === 'string') { try {root=JSON.parse(root);} catch {return fail('证据：输出不是JSON');} }
if (!object(root) || root.ok !== true || !object(root.parsed_output)) return fail('证据：缺少可消费的实际Trace');
const executions = root.parsed_output.tool_executions;
if (!Array.isArray(executions)) return fail('证据：缺少实际工具执行，不能用Planner计划代替');
const expectedProviders = rule.provider === 'both' ? ['clickup','todo'] : [rule.provider];
const reached = new Set();
const ids = new Set();
const hasErrors = value => {
  if (Array.isArray(value)) return value.some(hasErrors);
  if (!object(value)) return false;
  return Object.entries(value).some(([k,v]) => ['provider_errors','account_errors'].includes(k) ? !Array.isArray(v) || v.length > 0 : hasErrors(v));
};
for (const e of executions) {
  if (!object(e) || !nonempty(e.tool_request_id) || ids.has(e.tool_request_id)) return fail('证据：实际执行ID缺失或重复');
  ids.add(e.tool_request_id);
  if (!Array.isArray(e.calls) || e.calls.length !== 1 || !Array.isArray(e.terminals) || e.terminals.length !== 1) return fail('证据：当前规则需唯一调用和终态；不支持的复合记录不得视为通过');
  const c=e.calls[0], t=e.terminals[0];
  if (!object(c) || !object(t)) return fail('证据：调用或终态结构无效');
  const name=c.name ?? c.tool_name, args=c.param ?? c.args_json;
  if (!nonempty(name) || !object(args) || c.tool_request_id !== e.tool_request_id) return fail('证据：调用参数或关联无效');
  const r=t.tool_result;
  if (e.status !== 'SUCCEEDED' || t.type !== 'TOOL_RESULT' || !object(r) || r.name !== name || r.tool_request_id !== e.tool_request_id || r.status !== 'SUCCESS' || !object(r.result)) return fail('执行：缺少关联成功结果 ' + name);
  if (hasErrors(r.result)) return fail('执行：平台或账号存在部分失败 ' + name);
  if (['list_task_collections','list_tasks','search_tasks','get_task','create_tasks','update_task','delete_tasks'].includes(name)) {
    const providers=Array.isArray(args.provider) ? args.provider : [args.provider];
    if (!providers.length || providers.some(p => !expectedProviders.includes(p))) return fail('执行：平台缺失或串平台 ' + name);
    if (name===rule.tool) providers.forEach(p=>reached.add(p));
  }
  if (name==='create_tasks') {
    if (!Array.isArray(args.tasks) || args.tasks.length !== 1) return fail('创建：必须只创建一条测试任务');
    if (rule.id.endsWith('-02')) {
      const task=args.tasks[0];
      if (!object(task) || task.title!=='走查-产品方案' || task.priority!=='high' || task.description!=='整理用户反馈') return fail('创建：标题/优先级/备注参数错误');
      if (!nonempty(args.collection_id)) return fail('创建：缺少目标清单ID，不能用默认清单代替指定清单');
    }
  }
  if (name==='update_task') {
    if (!nonempty(args.task_id)) return fail('修改：缺少真实目标任务ID');
    if (rule.id.endsWith('-05') && (args.title!=='走查-产品方案终稿' || args.priority!=='normal' || args.description!=='准备提交评审')) return fail('修改：新标题/优先级/备注参数错误');
  }
  if (name==='delete_tasks' && (!Array.isArray(args.task_ids) || args.task_ids.length!==1 || !nonempty(args.task_ids[0]))) return fail('删除：必须针对一个明确任务ID');
}
if (rule.tool && expectedProviders.some(p=>!reached.has(p))) return fail('执行：缺少目标工具的实际成功调用/平台覆盖 ' + rule.tool);
return {pass:true,score:1,reason:'实际调用、终态、平台及已声明参数检查通过；资源身份/业务字段由业务评测核对，不代表多轮或视觉通过'};`;
}
const writes = ["create_tasks", "update_task", "delete_tasks"];
const definitions = source.cases.map((s) => {
  const allowed =
    s.id === "MX-03"
      ? ["create_tasks", "delete_tasks"]
      : !s.write
        ? []
        : s.id.endsWith("-02")
          ? ["create_tasks"]
          : s.id.endsWith("-08")
            ? ["delete_tasks"]
            : ["update_task"];
  const assertions: Record<string, unknown>[] = [
    {
      type: "javascript",
      metric: "证据｜E2E轨迹可消费",
      weight: 1,
      value: compileCaseFieldRule({ operation: "equals", path: "ok", expected: true })
    },
    { type: "javascript", metric: "执行｜实际终态、平台与关键参数", weight: 1, value: evidence(s) },
    agentCallPolicyAssertion({
      tools: writes.filter((t) => !allowed.includes(t)),
      mode: "forbid",
      maxCalls: 0
    })
  ];
  if (allowed.length)
    assertions.push(agentCallPolicyAssertion({ tools: allowed, mode: "limit", maxCalls: 1 }));
  if (s.turns.length > 1) {
    // Explicit blocked draft. Do not invent a turns[] response contract or accept only the last turn.
    assertions.push({
      type: "javascript",
      metric: "证据不足｜多轮整例验收暂不可用",
      weight: 1,
      value: `throw new Error('EVIDENCE_INSUFFICIENT: ${s.id}含${s.turns.length}轮；当前桥接只返回末轮Trace/A2UI，尚不能证明逐轮行为。补齐逐轮真实证据并更新本规则前不得整例通过；这不是Agent产品质量失败。');`
    });
  }
  if (s.id === "MX-04" || s.id === "MX-01")
    assertions.push({
      type: "javascript",
      metric: "待确认｜产品规则",
      weight: 1,
      value: `throw new Error(${JSON.stringify(s.id === "MX-04" ? "ACCEPTANCE_RULE_UNDEFINED: To Do只支持日期已经明确，但遇到时分应降级保存还是先澄清尚未确定；确认规则后替换本阻断项。" : "ACCEPTANCE_RULE_UNDEFINED: 最近待办的时间窗口尚未确定；确认业务定义后补充断言并替换本阻断项。")});`
    });
  assertions.push({
    type: "llm-rubric",
    metric: "业务｜用户任务完成及回复一致性",
    weight: 1,
    threshold: 1,
    value: `你是待办业务评测者，只评结构化事实与回复语义，不评视觉。\nCase：${s.id} ${s.name}\n用户逐轮输入：\n${s.turns.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n前置条件（需运行负责人确认，不能仅凭此文本认为已满足）：${s.precondition}\n验收要求：${s.expected}\n证据：读取完整输出 parsed_output 中的实际 tool_executions.calls / terminals、request_identity、final_output、delivered_messages 和 a2ui 数据；Planner计划、HTTP200、顶层ok不证明业务成功。核对实际工具返回字段、逐项失败和最终用户回复，缺关键证据必须未通过并列出缺口，不得猜测缺失字段。资源身份需以创建记录/明确前置基线及查询清单映射核对，不能仅凭同名判定同一任务。成功回复与实际结果矛盾必须失败；缺最终交付证据不得视为已回复。相对日期按实际采用的请求时间和时区计算，缺时间依据不能猜；不要固定为文档编写日期。创建/修改后原生平台人工核对不由Judge冒充完成。多轮仅有末轮结果不能推断此前已正确执行。Rubric通过不覆盖任何确定性失败，也不代表视觉审核通过。\n另由人工检查（不要由模型批准）：${s.manual}\n历史问题（不是本次实际结果）：${s.reportedIssue ?? "原材料未记录具体Bug；历史勾选不代表本次验收通过。"}`
  });
  return CaseAuthoringV1Schema.parse({
    contractVersion: CASE_DEFINITION_V1,
    description: `${s.name}${s.turns.length > 1 ? "｜多轮证据待补" : ""}`,
    threshold: 1,
    vars: {
      task: "agent-e2e",
      request_body: {
        uid: { __cortex_eval_int64: source.testUid },
        timezone: "Asia/Shanghai",
        lang: "zh-Hans",
        ...(s.turns.length === 1
          ? { text: s.turns[0] }
          : { conversation: s.turns.map((text) => ({ role: "user", text })) })
      }
    },
    metadata: {
      case_id: s.id,
      req_id: `dual_${s.id}`,
      task_id: `dual_${s.id}`,
      business_module: "待办",
      scenario_tag: s.phase,
      a2ui_capture: true
    },
    assert: assertions
  });
});
await writeFile(
  new URL("cases.draft.jsonl", directory),
  definitions.map((c) => JSON.stringify(c)).join("\n") + "\n"
);
console.log(
  JSON.stringify({
    file: fileURLToPath(new URL("cases.draft.jsonl", directory)),
    cases: definitions.length,
    multiTurn: source.cases.filter((s) => s.turns.length > 1).length,
    executed: false
  })
);
