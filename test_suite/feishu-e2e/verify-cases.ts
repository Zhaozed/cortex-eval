/** Synthetic unit/negative tests for assertions and binding guards; never business acceptance. */
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { executionAssertion, replyAssertion, writeTools, type Scenario } from "./assertions.ts";
import { CaseAuthoringV1Schema } from "../../packages/contracts/src/case-authoring-contracts.ts";
const dir = dirname(fileURLToPath(import.meta.url));
const original: Scenario[] = JSON.parse(
  await readFile(resolve(dir, "scenarios.json"), "utf8")
).cases;
const definitions = (await readFile(resolve(dir, "cases.draft.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((x) => JSON.parse(x));
let checks = 0;
function check(v: unknown, message = "check") {
  assert.ok(v, message);
  checks++;
}
check(original.length === 33);
check(definitions.length === 33);
check(new Set(original.map((x) => x.id)).size === 33);
check(new Set(original.map((x) => x.source_id)).size === 33);
check(original.filter((x) => x.kind === "core").length === 33);
for (const d of definitions) {
  check(d.vars.request_body.uid.__cortex_eval_int64 === "2075490654049271808");
  check(
    d.vars.request_body.execution_mode === "client" && !("sid" in d.vars.request_body),
    "draft ingress lock before Router"
  );
  check(d.description.includes("前置锁定"));
}
check(
  new Set(
    JSON.parse(await readFile(resolve(dir, "batches.json"), "utf8")).suggested_execution_order
  ).size === 33
);
check(original.filter((x) => x.turns.length > 1).length === 14);
const tokens: any = {
  date: "2099-09-18",
  start: "2099-09-18T15:00:00+08:00",
  end: "2099-09-18T16:00:00+08:00",
  window_start: "2099-09-17T00:00:00+08:00",
  window_end: "2099-09-20T00:00:00+08:00",
  doc_url: "https://synthetic.feishu.cn/docx/doc_test",
  doc_id: "doc_test",
  source_doc_url: "https://synthetic.feishu.cn/docx/doc_source",
  event_id: "event_test",
  calendar_id: "cal_test",
  second_event_id: "event_other",
  message_id: "om_root",
  person_id: "ou_person",
  group_id: "oc_group",
  last_two_block_ids: ["b1", "b2"],
  last_ten_block_ids: Array.from({ length: 10 }, (_, i) => "b" + i),
  merged_attendees: [{ email: "ou_person" }, { email: "omm_room" }],
  new_attendees: [{ email: "ou_person" }, { email: "omm_room" }],
  new_room_attendees: [{ email: "ou_person" }, { email: "omm_new" }],
  delegated_attendees: [{ email: "ou_person" }, { email: "ou_other" }],
  retrieval_tool: "synthetic_web_search"
};
function subst(v: any): any {
  if (Array.isArray(v)) return v.map(subst);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, subst(v)]));
  if (typeof v !== "string") return v;
  const m = /^\{\{([a-z_]+)\}\}$/.exec(v);
  if (m && tokens[m[1]] !== undefined) return tokens[m[1]];
  return v.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => String(tokens[k] ?? "synthetic_" + k));
}
function synthetic(s: Scenario) {
  let seq = 0;
  const frames = s.turns.map((t, i) => {
    const actual: any[] = [];
    const add = (name: string, args: any) => {
      args = { ...args };
      if (
        ["list_events", "get_event", "create_event", "update_event", "delete_events"].includes(name)
      )
        args.provider ??= name === "list_events" ? ["feishu"] : "feishu";
      if (name === "feishu_query_free_busy") args.open_ids ??= ["ou_person"];
      if (name === "get_event")
        Object.assign(args, {
          event_id: args.event_id ?? "event_test",
          calendar_id: args.calendar_id ?? "cal_test"
        });
      if (name === "feishu_send_message") args.text ??= "synthetic_text";
      let result: any = {};
      if (["feishu_get_doc", "feishu_update_doc", "feishu_create_doc"].includes(name))
        result = { document_id: "doc_test", content: "synthetic_body", title: "synthetic_title" };
      if (["get_event", "create_event", "update_event"].includes(name))
        result = { event: { id: "event_test", summary: "synthetic_title" } };
      if (name === "feishu_send_message")
        result = { message_id: "om_" + (seq + 1), chat_id: "oc_group" };
      if (name === "delete_events")
        result = {
          results: args.event_ids.map((event_id: string) => ({ event_id, success: true }))
        };
      const id = `execution-${i}-${++seq}`;
      const e = {
        tool_request_id: id,
        status: "SUCCEEDED",
        calls: [{ name, param: args, tool_request_id: id }],
        terminals: [
          {
            type: "TOOL_RESULT",
            tool_result: { tool_request_id: id, name, status: "SUCCESS", result }
          }
        ]
      };
      actual.push(e);
      return e;
    };
    for (const r of t.required) {
      const match = () =>
        actual.filter(
          (e) =>
            e.calls[0].name === r.tool &&
            Object.entries(r.args).every(
              ([k, v]) => JSON.stringify(e.calls[0].param[k]) === JSON.stringify(v)
            )
        ).length;
      while (match() < r.min) add(r.tool, r.args);
    }
    // Link each successful write to a real synthetic readback in the same turn; not a claim of full business correctness.
    for (const e of [...actual]) {
      const n = e.calls[0].name;
      if (
        ["feishu_update_doc", "feishu_create_doc"].includes(n) &&
        !actual.some((x) => x.calls[0].name === "feishu_get_doc")
      )
        add("feishu_get_doc", { doc: "doc_test" });
      if (
        ["create_event", "update_event"].includes(n) &&
        !actual.some((x) => x.calls[0].name === "get_event")
      )
        add("get_event", { event_id: "event_test", provider: "feishu" });
      if (n === "feishu_send_message") {
        let read = actual.find((x) =>
          ["feishu_list_messages", "feishu_get_thread_replies"].includes(x.calls[0].name)
        );
        if (!read) read = add("feishu_list_messages", { chat_id: "oc_group" });
        const result = read.terminals[0].tool_result.result;
        result.messages ??= [];
        result.messages.push({ ...e.terminals[0].tool_result.result, text: e.calls[0].param.text });
      }
    }
    const rid = "req-" + i,
      final = {
        req_id: rid,
        asst_msg_id: "asst-" + i,
        text: "synthetic_reply",
        kind: i === 0 && s.turns.length > 1 ? "QUESTION" : "NOTICE"
      };
    return {
      req_id: rid,
      parsed_output: {
        request_identity: { root_req_id: rid },
        outbound_capture: { status: "COLLECTED" },
        reply_text: final.text,
        reply_type: final.kind,
        final_output: final,
        delivered_messages: [final],
        tool_executions: actual
      }
    };
  });
  return {
    ok: true,
    parsed_output:
      s.turns.length === 1
        ? frames[0].parsed_output
        : { turns: frames, conversation_execution: { complete: true } }
  };
}
function trace(o: any, i = 0) {
  return o.parsed_output.turns?.[i]?.parsed_output ?? o.parsed_output;
}
function all(o: any) {
  return (o.parsed_output.turns ?? [{ parsed_output: o.parsed_output }]).flatMap(
    (t: any) => t.parsed_output.tool_executions
  );
}
for (let index = 0; index < original.length; index++) {
  const s = subst(original[index]) as Scenario,
    d = definitions[index];
  CaseAuthoringV1Schema.parse(d);
  checks++;
  check(d.threshold === 1 && d.assert.every((a: any) => a.weight === 1));
  check(d.assert.filter((a: any) => a.type === "llm-rubric").length === 2);
  check(d.metadata.case_id === s.id);
  check(Boolean(d.vars.request_body.conversation) === s.turns.length > 1);
  check(d.vars.request_body.execution_mode === "client");
  for (const a of d.assert)
    if (a.type === "javascript") {
      new Function("output", a.value);
      checks++;
    }
  check(d.assert[0].value.includes("FIXTURE_NOT_BOUND"));
  const run = new Function("output", executionAssertion(s, writeTools).value);
  const reply = new Function("output", replyAssertion(s).value);
  const ok = synthetic(s);
  check(run(ok).pass, `${s.id} positive: ${JSON.stringify(run(ok))}`);
  check(reply(ok).pass, `${s.id} reply`);
  check(run(JSON.stringify(ok)).pass);
  for (const bad of [null, {}, "bad-json", { ok: true, parsed_output: {} }, { ...ok, ok: false }])
    check(!run(bad).pass);
  for (const mutate of [
    (x: any) => delete trace(x).tool_executions,
    (x: any) => delete trace(x).request_identity,
    (x: any) => (trace(x).outbound_capture.status = "TIMED_OUT"),
    (x: any) => trace(x).tool_executions.push({ tool_request_id: "bad", calls: [], terminals: [] })
  ]) {
    const bad = structuredClone(ok);
    mutate(bad);
    check(!run(bad).pass, s.id + " should reject incomplete evidence");
  }
  const wrongReply = structuredClone(ok);
  trace(wrongReply).delivered_messages = [];
  check(!reply(wrongReply).pass);
  const wrongReq = structuredClone(ok);
  trace(wrongReq).final_output.req_id = "other";
  check(!reply(wrongReq).pass);
  if (s.turns.length > 1) {
    const flat = { ok: true, parsed_output: trace(ok, s.turns.length - 1) };
    check(!run(flat).pass);
    check(!reply(flat).pass);
    const dup = structuredClone(ok);
    dup.parsed_output.turns[1].req_id = dup.parsed_output.turns[0].req_id;
    check(!run(dup).pass);
    const aggregate = structuredClone(ok);
    aggregate.parsed_output.tool_executions = all(ok);
    check(run(aggregate).pass, "do not double count root aggregation");
  }
  if (all(ok).length) {
    const dup = structuredClone(ok);
    trace(dup).tool_executions.push(structuredClone(all(dup)[0]));
    check(!run(dup).pass);
    const missing = structuredClone(ok);
    all(missing)[0].terminals = [];
    check(!run(missing).pass);
    const mismatch = structuredClone(ok);
    all(mismatch)[0].calls[0].tool_request_id = "wrong";
    check(!run(mismatch).pass);
  }
  const wrongProvider = structuredClone(ok),
    event = all(wrongProvider).find((e: any) =>
      ["list_events", "get_event", "create_event", "update_event", "delete_events"].includes(
        e.calls[0].name
      )
    );
  if (event) {
    event.calls[0].param.provider = "google";
    check(!run(wrongProvider).pass);
  }
  const unauthorized = structuredClone(ok),
    rid = "unapproved-write";
  trace(unauthorized).tool_executions.push({
    tool_request_id: rid,
    status: "SUCCEEDED",
    calls: [{ name: "delete_events", param: { provider: "feishu" }, tool_request_id: rid }],
    terminals: [
      {
        type: "TOOL_RESULT",
        tool_result: { tool_request_id: rid, name: "delete_events", status: "SUCCESS", result: {} }
      }
    ]
  });
  check(!run(unauthorized).pass, "first turn never allows delete: " + s.id);
  for (const w of all(ok).filter((e: any) =>
    [
      "feishu_create_doc",
      "feishu_update_doc",
      "feishu_send_message",
      "create_event",
      "update_event"
    ].includes(e.calls[0].name)
  )) {
    const bad = structuredClone(ok),
      found = all(bad).find((e: any) => e.tool_request_id === w.tool_request_id);
    found.terminals[0].tool_result.result = {};
    check(!run(bad).pass, "write must have real ID");
  }
}
// Binding guard smoke: a synthetic baseline only demonstrates packaging, never network/Agent acceptance.
const temp = await mkdtemp(resolve(tmpdir(), "feishu-binding-test-"));
const label = "synthetic-guard-" + Date.now();
try {
  const cfg: any = {
    uid: "123456",
    run_label: label,
    selected_case_ids: ["FS-D02-01"],
    active_write_tools: writeTools,
    preflight: {
      test_scope_approved: true,
      endpoint_full_output_verified: true,
      tool_schema_verified: true,
      fixtures_reviewed: true,
      write_tool_inventory_complete: true
    },
    tokens: { doc_url: tokens.doc_url },
    cases: { "FS-D02-01": { reviewed: true, setup_evidence_path: resolve(temp, "fixture.json") } }
  };
  await writeFile(
    resolve(temp, "fixture.json"),
    JSON.stringify({
      captured_at: "2026-09-15T09:00:00+08:00",
      resources: [{ synthetic: true }],
      expected_facts: { synthetic: true }
    })
  );
  const invoke = async (c: any) => {
    await writeFile(resolve(temp, "bindings.json"), JSON.stringify(c));
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(dir, "build-cases.ts"),
        "--bindings",
        resolve(temp, "bindings.json")
      ],
      { cwd: resolve(dir, "../.."), encoding: "utf8" }
    );
  };
  let r = await invoke({ ...cfg, uid: "REPLACE_ME" });
  check(r.status !== 0);
  r = await invoke({ ...cfg, preflight: {} });
  check(r.status !== 0);
  r = await invoke({ ...cfg, tokens: {} });
  check(r.status !== 0);
  r = await invoke({ ...cfg, selected_case_ids: ["not-a-case"] });
  check(r.status !== 0);
  r = await invoke(cfg);
  check(r.status === 0, r.stderr);
  const ready = (await readFile(resolve(dir, ".local", label, "cases.ready.jsonl"), "utf8")).trim();
  const readyCase = JSON.parse(ready);
  check(!ready.includes("BIND_REQUIRED_"));
  check(readyCase.assert.length === 4);
  check(readyCase.vars.request_body.uid.__cortex_eval_int64 === "123456");
  r = await invoke(cfg);
  check(r.status !== 0, "same run_label cannot overwrite");
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(resolve(dir, ".local", label), { recursive: true, force: true });
}
console.log(
  `${checks} synthetic checks passed. No Feishu/Agent/Judge calls, no real business results.`
);
