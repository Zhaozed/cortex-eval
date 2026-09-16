/** Frozen, case-specific assertions. No service calls; no new platform evaluator or schema. */
import { agentReplyAssertion } from "../../packages/contracts/src/assertion-rules/agent-rules.ts";

export const writeTools = [
  "feishu_create_doc",
  "feishu_update_doc",
  "feishu_send_message",
  "create_event",
  "update_event",
  "delete_events"
];
export interface Turn {
  text: string;
  required: { tool: string; args: Record<string, unknown>; min: number }[];
  allowed_writes: Record<string, number>;
  check: string;
}
export interface Scenario {
  id: string;
  source_id: string;
  name: string;
  kind: string;
  priority: string;
  fixture: string;
  turns: Turn[];
  expected: string;
  fault: string | null;
  side_effect: boolean;
  manual: string;
}

/** Validate the real per-turn envelope, without counting the duplicated top-level last turn. */
const envelope = `
const fail = reason => ({pass:false,score:0,reason});
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string' && x.trim().length > 0;
const json = x => { if(typeof x==='string') {try{return JSON.parse(x);}catch{return x;}}return x;};
const equal = (a,b) => JSON.stringify(canon(a))===JSON.stringify(canon(b));
const canon = x => Array.isArray(x) ? x.map(canon) : obj(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])) : x;
const scalar = (a,b) => typeof a==='string' && typeof b==='string' && /(Z|[+-]\\d{2}:\\d{2})$/.test(a) && /(Z|[+-]\\d{2}:\\d{2})$/.test(b) && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? Date.parse(a)===Date.parse(b) : equal(a,b);
const matches = (a,b) => obj(a) && Object.entries(b).every(([k,v]) => {
 if(!Object.hasOwn(a,k))return false;
 if(['attendees','block_ids','event_ids','open_ids','room_ids'].includes(k) && Array.isArray(v)) {
   const aa=a[k]; return Array.isArray(aa) && aa.length===v.length && new Set(aa.map(x=>JSON.stringify(canon(x)))).size===aa.length && v.every(x=>aa.some(y=>equal(x,y)));
 }
 return scalar(a[k],v);
});
const root=json(output);
if(!obj(root) || root.ok!==true || !obj(root.parsed_output)) return fail('证据不足：缺少ok=true及parsed_output；传输失败不证明产品逻辑失败');
const p=root.parsed_output;
let frames;
if(Array.isArray(p.turns) && p.turns.length) {
 if(p.turns.length!==rule.turns.length) return fail('证据不足：逐轮数量不匹配，禁止只验末轮');
 frames=p.turns;
} else {
 if(rule.turns.length!==1)return fail('证据不足：多轮缺少parsed_output.turns');
 frames=[{parsed_output:p,req_id:p.request_identity?.root_req_id}];
}
if(p.conversation_execution?.complete===false)return fail('证据不足：会话执行未完整');
const turnIds=new Set(), executionIds=new Set();
const all=[];
for(let i=0;i<frames.length;i++) {
 const frame=frames[i], trace=frame?.parsed_output, spec=rule.turns[i];
 if(!obj(trace) || !Array.isArray(trace.tool_executions))return fail('证据不足：第'+(i+1)+'轮缺实际工具执行数组');
 const rid=trace.request_identity?.root_req_id;
 if(!str(rid) || (frame.req_id!==undefined && frame.req_id!==rid) || turnIds.has(rid))return fail('证据不足：逐轮req_id缺失、串联或重复');
 turnIds.add(rid);
 if(trace.outbound_capture?.status && trace.outbound_capture.status!=='COLLECTED')return fail('证据不足：该轮出站采集未完整');
 const actual=[];
 for(const e of trace.tool_executions) {
  if(!obj(e) || !str(e.tool_request_id) || executionIds.has(e.tool_request_id) || !Array.isArray(e.calls) || e.calls.length!==1 || !Array.isArray(e.terminals) || e.terminals.length!==1) return fail('证据不足：实际调用缺失/重复/无唯一终态');
  executionIds.add(e.tool_request_id);
  const c=e.calls[0], t=e.terminals[0], name=c?.name??c?.tool_name, args=json(c?.param??c?.args_json);
  if(!str(name) || !obj(args) || c.tool_request_id!==e.tool_request_id)return fail('证据不足：实际调用参数或关联无效');
  let result,success=false;
  if(e.status==='SUCCEEDED' && t?.type==='TOOL_RESULT' && t.tool_result?.tool_request_id===e.tool_request_id && t.tool_result?.name===name && t.tool_result?.status==='SUCCESS') {
    result=json(t.tool_result.result);success=obj(result)||Array.isArray(result);
    if(!success)return fail('证据不足：成功终态没有可消费业务结果');
  } else if(e.status==='FAILED' && t?.type==='ERROR' && t.error?.tool_request_id===e.tool_request_id) {
    result=t.error;
  } else return fail('证据不足：无已关联成功或失败终态，未知/仍执行中不能判完成');
  actual.push({name,args,result,success,turn:i,id:e.tool_request_id});
  if(['list_events','get_event','create_event','update_event','delete_events'].includes(name)) {
    const providers=Array.isArray(args.provider)?args.provider:[args.provider];
    if(!providers.length || providers.some(x=>x!=='feishu'))return fail('来源错误：日程实际调用不是且仅是feishu');
  }
  if(name==='feishu_search_docs' && Object.hasOwn(args,'page_token'))return fail('参数错误：文档搜索必须offset分页，不能page_token');
  if(name==='feishu_update_doc' && args.mode==='replace')return fail('范围错误：本评测集禁止全文replace');
  if(name==='feishu_query_free_busy') {
    const n=(Array.isArray(args.open_ids)?args.open_ids.length:0)+(Array.isArray(args.room_ids)?args.room_ids.length:0);
    if(n===0 || n>20)return fail('忙闲参数错误：查询对象数必须在1到20之间');
  }
 }
 for(const name of rule.write_tools) {
  const n=actual.filter(x=>x.name===name).length,max=spec.allowed_writes[name]??0;
  if(n>max)return fail('未授权/重复写入：第'+(i+1)+'轮 '+name+' 实际'+n+'次，上限'+max);
 }
 for(const r of spec.required) {
  if(actual.filter(x=>x.name===r.tool && matches(x.args,r.args)).length<r.min)return fail('缺少参数匹配的实际调用：第'+(i+1)+'轮 '+r.tool);
 }
 const errors = x => Array.isArray(x)?x.some(errors):obj(x)?Object.entries(x).some(([k,v]) => ['provider_errors','account_errors'].includes(k)?!Array.isArray(v)||v.length>0:k==='success'?v===false:errors(v)):false;
 if(!rule.fault) for(const a of actual) {
   const allowedDeletedRead=rule.source_id==='C08' && a.name==='get_event' && i>0 && /(^|[^0-9])193003([^0-9]|$)/.test(JSON.stringify(a.result));
   if((!a.success || errors(a.result)) && !allowedDeletedRead)return fail('正常路径出现实际调用/分项失败：'+a.name);
 }
 all.push(...actual);
}
`;

export function executionAssertion(s: Scenario, activeWrites: string[]) {
  const rule = { ...s, write_tools: [...new Set([...writeTools, ...activeWrites])] };
  return {
    type: "javascript",
    metric: "硬门槛｜逐轮实际执行、参数、来源、写入权限与次数",
    weight: 1,
    value: `const rule=${JSON.stringify(rule)};${envelope}
// Identity linkage is required; chronology and complete field preservation are additionally judged against raw timeline/baseline.
const event=x=>json(x?.event)??x;
const idOfDoc=x=>x?.document_id;
const readDocId=x=>idOfDoc(x.result);
const successfulWrites=all.filter(x=>x.success && rule.write_tools.includes(x.name));
for(const w of successfulWrites) {
 if(w.name==='delete_events') {
   const rows=w.result?.results, ids=w.args.event_ids;
   if(!Array.isArray(rows)||!Array.isArray(ids)||!ids.length||rows.length!==ids.length||new Set(rows.map(r=>r?.event_id)).size!==ids.length||!ids.every(id=>rows.some(r=>r?.event_id===id&&typeof r.success==='boolean')))return fail('删除证据不足：缺逐ID结果、漏项、重复或对象不匹配');
   if(!rule.fault && rows.some(r=>r.success!==true))return fail('删除失败：存在未成功项，不得报全部成功');
 }

 if(w.name==='feishu_create_doc' || w.name==='feishu_update_doc') {
   const id=w.result?.document_id;
   if(!str(id))return fail('写入证据不足：文档返回缺真实document_id');
   const reads=all.filter(x=>x.name==='feishu_get_doc' && x.success && x.turn>=w.turn && readDocId(x)===id);
   if(!reads.length && !rule.fault)return fail('回读证据不足：未按写入返回document_id取得正文');
   if(reads.length && !reads.some(x=>str(x.result.content) || (Array.isArray(x.result.blocks)&&x.result.blocks.length)))return fail('回读证据不足：文档缺正文/blocks');
 }
 if(w.name==='create_event' || w.name==='update_event') {
   const ev=event(w.result), id=ev?.id??ev?.event_id;
   if(!str(id))return fail('写入证据不足：日程返回缺真实ID');
   if(w.name==='update_event' && id!==w.args.event_id)return fail('对象错误：update返回不是原日程ID');
   const reads=all.filter(x=>x.name==='get_event' && x.success && x.args.event_id===id && x.turn>=w.turn);
   if(!reads.length && !rule.fault)return fail('回读证据不足：未读取写入返回event_id');
   if(reads.length && !reads.some(x=>(event(x.result)?.id??event(x.result)?.event_id)===id))return fail('对象错误：日程回读正文不是目标ID');
 }
 if(w.name==='feishu_send_message') {
   const mid=w.result?.message_id,chat=w.result?.chat_id;
   if(!str(mid)||!str(chat))return fail('发送证据不足：缺真实message_id/chat_id');
   const reads=all.filter(x=>['feishu_list_messages','feishu_get_thread_replies'].includes(x.name) && x.success && x.turn>=w.turn);
   const messages=reads.flatMap(x=>Array.isArray(x.result.messages)?x.result.messages:[]);
   if(!messages.some(m=>m.message_id===mid && (m.chat_id===undefined||m.chat_id===chat) && m.text===w.args.text) && !rule.fault)return fail('发送回读不匹配：必须找到精确message_id和正文，不能猜最新一条');
 }
}
return {pass:true,score:1,reason:'逐轮调用与声明的硬规则通过；顺序、完整业务事实、故障命中和真实UI另验，不等于整例E2E通过'};`
  };
}

export function replyAssertion(s: Scenario) {
  const source = agentReplyAssertion({ type: "NOTICE", delivered: true }).value as string;
  // Reuse canonical delivery matching, but do not hardcode QUESTION vs NOTICE for mixed confirmation/read turns.
  const delivery = source.replace(
    "p.reply_type !== rule.type",
    "!['QUESTION','NOTICE'].includes(p.reply_type)"
  );
  return {
    type: "javascript",
    metric: "硬门槛｜每轮终局回复真实交付",
    weight: 1,
    value: `
let root=output;if(typeof root==='string'){try{root=JSON.parse(root);}catch{return {pass:false,score:0,reason:'非法JSON'};}}
const p=root?.parsed_output;
const turns=Array.isArray(p?.turns)&&p.turns.length?p.turns.map(t=>t.parsed_output):[p];
if(turns.length!==${s.turns.length})return {pass:false,score:0,reason:'逐轮交付证据数量不足'};
const evaluate=function(output){${delivery}};
for(let i=0;i<turns.length;i++){const result=evaluate({ok:root?.ok,parsed_output:turns[i]});if(!result.pass)return {...result,reason:'第'+(i+1)+'轮：'+result.reason};}
return {pass:true,score:1,reason:'逐轮终局回复与真实交付记录一致；不代表正文语义/卡片/点击已验收'};`
  };
}
