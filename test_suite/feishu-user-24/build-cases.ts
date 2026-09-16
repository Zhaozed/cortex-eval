import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssertions } from "../feishu-e2e-v2/rules/index.ts";
import { CaseAuthoringV1Schema } from "../../packages/contracts/src/case-authoring-contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "cases.jsonl");
const uid = { __cortex_eval_int64: "2075490654049271808" };
const existing = JSON.parse(
  await readFile(resolve(here, "../feishu-e2e-v2/scenarios.v2.json"), "utf8")
) as { cases: any[] };
const byId = new Map(existing.cases.map((x) => [x.id, x]));

const readDims = (templateId: string) => [...(byId.get(templateId)?.dimensions ?? [])];
const noWrites = [
  "feishu_send_message",
  "feishu_create_doc",
  "feishu_update_doc",
  "create_event",
  "update_event",
  "delete_events"
];
const docRead = ["feishu_update_doc", "feishu_create_doc", "feishu_send_message", "create_event", "update_event", "delete_events"];
const messageRead = ["feishu_send_message", "feishu_create_doc", "feishu_update_doc", "create_event", "update_event", "delete_events"];
const calendarRead = ["create_event", "update_event", "delete_events", "feishu_send_message"];
const writeDoc = ["feishu_create_doc", "feishu_send_message", "create_event", "update_event", "delete_events"];
const writeMessage = ["feishu_create_doc", "feishu_update_doc", "create_event", "update_event", "delete_events"];
const writeEvent = ["feishu_send_message", "feishu_create_doc", "feishu_update_doc", "delete_events"];

const cases: any[] = [
  {
    id: "FSU24-01", name: "按产品组归属找到发布方案", template: "FS2-D01-01",
    prompt: ["帮我在飞书找一下《发布方案 V2》，我要产品组那份。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 1 }], order: [], allowedWrites: {}, forbidden: noWrites, replyType: "NOTICE", card: "DOC", needConfirm: false }
  },
  {
    id: "FSU24-02", name: "在文档末尾追加灰度验证", template: "FS2-D04-01",
    prompt: ["在《发布方案 V2》这份飞书文档末尾加一段：本周五完成灰度验证。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 2 }, { tool: "feishu_update_doc", min: 1 }], order: [], allowedWrites: { feishu_update_doc: 1 }, forbidden: noWrites.filter((x) => x !== "feishu_update_doc"), replyType: "NOTICE", card: "DOC", needConfirm: false }
  },
  {
    id: "FSU24-03", name: "局部改日期并删除末尾两条方案", template: "FS2-D08-01",
    prompt: ["把《发布方案 V2》这份飞书文档“上线计划”里的日期改为周五；再删掉最后两条备选方案，其他内容保留。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 2 }, { tool: "feishu_update_doc", min: 1 }], order: [], allowedWrites: { feishu_update_doc: 3 }, forbidden: writeDoc, replyType: "NOTICE", card: "DOC", needConfirm: false }
  },
  {
    id: "FSU24-04", name: "只改发布方案标题", template: "FS2-D05-01",
    prompt: ["把《发布方案 V2》这份飞书文档改名为《发布方案 V2｜正式版》，正文不要动。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 2 }, { tool: "feishu_update_doc", min: 1 }], order: [], allowedWrites: { feishu_update_doc: 1 }, forbidden: writeDoc, replyType: "NOTICE", card: "DOC", needConfirm: false }
  },
  {
    id: "FSU24-05", name: "查找秦宇龙和飞书测试群后确认对象", template: "FS2-M01-01",
    prompt: ["在飞书找一下秦宇龙和“飞书测试”群，先让我确认对象。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_list_conversations", min: 1 }], order: [], allowedWrites: {}, forbidden: messageRead, replyType: "QUESTION", card: "CONFIRM", needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.3", "D6.7"]
  },
  {
    id: "FSU24-06", name: "读取与秦宇龙最近20条聊天", template: "FS2-M02-01",
    prompt: ["看看飞书里我和秦宇龙最近的聊天，先看最近 20 条。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: {}, forbidden: messageRead, replyType: "NOTICE", card: "MESSAGE", needConfirm: false }
  },
  {
    id: "FSU24-07", name: "按人和关键词搜索群消息并读取回复", template: "FS2-M03-01",
    prompt: ["在飞书“小群”群里找秦宇龙之前说过的“放假不知道干啥”相关的内容，以及下面有哪些回复。"],
    expected: { tools: [{ tool: "feishu_list_conversations", min: 1 }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_search_messages", min: 1 }, { tool: "feishu_get_thread_replies", min: 1 }], order: [], allowedWrites: {}, forbidden: messageRead, replyType: "NOTICE", card: "MESSAGE", needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-08", name: "总结群昨天讨论并找出待回复问题", template: "FS2-M04-01",
    prompt: ["总结“飞书测试”这个群昨天讨论了啥，列出结论和还需要我回复的问题。"],
    expected: { tools: [{ tool: "feishu_list_conversations", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: {}, forbidden: messageRead, replyType: "NOTICE", card: null, needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.3", "D5.4", "D5.6", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-09", name: "发送版本发布验证提醒", template: "FS2-M07-01",
    prompt: ["用飞书给秦宇龙发：新版本周五发布，请今天完成验证。", "发吧。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_send_message", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: { feishu_send_message: 1 }, forbidden: writeMessage, replyType: "NOTICE", card: "CONFIRM", needConfirm: true },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-10", name: "查看明天飞书日历会议", template: "FS2-C01-01",
    prompt: ["看看我明天飞书日历有哪些会议，告诉我时间、地点和参会人。"],
    expected: { tools: [{ tool: "list_events", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: {}, forbidden: calendarRead, replyType: "NOTICE", card: "EVENT", needConfirm: false }
  },
  {
    id: "FSU24-11", name: "按周五日期打开飞书测试会议", template: "FS2-C02-01",
    prompt: ["帮我找飞书本周的飞书测试，打开周五那场。"],
    expected: { tools: [{ tool: "list_events", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: {}, forbidden: calendarRead, replyType: "NOTICE", card: "EVENT", needConfirm: false }
  },
  {
    id: "FSU24-12", name: "查找我和秦宇龙明天下午共同空闲半小时", template: "FS2-C03-01",
    prompt: ["帮我看飞书里我和秦宇龙明天下午哪半小时都有空。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_query_free_busy", min: 1 }], order: [], allowedWrites: {}, forbidden: calendarRead, replyType: "NOTICE", card: "TEXT", needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-13", name: "创建发布评审会", template: "FS2-C04-01",
    prompt: ["在飞书约我和秦宇龙明天下午 3 点到 4 点开发布评审会。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_query_free_busy", min: 1 }, { tool: "create_event", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: { create_event: 1 }, forbidden: writeEvent, replyType: "NOTICE", card: "EVENT", needConfirm: false }
  },
  {
    id: "FSU24-14", name: "把秦宇龙和群成员加入既有评审会", template: "FS2-C07-01",
    prompt: ["把秦宇龙和飞书“飞书测试”群的所有成员加入明天下午 3 点到 4 点的发布评审会。"],
    expected: { tools: [{ tool: "list_events", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 2, args: { provider: "feishu" } }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_list_conversations", min: 1 }, { tool: "feishu_list_chat_members", min: 1 }, { tool: "feishu_query_free_busy", min: 1 }, { tool: "update_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: { update_event: 1 }, forbidden: ["create_event", "delete_events", "feishu_send_message", "feishu_create_doc", "feishu_update_doc"], replyType: "NOTICE", card: "EVENT", needConfirm: false },
    dimensions: ["D1.1", "D1.2", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-15", name: "预约6人皮卡丘会议室", template: "FS2-C05-01",
    prompt: ["帮我在飞书预约明天下午 3 点到 4 点的“皮卡丘”会议室，供 6 人开会。"],
    expected: { tools: [{ tool: "feishu_list_room_availability", min: 1 }, { tool: "create_event", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: { create_event: 1 }, forbidden: ["update_event", "delete_events", "feishu_send_message", "feishu_create_doc", "feishu_update_doc"], replyType: "NOTICE", card: "EVENT", needConfirm: false },
    dimensions: ["D1.1", "D1.2", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.5", "D6.7"]
  },
  {
    id: "FSU24-16", name: "保留人员和会议室改期发布评审", template: "FS2-C06-01",
    prompt: ["把飞书明天的那场发布评审改到后天晚上 9 点到 10 点，其他人员和会议室保留。"],
    expected: { tools: [{ tool: "list_events", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 2, args: { provider: "feishu" } }, { tool: "feishu_query_free_busy", min: 1 }, { tool: "update_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: { update_event: 1 }, forbidden: ["create_event", "delete_events", "feishu_send_message", "feishu_create_doc", "feishu_update_doc"], replyType: "NOTICE", card: "EVENT", needConfirm: false }
  },
  {
    id: "FSU24-17", name: "取消本人组织的发布评审并核验房间释放", template: "FS2-C08-01",
    prompt: ["取消飞书我组织的那场发布评审，确认会议室也释放了。", "确认取消。"],
    expected: { tools: [{ tool: "feishu_get_user_profile", min: 1 }, { tool: "list_events", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }, { tool: "delete_events", min: 1, args: { provider: "feishu" } }, { tool: "feishu_list_room_availability", min: 1 }], order: [], allowedWrites: { delete_events: 1 }, forbidden: ["create_event", "update_event", "feishu_send_message", "feishu_create_doc", "feishu_update_doc"], replyType: "NOTICE", card: "CONFIRM", needConfirm: true },
    dimensions: ["D1.1", "D1.2", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-18", name: "找出三天内待我回复的问题并拟稿", template: "FS2-M04-01",
    prompt: ["看看飞书里我和秦宇龙这三天的聊天，有哪些问题还等我回复？先帮我拟回复，不要发。"],
    expected: { tools: [{ tool: "feishu_get_user_profile", min: 1 }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: {}, forbidden: messageRead, replyType: "NOTICE", card: "MESSAGE", needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-19", name: "依据刚才聊天主题创建早间会议", template: "FS2-X01-01",
    prompt: ["就飞书刚才和秦宇龙聊的话题，帮我和他约明天上午 6 点到 7 点开个会。"],
    expected: { tools: [{ tool: "feishu_list_messages", min: 1 }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_query_free_busy", min: 1 }, { tool: "create_event", min: 1, args: { provider: "feishu" } }, { tool: "get_event", min: 1, args: { provider: "feishu" } }], order: [], allowedWrites: { create_event: 1 }, forbidden: ["feishu_send_message", "feishu_update_doc", "feishu_create_doc", "update_event", "delete_events"], replyType: "NOTICE", card: "EVENT", needConfirm: false },
    dimensions: ["D1.1", "D1.2", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-20", name: "检索静安聚餐餐厅并发给自己", template: "FS2-X06-01",
    prompt: ["帮我查一下上海静安适合团队聚餐的餐厅，整理地址和来源链接，再用飞书发给我自己。", "发吧。"],
    expected: { tools: [{ tool: "web_search", min: 1 }, { tool: "get_restaurant", min: 1 }, { tool: "feishu_get_user_profile", min: 1 }, { tool: "feishu_send_message", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: { feishu_send_message: 1 }, forbidden: writeMessage, replyType: "NOTICE", card: "CONFIRM", needConfirm: true },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-21", name: "整理今天产品问题讨论并追加到发布方案", template: "FS2-X03-01",
    prompt: ["把飞书今天我和秦宇龙关于产品问题的讨论整理成一段，追加到《发布方案 V2》文档末尾。"],
    expected: { tools: [{ tool: "feishu_search_users", min: 1 }, { tool: "feishu_list_messages", min: 1 }, { tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 1 }, { tool: "feishu_update_doc", min: 1 }], order: [], allowedWrites: { feishu_update_doc: 1 }, forbidden: ["feishu_create_doc", "feishu_send_message", "create_event", "update_event", "delete_events"], replyType: "NOTICE", card: "DOC", needConfirm: false },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-22", name: "把问题讨论文档链接发给两位收件人", template: "FS2-X04-01",
    prompt: ["把《发布方案 V2》那份飞书文档链接发给秦宇龙和我自己，正文写：请看最新。", "确认发送。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 1 }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_get_user_profile", min: 1 }, { tool: "feishu_send_message", min: 2 }, { tool: "feishu_list_messages", min: 2 }], order: [], allowedWrites: { feishu_send_message: 2 }, forbidden: ["feishu_update_doc", "feishu_create_doc", "create_event", "update_event", "delete_events"], replyType: "NOTICE", card: "CONFIRM", needConfirm: true },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.7", "D5.8", "D6.7"]
  },
  {
    id: "FSU24-23", name: "删除发布方案末尾10条备选方案并发送最新版", template: "FS2-X02-01",
    prompt: ["删掉《发布方案 V2》这份飞书文档最后 10 条备选方案，其他保留，再把最新版链接发给秦宇龙。", "确认删除并发送。"],
    expected: { tools: [{ tool: "feishu_search_docs", min: 1 }, { tool: "feishu_get_doc", min: 2 }, { tool: "feishu_update_doc", min: 1 }, { tool: "feishu_search_users", min: 1 }, { tool: "feishu_send_message", min: 1 }, { tool: "feishu_list_messages", min: 1 }], order: [], allowedWrites: { feishu_update_doc: 1, feishu_send_message: 1 }, forbidden: ["feishu_create_doc", "create_event", "update_event", "delete_events"], replyType: "NOTICE", card: "CONFIRM", needConfirm: true },
    dimensions: ["D1.1", "D1.3", "D1.4", "D2.1", "D2.2", "D2.3", "D2.4", "D2.5", "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.7", "D5.8", "D6.6", "D6.7"]
  },
  {
    id: "FSU24-24", name: "原生文档@和权限分享能力缺失时如实说明", template: "FS2-S02-01",
    prompt: ["在《发布方案 V2》这份飞书文档里 @ 秦宇龙，并把文档访问权限分享给“飞书测试”群。"],
    expected: { tools: [], order: [], allowedWrites: {}, forbidden: ["feishu_search_docs", "feishu_get_doc", "feishu_create_doc", "feishu_update_doc", "feishu_send_message", "create_event", "update_event", "delete_events"], replyType: "NOTICE", card: null, needConfirm: false },
    dimensions: ["D1.3", "D1.4", "D2.5", "D3.1", "D3.2", "D3.5", "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6", "D4.7", "D4.8", "D5.3", "D5.4", "D5.6", "D5.7", "D6.2", "D6.7"]
  }
];

const definitions: any[] = [];
for (const c of cases) {
  const scenario = { id: c.id, name: c.name, turns: c.prompt.length, expected: c.expected, dimensions: c.dimensions ?? readDims(c.template) };
  const assertions = buildAssertions({ caseId: c.id, scenario, tokens: {} });
  const hard = assertions.filter((a) => a.metric.startsWith("【硬性】")).length;
  const soft = assertions.length - hard;
  const total = hard * 20 + soft;
  const lo = ((hard - 1) * 20 + soft) / total;
  const hi = (hard * 20) / total;
  const threshold = Number(((lo + hi) / 2).toFixed(6));
  const multi = c.prompt.length > 1;
  const request_body: any = {
    uid,
    timezone: "Asia/Shanghai",
    lang: "zh-Hans",
    // 所有 case 均走真实 WebUI client 会话，保持与线上入口一致。
    execution_mode: "client",
    timeout_ms: 240000
  };
  request_body.sid = "web_ui_2075490654049271808";
  request_body.speaker = "2075490654049271808";
  if (multi) {
    request_body.conversation = c.prompt.map((text: string) => ({ role: "user", text }));
  } else {
    request_body.text = c.prompt[0];
  }
  const definition = {
    contractVersion: "cortex.case-definition.v1",
    description: `[用户整理]｜P0｜${c.id}｜${c.name}｜硬性${hard}·质量${soft}`,
    threshold,
    vars: { task: "agent-e2e", request_body },
    metadata: {
      case_id: c.id,
      req_id: `feishu_user24_${c.id}`,
      task_id: `feishu_user24_${c.id}`,
      business_module: "飞书用户整理24条",
      scenario_tag: "feishu-user24-20260916",
      a2ui_capture: true
    },
    assert: assertions
  };
  const parsed = CaseAuthoringV1Schema.safeParse(definition);
  if (!parsed.success) {
    console.error(JSON.stringify({ id: c.id, issues: parsed.error.issues }, null, 2));
    throw new Error(`${c.id} contract validation failed`);
  }
  definitions.push(definition);
}
await mkdir(here, { recursive: true });
await writeFile(out, definitions.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
console.log(JSON.stringify({ out, count: definitions.length, ids: definitions.map((x) => x.metadata.case_id), hardQuality: definitions.map((x) => ({ id: x.metadata.case_id, assertions: x.assert.length, hard: x.assert.filter((a: any) => a.metric.startsWith("【硬性】")).length, soft: x.assert.filter((a: any) => a.metric.startsWith("【质量】")).length, threshold: x.threshold })) }, null, 2));
