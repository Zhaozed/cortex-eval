#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ToolHub 工具合并后，把 feishu-user-24 的断言适配到统一 docs/chat 契约（需求文档 V1.1，2026-09-17）。

只改断言规则 + scenario_tag；用户输入 / request_body 一律不动。

工具改名（11 个）：
  feishu_search_docs -> search_docs         (offset 分页，禁 page_token)
  feishu_get_doc -> get_doc
  feishu_create_doc -> create_doc
  feishu_update_doc -> update_doc           (mode=append/replace/insert/edit_block/delete_blocks/rename)
  feishu_send_message -> send_chat_message  (唯一需危险确认的发送工具)
  feishu_list_messages -> get_chat_messages
  feishu_search_messages -> search_chat_messages
  feishu_get_thread_replies -> get_chat_thread
  feishu_list_conversations -> list_chats
  feishu_list_chat_members -> list_chat_members
  feishu_search_users -> search_chat_users
保留：feishu_get_user_profile / feishu_list_calendars / feishu_query_free_busy / feishu_list_room_availability

语义修正：
- D2.4 / D6.6：update_doc 的 mode=replace 仅在未定位 block_id/block_ids 时判为整篇替换；
  replace_all/overwrite/full_replace/rewrite 永远违规。
- D5.5：危险确认只针对 send_chat_message、delete_events（文档/日程 create/update 不再要求确认卡）。
"""
import json, re, copy
from pathlib import Path

SRC = Path("test_suite/feishu-user-24/cases.jsonl")
DST = Path("test_suite/feishu-user-24-v2/cases.jsonl")
NEW_TAG = "feishu-user24-v2-20260917"

OLD2NEW = {
    "feishu_search_docs": "search_docs",
    "feishu_get_doc": "get_doc",
    "feishu_create_doc": "create_doc",
    "feishu_update_doc": "update_doc",
    "feishu_send_message": "send_chat_message",
    "feishu_list_messages": "get_chat_messages",
    "feishu_search_messages": "search_chat_messages",
    "feishu_get_thread_replies": "get_chat_thread",
    "feishu_list_conversations": "list_chats",
    "feishu_list_chat_members": "list_chat_members",
    "feishu_search_users": "search_chat_users",
}

NEW_TOOLSRC = ("(?:search_docs|get_doc|create_doc|update_doc|send_chat_message|get_chat_messages|"
               "search_chat_messages|get_chat_thread|list_chats|list_chat_members|search_chat_users|"
               "feishu_get_user_profile|feishu_list_calendars|feishu_query_free_busy|feishu_list_room_availability|"
               "create_event|update_event|delete_events|get_event|list_events|web_search|"
               "declare_miss_tool_candidates|ios_reminder_[a-z_]+|create_tasks|update_task|delete_tasks|"
               "get_task|list_tasks|search_tasks)")


def rename_tools(text: str) -> str:
    for old, new in OLD2NEW.items():
        text = re.sub(r"\b" + re.escape(old) + r"\b", new, text)
    return text


def rewrite_toolsrc(text: str) -> str:
    pat = re.compile(r'"toolSrc":"(?:[^"\\]|\\.)*"')
    out, n = pat.subn('"toolSrc":"' + NEW_TOOLSRC + '"', text)
    return out


# ---------- D2.4 ----------
# post-rename: update_doc 的 replace 仅在未定位块时判违规（search_docs 禁 page_token 不变）
D24_OLD_UPDATE = (
    "if (c.name === 'update_doc') { n++; if (a.mode === 'replace') "
    "bad.push('update_doc mode=replace（整篇替换），要求 append 等局部改法' + TL(c.f)); }"
)
D24_NEW_UPDATE = (
    "if (c.name === 'update_doc') { n++; const _blk = (STR(a.block_id) && a.block_id) || "
    "(ARR(a.block_ids) && a.block_ids.length > 0); if (a.mode === 'replace' && !_blk) "
    "bad.push('update_doc mode=replace 且未定位 block_id/block_ids（整篇替换），要求 append/edit_block/insert/delete_blocks 等局部改法' + TL(c.f)); }"
)

# ---------- D6.6 ----------
D66_OLD_BAD = "const bad = U.filter(c => OBJ(c.args) && STR(c.args.mode) && /^(replace|replace_all|overwrite|full_replace|rewrite)$/i.test(c.args.mode));"
D66_NEW_BAD = (
    "const bad = U.filter(c => { const a = OBJ(c.args) ? c.args : {}; "
    "const blk = (STR(a.block_id) && a.block_id) || (ARR(a.block_ids) && a.block_ids.length > 0); "
    "return /^(replace_all|overwrite|full_replace|rewrite)$/i.test(String(a.mode)) || (a.mode === 'replace' && !blk); });"
)
D66_OLD_FAIL = "if (bad.length) return FAIL('D6.6 禁止整篇替换：update_doc mode=' + JSON.stringify(bad[0].args.mode) + '（整篇替换），期望 append/insert 这类局部改法' + TL(bad[0].f));"
D66_NEW_FAIL = (
    "if (bad.length) return FAIL('D6.6 禁止整篇替换：update_doc mode=' + JSON.stringify(bad[0].args.mode) + "
    "(bad[0].args.mode === 'replace' ? ' 且未定位 block_id/block_ids' : '') + '（整篇替换），期望 append/edit_block/insert/delete_blocks 这类局部改法' + TL(bad[0].f));"
)

# ---------- D5.5 ----------
cfg_re = re.compile(r"const CFG = (\{.*?\});\nconst FAIL", re.S)

D55_OLD_W = "const W = A.filter(c => CFG.writes.indexOf(c.name) >= 0);"
D55_NEW_W = (
    "const W = A.filter(c => CFG.writes.indexOf(c.name) >= 0);\n"
    "const DGR = ARR(CFG.danger) && CFG.danger.length ? CFG.danger : CFG.writes;"
)
D55_OLD_QW = "if (CFG.writes.indexOf(c.name) >= 0) qw.push(i + 1);"
D55_NEW_QW = "if (DGR.indexOf(c.name) >= 0) qw.push(i + 1);"
D55_OLD_FIRST = (
    "if (!W.length) return INS('期望先确认再写（needConfirm=true），但实际 0 次写入型调用，没有写入可校验确认前置');\n"
    "const first = W[0]; let asked = null;"
)
D55_NEW_FIRST = (
    "const D = A.filter(c => DGR.indexOf(c.name) >= 0);\n"
    "if (!D.length) return INS('期望先确认再写（needConfirm=true），但实际 0 次危险写入型调用（' + DGR.join('/') + '），没有写入可校验确认前置');\n"
    "const first = D[0]; let asked = null;"
)


def patch_d55_cfg(text: str) -> str:
    def repl(m):
        cfg = json.loads(m.group(1))
        cfg["writes"] = [OLD2NEW.get(t, t) for t in cfg["writes"]]
        cfg["danger"] = ["send_chat_message", "delete_events"]
        return "const CFG = " + json.dumps(cfg, ensure_ascii=False, separators=(",", ":")) + ";\nconst FAIL"

    text, n = cfg_re.subn(repl, text, count=1)
    assert n == 1, "D5.5 CFG 块未命中"
    return text


def transform_assert(metric: str, value: str):
    v = rename_tools(value)
    # D2.4 语义修正（必须在 rename 之后匹配）
    if "D2.4 关键参数合规" in metric:
        assert D24_OLD_UPDATE in v, "D2.4 update 段未命中"
        v = v.replace(D24_OLD_UPDATE, D24_NEW_UPDATE)
    if "D6.6 禁止整篇替换" in metric:
        assert D66_OLD_BAD in v, "D6.6 bad filter 未命中"
        assert D66_OLD_FAIL in v, "D6.6 fail 分支未命中"
        v = v.replace(D66_OLD_BAD, D66_NEW_BAD).replace(D66_OLD_FAIL, D66_NEW_FAIL)
    if "D5.5 危险写操作前有确认卡" in metric:
        v = patch_d55_cfg(v)
        assert D55_OLD_W in v, "D5.5 W 行未命中"
        assert D55_OLD_QW in v, "D5.5 QUESTION 分支未命中"
        assert D55_OLD_FIRST in v, "D5.5 first 段未命中"
        v = v.replace(D55_OLD_W, D55_NEW_W).replace(D55_OLD_QW, D55_NEW_QW).replace(D55_OLD_FIRST, D55_NEW_FIRST)
    # toolSrc 正则（D4.3/D5.7 里出现，统一替换为新工具全集）
    v = rewrite_toolsrc(v)
    m = rename_tools(metric)
    # 兜底：旧名紧贴中文（如「正在feishu_search_users」）时 \b 不生效，补一次全局替换
    for old, nn in OLD2NEW.items():
        if old in v:
            v = v.replace(old, nn)
        if old in m:
            m = m.replace(old, nn)
    return m, v


def main():
    cases = [json.loads(l) for l in open(SRC, encoding="utf-8") if l.strip()]
    out = []
    n_assert = 0
    for c in cases:
        cc = copy.deepcopy(c)
        cc["metadata"]["scenario_tag"] = NEW_TAG
        for a in cc["assert"]:
            m, v = transform_assert(a["metric"], a["value"])
            a["metric"] = m
            a["value"] = v
            n_assert += 1
        out.append(cc)
    with open(DST, "w", encoding="utf-8") as f:
        for c in out:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"wrote {len(out)} cases, {n_assert} asserts -> {DST}")


if __name__ == "__main__":
    main()
