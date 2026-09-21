import { mkdir, writeFile } from "node:fs/promises";
const UID = "2075490654049271808",
  U = { __cortex_eval_int64: UID },
  OUT = new URL(".", import.meta.url);
const base = {
  task: "agent-e2e",
  lang: "zh-Hans",
  timezone: "Asia/Shanghai",
  timeout_ms: 600000,
  uid: U
};
const pre = `let R=output;if(typeof R==='string'){try{R=JSON.parse(R)}catch{return {pass:false,score:0,reason:'EVIDENCE_GAP:非JSON'}}}if(!R||R.ok!==true||!R.parsed_output)return {pass:false,score:0,reason:'EVIDENCE_GAP:缺ok/parsed_output'};const P=R.parsed_output,FS=Array.isArray(P.turns)&&P.turns.length?P.turns.map(x=>x&&x.parsed_output):[P];if(FS.some(x=>!x||typeof x!=='object'))return {pass:false,score:0,reason:'EVIDENCE_GAP:缺逐轮结果'};const X=[];for(const [fi,f] of FS.entries()){if(!Array.isArray(f.tool_executions))return {pass:false,score:0,reason:'EVIDENCE_GAP:缺tool_executions'};for(const e of f.tool_executions){if(!e||typeof e.tool_request_id!=='string'||!Array.isArray(e.calls)||e.calls.length!==1||!Array.isArray(e.terminals)||e.terminals.length!==1)return {pass:false,score:0,reason:'EVIDENCE_GAP:调用缺唯一请求/终态'};const c=e.calls[0],t=e.terminals[0],tr=t&&t.tool_result;let result=tr?.result;if(typeof result==='string'){try{result=JSON.parse(result)}catch{}}X.push({fi,n:c?.name??c?.tool_name,a:c?.param??c?.args_json,r:result,s:tr?.status})}}`;
function calls(label, order = [], forbidden = [], min = {}, max = {}, extra = "") {
  let cfg = JSON.stringify({ order, forbidden, min, max });
  return {
    type: "javascript",
    metric: `【硬性】执行证据｜${label}`,
    weight: 2,
    value: `${pre}const C=${cfg},N=X.map(x=>x.n);for(const t of C.forbidden)if(N.includes(t))return {pass:false,score:0,reason:'禁止工具被调用：'+t};for(const [t,n] of Object.entries(C.min))if(N.filter(x=>x===t).length<n)return {pass:false,score:0,reason:'缺少真实调用：'+t};for(const [t,n] of Object.entries(C.max))if(N.filter(x=>x===t).length>n)return {pass:false,score:0,reason:'调用超限：'+t};let p=-1;for(const t of C.order){const q=N.indexOf(t,p+1);if(q<0)return {pass:false,score:0,reason:'调用顺序/工具错误：'+t};p=q}${extra}return {pass:true,score:1,reason:'真实 tool_executions 顺序、次数和禁止工具符合预期'};`
  };
}
function biz(label, card = false) {
  return {
    type: "javascript",
    metric: `【硬性】业务结果｜${label}`,
    weight: 2,
    value: `${pre}const has=X.some(x=>{let a=x.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}return a&&((Array.isArray(a.provider)&&a.provider.includes('feishu'))||a.provider==='feishu')});if(!has)return {pass:false,score:0,reason:'没有 provider=feishu 的真实调用'};${card ? `const cards=FS.flatMap(f=>Array.isArray(f.a2ui_surfaces)?f.a2ui_surfaces:[]).filter(s=>String(s.surface_id||'').startsWith('cortex:'));if(!cards.length)return {pass:false,score:0,reason:'未采集到任务结果卡'};` : ""}return {pass:true,score:1,reason:'Feishu 业务结果可消费'};`
  };
}
function confirmCard() {
  return {
    type: "javascript",
    metric: "【硬性】危险操作确认｜第二轮必须有删除确认卡且第三轮才可删除",
    weight: 3,
    value: `${pre}if(FS.length<3)return {pass:false,score:0,reason:'EVIDENCE_GAP:少于三轮，无法验证确认后删除'};if(X.some(z=>z.n==='delete_tasks'&&z.fi===1))return {pass:false,score:0,reason:'第二轮已调用delete_tasks，未等待确认'};const s=FS[1].a2ui_surfaces;if(!Array.isArray(s))return {pass:false,score:0,reason:'EVIDENCE_GAP:第二轮缺a2ui_surfaces'};const cards=s.filter(x=>String(x?.surface_id||'').startsWith('cortex:'));const hit=cards.some(x=>{const ids=Array.isArray(x?.component_ids)?x.component_ids:[];const has=k=>ids.some(id=>id===k||String(id).endsWith('_'+k));return has('targetRow')&&has('targetLabel')&&has('targetBadge0')});if(!hit)return {pass:false,score:0,reason:'第二轮缺少删除危险操作确认卡（targetRow/targetLabel/targetBadge0）'};const ds=X.filter(z=>z.n==='delete_tasks');if(ds.length!==1||ds[0].fi!==2)return {pass:false,score:0,reason:'delete_tasks必须仅在第三轮确认后调用一次'};return {pass:true,score:1,reason:'第二轮出现真实删除确认卡，第三轮确认后才执行一次删除'};`
  };
}
const rub = (s) => ({
  type: "llm-rubric",
  metric: "【质量】回复语义与A2UI交付",
  threshold: 1,
  weight: 1,
  value:
    "只按真实工具调用、工具返回和逐轮输出判定；不得把Planner计划、HTTP 200、根ok或助手自述当业务完成证据。" +
    s +
    "回复须简洁、简体中文，不泄内部ID、原始工具名或未返回字段。"
});
function mk(id, desc, text, as, tag, mode = "isolated") {
  const rb = { ...base, execution_mode: mode };
  if (mode === "client") {
    rb.sid = `feishu-task-${id}`;
    rb.conversation = text.map((x) => ({ role: "user", text: x }));
  } else rb.text = text;
  return {
    contractVersion: "cortex.case-definition.v1",
    description: desc,
    threshold: 1,
    vars: { task: "agent-e2e", request_body: rb },
    metadata: {
      case_id: id,
      req_id: `feishu_task_${id}`,
      task_id: `feishu_task_${id}`,
      business_module: "飞书-任务评测",
      scenario_tag: tag,
      a2ui_capture: true
    },
    assert: as
  };
}
const C = [];
const read =
  "Feishu任务必须保留provider=feishu和真实task_id；列表/搜索如实区分空结果、权限失败、分页或coverage不足；按Asia/Shanghai表达截止时间；结果卡缺失或验证失败不能伪造成功。";
C.push(
  mk(
    "FT-T01",
    "T01｜今天和明天的未完成任务",
    "看看我今天和明天还有哪些飞书任务。",
    [
      calls(
        "日期/状态过滤",
        ["list_tasks"],
        [
          "list_task_collections",
          "search_tasks",
          "get_task",
          "create_tasks",
          "update_task",
          "delete_tasks"
        ],
        { list_tasks: 1 },
        { list_tasks: 1 },
        `const x=X.find(z=>z.n==='list_tasks');let a=x?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(!a||!Array.isArray(a.provider)||a.provider[0]!=='feishu'||a.status!=='open'||!a.due_after||!a.due_before)return {pass:false,score:0,reason:'list_tasks参数必须含feishu/open/due_after/due_before'};`
      ),
      biz("日期范围结果"),
      rub(read + "合法空结果用普通文本，不能说“全部任务”。")
    ],
    "T01-read-date"
  )
);
C.push(
  mk(
    "FT-T02",
    "T02｜解析发布项目清单后查询任务",
    "看看飞书里“发布项目”清单还有哪些任务。",
    [
      calls(
        "清单可信ID",
        ["list_task_collections", "list_tasks"],
        ["search_tasks", "create_tasks", "update_task", "delete_tasks"],
        { list_task_collections: 1, list_tasks: 1 },
        { list_task_collections: 1, list_tasks: 1 },
        `const c=X.find(z=>z.n==='list_task_collections'),l=X.find(z=>z.n==='list_tasks');let a=l?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(!a||!Array.isArray(a.provider)||a.provider[0]!=='feishu'||!a.collection_id)return {pass:false,score:0,reason:'缺Feishu collection_id'};const cols=c?.r?.collections||[];if(Array.isArray(cols)&&cols.length&&!cols.some(z=>z.id===a.collection_id))return {pass:false,score:0,reason:'collection_id不是本轮清单结果中的真实ID'};`
      ),
      biz("清单任务结果"),
      rub(read + "必须先调用list_task_collections；同名多候选要先让用户选择，不能把名称直接当ID。")
    ],
    "T02-collection"
  )
);
C.push(
  mk(
    "FT-T03",
    "T03｜搜索发布相关任务",
    "找一下和发布相关的飞书任务。",
    [
      calls(
        "标题关键词搜索",
        ["search_tasks"],
        [
          "list_task_collections",
          "list_tasks",
          "get_task",
          "create_tasks",
          "update_task",
          "delete_tasks"
        ],
        { search_tasks: 1 },
        { search_tasks: 1 },
        `const x=X.find(z=>z.n==='search_tasks');let a=x?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!String(a.query||'').includes('发布'))return {pass:false,score:0,reason:'搜索必须是Feishu且query含发布'};`
      ),
      biz("搜索与覆盖结果"),
      rub(
        read +
          "当前参数只明确标题匹配；未命中不能断言任务不存在，必须保留覆盖范围说明和真实task_id。"
      )
    ],
    "T03-search"
  )
);
C.push(
  mk(
    "FT-T04",
    "T04｜从搜索结果打开详情",
    ["找一下和发布相关的飞书任务。", "看第二个待办任务，告诉我due"],
    [
      calls(
        "搜索到详情的身份链路",
        ["search_tasks", "get_task"],
        ["list_task_collections", "list_tasks", "create_tasks", "update_task", "delete_tasks"],
        { search_tasks: 1, get_task: 1 },
        { search_tasks: 1, get_task: 1 },
        `const g=X.find(z=>z.n==='get_task');let a=g?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!a.task_id)return {pass:false,score:0,reason:'get_task必须继承Feishu真实task_id'};`
      ),
      biz("详情字段"),
      rub(
        read +
          "详情目标必须继承当前可信结果的provider和task_id，不能跨Provider猜ID，也不能用父任务代替子任务；缺失字段要明说。"
      )
    ],
    "T04-detail",
    "client"
  )
);
C.push(
  mk(
    "FT-T05",
    "T05｜创建个人飞书任务",
    "在飞书任务里创建“EVAL-FT-T05-周五前完成发布方案”，截止时间是2026年9月25日星期五下午6点。",
    [
      calls(
        "创建必填字段",
        ["create_tasks"],
        ["list_task_collections", "search_tasks", "list_tasks", "update_task", "delete_tasks"],
        { create_tasks: 1 },
        { create_tasks: 1 },
        `const x=X.find(z=>z.n==='create_tasks');let a=x?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!Array.isArray(a.tasks)||a.tasks.length!==1||a.tasks[0]?.title!=='EVAL-FT-T05-周五前完成发布方案'||!a.tasks[0]?.due)return {pass:false,score:0,reason:'创建必须有Feishu/title/due'};`
      ),
      biz("创建真实返回"),
      rub(
        read +
          "截止时间明确，不得追问或补当前时间。只有Tool成功且返回真实任务字段/ID才可展示成功卡；priority未落库不得声称已持久化；不确定不自动重试。"
      )
    ],
    "T05-create"
  )
);
C.push(
  mk(
    "FT-T06",
    "T06｜完成并更新已有任务",
    "把“猛猛练”这个飞书任务标记为已完成，并把描述改成“已交付”。",
    [
      calls(
        "定位后局部更新",
        ["search_tasks", "update_task"],
        ["list_task_collections", "create_tasks", "delete_tasks"],
        { search_tasks: 1, update_task: 1 },
        { update_task: 1 },
        `const u=X.find(z=>z.n==='update_task');let a=u?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(!a||a.provider!=='feishu'||!a.task_id||a.status!=='completed'||a.description!=='已交付')return {pass:false,score:0,reason:'update_task必须只改status=completed和description=已交付且使用真实ID'};`
      ),
      biz("更新任务与changes"),
      rub(
        read +
          "只改变用户明确字段；不能因为标题更新成功就声称负责人或优先级变化，Feishu priority不持久化。"
      )
    ],
    "T06-update"
  )
);
C.push(
  mk(
    "FT-T07",
    "T07｜确认后删除任务",
    [
      "找一下标题为“周五前完成发布方案”的飞书任务，先不要删除。",
      "你删掉这个待办吧。",
      "确认删除。"
    ],
    [
      calls(
        "确认后按可信快照删除",
        ["search_tasks", "delete_tasks"],
        ["list_task_collections", "create_tasks", "update_task"],
        { search_tasks: 1, delete_tasks: 1 },
        { delete_tasks: 1 },
        `const d=X.find(z=>z.n==='delete_tasks');let a=d?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!Array.isArray(a.task_ids)||a.task_ids.length!==1||!a.task_ids[0])return {pass:false,score:0,reason:'删除必须使用可信Feishu task_id'};if(X.some(z=>z.n==='delete_tasks'&&z.fi===1))return {pass:false,score:0,reason:'第二轮不得调用delete_tasks'};if(d?.fi!==2)return {pass:false,score:0,reason:'delete_tasks必须发生在第三轮确认后'};`
      ),
      confirmCard(),
      biz("逐项删除结果"),
      rub(
        read +
          "第二轮必须出删除危险操作确认卡且不得调用delete_tasks；第三轮“确认删除”后才执行一次删除。删除前要展示标题、截止时间、来源并获得确认；删除没有恢复API，不能说进入回收站；部分失败必须逐项表达。"
      )
    ],
    "T07-delete",
    "client"
  )
);
C.push(
  mk(
    "FT-T08",
    "T08｜空结果与覆盖不足",
    "查一下关键词“任务评测-不存在-ZZZ”的飞书任务；如果权限或分页没有覆盖完整，请如实告诉我。",
    [
      calls(
        "空结果搜索",
        ["search_tasks"],
        [
          "list_task_collections",
          "list_tasks",
          "get_task",
          "create_tasks",
          "update_task",
          "delete_tasks"
        ],
        { search_tasks: 1 },
        { search_tasks: 1 },
        `const x=X.find(z=>z.n==='search_tasks');let a=x?.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!String(a.query||'').includes('任务评测-不存在-ZZZ'))return {pass:false,score:0,reason:'必须按用户关键词搜索Feishu'};`
      ),
      biz("真实空结果/coverage"),
      rub(
        read +
          "空结果只能说本次覆盖范围没有匹配；权限失败、分页未完成、部分失败不能伪装成空结果，可用普通文本且不生成空业务卡。"
      )
    ],
    "T08-empty"
  )
);
C.push(
  mk(
    "FT-T09",
    "T09｜子任务与消息提取边界",
    "把刚才那条飞书任务拆成子任务，并把群消息总结里的待办自动创建成飞书任务。",
    [
      calls("不支持能力零写入", [], ["create_tasks", "update_task", "delete_tasks"], {}, {}),
      rub(
        read +
          "当前Feishu Task只支持一级任务，不支持子任务读写；消息待办只能提取普通文本，不能自动create_tasks；信息不足时直接说明限制，不出伪造成功卡。"
      )
    ],
    "T09-boundary"
  )
);
C.push(
  mk(
    "FT-LC01",
    "组合长链路｜列表→搜索→详情",
    [
      "先看看我今天和明天还有哪些未完成的飞书任务。",
      "再找一下和发布相关的飞书任务。",
      "打开刚才搜索结果里的第一条，看看描述和截止时间。"
    ],
    [
      calls(
        "读长链路",
        ["list_tasks", "search_tasks", "get_task"],
        ["create_tasks", "update_task", "delete_tasks"],
        { list_tasks: 1, search_tasks: 1, get_task: 1 },
        { list_tasks: 1, search_tasks: 1, get_task: 1 }
      ),
      biz("三段真实读结果")
    ],
    "LC01-read",
    "client"
  )
);
C.push(
  mk(
    "FT-LC02",
    "组合长链路｜创建→更新→完成→重开→详情→清理",
    [
      "创建一个飞书任务“EVAL-FT-LC02-发布方案链路”，截止时间是2026年9月25日18点。",
      "把刚才创建的任务描述改成“已交付”。",
      "把它标记为已完成。",
      "重新打开刚才的任务。",
      "读取这条任务的详情。",
      "清理测试数据，删除刚才这条飞书任务。"
    ],
    [
      calls(
        "写入长链路与真实ID",
        ["create_tasks", "update_task", "update_task", "get_task", "delete_tasks"],
        ["list_task_collections", "search_tasks"],
        { create_tasks: 1, update_task: 2, get_task: 1, delete_tasks: 1 },
        { create_tasks: 1, update_task: 2, delete_tasks: 1 },
        `for(const z of X.filter(x=>['update_task','get_task','delete_tasks'].includes(x.n))){let a=z.a;if(typeof a==='string'){try{a=JSON.parse(a)}catch{}}if(a?.provider!=='feishu'||!a.task_id)return {pass:false,score:0,reason:'写后链路必须使用Feishu真实task_id'};}`
      ),
      biz("写入后详情与清理")
    ],
    "LC02-write",
    "client"
  )
);
await mkdir(OUT, { recursive: true });
await writeFile(new URL("cases.jsonl", OUT), C.map((x) => JSON.stringify(x)).join("\n") + "\n");
await writeFile(new URL("cases.json", OUT), JSON.stringify(C, null, 2) + "\n");
const M = {
  suite: {
    name: "飞书-任务评测",
    uid: UID,
    version: "1.0.0",
    timezone: "Asia/Shanghai",
    case_count: C.length
  },
  case_ids: C.map((x) => x.metadata.case_id),
  mode: {
    isolated: ["FT-T01", "FT-T02", "FT-T03", "FT-T05", "FT-T06", "FT-T08", "FT-T09"],
    client: ["FT-T04", "FT-T07", "FT-LC01", "FT-LC02"]
  },
  long_chain: ["FT-LC01", "FT-LC02"],
  rules: [
    "真实tool_executions优先",
    "collection_id只来自成功清单结果",
    "Feishu仅一级任务",
    "空结果/权限/分页/部分失败分开",
    "未知写结果先回读不重试"
  ],
  cleanup: "创建/更新/删除类按真实task_id精确回读与清理"
};
await writeFile(new URL("manifest.json", OUT), JSON.stringify(M, null, 2) + "\n");
console.log(JSON.stringify({ count: C.length, file: new URL("cases.jsonl", OUT).pathname }));
