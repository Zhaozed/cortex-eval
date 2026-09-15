/**
 * 合成证据校验（v2，配套 build-cases.ts 的 9-case 边界矩阵，含 1 例 client 多轮）。
 * 只做一件事：证明每个 case 的断言
 *   1) 在“形状与真实证据一致的正确轨迹”上全绿；
 *   2) 在每一条刻意做错的轨迹上被至少一条断言拦截。
 * 不调用 Agent / Judge / 任何服务，不创建真实任务，不触发评测运行。
 *
 * 合成证据的形状取自真实采集（不是猜的）：
 *   .cortex-eval/tmp/diagnosis/live-capture-20260911/single-response.json（To Do collections/create）
 *   .cortex-eval/artifacts/runs/<runId>/rest-results.json（ClickUp collections 5 条、search 结果、任务对象字段）
 * 平台回显差异也按真实情况模拟：To Do 的 due 被截断到日期（T00:00:00Z）、description 追加 \r\n。
 */
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const TEST_UID = "2075490654049271808";
const T_FULL = "边界-全字段";
const T_NO_DUE = "边界-缺截止";
const T_MIN = "边界-最小字段";
const T_READBACK = "边界-回读链路";
const T_UPDATE = "边界-修改链路";
const T_MISSING = "边界-不存在-ZZZ";
const T_MULTI = "边界-多轮删除链路";
/** B9 是 client 多轮例（0-based 第 8 条），入口结构校验与单轮例不同。 */
const MULTI_INDEX = 8;
const MULTI_TURNS = 6;
const CASES_PER_FILE = 9;
const NOTE_FULL = "覆盖优先级截止备注";
const NOTE_UPDATED = "修改链路已覆盖";

const pad = (n: number): string => String(n).padStart(2, "0");
const shifted = new Date(Date.now() + 8 * 3600e3);
const dayOf = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const TOMORROW = dayOf(new Date(shifted.getTime() + 24 * 3600e3));
const TODAY = dayOf(shifted);
/** 用户给了时刻（ClickUp 全字段例）：明天 18:00 Asia/Shanghai。 */
const DUE_1800 = `${TOMORROW}T18:00:00+08:00`;
/** 用户只说“明天”：不得虚构具体时刻，用当天末尾，只校验日期。 */
const DUE_DAY = `${TOMORROW}T23:59:59+08:00`;
const utcEcho = (s: string): string => new Date(s).toISOString().replace(".000", "");

const TODO_COLLECTION_ID =
  "AQMkADAwATMwMAExLWFkOWUtNDU3Ni0wMAItMDAKAC4AAAMRNDvoFx1QQplp7Y7nCI2XAQDbxsP1yLziRIaEUkR-6-ZbAAACARIAAAA=";
const CU_COLLECTION_ID = "901820364132";

interface Plat {
  readonly provider: "clickup" | "todo";
  readonly prefix: "CU" | "TD";
  readonly file: string;
  /** list_task_collections 的真实返回（ClickUp 5 条，其中 Project 1 重名两条；To Do 1 条）。 */
  readonly collections: { id: string; name: string; parent?: string; provider: string }[];
  readonly targetCollectionId: string;
  readonly dueHour: number | null;
  readonly newTaskId: string;
}

const CU: Plat = {
  provider: "clickup",
  prefix: "CU",
  file: "cases.clickup.jsonl",
  collections: [
    { id: "901821240669", name: "Project 1", parent: "Space", provider: "clickup" },
    { id: "901820364139", name: "IT School Hub", parent: "Space", provider: "clickup" },
    { id: CU_COLLECTION_ID, name: "Project 2", parent: "Team Space", provider: "clickup" },
    {
      id: "901820364136",
      name: "Get Started with ClickUp",
      parent: "Team Space",
      provider: "clickup"
    },
    { id: "901820364133", name: "Project 1", parent: "Team Space", provider: "clickup" }
  ],
  targetCollectionId: CU_COLLECTION_ID,
  dueHour: 18,
  newTaskId: "86ezk0bnd"
};
const TD: Plat = {
  provider: "todo",
  prefix: "TD",
  file: "cases.todo.jsonl",
  collections: [{ id: TODO_COLLECTION_ID, name: "Tasks", provider: "todo" }],
  targetCollectionId: TODO_COLLECTION_ID,
  dueHour: null,
  newTaskId:
    "AQMkADAwATMwMAExLWFkOWUtNDU3Ni0wMAItMDAKAEYAAAMRNDvoFx1QQplp7Y7nCI2XBwDbxsP1yLziRIaEUkR-6-ZbAAACARIAAADbxsP1yLziRIaEUkR-6-ZbAAAATfA5PAAAAA=="
};
const PLATS: Plat[] = [CU, TD];
const other = (p: Plat): string => (p.provider === "clickup" ? "todo" : "clickup");

type Exec = Record<string, unknown>;
const exec = (
  id: string,
  name: string,
  param: Record<string, unknown>,
  result: Record<string, unknown>
): Exec => ({
  tool_request_id: id,
  status: "SUCCEEDED",
  calls: [{ tool_request_id: id, name, param }],
  terminals: [
    { type: "TOOL_RESULT", tool_result: { tool_request_id: id, name, status: "SUCCESS", result } }
  ]
});
const root = (
  executions: Exec[],
  reply: { reply_type: "QUESTION" | "NOTICE"; reply_text: string }
): Record<string, unknown> => ({
  ok: true,
  parsed_output: {
    request: { received_at: new Date().toISOString(), timezone: "Asia/Shanghai", lang: "zh-Hans" },
    reply_type: reply.reply_type,
    reply_text: reply.reply_text,
    tool_executions: executions
  }
});
const notice = (text: string) => ({ reply_type: "NOTICE" as const, reply_text: text });

const collectionsExec = (p: Plat, provider: string = p.provider, list = p.collections): Exec =>
  exec("r1", "list_task_collections", { provider }, { collections: list, total: list.length });

const taskEcho = (
  p: Plat,
  o: { id?: string; title: string; due: string; priority?: string; description?: string }
): Record<string, unknown> => {
  const due = p.provider === "todo" ? `${TOMORROW}T00:00:00Z` : utcEcho(o.due);
  const base: Record<string, unknown> = {
    collection_id: p.targetCollectionId,
    due,
    id: o.id ?? p.newTaskId,
    native_status: p.provider === "todo" ? "notStarted" : "to do",
    provider: p.provider,
    status: "open",
    title: o.title
  };
  if (o.priority !== undefined) base.priority = o.priority;
  // To Do 备注回显会追加 \r\n，ClickUp 原样回显。
  if (o.description !== undefined)
    base.description = p.provider === "todo" ? `${o.description}\r\n` : o.description;
  if (p.provider === "clickup") base.url = `https://app.clickup.com/t/${base.id}`;
  if (p.provider === "todo") base.collection_name = "Tasks";
  return base;
};

const createResult = (
  p: Plat,
  echo: Record<string, unknown>,
  count = 1
): Record<string, unknown> => ({
  collection_id: p.targetCollectionId,
  created_count: count,
  provider: p.provider,
  results: [{ index: 0, success: true, task: echo }],
  success: true
});

const createExec = (
  p: Plat,
  tasks: Record<string, unknown>[],
  o: {
    id?: string;
    provider?: string;
    collectionId?: string | null;
    result?: Record<string, unknown>;
  } = {}
): Exec => {
  const param: Record<string, unknown> = { provider: o.provider ?? p.provider, tasks };
  if (o.collectionId !== null) param.collection_id = o.collectionId ?? p.targetCollectionId;
  return exec(
    "r2",
    "create_tasks",
    param,
    o.result ??
      createResult(
        p,
        taskEcho(p, {
          title: String(tasks[0]?.title ?? ""),
          due: String(tasks[0]?.due ?? ""),
          ...(tasks[0] as object)
        })
      )
  );
};

type Reply = { reply_type: "QUESTION" | "NOTICE"; reply_text: string };
interface MtTurn {
  execs: Exec[];
  reply: Reply;
  ready?: boolean;
}

/** 多轮合成执行记录：ID 跨轮也必须唯一（断言按全局去重校验执行记录可信度）。 */
const mtExec = (
  turn: number,
  seq: number,
  name: string,
  param: Record<string, unknown>,
  result: Record<string, unknown>,
  o: { status?: string; resultStatus?: string } = {}
): Exec => {
  const id = `t${turn}r${seq}`;
  return {
    tool_request_id: id,
    status: o.status ?? "SUCCEEDED",
    calls: [{ tool_request_id: id, name, param }],
    terminals: [
      {
        type: "TOOL_RESULT",
        tool_result: { tool_request_id: id, name, status: o.resultStatus ?? "SUCCESS", result }
      }
    ]
  };
};

/**
 * 多轮证据根：复刻 Agent 侧 _conversation_projection 的形状——
 * 顶层是末轮投影平铺，逐轮事实在 parsed_output.turns[]，完整性口径在 conversation_execution。
 */
const mtRoot = (
  turns: MtTurn[],
  o: {
    expected?: number;
    observed?: number;
    completed?: number;
    complete?: boolean;
    dropTurns?: boolean;
  } = {}
): Record<string, unknown> => {
  const expected = o.expected ?? turns.length;
  const records = turns.map((t, i) => ({
    turn_index: i,
    req_id: `req-${i}`,
    input_text: `第${i + 1}轮`,
    execution_ready: t.ready ?? true,
    parsed_output: {
      request: {
        received_at: new Date().toISOString(),
        timezone: "Asia/Shanghai",
        lang: "zh-Hans"
      },
      reply_type: t.reply.reply_type,
      reply_text: t.reply.reply_text,
      tool_executions: t.execs
    }
  }));
  const last = records[records.length - 1]!.parsed_output;
  const projection: Record<string, unknown> = {
    ...last,
    conversation_execution: {
      expected_turns: expected,
      observed_turns: o.observed ?? records.length,
      completed_turns: o.completed ?? records.filter((r) => r.execution_ready).length,
      complete:
        o.complete ?? (records.length === expected && records.every((r) => r.execution_ready))
    }
  };
  if (!o.dropTurns) projection.turns = records;
  return {
    ok: true,
    task_name: "EVAL_E2E",
    resolved_config: { execution_mode: "client" },
    parsed_output: projection
  };
};

const listOpenExec = (p: Plat, turn: number, seq: number, titles: string[]): Exec =>
  mtExec(
    turn,
    seq,
    "list_tasks",
    { provider: [p.provider], status: "open" },
    {
      results: [
        {
          provider: p.provider,
          total: titles.length,
          tasks: titles.map((title, i) => ({
            id: `${p.provider}-leftover-${i}`,
            title,
            status: "open",
            provider: p.provider
          }))
        }
      ]
    }
  );

const delResult = (p: Plat, ids: string[]): Record<string, unknown> => ({
  provider: p.provider,
  success: true,
  results: ids.map((task_id, index) => ({ index, success: true, task_id }))
});
const delExec = (p: Plat, turn: number, seq: number, ids: string[], provider?: string): Exec =>
  mtExec(
    turn,
    seq,
    "delete_tasks",
    { provider: provider ?? p.provider, task_ids: ids },
    delResult(p, ids)
  );

/**
 * B9 的两条正确轨迹：产品提示词里没有“删除需二次确认”规则，
 * 所以“第2轮直接删”和“先反问、第4轮才删”两种真实行为都必须判绿，否则 Case 本身就是坏 Case。
 */
function mtGoodTurns(p: Plat, variant: "direct" | "confirmFirst"): MtTurn[] {
  const createParam: Record<string, unknown> = {
    provider: p.provider,
    tasks: [{ title: T_MULTI, due: DUE_DAY }]
  };
  if (p.provider === "clickup") createParam.collection_id = p.targetCollectionId;
  const t0: Exec[] = [];
  if (p.provider === "clickup")
    t0.push(
      mtExec(
        0,
        1,
        "list_task_collections",
        { provider: p.provider },
        { collections: p.collections, total: p.collections.length }
      )
    );
  t0.push(
    mtExec(
      0,
      t0.length + 1,
      "create_tasks",
      createParam,
      createResult(p, taskEcho(p, { title: T_MULTI, due: DUE_DAY }))
    )
  );
  const deleted = `“${T_MULTI}”已删除。`;
  return [
    { execs: t0, reply: notice(`已创建“${T_MULTI}”，截止明天。`) },
    variant === "direct"
      ? { execs: [delExec(p, 1, 1, [p.newTaskId])], reply: notice(deleted) }
      : { execs: [], reply: { reply_type: "QUESTION", reply_text: `确认要删除“${T_MULTI}”吗？` } },
    {
      execs: [],
      reply: notice(
        variant === "direct"
          ? "这条任务上一步已经删除，无法撤销或恢复。"
          : "好的，先保留，没有删除。"
      )
    },
    variant === "direct"
      ? { execs: [], reply: notice("这条任务已经删除过了，不需要再删一次。") }
      : { execs: [delExec(p, 3, 1, [p.newTaskId])], reply: notice(deleted) },
    { execs: [], reply: notice("确认：该任务已删除，账号里已经没有这条任务。") },
    {
      execs: [listOpenExec(p, 5, 1, ["既有未完成任务"])],
      reply: notice(
        `已回查，${p.provider === "clickup" ? "ClickUp" : "Microsoft To Do"} 里没有“${T_MULTI}”这条任务。`
      )
    }
  ];
}

const findExec = (turns: MtTurn[], index: number, name: string): Exec => {
  const hit = turns[index]!.execs.find((e) => (e.calls[0] as { name: string }).name === name);
  if (!hit) throw new Error(`合成证据缺少 ${name} @turn${index}`);
  return hit;
};
const paramOf = (e: Exec): Record<string, unknown> =>
  (e.calls[0] as { param: Record<string, unknown> }).param;
const clone = (turns: MtTurn[]): MtTurn[] => JSON.parse(JSON.stringify(turns)) as MtTurn[];

/** B9 反例：每一条都必须被至少一条断言拦截，拦不住就是断言有洞。 */
function mtBad(p: Plat): Bad[] {
  const out: Bad[] = [
    {
      label: "隔离模式拒绝多轮（EVAL_E2E_CONTEXT_MODE_REQUIRED）",
      evidence: { ok: false, err_msg: "EVAL_E2E_CONTEXT_MODE_REQUIRED", parsed_output: null }
    },
    {
      label: "client 模式缺 sid（EVAL_E2E_CLIENT_CONTEXT_REQUIRED）",
      evidence: { ok: false, err_msg: "EVAL_E2E_CLIENT_CONTEXT_REQUIRED", parsed_output: null }
    }
  ];
  const push = (
    label: string,
    mutate: (t: MtTurn[]) => void,
    rootOpts?: {
      expected?: number;
      observed?: number;
      completed?: number;
      complete?: boolean;
      dropTurns?: boolean;
    }
  ): void => {
    const t = clone(mtGoodTurns(p, "direct"));
    mutate(t);
    out.push({ label, evidence: mtRoot(t, rootOpts ?? {}) });
  };
  push("多轮中断（6 轮只跑完 3 轮）", () => {}, {
    expected: MULTI_TURNS,
    observed: 3,
    completed: 3,
    complete: false
  });
  push("缺逐轮 turns，只剩末轮投影", () => {}, { dropTurns: true });
  push("某一轮 execution_ready=false", (t) => {
    t[4]!.ready = false;
  });
  push("第3轮用户已取消却仍执行删除", (t) => {
    t[2]!.execs.push(delExec(p, 2, 1, [p.newTaskId]));
  });
  push("删除用捏造 ID（不是第1轮创建返回的真实 ID）", (t) => {
    paramOf(findExec(t, 1, "delete_tasks")).task_ids = ["task-999999"];
  });
  push("删除多带了别的任务 ID（越界多删）", (t) => {
    paramOf(findExec(t, 1, "delete_tasks")).task_ids = [p.newTaskId, "task-innocent"];
  });
  push("整段对话一次都没删除", (t) => {
    t[1]!.execs = [];
    t[1]!.reply = notice("好的，先保留。");
  });
  push("重复删除已删任务", (t) => {
    t[3]!.execs.push(delExec(p, 3, 1, [p.newTaskId]));
  });
  push("末轮回查结果里该任务仍在（删除没生效）", (t) => {
    t[5]!.execs = [listOpenExec(p, 5, 1, [T_MULTI, "既有未完成任务"])];
  });
  push("末轮不是只读回查，又调了一次删除", (t) => {
    t[5]!.execs.push(delExec(p, 5, 2, [p.newTaskId]));
  });
  push("末轮没做任何只读回查就下结论", (t) => {
    t[5]!.execs = [];
  });
  push("末轮缺最终回复正文", (t) => {
    t[5]!.reply = { reply_type: "NOTICE", reply_text: "" };
  });
  push("第1轮没有创建就凭空删除", (t) => {
    t[0]!.execs = p.provider === "clickup" ? [findExec(t, 0, "list_task_collections")] : [];
  });
  push("第1轮创建串平台", (t) => {
    paramOf(findExec(t, 0, "create_tasks")).provider = other(p);
  });
  push("删除轮串平台", (t) => {
    paramOf(findExec(t, 1, "delete_tasks")).provider = other(p);
  });
  push("第4轮又创建了一条任务", (t) => {
    const cp: Record<string, unknown> = {
      provider: p.provider,
      tasks: [{ title: T_MULTI, due: DUE_DAY }]
    };
    if (p.provider === "clickup") cp.collection_id = p.targetCollectionId;
    t[3]!.execs.push(
      mtExec(
        3,
        2,
        "create_tasks",
        cp,
        createResult(p, taskEcho(p, { title: T_MULTI, due: DUE_DAY }))
      )
    );
  });
  push("调用了 update_task（本例无修改诉求）", (t) => {
    t[4]!.execs.push(
      mtExec(
        4,
        1,
        "update_task",
        { provider: p.provider, task_id: p.newTaskId, priority: "low" },
        {
          task: taskEcho(p, { title: T_MULTI, due: DUE_DAY, priority: "low" })
        }
      )
    );
  });
  push("第1轮编造截止时间（今天而非明天）", (t) => {
    const tasks = paramOf(findExec(t, 0, "create_tasks")).tasks as Record<string, unknown>[];
    tasks[0]!.due = `${TODAY}T23:59:59+08:00`;
  });
  push("第1轮编造优先级/备注（用户只给了标题和截止）", (t) => {
    const tasks = paramOf(findExec(t, 0, "create_tasks")).tasks as Record<string, unknown>[];
    tasks[0]!.priority = "high";
    tasks[0]!.description = "顺手补一个备注";
  });
  push("第1轮标题不精确", (t) => {
    const tasks = paramOf(findExec(t, 0, "create_tasks")).tasks as Record<string, unknown>[];
    tasks[0]!.title = `${T_MULTI}-改`;
  });
  if (p.provider === "clickup")
    push("ClickUp 创建缺 collection_id", (t) => {
      delete paramOf(findExec(t, 0, "create_tasks")).collection_id;
    });
  return out;
}

/** 正确轨迹：形状与真实证据一致。 */
function goodEvidence(p: Plat, id: string): Record<string, unknown> {
  const s = id.slice(-2);
  const dueFull = p.dueHour === null ? DUE_DAY : DUE_1800;
  // To Do 侧刻意混用“带 collection_id / 省略 collection_id（默认清单）”两条真实可行路径。
  const withCollectionId = p.provider === "clickup" || s === "B3";
  const coll = withCollectionId ? { collectionId: p.targetCollectionId } : { collectionId: null };
  if (s === "B9") return mtRoot(mtGoodTurns(p, "direct"));
  if (s === "B1")
    return root(
      [collectionsExec(p)],
      notice(
        p.provider === "clickup"
          ? "你在 ClickUp 有 5 个清单。"
          : "你在 Microsoft To Do 有 1 个清单：任务。"
      )
    );
  if (s === "B2")
    return root(
      [
        exec(
          "r1",
          "list_tasks",
          { provider: [p.provider], status: "open" },
          {
            results: [
              {
                provider: p.provider,
                total: 1,
                tasks: [
                  {
                    id: p.provider === "clickup" ? "86eyu9ah1" : "AQMkADAw-existing",
                    title: "既有未完成任务",
                    status: "open",
                    provider: p.provider
                  }
                ]
              }
            ]
          }
        )
      ],
      notice("还有 1 条未完成待办。")
    );
  if (s === "B3")
    return root(
      [
        collectionsExec(p),
        createExec(p, [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }], {
          ...coll,
          result: createResult(
            p,
            taskEcho(p, { title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL })
          )
        })
      ],
      notice(`已创建“${T_FULL}”。`)
    );
  if (s === "B4")
    return root([collectionsExec(p)], {
      reply_type: "QUESTION",
      reply_text: `“${T_NO_DUE}”的截止时间是哪天几点？给我日期就行。`
    });
  if (s === "B5")
    return root(
      [
        collectionsExec(p),
        createExec(p, [{ title: T_MIN, due: DUE_DAY }], {
          ...coll,
          result: createResult(p, taskEcho(p, { title: T_MIN, due: DUE_DAY }))
        })
      ],
      notice(`已创建“${T_MIN}”。`)
    );
  if (s === "B6")
    return root(
      [
        collectionsExec(p),
        createExec(p, [{ title: T_READBACK, due: DUE_DAY }], {
          ...coll,
          result: createResult(p, taskEcho(p, { title: T_READBACK, due: DUE_DAY }))
        }),
        exec(
          "r3",
          "get_task",
          { provider: p.provider, task_id: p.newTaskId },
          {
            task: taskEcho(p, { title: T_READBACK, due: DUE_DAY })
          }
        )
      ],
      notice(`已创建并回读“${T_READBACK}”，截止日期为明天。`)
    );
  if (s === "B7")
    return root(
      [
        collectionsExec(p),
        createExec(p, [{ title: T_UPDATE, due: DUE_DAY, priority: "high" }], {
          ...coll,
          result: createResult(p, taskEcho(p, { title: T_UPDATE, due: DUE_DAY, priority: "high" }))
        }),
        exec(
          "r3",
          "update_task",
          {
            provider: p.provider,
            task_id: p.newTaskId,
            priority: "low",
            description: NOTE_UPDATED
          },
          {
            task: taskEcho(p, {
              title: T_UPDATE,
              due: DUE_DAY,
              priority: "low",
              description: NOTE_UPDATED
            })
          }
        )
      ],
      notice(`已把“${T_UPDATE}”改为低优先级并更新备注。`)
    );
  return root(
    [
      exec(
        "r1",
        "search_tasks",
        { provider: p.provider, query: T_MISSING },
        { provider: p.provider, tasks: [], total: 0 }
      )
    ],
    notice(`没有找到标题为“${T_MISSING}”的任务，未做任何删除。`)
  );
}

interface Bad {
  readonly label: string;
  readonly evidence: Record<string, unknown>;
}

/**
 * 正确轨迹变体：B9 有两条都必须判绿（产品提示词无“删除需二次确认”规则，
 * 第2轮直接删 / 先反问第4轮再删，都是真实可接受行为）；其余 case 只有一条默认正确轨迹。
 */
function goodVariants(p: Plat, id: string): Bad[] {
  if (id.slice(-2) === "B9")
    return [
      { label: "第2轮直接删除", evidence: mtRoot(mtGoodTurns(p, "direct")) },
      { label: "先反问确认再删除", evidence: mtRoot(mtGoodTurns(p, "confirmFirst")) }
    ];
  return [{ label: "default", evidence: goodEvidence(p, id) }];
}

/** 每条反例都必须被至少一条断言拦截；拦不住就是断言有洞。 */
function badEvidence(p: Plat, id: string): Bad[] {
  const s = id.slice(-2);
  const dueFull = p.dueHour === null ? DUE_DAY : DUE_1800;
  const wrongDayDue = `${TODAY}T18:00:00+08:00`;
  const fakeCollectionId = p.provider === "clickup" ? "901800000000" : "FAKE-COLLECTION-ID";
  const createOk = (title: string, due: string, extra: Record<string, unknown> = {}) =>
    createResult(p, taskEcho(p, { title, due, ...extra }));
  if (s === "B1")
    return [
      { label: "串平台查询", evidence: root([collectionsExec(p, other(p))], notice("清单如下。")) },
      {
        label: "虚构/漏报真实清单",
        evidence: root(
          [
            collectionsExec(
              p,
              p.provider,
              p.collections.filter((c) => c.id !== p.targetCollectionId)
            )
          ],
          notice("清单如下。")
        )
      },
      { label: "只有计划没有真实执行", evidence: root([], notice("清单如下。")) }
    ];
  if (s === "B2")
    return [
      {
        label: "虚构时间范围 due_after",
        evidence: root(
          [
            exec(
              "r1",
              "list_tasks",
              { provider: [p.provider], status: "open", due_after: DUE_DAY },
              { results: [] }
            )
          ],
          notice("未完成如下。")
        )
      },
      {
        label: "串平台查询",
        evidence: root(
          [
            exec(
              "r1",
              "list_tasks",
              { provider: ["clickup", "todo"], status: "open" },
              { results: [] }
            )
          ],
          notice("未完成如下。")
        )
      },
      {
        label: "未按未完成口径（缺 status=open）",
        evidence: root(
          [
            exec(
              "r1",
              "list_tasks",
              { provider: [p.provider] },
              { results: [{ provider: p.provider, tasks: [], total: 0 }] }
            )
          ],
          notice("未完成如下。")
        )
      }
    ];
  if (s === "B3") {
    const list: Bad[] = [
      {
        label: "截止日期算错（今天）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_FULL, due: wrongDayDue, priority: "high", description: NOTE_FULL }],
              {
                result: createOk(T_FULL, wrongDayDue, { priority: "high", description: NOTE_FULL })
              }
            )
          ],
          notice("已创建。")
        )
      },
      {
        label: "collection_id 编造（不来自本轮清单结果）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }],
              {
                collectionId: fakeCollectionId,
                result: createOk(T_FULL, dueFull, { priority: "high", description: NOTE_FULL })
              }
            )
          ],
          notice("已创建。")
        )
      },
      {
        label: "漏字段（未设置优先级）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_FULL, due: dueFull, description: NOTE_FULL }], {
              result: createOk(T_FULL, dueFull, { description: NOTE_FULL })
            })
          ],
          notice("已创建。")
        )
      },
      {
        label: "重复创建两次",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }],
              {
                result: createOk(T_FULL, dueFull, { priority: "high", description: NOTE_FULL })
              }
            ),
            {
              ...createExec(
                p,
                [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }],
                {
                  result: createOk(T_FULL, dueFull, { priority: "high", description: NOTE_FULL })
                }
              ),
              tool_request_id: "r9"
            }
          ],
          notice("已创建。")
        )
      },
      {
        label: "业务失败仍报成功（success=false）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }],
              {
                result: {
                  provider: p.provider,
                  created_count: 0,
                  success: false,
                  results: [{ index: 0, success: false }]
                }
              }
            )
          ],
          notice("已创建。")
        )
      }
    ];
    if (p.provider === "clickup") {
      list.push({
        label: "ClickUp 创建缺 collection_id",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_FULL, due: dueFull, priority: "high", description: NOTE_FULL }],
              {
                collectionId: null,
                result: createOk(T_FULL, dueFull, { priority: "high", description: NOTE_FULL })
              }
            )
          ],
          notice("已创建。")
        )
      });
      list.push({
        label: "截止时刻错（09:00 而非 18:00）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [
                {
                  title: T_FULL,
                  due: `${TOMORROW}T09:00:00+08:00`,
                  priority: "high",
                  description: NOTE_FULL
                }
              ],
              {
                result: createOk(T_FULL, `${TOMORROW}T09:00:00+08:00`, {
                  priority: "high",
                  description: NOTE_FULL
                })
              }
            )
          ],
          notice("已创建。")
        )
      });
    }
    return list;
  }
  if (s === "B4")
    return [
      {
        label: "编造截止时间先斩后奏创建",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_NO_DUE, due: DUE_DAY }], {
              result: createOk(T_NO_DUE, DUE_DAY)
            })
          ],
          notice("已创建，截止明天。")
        )
      },
      {
        label: "不追问，直接回 NOTICE",
        evidence: root([collectionsExec(p)], notice("好的，已记录。"))
      },
      {
        label: "追问正文为空",
        evidence: root([collectionsExec(p)], { reply_type: "QUESTION", reply_text: "  " })
      },
      {
        label: "澄清前只读查询串平台",
        evidence: root([collectionsExec(p, other(p))], {
          reply_type: "QUESTION",
          reply_text: "截止时间是哪天？"
        })
      }
    ];
  if (s === "B5")
    return [
      {
        label: "编造 priority=normal",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_MIN, due: DUE_DAY, priority: "normal" }], {
              result: createOk(T_MIN, DUE_DAY, { priority: "normal" })
            })
          ],
          notice("已创建。")
        )
      },
      {
        label: "编造备注",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_MIN, due: DUE_DAY, description: "自动补的备注" }], {
              result: createOk(T_MIN, DUE_DAY, { description: "自动补的备注" })
            })
          ],
          notice("已创建。")
        )
      },
      {
        label: "一次创建两条",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [
                { title: T_MIN, due: DUE_DAY },
                { title: `${T_MIN}-2`, due: DUE_DAY }
              ],
              {
                result: {
                  provider: p.provider,
                  collection_id: p.targetCollectionId,
                  created_count: 2,
                  success: true,
                  results: [
                    { index: 0, success: true, task: taskEcho(p, { title: T_MIN, due: DUE_DAY }) },
                    {
                      index: 1,
                      success: true,
                      task: taskEcho(p, { id: "second-id", title: `${T_MIN}-2`, due: DUE_DAY })
                    }
                  ]
                }
              }
            )
          ],
          notice("已创建。")
        )
      }
    ];
  if (s === "B6")
    return [
      {
        label: "回读用捏造的任务 ID",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_READBACK, due: DUE_DAY }], {
              result: createOk(T_READBACK, DUE_DAY)
            }),
            exec(
              "r3",
              "get_task",
              { provider: p.provider, task_id: "task-999999" },
              {
                task: taskEcho(p, { id: "task-999999", title: T_READBACK, due: DUE_DAY })
              }
            )
          ],
          notice("已回读。")
        )
      },
      {
        label: "拿清单 ID 冒充任务 ID",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_READBACK, due: DUE_DAY }], {
              result: createOk(T_READBACK, DUE_DAY)
            }),
            exec(
              "r3",
              "get_task",
              { provider: p.provider, task_id: p.targetCollectionId },
              {
                task: taskEcho(p, { id: p.targetCollectionId, title: T_READBACK, due: DUE_DAY })
              }
            )
          ],
          notice("已回读。")
        )
      },
      {
        label: "用宽泛搜索代替按 ID 回读",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_READBACK, due: DUE_DAY }], {
              result: createOk(T_READBACK, DUE_DAY)
            }),
            exec(
              "r3",
              "search_tasks",
              { provider: p.provider, query: T_READBACK },
              {
                provider: p.provider,
                total: 1,
                tasks: [taskEcho(p, { title: T_READBACK, due: DUE_DAY })]
              }
            )
          ],
          notice("已回读。")
        )
      },
      {
        label: "创建后没有回读",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_READBACK, due: DUE_DAY }], {
              result: createOk(T_READBACK, DUE_DAY)
            })
          ],
          notice("已创建，详情略。")
        )
      }
    ];
  if (s === "B7")
    return [
      {
        label: "拿清单 ID 当 task_id 修改",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_UPDATE, due: DUE_DAY, priority: "high" }], {
              result: createOk(T_UPDATE, DUE_DAY, { priority: "high" })
            }),
            exec(
              "r3",
              "update_task",
              {
                provider: p.provider,
                task_id: p.targetCollectionId,
                priority: "low",
                description: NOTE_UPDATED
              },
              {
                task: taskEcho(p, {
                  id: p.targetCollectionId,
                  title: T_UPDATE,
                  due: DUE_DAY,
                  priority: "low",
                  description: NOTE_UPDATED
                })
              }
            )
          ],
          notice("已修改。")
        )
      },
      {
        label: "改成了 normal 而不是 low",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_UPDATE, due: DUE_DAY, priority: "high" }], {
              result: createOk(T_UPDATE, DUE_DAY, { priority: "high" })
            }),
            exec(
              "r3",
              "update_task",
              {
                provider: p.provider,
                task_id: p.newTaskId,
                priority: "normal",
                description: NOTE_UPDATED
              },
              {
                task: taskEcho(p, {
                  title: T_UPDATE,
                  due: DUE_DAY,
                  priority: "normal",
                  description: NOTE_UPDATED
                })
              }
            )
          ],
          notice("已修改。")
        )
      },
      {
        label: "备注不精确",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_UPDATE, due: DUE_DAY, priority: "high" }], {
              result: createOk(T_UPDATE, DUE_DAY, { priority: "high" })
            }),
            exec(
              "r3",
              "update_task",
              {
                provider: p.provider,
                task_id: p.newTaskId,
                priority: "low",
                description: "改过了"
              },
              {
                task: taskEcho(p, {
                  title: T_UPDATE,
                  due: DUE_DAY,
                  priority: "low",
                  description: "改过了"
                })
              }
            )
          ],
          notice("已修改。")
        )
      },
      {
        label: "平台回显未生效（仍是 high）",
        evidence: root(
          [
            collectionsExec(p),
            createExec(p, [{ title: T_UPDATE, due: DUE_DAY, priority: "high" }], {
              result: createOk(T_UPDATE, DUE_DAY, { priority: "high" })
            }),
            exec(
              "r3",
              "update_task",
              {
                provider: p.provider,
                task_id: p.newTaskId,
                priority: "low",
                description: NOTE_UPDATED
              },
              {
                task: taskEcho(p, {
                  title: T_UPDATE,
                  due: DUE_DAY,
                  priority: "high",
                  description: NOTE_UPDATED
                })
              }
            )
          ],
          notice("已修改。")
        )
      },
      {
        label: "创建阶段编造备注",
        evidence: root(
          [
            collectionsExec(p),
            createExec(
              p,
              [{ title: T_UPDATE, due: DUE_DAY, priority: "high", description: "先补一个备注" }],
              {
                result: createOk(T_UPDATE, DUE_DAY, {
                  priority: "high",
                  description: "先补一个备注"
                })
              }
            ),
            exec(
              "r3",
              "update_task",
              {
                provider: p.provider,
                task_id: p.newTaskId,
                priority: "low",
                description: NOTE_UPDATED
              },
              {
                task: taskEcho(p, {
                  title: T_UPDATE,
                  due: DUE_DAY,
                  priority: "low",
                  description: NOTE_UPDATED
                })
              }
            )
          ],
          notice("已修改。")
        )
      }
    ];
  if (s === "B9") return mtBad(p);
  return [
    {
      label: "捏造 ID 直接删除",
      evidence: root(
        [
          exec(
            "r1",
            "delete_tasks",
            { provider: p.provider, task_ids: ["task-999999"] },
            { provider: p.provider, deleted: ["task-999999"] }
          )
        ],
        notice("已删除。")
      )
    },
    { label: "没做任何只读定位就下结论", evidence: root([], notice(`没有找到“${T_MISSING}”。`)) },
    {
      label: "查询词不含目标关键词（宽泛拉取）",
      evidence: root(
        [
          exec(
            "r1",
            "search_tasks",
            { provider: p.provider, query: "边界" },
            { provider: p.provider, tasks: [], total: 0 }
          )
        ],
        notice("没有找到。")
      )
    },
    {
      label: "只读定位串平台",
      evidence: root(
        [
          exec(
            "r1",
            "search_tasks",
            { provider: other(p), query: T_MISSING },
            { provider: other(p), tasks: [], total: 0 }
          )
        ],
        notice("没有找到。")
      )
    },
    {
      label: "前提被破坏（账号里真有这条任务）",
      evidence: root(
        [
          exec(
            "r1",
            "search_tasks",
            { provider: p.provider, query: T_MISSING },
            {
              provider: p.provider,
              total: 1,
              tasks: [taskEcho(p, { id: "task-real", title: T_MISSING, due: DUE_DAY })]
            }
          )
        ],
        notice("没有找到。")
      )
    },
    {
      label: "缺最终回复正文",
      evidence: root(
        [
          exec(
            "r1",
            "search_tasks",
            { provider: p.provider, query: T_MISSING },
            { provider: p.provider, tasks: [], total: 0 }
          )
        ],
        { reply_type: "NOTICE", reply_text: "" }
      )
    }
  ];
}

function runAssertions(
  asserts: { type: string; value: string; metric?: string }[],
  evidence: Record<string, unknown>
): { metric: string; pass: boolean; reason: string }[] {
  return asserts
    .filter((a) => a.type === "javascript")
    .map((a) => {
      try {
        const out = runInNewContext(`(function (output) {\n${a.value}\n})(__evidence)`, {
          __evidence: JSON.parse(JSON.stringify(evidence))
        }) as { pass?: boolean; reason?: string };
        return {
          metric: a.metric ?? "",
          pass: out?.pass === true,
          reason: out?.reason ?? "断言没有返回结果"
        };
      } catch (error) {
        return { metric: a.metric ?? "", pass: false, reason: `throw ${(error as Error).message}` };
      }
    });
}

interface CaseJson {
  contractVersion: string;
  description: string;
  threshold: number;
  vars: { task: string; request_body: Record<string, unknown> };
  metadata: Record<string, unknown>;
  assert: { type: string; value: string; metric?: string; weight?: number }[];
}

/** 结构校验：单轮、隔离模式、UID/时区、断言组合、写工具策略。 */
function structureProblems(p: Plat, index: number, c: CaseJson): string[] {
  const out: string[] = [];
  const want = `${p.prefix}-B${index + 1}`;
  if (c.metadata.case_id !== want)
    out.push(`case_id 期望 ${want}，实际 ${String(c.metadata.case_id)}`);
  if (c.metadata.req_id !== `spb2_${want}` || c.metadata.task_id !== `spb2_${want}`)
    out.push("req_id/task_id 前缀不是 spb2_");
  if (c.metadata.a2ui_capture !== true) out.push("a2ui_capture 未开启");
  if (c.threshold !== 1) out.push("threshold 不是 1");
  if (c.vars.task !== "agent-e2e") out.push("vars.task 不是 agent-e2e");
  const rb = c.vars.request_body as {
    uid?: unknown;
    timezone?: string;
    lang?: string;
    text?: string;
    turns?: unknown;
    conversation?: unknown;
    execution_mode?: string;
    sid?: string;
  };
  if (JSON.stringify(rb.uid) !== JSON.stringify({ __cortex_eval_int64: TEST_UID }))
    out.push("uid 不是 int64 包装的测试账号");
  if (rb.timezone !== "Asia/Shanghai") out.push("timezone 不是 Asia/Shanghai");
  if (rb.lang !== "zh-Hans") out.push("lang 不是 zh-Hans");
  if (index === MULTI_INDEX) {
    if (rb.execution_mode !== "client")
      out.push("多轮例 execution_mode 必须是 client（隔离模式会拒绝多轮）");
    if (typeof rb.sid !== "string" || !rb.sid.trim()) out.push("多轮例缺少非空 sid");
    if (rb.text !== undefined) out.push("多轮例不应出现单轮 text");
    if (rb.turns !== undefined) out.push("多轮例用 conversation，不应出现 turns");
    if (!Array.isArray(rb.conversation) || rb.conversation.length !== MULTI_TURNS) {
      out.push(
        `多轮例 conversation 必须是 ${MULTI_TURNS} 条，实际 ${Array.isArray(rb.conversation) ? rb.conversation.length : "非数组"}`
      );
    } else {
      const bad = rb.conversation.findIndex((t) => {
        const x = t as { role?: string; text?: string };
        return x.role !== "user" || typeof x.text !== "string" || !x.text.trim();
      });
      if (bad >= 0) out.push(`conversation[${bad}] 不是非空 user 文本`);
    }
  } else {
    if (typeof rb.text !== "string" || !rb.text.trim()) out.push("缺少单轮 text");
    if (rb.turns !== undefined) out.push("单轮例不应出现 turns");
    if (rb.conversation !== undefined) out.push("单轮例不应出现 conversation");
    if (rb.execution_mode !== undefined) out.push("单轮例不应出现 execution_mode（默认隔离）");
    if (rb.sid !== undefined) out.push("单轮例不应出现 sid");
  }
  const js = c.assert.filter((a) => a.type === "javascript");
  const rubric = c.assert.filter((a) => a.type === "llm-rubric");
  if (js.length < 2) out.push("javascript 断言少于 2 条");
  if (rubric.length !== 1) out.push("llm-rubric 断言必须恰好 1 条");
  if (c.assert.some((a) => a.weight !== 1)) out.push("存在 weight≠1 的断言");
  const policies = js
    .map((a) => /const policy = (\{.*?\});/s.exec(a.value)?.[1])
    .filter((v): v is string => typeof v === "string")
    .map((v) => JSON.parse(v) as { tools: string[]; mode: string; maxCalls: number });
  const forbidden = policies.filter((x) => x.mode === "forbid").flatMap((x) => x.tools);
  const limits = policies.filter((x) => x.mode === "limit");
  const writes = ["create_tasks", "update_task", "delete_tasks"];
  const allowedWrites = limits.map((l) => l.tools[0]);
  const expectedForbidden = writes.filter((w) => !allowedWrites.includes(w)).sort();
  if (JSON.stringify(forbidden.slice().sort()) !== JSON.stringify(expectedForbidden))
    out.push(`禁止工具集合不符：期望 ${expectedForbidden.join(",")}，实际 ${forbidden.join(",")}`);
  return out;
}

let failures = 0;
const rows: string[] = [];
for (const p of PLATS) {
  const lines = (await readFile(new URL(p.file, import.meta.url), "utf8")).trim().split("\n");
  if (lines.length !== CASES_PER_FILE) {
    failures++;
    console.log(`FAIL ${p.file} 期望 ${CASES_PER_FILE} 个 case，实际 ${lines.length}`);
  }
  let badTotal = 0;
  lines.forEach((line, index) => {
    const c = JSON.parse(line) as CaseJson;
    const id = String(c.metadata.case_id);
    for (const problem of structureProblems(p, index, c)) {
      failures++;
      console.log(`FAIL ${id} 结构：${problem}`);
    }
    for (const variant of goodVariants(p, id)) {
      const goodFailed = runAssertions(c.assert, variant.evidence).filter((r) => !r.pass);
      if (goodFailed.length) {
        failures++;
        console.log(
          `FAIL ${id} 正确轨迹[${variant.label}]应全绿：`,
          goodFailed.map((g) => `${g.metric} → ${g.reason}`).join(" | ")
        );
      }
    }
    const leaked: string[] = [];
    const caughtBy: string[] = [];
    for (const bad of badEvidence(p, id)) {
      badTotal++;
      const res = runAssertions(c.assert, bad.evidence);
      const blocked = res.filter((r) => !r.pass);
      if (!blocked.length) leaked.push(bad.label);
      else caughtBy.push(`${bad.label}←${blocked[0].metric}`);
    }
    if (leaked.length) {
      failures++;
      console.log(`FAIL ${id} 反例未被拦截：${leaked.join("、")}`);
    }
    rows.push(
      `${id}\t正确轨迹 ${goodVariants(p, id).length} 条全绿\t反例 ${badTotal - leaked.length}/${badTotal} 被拦截`
    );
    if (process.env.VERBOSE) console.log(`${id} 拦截明细：\n  ` + caughtBy.join("\n  "));
  });
  console.log(`${p.file}: ${lines.length} cases，反例合计 ${badTotal} 条`);
}
console.log(rows.join("\n"));
console.log(failures === 0 ? "SYNTHETIC CHECK PASSED" : `SYNTHETIC CHECK FAILED ${failures}`);
