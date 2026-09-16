/** Build import files only. Never imports, runs Agent/Judge, or provisions real Feishu resources. */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CaseAuthoringV1Schema } from "../../packages/contracts/src/case-authoring-contracts.ts";
import { executionAssertion, replyAssertion, writeTools, type Scenario } from "./assertions.ts";
const dir = dirname(fileURLToPath(import.meta.url));
const suiteConfig = JSON.parse(await readFile(resolve(dir, "suite-config.json"), "utf8"));
const source = JSON.parse(await readFile(resolve(dir, "source-index.json"), "utf8"));
const scenarios: Scenario[] = JSON.parse(
  await readFile(resolve(dir, "scenarios.json"), "utf8")
).cases;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const args = process.argv.slice(2),
  configIndex = args.indexOf("--bindings");
if (args.some((x, i) => !(x === "--bindings" || (i === configIndex + 1 && configIndex >= 0))))
  throw new Error("Usage: build-cases.ts [--bindings /absolute/config.json]");
const configPath = configIndex >= 0 ? resolve(args[configIndex + 1] ?? "") : null;
const config = configPath ? JSON.parse(await readFile(configPath, "utf8")) : null;
const ready = Boolean(config);
if (ready) {
  if (!/^[1-9]\d{0,18}$/.test(config.uid ?? "") || BigInt(config.uid) > 9223372036854775807n)
    throw new Error("需要真实正int64 uid字符串，不用JS浮点数承载");
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(config.run_label ?? ""))
    throw new Error("run_label需唯一的3-40位字母数字_-标记");
  if (
    !Array.isArray(config.selected_case_ids) ||
    !config.selected_case_ids.length ||
    new Set(config.selected_case_ids).size !== config.selected_case_ids.length
  )
    throw new Error("必须显式选择非空且不重复的case列表");
  if (
    !Array.isArray(config.active_write_tools) ||
    writeTools.some((t) => !config.active_write_tools.includes(t)) ||
    config.active_write_tools.some((t: unknown) => typeof t !== "string" || !t.trim())
  )
    throw new Error("声明已核对的当前全部可用写工具清单，至少包含飞书6个写工具");
  for (const k of [
    "test_scope_approved",
    "endpoint_full_output_verified",
    "tool_schema_verified",
    "fixtures_reviewed",
    "write_tool_inventory_complete"
  ])
    if (config.preflight?.[k] !== true) throw new Error("未满足预检：" + k);
  if (
    scenarios.some((s) => s.side_effect && config.selected_case_ids.includes(s.id)) &&
    config.preflight?.writes_approved !== true
  )
    throw new Error("写测试需明确批准专用资源副作用范围");
}
const selected = ready
  ? config.selected_case_ids.map((id: string) => {
      const s = scenarios.find((s) => s.id === id);
      if (!s) throw new Error("未知Case：" + id);
      return s;
    })
  : scenarios;
const sessions = new Set<string>();
const unresolved = new Set<string>();
function substitute(value: any, tokens: Record<string, unknown>): any {
  if (Array.isArray(value)) return value.map((v) => substitute(v, tokens));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, tokens)]));
  if (typeof value !== "string") return value;
  const whole = /^\{\{([a-z_]+)\}\}$/.exec(value);
  if (whole && Object.hasOwn(tokens, whole[1])) return tokens[whole[1]];
  return value.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => {
    if (!Object.hasOwn(tokens, k)) {
      unresolved.add(k);
      return `BIND_REQUIRED_${k}`;
    }
    const v = tokens[k];
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}
const definitions = [],
  receipts = [];
for (const original of selected) {
  const binding = ready ? config.cases?.[original.id] : null;
  if (ready && (!binding || binding.reviewed !== true))
    throw new Error(original.id + "：缺已审核逐例绑定");
  const marker = `测试[EVAL:${config?.run_label ?? "DRAFT"}:${original.id}] `;
  const tokens = {
    ...suiteConfig.known_tokens,
    message_text: marker + "排期测试：灰度后全量，请确认回归结果。",
    append_text: marker + "追加测试结论：先灰度后全量；不修改原文。",
    ...(config?.tokens ?? {}),
    ...(binding?.tokens ?? {}),
    marker
  };
  unresolved.clear();
  const s = substitute(original, tokens) as Scenario;
  if (ready && unresolved.size)
    throw new Error(original.id + "：缺tokens " + [...unresolved].join(","));
  let baseline: any = { not_bound: true },
    setupHash = null,
    faultHash = null;
  if (ready) {
    for (const [k, v] of Object.entries(tokens)) {
      if (
        typeof v === "string" &&
        /BIND_REQUIRED_|REPLACE_ME|example\.feishu|ou_example|oc_example|omm_example/.test(v)
      )
        throw new Error(original.id + "：占位数据未替换 " + k);
      if (["doc_url", "source_doc_url"].includes(k) && typeof v === "string") {
        const u = new URL(v);
        if (u.protocol !== "https:" || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname))
          throw new Error("文档URL需实际飞书/Lark HTTPS域名");
      }
      if (/person_id$|self_id$/.test(k) && typeof v === "string" && !v.startsWith("ou_"))
        throw new Error("人员ID前缀错误：" + k);
      if (k === "group_id" && typeof v === "string" && !v.startsWith("oc_"))
        throw new Error("群ID前缀错误");
    }
    for (const t of s.turns)
      for (const r of t.required)
        for (const k of ["attendees", "block_ids", "event_ids"]) {
          const v = r.args[k];
          if (v !== undefined && (!Array.isArray(v) || !v.length))
            throw new Error(original.id + "：" + k + "必须是真实非空数组，不是字符串");
        }
    if (
      s.side_effect &&
      s.turns.some((t) => t.allowed_writes.create_event || t.allowed_writes.update_event)
    ) {
      const { start, end } = tokens as any;
      if (
        start !== undefined &&
        (!/(Z|[+-]\d{2}:\d{2})$/.test(start) ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(end ?? "") ||
          !(Date.parse(start) > Date.now()) ||
          !(Date.parse(end) > Date.parse(start)))
      )
        throw new Error(original.id + "：会议起止需带时区且是未来有效时段");
    }
    if (typeof binding.setup_evidence_path !== "string" || !binding.setup_evidence_path.trim())
      throw new Error(original.id + "：缺fixture证据文件");
    const setup = await readFile(
      resolve(dirname(configPath!), binding.setup_evidence_path),
      "utf8"
    );
    setupHash = sha(setup);
    baseline = JSON.parse(setup);
    if (
      !baseline ||
      typeof baseline !== "object" ||
      Array.isArray(baseline) ||
      !Object.keys(baseline).length ||
      baseline.not_bound
    )
      throw new Error(original.id + "：fixture证据不能为空/占位");
    if (
      !Array.isArray(baseline.resources) ||
      !baseline.resources.length ||
      !baseline.expected_facts ||
      typeof baseline.expected_facts !== "object" ||
      Array.isArray(baseline.expected_facts) ||
      !Object.keys(baseline.expected_facts).length ||
      typeof baseline.captured_at !== "string" ||
      !Number.isFinite(Date.parse(baseline.captured_at))
    )
      throw new Error(original.id + "：fixture证据需非空resources/expected_facts和有效captured_at");
    if (s.fault) {
      if (!binding.fault_setup_path) throw new Error(original.id + "：故障例缺受控故障配置证据");
      faultHash = sha(
        await readFile(resolve(dirname(configPath!), binding.fault_setup_path), "utf8")
      );
    }
  }
  const multi = s.turns.length > 1;
  if (ready && multi) {
    if (config.preflight?.client_context_verified !== true)
      throw new Error("多轮需核对client真实会话与逐轮证据");
    if (typeof binding.sid !== "string" || !binding.sid.trim() || sessions.has(binding.sid))
      throw new Error(s.id + "：需要每例独立且入口认可的真实sid");
    sessions.add(binding.sid);
  }
  const originalSource = source[s.source_id];
  const common = `仅根据当前真实执行证据评分，不把预期/fixture/故障计划当实际输出。Planner计划、HTTP200、顶层ok、接口成功均不等于业务完成。检查每轮parsed_output.turns[i].parsed_output；单轮使用parsed_output。缺关键证据必须不通过并明确“证据不足”，不得猜测。证据不足/未命中故障归因评测环境，不归因产品失败；已观察违规则给出工具请求ID和轮次。判定二元0/1，只有全部要求满足才1。不得按输出倒改golden。`;
  const assertions: any[] = [
    executionAssertion(s, config?.active_write_tools ?? writeTools),
    replyAssertion(s),
    {
      type: "llm-rubric",
      metric: "业务｜逐轮目标、对象连续性、写后回读与恢复",
      weight: 1,
      threshold: 1,
      value: `${common}\nCase ${s.id} ${s.name}\n输入及逐轮约束：${JSON.stringify(s.turns)}\n前置（仅预期）：${s.fixture}\n本例验收：${s.expected}\n${s.kind === "core" ? "原始正常路径：" + originalSource.agent : "本例是原场景分支，只以本例要求替代原文正常写入链，不能要求被禁止的写入。"}\n执行前基线（需与实际工具输出核对）：${JSON.stringify(baseline)}\n严格对照工具calls参数、关联terminals业务结果和原始timeline顺序，检查读取->写入->按返回原ID回读，不能以写前读取当写后回读。修改原文档必须逐项对比保留块/子块/正文；改标题核对正文hash或完整内容及stable URL。日程最小delta；attendees整体替换需完整并集，人员/房间保持且不把组织者当accepted；查房responseStatus和新旧时间忙闲，单有location不算预约。消息按message_id/chat_id及全文回读，回复核对reply_to_message_id、reply_in_thread；多目标集合去重不漏人，每个成功项独立回读。正常读/写链不得接受缺正文、分页遗漏、部分失败或伪造URL。对于允许只读失败的取消核验，193003只证明原event已删除，其余错误不能证明删除。未知写结果先只读核验而非盲重试。\n故障计划：${s.fault ?? "无；正常例如遇环境故障不能作为正常功能通过"}。若有故障，必须用真实日志证明故障确实命中指定步骤、状态和目标；缺证据是未覆盖，不可因措辞合理判通过。故障例成功的写入部分同样必须身份匹配且回读核验，失败/未核验部分明确披露。\n拒绝编造本人、成员、忙闲、已读/accepted/房间占用等状态。相对时间以执行时真实时钟和timezone为依据，缺时钟不猜。`
    },
    {
      type: "llm-rubric",
      metric: "UI协议｜实际出站卡与分支（不含视觉和点击）",
      weight: 1,
      threshold: 1,
      value: `${common}\n本例输入与分支：${JSON.stringify(s.turns)}\n本例预期：${s.expected}\n原始UI参照（仅选本例实际适用分支）：${originalSource.ui}\n只检查真实出站a2ui/已交付信封，不用Planner present_mode。tool_start=tool_status/started/default；默认失败tool_fail=tool_status/failed/default；delete_events失败例外event_list_detail；结果通常tool_status/success_final/default，有后续用success_with_follow_up；主动呈现present_result/ready/default。文档正文markdown_title_body，候选/忙闲list_simple，消息slack_list_messages仍是飞书来源，日程event_detail/list为event_list_detail；概览增强才carousel_list_events。文档无正文不得伪造正文结果卡；空结果/取消需真实文本，无调用失败不出现tool_fail。发送确认send_message_multi_target与删除确认event_list_detail：tool_confirm/request/request；多目标外层tool_confirm_group/group_request、成员send_message_multi_target。本例每一版最终内容一次确认，修改目标/正文后更新确认，不能让旧内容被发送。文档写入及日程create/update不强加不存在的危险确认卡，必要预览用文本；前置读取可能出卡，不强制每次分页出独立新卡。\n核对卡片字段、实际资源ID和调用状态一致。要求“不出卡”时必须存在完整采集证明（例如outbound_capture.status=COLLECTED且该轮已结束）；空a2ui数组本身不证明无卡。缺该证据应不通过并注明证据不足。UI语义协议评分不能批准布局、可见性、真实按钮点击、客户端交互，这些必须独立人工复核。`
    }
  ];
  if (!ready)
    assertions.unshift({
      type: "javascript",
      metric: "未绑定｜草案禁止作为验收结果",
      weight: 1,
      value:
        "throw new Error('FIXTURE_NOT_BOUND: 该文件仅供导入查看；请绑定真实账号/测试资源并生成ready文件。草稿另以client模式缺sid在E2E入口前置拒绝；此断言本身不承担REST拦截。');"
    });
  const body: any = {
    uid: { __cortex_eval_int64: config?.uid ?? suiteConfig.uid },
    timezone: "Asia/Shanghai",
    lang: "zh-Hans",
    execution_mode: ready ? (multi ? "client" : "isolated") : "client",
    timeout_ms: Math.min(240000, Math.floor(540000 / s.turns.length)),
    ...(multi
      ? {
          ...(ready ? { sid: binding.sid } : {}),
          conversation: s.turns.map((t) => ({ role: "user", text: t.text }))
        }
      : { text: s.turns[0].text })
  };
  const definition = CaseAuthoringV1Schema.parse({
    contractVersion: "cortex.case-definition.v1",
    description: `${ready ? "" : "[待授权/前置锁定]｜"}${s.priority}｜${s.id}｜${s.name}`,
    threshold: 1,
    vars: { task: "agent-e2e", request_body: body },
    metadata: {
      case_id: s.id,
      req_id: `feishu_${s.id}`,
      task_id: `feishu_${s.id}`,
      business_module: `飞书-${({ D: "文档", M: "消息", C: "日程", X: "组合" } as any)[s.source_id[0]]}`,
      scenario_tag: `feishu-${s.kind}${ready ? "" : "-blocked-auth-fixture"}`,
      a2ui_capture: true
    },
    assert: assertions
  });
  definitions.push(definition);
  receipts.push({
    case_id: s.id,
    source: s.source_id,
    side_effect: s.side_effect,
    multi_turn: multi,
    fixture_sha256: setupHash,
    fault_setup_sha256: faultHash,
    definition_sha256: sha(JSON.stringify(definition))
  });
}
const outDir = ready ? resolve(dir, ".local", config.run_label) : dir;
await mkdir(outDir, { recursive: true });
const out = resolve(outDir, ready ? "cases.ready.jsonl" : "cases.draft.jsonl");
if (ready) {
  let exists = true;
  try {
    await access(out);
  } catch {
    exists = false;
  }
  if (exists)
    throw new Error(
      "本run_label已生成；为防复用测试标记，改用新run_label并重新核对fixture，不覆盖ready文件"
    );
}
const data = definitions.map((c) => JSON.stringify(c)).join("\n") + "\n";
await writeFile(out, data);
await writeFile(
  resolve(outDir, ready ? "manifest.ready.json" : "manifest.draft.json"),
  JSON.stringify(
    {
      version: "2.0",
      generated_at: ready ? new Date().toISOString() : "2026-09-15",
      state: ready ? "BOUND_NOT_EXECUTED" : "BLOCKED_AUTH_AND_FIXTURES_INGRESS_LOCKED",
      source_sha256: sha(await readFile(resolve(dir, "source-cases.txt"), "utf8")),
      cases: definitions.length,
      sha256: sha(data),
      business_executed: false,
      endpoint_id: suiteConfig.endpoint_id,
      draft_ingress_lock: ready ? null : "client模式不发送sid；E2E入口返回EVAL_E2E_CLIENT_CONTEXT_REQUIRED，Router前拒绝",
      notes:
        "ready仅表示已通过绑定检查，不代表权限/故障/业务/UI验收通过；preflight由运行负责人声明而非自动探测",
      entries: receipts
    },
    null,
    2
  ) + "\n"
);
console.log(
  JSON.stringify({
    output: out,
    cases: definitions.length,
    state: ready ? "BOUND_NOT_EXECUTED" : "BLOCKED_AUTH_AND_FIXTURES_INGRESS_LOCKED",
    business_executed: false
  })
);
