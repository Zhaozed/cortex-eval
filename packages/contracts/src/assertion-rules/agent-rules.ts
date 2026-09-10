import type { AssertionDefinitionV1 } from "../case-contracts.ts";
import type { JsonValue } from "../contracts-primitives.ts";

/** One expected execution, correlated by tool_request_id rather than flat planned tools. */
export interface AgentExecutionExpectation {
  /** Business tool whose actual execution must be observed exactly once. */
  readonly tool: string;
  /** Expected call parameters; other parameters are allowed. */
  readonly args: Readonly<Record<string, JsonValue>>;
  /** Expected terminal outcome, including deliberate failure scenarios. */
  readonly outcome: "success" | "failure";
  /** JSON paths relative to tool_result.result; every expected field must exist. */
  readonly fields?: Readonly<Record<string, JsonValue>>;
  /** Result paths compared as unordered exact sets with duplicate rejection. */
  readonly sets?: Readonly<Record<string, readonly JsonValue[]>>;
  /** Timestamp fields compared by instant, not spelling or timezone representation. */
  readonly instants?: Readonly<Record<string, string>>;
  /** Paths to nonempty returned resource identifiers. */
  readonly resourceIds?: readonly string[];
  /** Exact terminal error code for an expected failure. */
  readonly errorCode?: string;
}

/** Build a deterministic, portable inline Promptfoo assertion; no evaluator engine or I/O. */
export function agentExecutionAssertion(
  expectations: readonly AgentExecutionExpectation[]
): AssertionDefinitionV1 {
  return {
    type: "javascript",
    metric: "执行｜实际调用、终态与业务结果",
    weight: 1,
    value: `
const expected = ${JSON.stringify(expectations)};
const fail = reason => ({pass:false,score:0,reason});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value,key) => object(value) && Object.hasOwn(value,key);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const equal = (a,b) => {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i) => equal(v,b[i]));
  if (object(a) || object(b)) return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b,k) && equal(a[k],b[k]));
  return a === b;
};
const at = (value,path) => path.split('.').reduce((v,k) => v !== null && typeof v === 'object' && Object.hasOwn(v,k) ? v[k] : undefined,value);
const hasProviderErrors = value => {
  if (Array.isArray(value)) return value.some(hasProviderErrors);
  if (!object(value)) return false;
  return Object.entries(value).some(([key,v]) => {
    if (key === 'provider_errors' || key === 'account_errors') return !Array.isArray(v) || v.length > 0;
    return hasProviderErrors(v);
  });
};
let root = output;
if (typeof root === 'string') { try { root = JSON.parse(root); } catch { return fail('证据：输出不是JSON'); } }
if (!object(root) || root.ok !== true || !object(root.parsed_output)) return fail('证据：缺少可消费parsed_output');
const executions = root.parsed_output.tool_executions;
if (!Array.isArray(executions)) return fail('证据：缺少实际tool_executions；不能用tools代替');
if (executions.length !== expected.length) return fail('执行：实际执行数量不符，可能缺失、额外调用或重复写入');
const requestIds = new Set();
const remaining = [...executions];
for (const rule of expected) {
  if (!object(rule) || !nonempty(rule.tool) || !['success','failure'].includes(rule.outcome) || !object(rule.args)) throw new Error('TODO_ASSERTION_CONFIG');
  const index = remaining.findIndex(e => object(e) && Array.isArray(e.calls) && e.calls.length === 1 && object(e.calls[0]) && (e.calls[0].name ?? e.calls[0].tool_name) === rule.tool && object(e.calls[0].param ?? e.calls[0].args_json) && Object.entries(rule.args).every(([k,v]) => own(e.calls[0].param ?? e.calls[0].args_json,k) && equal((e.calls[0].param ?? e.calls[0].args_json)[k],v)));
  if (index < 0) return fail('规划/执行：未找到参数正确的实际调用 ' + rule.tool);
  const execution = remaining.splice(index,1)[0];
  const id = execution.tool_request_id;
  if (!nonempty(id) || requestIds.has(id)) return fail('证据：执行请求ID缺失或重复');
  requestIds.add(id);
  const call = execution.calls[0];
  if (call.tool_request_id !== id) return fail('证据：调用与执行请求ID不一致');
  if (!Array.isArray(execution.terminals) || execution.terminals.length !== 1) return fail('证据：缺少唯一终态或出现冲突终态');
  const terminal = execution.terminals[0];
  if (!object(terminal)) return fail('证据：终态结构非法');
  if (rule.outcome === 'failure') {
    if (!nonempty(rule.errorCode)) throw new Error('TODO_ASSERTION_ERROR_CODE_REQUIRED');
    if (execution.status !== 'FAILED' || terminal.type !== 'ERROR' || !object(terminal.error) || terminal.error.tool_request_id !== id || terminal.error.error_code !== rule.errorCode) return fail('执行：未观察到预期且归属正确的工具失败 ' + rule.tool);
    continue;
  }
  const result = terminal.tool_result;
  if (execution.status !== 'SUCCEEDED' || terminal.type !== 'TOOL_RESULT' || !object(result) || result.name !== rule.tool || result.tool_request_id !== id || result.status !== 'SUCCESS' || !object(result.result)) return fail('执行：缺少归属正确的成功业务结果 ' + rule.tool);
  const business = result.result;
  if (hasProviderErrors(business)) return fail('执行：Provider存在部分失败或错误证据格式非法');
  for (const [path,value] of Object.entries(rule.fields ?? {})) {
    if (!equal(at(business,path),value)) return fail('业务结果：字段缺失或不匹配 ' + path);
  }
  for (const [path,values] of Object.entries(rule.sets ?? {})) {
    if (!Array.isArray(values) || values.some((v,i) => values.slice(0,i).some(x => equal(x,v)))) throw new Error('TODO_ASSERTION_SET_CONFIG');
    const actual = at(business,path);
    if (!Array.isArray(actual) || actual.length !== values.length || actual.some((v,i) => actual.slice(0,i).some(x => equal(x,v))) || !values.every(v => actual.some(x => equal(x,v)))) return fail('业务结果：集合缺失、重复、多项或少项 ' + path);
  }
  for (const [path,value] of Object.entries(rule.instants ?? {})) {
    if (!nonempty(value) || !/(Z|[+-]\\d{2}:\\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('TODO_ASSERTION_TIME_CONFIG');
    const actual = at(business,path);
    if (!nonempty(actual) || !/(Z|[+-]\\d{2}:\\d{2})$/.test(actual) || Date.parse(actual) !== Date.parse(value)) return fail('业务结果：时间缺失、无时区或时刻错误 ' + path);
  }
  for (const path of rule.resourceIds ?? []) if (!nonempty(at(business,path))) return fail('业务结果：缺少实际资源ID ' + path);
}
return {pass:true,score:1,reason:'实际调用、关联终态及指定业务字段通过；不代表未声明的业务语义或客户端视觉通过'};
`
  };
}

/** Require a real reply; delivery is opt-in and must match the terminal reply and request. */
export function agentReplyAssertion(options: {
  readonly type: "QUESTION" | "NOTICE";
  readonly delivered: boolean;
  readonly exactText?: string;
}): AssertionDefinitionV1 {
  return {
    type: "javascript",
    metric: options.delivered ? "回复｜终局回复已交付" : "回复｜决策正文存在（不代表交付）",
    weight: 1,
    value: `
const rule = ${JSON.stringify(options)};
const fail = reason => ({pass:false,score:0,reason});
let root = output;
if (typeof root === 'string') { try { root=JSON.parse(root); } catch { return fail('回复：非法JSON'); } }
const p=root?.parsed_output;
if (!p || typeof p.reply_text !== 'string' || !p.reply_text.trim() || p.reply_type !== rule.type) return fail('回复：正文缺失、为空或类型不符');
if (rule.exactText !== undefined && p.reply_text !== rule.exactText) return fail('回复：固定文案不符');
if (rule.delivered) {
  const req=p.request_identity?.root_req_id;
  const final=p.final_output;
  if (typeof req !== 'string' || !req || !final || typeof final.asst_msg_id !== 'string' || !final.asst_msg_id || final.req_id !== req || final.text !== p.reply_text || final.kind !== p.reply_type || !Array.isArray(p.delivered_messages) || !p.delivered_messages.some(m => m?.req_id === req && m.asst_msg_id === final.asst_msg_id && m.text === p.reply_text && m.kind === p.reply_type)) return fail('交付：缺少与当前请求和终局回复一致的已交付消息；过渡话术不算完成');
}
return {pass:true,score:1,reason:rule.delivered ? '终局回复交付证据一致；自由文本语义仍需独立验收' : '决策回复存在；未验证交付或语义'};
`
  };
}
