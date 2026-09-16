/**
 * 飞书 E2E v2｜证据解析层（帧无关）。
 *
 * 唯一规则源：test_suite/feishu-e2e-v2/SPEC.md 第 1 节「证据契约」。
 * 本文件提供两套东西：
 *   1) TS 侧解析器与取值器（parseEnvelope / replyText / actualCalls / resultSurfaces …），
 *      供单测与 scripts/validate-rules.ts 在宿主里核对真实证据；
 *   2) 内联 JS 片段库（JS_CHUNKS），供 checks.ts 拼成 Promptfoo `javascript` 断言的 value。
 *      断言里禁止 import / I/O / eval / new Function，所以证据解析逻辑必须以文本形式内联。
 *
 * 失败语义（SPEC 第 8 节第 5 条）：缺证据一律返回 { insufficient: '具体缺什么' }，
 * 调用方产出 pass:false 且 reason 以「证据不足：」开头；既不静默当产品通过，也不当产品逻辑失败。
 */

/* ------------------------------------------------------------------ *
 * SPEC 1.4 已授权工具目录（83 个，实测来自 router system_prompt）
 * ------------------------------------------------------------------ */
export const AUTHORIZED_TOOLS: readonly string[] = [
  // calendar(5)
  "create_event",
  "delete_events",
  "get_event",
  "list_events",
  "update_event",
  // contact(6)
  "create_contact",
  "delete_contact",
  "get_contact",
  "list_contacts",
  "search_contacts",
  "update_contact",
  // feishu(15)
  "feishu_create_doc",
  "feishu_get_doc",
  "feishu_get_thread_replies",
  "feishu_get_user_profile",
  "feishu_list_calendars",
  "feishu_list_chat_members",
  "feishu_list_conversations",
  "feishu_list_messages",
  "feishu_list_room_availability",
  "feishu_query_free_busy",
  "feishu_search_docs",
  "feishu_search_messages",
  "feishu_search_users",
  "feishu_send_message",
  "feishu_update_doc",
  // google_docs(3)
  "batch_update_google_doc",
  "create_google_doc",
  "get_google_doc",
  // google_drive(8)
  "copy_drive_files",
  "create_drive_folder",
  "delete_drive_files",
  "get_drive_file",
  "list_drive_files",
  "move_drive_files",
  "read_drive_file",
  "rename_drive_file",
  // mail(3)
  "get_mail_by_id",
  "get_mail_list",
  "send_mail",
  // notion(8)
  "append_to_notion_page",
  "apply_notion_page_draft",
  "create_notion_page",
  "get_notion_page",
  "list_notion_accessible_items",
  "publish_artifact_to_notion",
  "search_notion",
  "update_notion_page_draft",
  // task(7)
  "create_tasks",
  "delete_tasks",
  "get_task",
  "list_task_collections",
  "list_tasks",
  "search_tasks",
  "update_task",
  // teams(11)
  "teams_find_meeting_times",
  "teams_list_channels",
  "teams_list_chats",
  "teams_list_teams",
  "teams_read_channel_messages",
  "teams_read_channel_replies",
  "teams_read_chat_messages",
  "teams_reply_channel_message",
  "teams_search_messages",
  "teams_send_channel_message",
  "teams_send_chat_message",
  // zoom(2)
  "get_zoom_me",
  "get_zoom_presence_status",
  // standalone(15)
  "camera_shooting",
  "clipboard",
  "get_hotel",
  "get_restaurant",
  "get_weather",
  "get_web_url_content",
  "ios_reminder_create",
  "ios_reminder_delete",
  "ios_reminder_list",
  "ios_reminder_list_lists",
  "ios_reminder_update",
  "perform",
  "search_conversation_history",
  "turn_direction",
  "web_search"
];

/** 评测框架自身的申报工具，不属于业务目录，但会出现在 tool_executions 里（D6.2）。 */
export const META_TOOLS: readonly string[] = ["declare_miss_tool_candidates"];

/** 写入型工具（默认清单；场景可用 allowedWrites 的键扩充）。 */
export const DEFAULT_WRITE_TOOLS: readonly string[] = [
  "create_event",
  "update_event",
  "delete_events",
  "feishu_create_doc",
  "feishu_update_doc",
  "feishu_send_message",
  "create_tasks",
  "update_task",
  "delete_tasks",
  "create_contact",
  "update_contact",
  "delete_contact",
  "create_google_doc",
  "batch_update_google_doc",
  "copy_drive_files",
  "create_drive_folder",
  "delete_drive_files",
  "move_drive_files",
  "rename_drive_file",
  "send_mail",
  "create_notion_page",
  "append_to_notion_page",
  "apply_notion_page_draft",
  "publish_artifact_to_notion",
  "update_notion_page_draft",
  "teams_reply_channel_message",
  "teams_send_channel_message",
  "teams_send_chat_message",
  "ios_reminder_create",
  "ios_reminder_update",
  "ios_reminder_delete"
];

/** 日程类工具（D1.2 provider 校验对象）。 */
export const CALENDAR_TOOLS: readonly string[] = [
  "create_event",
  "update_event",
  "delete_events",
  "get_event",
  "list_events"
];

/**
 * D1.1 事项类型族。族内工具决定「这件事被分流成了什么」；
 * 族外工具（feishu_search_users / feishu_query_free_busy / feishu_list_room_availability 等）
 * 是中性解析器，不参与分流判定。
 */
export const KIND_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Event: ["create_event", "update_event", "delete_events", "get_event", "list_events"],
  Reminder: [
    "ios_reminder_create",
    "ios_reminder_update",
    "ios_reminder_delete",
    "ios_reminder_list",
    "ios_reminder_list_lists"
  ],
  Task: [
    "create_tasks",
    "update_task",
    "delete_tasks",
    "get_task",
    "list_tasks",
    "search_tasks",
    "list_task_collections"
  ],
  Doc: [
    "feishu_create_doc",
    "feishu_update_doc",
    "feishu_get_doc",
    "feishu_search_docs",
    "create_google_doc",
    "get_google_doc",
    "batch_update_google_doc",
    "create_notion_page",
    "get_notion_page",
    "update_notion_page_draft",
    "apply_notion_page_draft",
    "append_to_notion_page",
    "search_notion"
  ],
  Message: [
    "feishu_send_message",
    "feishu_list_messages",
    "feishu_search_messages",
    "feishu_get_thread_replies",
    "feishu_list_conversations",
    "feishu_list_chat_members",
    "get_mail_list",
    "get_mail_by_id",
    "send_mail",
    "teams_send_chat_message",
    "teams_send_channel_message",
    "teams_reply_channel_message",
    "teams_read_chat_messages",
    "teams_read_channel_messages",
    "teams_read_channel_replies",
    "teams_search_messages"
  ],
  External: ["web_search", "get_restaurant", "get_hotel", "get_weather", "get_web_url_content"]
};

/* ------------------------------------------------------------------ *
 * SPEC 1.3 A2UI 卡片族判定组件
 * 实测组件 id 常带序号前缀（event0_eventItem / c0_events），因此按「等于或以 _<kw> 结尾」匹配。
 * ------------------------------------------------------------------ */
export const CARD_FAMILY_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  EVENT: ["eventItem", "eventRow", "eventTitle", "eventMetaWide", "eventMetaGrid", "events"],
  MESSAGE: ["messageItem", "messageContent", "messageText", "messageMeta"],
  LIST: ["rowPrimary", "countBadge"],
  DOC: ["documentLink", "bodyBox"],
  CONFIRM: ["targetRow", "targetLabel", "targetBadge0"],
  TEXT: ["title", "col"]
};

/** LIST 族的 SPEC 1.3 定义是 `row` + `rowPrimary`（或 `countBadge`），需要成对判定。 */
export const LIST_REQUIRES_ROW = true;

export type CardFamily = keyof typeof CARD_FAMILY_COMPONENTS;
export const CARD_FAMILIES: readonly CardFamily[] = [
  "EVENT",
  "MESSAGE",
  "LIST",
  "DOC",
  "CONFIRM",
  "TEXT"
];

/* ------------------------------------------------------------------ *
 * D4 语音规则常量（SPEC 第 2 节 D4 表，逐字来自 SPEC，不得按实际输出倒改）
 * ------------------------------------------------------------------ */
export const BANNED_WORDS: readonly string[] = [
  "为您",
  "很高兴",
  "请问有什么可以帮您",
  "总之",
  "综上",
  "希望对你有帮助",
  "元气满满",
  "满满的",
  "家里的一份子",
  "抱歉听到",
  "这种感觉确实",
  "干饭人",
  "yyds",
  "上大分",
  "打工人",
  "绝绝子",
  "破防了",
  "啧",
  "您"
];

export const PARTICLES: readonly string[] = ["呀", "啦", "哦", "呢", "嘛", "咯"];

/** 仅收繁体专有字形，简体正字一律不在表内，避免误判。 */
export const TRADITIONAL_ONLY_CHARS: readonly string[] = [
  "說",
  "來",
  "過",
  "時",
  "對",
  "裡",
  "們",
  "這",
  "還",
  "與",
  "發",
  "後",
  "給",
  "從",
  "進",
  "問",
  "讓",
  "無",
  "點",
  "鐘",
  "麼",
  "樣",
  "東",
  "車",
  "馬",
  "門",
  "開",
  "關",
  "電",
  "話",
  "誰",
  "認",
  "識",
  "記",
  "錄",
  "經",
  "結",
  "統",
  "語",
  "請",
  "謝",
  "誤",
  "幫",
  "廣",
  "應",
  "廳",
  "曆",
  "單",
  "雙",
  "數",
  "據",
  "檔",
  "資",
  "訊",
  "網",
  "絡",
  "線",
  "圖",
  "標",
  "頭",
  "頁",
  "內",
  "確",
  "實",
  "會",
  "議",
  "參",
  "顯",
  "題",
  "辦",
  "學",
  "機",
  "構",
  "員",
  "號",
  "書",
  "寫",
  "讀",
  "訊",
  "覽",
  "衝"
];

/* ------------------------------------------------------------------ *
 * TS 侧类型与解析
 * ------------------------------------------------------------------ */
export type Json = unknown;

/** 缺证据。reason 必须以「证据不足：」开头（SPEC 第 8 节第 5 条）。 */
export interface Insufficient {
  readonly insufficient: string;
}

export function insufficient(what: string): Insufficient {
  return { insufficient: what };
}

export function isInsufficient<T>(value: T | Insufficient): value is Insufficient {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { insufficient?: unknown }).insufficient === "string"
  );
}

export interface ActualCall {
  /** 在本帧 tool_executions 里的下标（D2.2 按它比先后）。 */
  readonly index: number;
  readonly name: string | null;
  readonly args: Json;
  readonly toolRequestId: string | null;
  readonly status: string | null;
  readonly terminalType: string | null;
  readonly toolResultStatus: string | null;
  readonly result: Json;
  readonly errorCode: string | null;
  readonly errorText: string | null;
  /** calls 与 terminals 是否各恰好 1 条（唯一终态）。 */
  readonly singleTerminal: boolean;
}

export interface Surface {
  readonly surfaceId: string | null;
  readonly catalogId: string | null;
  readonly componentIds: readonly string[];
  readonly computed: Json;
  readonly dataModel: Json;
  readonly sourceToolNames: readonly string[];
  readonly raw: Json;
}

export interface Frame {
  /** 0-based 帧号。 */
  readonly index: number;
  readonly reqId: string | null;
  readonly inputText?: string | undefined;
  readonly executionReady?: boolean | undefined;
  readonly p: Record<string, Json>;
}

export interface ParsedEnvelope {
  readonly ok: true;
  readonly frames: readonly Frame[];
  readonly root: Record<string, Json>;
  readonly conversationExecution: Json;
  readonly executionMode: string | null;
  readonly multiTurn: boolean;
}

export type Envelope = ParsedEnvelope | { readonly error: string };

const rec = (value: Json): Record<string, Json> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;

const str = (value: Json): string | null => (typeof value === "string" ? value : null);

const arr = (value: Json): readonly Json[] | null => (Array.isArray(value) ? value : null);

const json = (value: Json): Json => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
};

/**
 * SPEC 1.1：单轮取扁平 parsed_output；多轮取 parsed_output.turns[].parsed_output。
 * 注意：多轮时根 parsed_output 会重复挂最后一轮的字段，绝不能既算根又算 turns（会重复计数）。
 */
export function parseEnvelope(output: Json): Envelope {
  let root = output;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root) as Json;
    } catch {
      return { error: "输出不是合法 JSON，取不到 parsed_output" };
    }
  }
  const rootRec = rec(root);
  if (!rootRec) return { error: "输出不是对象，缺 ok 与 parsed_output" };
  const po = rec(rootRec.parsed_output);
  if (!po) return { error: "缺 parsed_output 对象" };
  const turns = arr(po.turns);
  const multiTurn = turns !== null && turns.length > 0;
  const frames: Frame[] = [];
  if (multiTurn && turns) {
    for (const [i, turn] of turns.entries()) {
      const t = rec(turn);
      const p = rec(t?.parsed_output);
      if (!p) return { error: `第${i + 1}轮 turns[i].parsed_output 缺失` };
      const identity = rec(p.request_identity);
      frames.push({
        index: i,
        reqId: str(identity?.root_req_id) ?? str(t?.req_id),
        ...(str(t?.input_text) === null ? {} : { inputText: str(t?.input_text) as string }),
        ...(typeof t?.execution_ready !== "boolean" ? {} : { executionReady: t.execution_ready }),
        p
      });
    }
  } else {
    const identity = rec(po.request_identity);
    frames.push({ index: 0, reqId: str(identity?.root_req_id), p: po });
  }
  const resolved = rec(rootRec.resolved_config);
  return {
    ok: true,
    frames,
    root: rootRec,
    conversationExecution: po.conversation_execution ?? null,
    executionMode: str(resolved?.execution_mode),
    multiTurn
  };
}

/** 把 Envelope 拆成「帧数组 or 缺证据」，取值器统一用它。 */
function framesOf(output: Json): readonly Frame[] | Insufficient {
  const env = parseEnvelope(output);
  if ("error" in env) return insufficient(env.error);
  return env.frames;
}

export function replyText(frame: Frame): string | Insufficient {
  const value = str(frame.p.reply_text);
  return value === null ? insufficient(`第${frame.index + 1}帧缺 reply_text`) : value;
}

export function replyType(frame: Frame): string | Insufficient {
  const value = str(frame.p.reply_type);
  return value === null ? insufficient(`第${frame.index + 1}帧缺 reply_type`) : value;
}

/** 实测本 run 41/41 帧恒为 'none'，SPEC 1.2 明令不得作为出卡判据；仅供报告展示。 */
export function presentMode(frame: Frame): string | null {
  return str(frame.p.present_mode);
}

export function executions(frame: Frame): readonly Json[] | Insufficient {
  const value = arr(frame.p.tool_executions);
  return value === null
    ? insufficient(`第${frame.index + 1}帧缺 tool_executions 数组`)
    : value;
}

/**
 * 从 tool_executions 展开真实执行。
 * 绝不能用 parsed_output.tools —— 那是「计划」，不是执行（SPEC 1.2 明令）。
 */
export function actualCalls(frame: Frame): readonly ActualCall[] | Insufficient {
  const list = executions(frame);
  if (isInsufficient(list)) return list;
  const out: ActualCall[] = [];
  for (const [index, item] of list.entries()) {
    const e = rec(item);
    if (!e) return insufficient(`第${frame.index + 1}帧 tool_executions[${index}] 不是对象`);
    const calls = arr(e.calls);
    const terminals = arr(e.terminals);
    const call = rec(calls?.[0]);
    const terminal = rec(terminals?.[0]);
    const toolResult = rec(terminal?.tool_result);
    const error = rec(terminal?.error);
    const result = toolResult ? json(toolResult.result) : undefined;
    const resultRec = rec(result);
    out.push({
      index,
      name: str(call?.name) ?? str(call?.tool_name),
      args: call ? json(call.param !== undefined ? call.param : call.args_json) : null,
      toolRequestId: str(e.tool_request_id),
      status: str(e.status),
      terminalType: str(terminal?.type),
      toolResultStatus: str(toolResult?.status),
      result,
      errorCode: str(error?.error_code),
      errorText: str(resultRec?.error_message) ?? str(resultRec?.error_type),
      singleTerminal: calls?.length === 1 && terminals?.length === 1
    });
  }
  return out;
}

export function allSurfaces(frame: Frame): readonly Surface[] | Insufficient {
  const list = arr(frame.p.a2ui_surfaces);
  if (list === null) return insufficient(`第${frame.index + 1}帧缺 a2ui_surfaces 数组`);
  return list.map((item) => {
    const s = rec(item);
    const dataModel = rec(s?.data_model);
    return {
      surfaceId: str(s?.surface_id),
      catalogId: str(s?.catalog_id),
      componentIds: (arr(s?.component_ids) ?? []).map((x) => str(x) ?? ""),
      computed: dataModel ? dataModel.computed : null,
      dataModel: dataModel ?? null,
      sourceToolNames: (arr(s?.source_tool_names) ?? []).map((x) => str(x) ?? ""),
      raw: s ?? null
    } satisfies Surface;
  });
}

/** SPEC 1.3：只有 surface_id 以 `cortex:` 开头的才算结果卡；infoChip 是进度条，不算。 */
export function resultSurfaces(frame: Frame): readonly Surface[] | Insufficient {
  const all = allSurfaces(frame);
  if (isInsufficient(all)) return all;
  return all.filter((s) => (s.surfaceId ?? "").startsWith("cortex:"));
}

export function infoChipSurfaces(frame: Frame): readonly Surface[] | Insufficient {
  const all = allSurfaces(frame);
  if (isInsufficient(all)) return all;
  return all.filter((s) => s.surfaceId === "infoChip");
}

/** 组件 id 命中判定：等于关键字，或以 `_<关键字>` 结尾（实测存在 event0_eventItem / c0_events）。 */
export function componentHits(componentIds: readonly string[], keyword: string): boolean {
  return componentIds.some((id) => id === keyword || id.endsWith(`_${keyword}`));
}

export function cardFamiliesOfSurface(surface: Surface): readonly CardFamily[] {
  const hit: CardFamily[] = [];
  for (const family of CARD_FAMILIES) {
    if (family === "TEXT") continue;
    const keywords = CARD_FAMILY_COMPONENTS[family];
    const matched = keywords.some((k) => componentHits(surface.componentIds, k));
    if (family === "LIST" && LIST_REQUIRES_ROW) {
      const hasRow = componentHits(surface.componentIds, "row");
      const hasRowPrimary = componentHits(surface.componentIds, "rowPrimary");
      const hasBadge = componentHits(surface.componentIds, "countBadge");
      if (!((hasRow && hasRowPrimary) || hasBadge)) continue;
      if (matched) hit.push(family);
      continue;
    }
    if (matched) hit.push(family);
  }
  if (!hit.length && CARD_FAMILY_COMPONENTS.TEXT.some((k) => componentHits(surface.componentIds, k))) {
    hit.push("TEXT");
  }
  return hit;
}

/** 帧内所有结果卡的卡片族集合（EVENT|MESSAGE|LIST|DOC|CONFIRM|TEXT）。 */
export function cardTypes(frame: Frame): readonly CardFamily[] | Insufficient {
  const cards = resultSurfaces(frame);
  if (isInsufficient(cards)) return cards;
  return [...new Set(cards.flatMap((s) => [...cardFamiliesOfSurface(s)]))];
}

export function a2uiValidation(frame: Frame): Record<string, Json> | Insufficient {
  const value = rec(frame.p.a2ui_validation);
  return value === null
    ? insufficient(`第${frame.index + 1}帧缺 a2ui_validation`)
    : value;
}

export function outboundCapture(frame: Frame): Record<string, Json> | Insufficient {
  const value = rec(frame.p.outbound_capture);
  return value === null ? insufficient(`第${frame.index + 1}帧缺 outbound_capture`) : value;
}

export function finalOutput(frame: Frame): Record<string, Json> | Insufficient {
  const value = rec(frame.p.final_output);
  return value === null ? insufficient(`第${frame.index + 1}帧缺 final_output`) : value;
}

export function deliveredMessages(frame: Frame): readonly Json[] | Insufficient {
  const value = arr(frame.p.delivered_messages);
  return value === null
    ? insufficient(`第${frame.index + 1}帧缺 delivered_messages 数组`)
    : value;
}

export function routeDecision(frame: Frame): string | Insufficient {
  const route = rec(frame.p.route);
  const decision = str(route?.decision);
  const evidence = rec(rec(frame.p.request_execution)?.evidence);
  const fallback = str(evidence?.route_decision);
  const value = decision ?? fallback;
  return value === null ? insufficient(`第${frame.index + 1}帧缺 route.decision`) : value;
}

/* ------------------------------------------------------------------ *
 * 内联 JS 片段库
 *
 * 约定（SPEC 第 8 节第 3 条 + 主线程补充约束）：
 *   · 首行是普通注释 `// v2 <D-ID> <名称>`，绝不能是 `// cortex-eval field-rule v1 `；
 *   · 首个顶层 const 一律叫 CFG，绝不能叫 expected / rule / policy；
 *   · 片段里不得出现 import / require / fetch / eval / new Function。
 * ------------------------------------------------------------------ */
export type JsChunk = "base" | "calls" | "cards" | "text";

/**
 * 内部信息泄露形态表：`[标签, 正则源]`。D4.3（播报文本）与 D5.7（卡片 computed）共用，
 * 由生成器 JSON.stringify 内联进 CFG；正则源里不含反引号，可安全进内联 JS。
 */
export const INTERNAL_ID_PATTERNS: readonly (readonly [string, string])[] = [
  ["飞书内部ID（ou_/oc_/om_/omm_/on_）", "(?:ou|oc|om|omm|on)_[A-Za-z0-9]{6,}"],
  ["文档/资源token", "[A-Za-z0-9]{24,}"],
  ["UUID", "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"],
  ["32位hex串", "[0-9a-fA-F]{32}"],
  ["内部步骤/任务ID", "(?:tool|asst|task|step|call)_[A-Za-z0-9]{6,}"],
  ["裸URL", "https?://[^\\s，。、）)】]+"],
  ["日历ID", "[A-Za-z0-9._-]+@group\\.calendar\\.[A-Za-z0-9.-]+"],
  ["内部字段名", "(?:calendar_id|message_id|open_id|chat_id|document_id|tool_request_id|root_req_id|page_token)"]
];

/** 原始工具名形态（D4.3 / D5.7 都不得让用户看见）。 */
export const RAW_TOOL_NAME_SOURCE =
  "(?:feishu_[a-z_]+|create_event|update_event|delete_events|get_event|list_events|web_search|declare_miss_tool_candidates|ios_reminder_[a-z_]+|create_tasks|update_task|delete_tasks|get_task|list_tasks|search_tasks)";

/** 视觉指代词（D4.8 / D5.8）：说了这些就必须本帧真有 cortex: 结果卡。 */
export const VISUAL_REFERENCE_WORDS: readonly string[] = [
  "上面",
  "上述",
  "如上",
  "如下",
  "下图",
  "这几篇",
  "这几条",
  "这几个",
  "列表中",
  "列表里",
  "卡片上",
  "卡片里",
  "下表",
  "图中",
  "这份清单"
];

/* ------------------------------------------------------------------ *
 * 内联 JS 片段（帧无关）。行数预算：header 2 + base 14 = 16；
 * +calls 13 = 29；+cards 13 = 42；+text 3 = 45。单条断言总行数须 ≤ 60。
 * 语义与导出名与 TS 侧解析器一一对应，只做了行合并压缩，不改判定行为。
 * ------------------------------------------------------------------ */
const BASE = String.raw`const FAIL = r => ({ pass: false, score: 0, reason: r });
const PASS = r => ({ pass: true, score: 1, reason: r });
const INS = w => ({ pass: true, score: 1, reason: '证据不足：' + w });
const OBJ = x => x !== null && typeof x === 'object' && !Array.isArray(x), STR = x => typeof x === 'string', ARR = Array.isArray;
const JSN = x => { if (STR(x)) { try { return JSON.parse(x); } catch { return x; } } return x; };
const NS = s => (STR(s) ? s.replace(/\s+/g, '') : '');
let ROOT = output;
if (STR(ROOT)) { try { ROOT = JSON.parse(ROOT); } catch { return INS('输出不是合法 JSON，取不到 parsed_output'); } }
if (!OBJ(ROOT) || !OBJ(ROOT.parsed_output)) return INS('输出缺 parsed_output 对象（根 ok=' + (OBJ(ROOT) ? String(ROOT.ok) : '非对象') + '）');
const PO = ROOT.parsed_output;
const TURNS = ARR(PO.turns) && PO.turns.length ? PO.turns : null;
const FR = TURNS ? TURNS.map(t => (OBJ(t) ? t.parsed_output : null)) : [PO];
if (FR.some(f => !OBJ(f))) return INS('多轮 turns[] 里有轮次缺 parsed_output，无法逐帧判定');
const NF = FR.length, LAST = FR[NF - 1], TL = i => (TURNS ? '（第' + (i + 1) + '轮）' : '');`;

const CALLS = String.raw`const EX = f => (ARR(f.tool_executions) ? f.tool_executions : null);
const CALLS = f => { const L = EX(f); if (!L) return null; const out = [];
  for (let i = 0; i < L.length; i++) { const e = L[i], c = OBJ(e) && ARR(e.calls) ? e.calls[0] : null, t = OBJ(e) && ARR(e.terminals) ? e.terminals[0] : null;
    const tr = t && OBJ(t.tool_result) ? t.tool_result : null, er = t && OBJ(t.error) ? t.error : null, res = tr ? JSN(tr.result) : undefined;
    out.push({ i, name: OBJ(c) ? (STR(c.name) ? c.name : c.tool_name) : null, args: OBJ(c) ? JSN(c.param !== undefined ? c.param : c.args_json) : null,
      trid: OBJ(e) && STR(e.tool_request_id) ? e.tool_request_id : null, status: OBJ(e) && STR(e.status) ? e.status : null,
      termType: t && STR(t.type) ? t.type : null, rs: tr && STR(tr.status) ? tr.status : null, result: res,
      err: (er && STR(er.error_code) ? er.error_code : null) ?? (OBJ(res) && STR(res.error_message) ? res.error_message : null) ?? (OBJ(res) && STR(res.error_type) ? res.error_type : null),
      single: OBJ(e) && ARR(e.calls) && e.calls.length === 1 && ARR(e.terminals) && e.terminals.length === 1 }); }
  return out; };
const ALL = () => { const out = []; for (let i = 0; i < NF; i++) { const cs = CALLS(FR[i]); if (cs === null) return null; for (const c of cs) out.push(Object.assign({}, c, { f: i })); } return out; };
const CNT = (a, n) => a.filter(c => c.name === n).length;
const UNIQ = a => [...new Set(a.map(c => c.name))].join('、');
const SEQ = i => i * 1000;`;

const CARDS = `const FAMKW = ${JSON.stringify(CARD_FAMILY_COMPONENTS)};
${String.raw`const SURF = f => (ARR(f.a2ui_surfaces) ? f.a2ui_surfaces : null);
const SID = s => (OBJ(s) && STR(s.surface_id) ? s.surface_id : null);
const CARDS = f => { const s = SURF(f); return s ? s.filter(x => (SID(x) ?? '').startsWith('cortex:')) : null; };
const CHIPS = f => { const s = SURF(f); return s ? s.filter(x => SID(x) === 'infoChip') : null; };
const CID = s => (OBJ(s) && ARR(s.component_ids) ? s.component_ids.filter(STR) : []);
const HIT = (ids, k) => ids.some(id => id === k || id.endsWith('_' + k));
const COMP = s => (OBJ(s) && OBJ(s.data_model) ? s.data_model.computed : null);
const FAM = s => { const ids = CID(s), out = [];
  for (const k of Object.keys(FAMKW)) { if (k === 'TEXT') continue; const hit = FAMKW[k].some(w => HIT(ids, w));
    if (k === 'LIST' && hit && !(HIT(ids, 'row') && HIT(ids, 'rowPrimary')) && !HIT(ids, 'countBadge')) continue; if (hit) out.push(k); }
  if (!out.length && FAMKW.TEXT.some(w => HIT(ids, w))) out.push('TEXT'); return out; };
const FAMS = f => { const c = CARDS(f); return c === null ? null : [...new Set(c.flatMap(FAM))]; };
const ALLCARDS = () => { const out = []; for (let i = 0; i < NF; i++) { const c = CARDS(FR[i]); if (c === null) return null; for (const s of c) out.push({ f: i, s }); } return out; };`}`;

const TEXT = String.raw`const RT = f => (STR(f.reply_text) ? f.reply_text : null);
const RTP = f => (STR(f.reply_type) ? f.reply_type : null);
const CHS = s => (NS(s).match(/[\u4e00-\u9fff]/g) || []).length;`;

export const JS_CHUNKS: Readonly<Record<JsChunk, string>> = {
  base: BASE,
  calls: CALLS,
  cards: CARDS,
  text: TEXT
};

export interface ComposeOptions {
  /** 形如 `D2.3`。 */
  readonly id: string;
  /** 子项名，形如 `写入次数上限`。 */
  readonly title: string;
  /** 期望值，JSON.stringify 内联成 CFG。 */
  readonly cfg: Json;
  /** 需要的证据片段，base 恒定包含。 */
  readonly chunks: readonly JsChunk[];
  /** 判定逻辑，必须以 return 结束。 */
  readonly body: string;
}

/** 拼出一条断言的内联 JS。首行注释 + `const CFG = …`，随后是证据片段与判定体。 */
export function composeAssertionJS(options: ComposeOptions): string {
  const chunks = (["base", ...options.chunks.filter((c) => c !== "base")] as JsChunk[]).map(
    (c) => JS_CHUNKS[c]
  );
  return [
    `// v2 ${options.id} ${options.title}`,
    `const CFG = ${JSON.stringify(options.cfg)};`,
    ...chunks,
    options.body.trim()
  ].join("\n");
}
