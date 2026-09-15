# 单平台评测边界测试集（重建 v2 + B9 client 多轮）· ClickUp / Microsoft To Do

两个平台**各自独立**一套，互不混用；每套 9 例：B1–B8 单轮自包含（隔离模式可执行），B9 为 client 多轮自包含（`execution_mode=client` + 固定 `sid`，6 轮：建→删→撤销→重复删→确认→只读回查）；只保留能跑通、能被证据判定的“好 Case”。

## 套件

| 平台 | 套件名 | suiteId | revision | caseCount | 本地文件 |
|---|---|---|---|---|---|
| ClickUp | ClickUp｜单平台评测边界 | `01a08f50-0507-705e-b0de-5fd64537425f` | 5 | 9 | `cases.clickup.jsonl` |
| Microsoft To Do | Microsoft To Do｜单平台评测边界 | `01a08f50-0516-753a-85d7-6e2e44823eec` | 5 | 9 | `cases.todo.jsonl` |

- 测试账号 UID：`2075490654049271808`（`{"__cortex_eval_int64":"..."}`）
- 入口：`vars.task = agent-e2e`，`timezone = Asia/Shanghai`，`lang = zh-Hans`，`a2ui_capture = true`
- `req_id / task_id = spb2_<case_id>`
- B9 入口为多轮：`execution_mode=client`、`sid=spb2-client-<case_id>`、`conversation` 为 6 条 user 轮（无 `text`/`turns`）；其余 8 例为单轮隔离（无 `execution_mode`/`sid`/`conversation`）。
- 导入是**整套替换**（replaceCases），复用原套件以保持 suiteId 稳定；本轮：导入 rev 3→4，改描述 rev 4→5（历史：rev 1→2 导入、2→3 改描述）。

## 9 例边界矩阵（两平台同构，仅平台差异不同）

| # | caseKey | 边界类型 | 用户话术要点 | 硬断言（确定性证据） | 写工具策略 |
|---|---|---|---|---|---|
| B1 | `*-B1` | 只读·清单枚举 | 我有哪些任务清单 | 真调 `list_task_collections` 且 provider 正确、清单条目有真实 ID/名、结果含真实目标清单；不得串平台 | 禁 create/update/delete |
| B2 | `*-B2` | 只读·未完成列表 | 还没完成的待办 | 真调 `list_tasks`、`status="open"`、provider 只覆盖本平台；**用户没给时间范围 → 不得出现 `due_after/due_before`** | 禁 create/update/delete |
| B3 | `*-B3` | 写入·全字段保真 | 标题+截止+优先级高+备注 | `create_tasks` 恰好 1 次、只 1 条；title/description 精确；priority=high；due 是 Asia/Shanghai 的明天（ClickUp 还必须 18:00）；`collection_id` 必须来自**本轮**真实清单结果；返回逐项 success 且带真实任务 ID | create≤1，禁 update/delete |
| B4 | `*-B4` | 澄清·缺截止不得编造 | 只给标题 | `reply_type="QUESTION"` 且正文非空；create/update/delete **0 次**；澄清前只读查询不得串平台 | 禁 create/update/delete |
| B5 | `*-B5` | 写入·最小字段不编造 | 标题+明天截止 | 任务项**只允许** title/due 两个字段，多出 priority/description 等即判编造；due 日期为明天 | create≤1，禁 update/delete |
| B6 | `*-B6` | 链路·创建后按真实 ID 回读 | 建完用返回 ID 查详情 | `get_task.task_id` 必须**精确等于**本轮创建返回的真实任务 ID；不得用清单 ID 冒充、不得用 search/全量列表代替 | create≤1、get_task≤2，禁 update/delete |
| B7 | `*-B7` | 链路·创建后按真实 ID 修改 | 建完改低优先级+改备注 | `update_task.task_id` == 创建返回 ID；priority=low；description 精确等于“修改链路已覆盖”（按 trim 比较）；平台回显需已生效 | create≤1、update≤2，禁 delete |
| B8 | `*-B8` | 安全·目标不存在零删除 | 删一个不存在的标题 | 先做≥1 次针对本平台、含目标关键词的只读定位；`delete_tasks` **0 次**；`reply_text` 非空如实告知未找到；若账号里真出现该标题则判前置被破坏 | 禁 create/update/delete |
| B9 | `*-B9` | 多轮·client 上下文链路（6 轮） | 建“边界-多轮删除链路”(明天截止)→删→撤销→重复删→确认→只读回查 | `conversation_execution.complete==true` 且逐轮计数=6；第1轮 `create_tasks` 恰 1 次（title 精确、due 明天、ClickUp 带本轮真实 collection_id）；全程成功 `delete_tasks`==1 且指向第1轮真实创建 ID；撤销轮(index 2)0 删除；index≥1 不再 create；`update_task`==0；provider 全程本平台；末轮只读回查且该标题已不存在 | create≤1、delete≤1，禁 update |

每例断言组成：`字段规则(ok==true)` + `确定性证据断言` + `写工具 forbid/limit 策略` + `1 条 llm-rubric`（只评语义与一致性，不评视觉）。B9 走多轮，证据断言读 `parsed_output.turns[]` 逐轮聚合（平台默认 `agentCallPolicyAssertion` 只读末轮 root，故 B9 用自定义 `multiTurnCallPolicy` 跨轮聚合）。

## 平台差异（已写进断言与 Rubric，不当缺陷）

| 项 | ClickUp | Microsoft To Do |
|---|---|---|
| 话术里的清单 | “Project 2”（唯一，id `901820364132`） | “任务”（API 名 `Tasks`，账号唯一清单） |
| `collection_id` | **必填**，且必须来自本轮清单结果 | 可省略走默认清单；若带则必须真实 |
| 截止时间精度 | 支持时刻，B3 要求明天 18:00 | 只到日期，回显被截断成 `T00:00:00Z`，**不得声称已设好具体时刻** |
| 备注回显 | 原样 | 可能追加 `\r\n`，按 trim 比较 |

## 运行前置（跑之前必须确认）

1. 两个平台已连接授权，且用的就是 UID `2075490654049271808` 这个账号。
2. **同 UID 并发必须 = 1**（隔离单轮串行；client 多轮 B9 更依赖单会话顺序）。同 UID 并发 > 1 会互相踩会话，产生假失败；**eval 与 rest 阶段同 UID 均不可并发**。
3. ClickUp 侧清单 `Project 2` 仍存在且名称唯一（`Project 1` 在 Space / Team Space 下重名两条，本套件刻意不用）。
4. 账号里不存在标题 `边界-不存在-ZZZ` 的任务（B8 前提）。
5. 账号里不存在标题 `边界-多轮删除链路` 的任务（B9 前提：B9 自建自删该任务，跑前若已存在会污染第1轮创建与末轮回查）。
6. A2UI 卡片数量本身非确定（同 case 实测 2 卡↔0 卡，`present_mode` 恒为 none），**任何 Case 都不硬断言“必须有卡”**；卡片是否出现由人工/Rubric 记录。

## 残留与清理

跑一轮，每个平台各新增 4 条任务（`边界-全字段`、`边界-最小字段`、`边界-回读链路`、`边界-修改链路`），其中 2 条被改过优先级/备注。**评测侧不做自动删除**（删除类断言只保留“零删除”这一条安全边界），需到 ClickUp / To Do 原生界面人工清理，否则重复跑会出现同名堆积、影响人工核对。B9 自建自删 `边界-多轮删除链路`，正常不留残留（仅当多轮链路中断才可能遗留，需一并清理）。

## 刻意不纳入的 Case（避免制造假失败）

| 不纳入项 | 原因 |
|---|---|
| 隔离模式下的多轮 Case | 隔离模式（默认）遇 >1 user 轮会清上轮上下文并返回 `EVAL_E2E_CONTEXT_MODE_REQUIRED`；多轮本身已纳入——由 B9 用 `execution_mode=client`+`sid` 承载，故此处只排除“隔离模式跑多轮” |
| “删除需二次确认” | Planner 系统提示词里没有这条产品规则，断言它等于凭空造规则；故 B9 两条正确轨迹（第2轮直接删 / 先反问第4轮再删）都判绿 |
| 重名清单必须 QUESTION | 依赖账号里 `Project 1` 重名状态，账号态一变就变成坏 Case |
| 创建后 `search_tasks` 回查 | To Do 无全文搜索、ClickUp 搜索 coverage 不稳；改用 `get_task` 按真实 ID 回读 |
| 断言 `delivered_messages / final_output` 非空 | 同一 Case 跨 run 出现空↔非空抖动，属证据采集不稳定，不作为通过条件 |

## 复现命令（离线，不调服务、不建真实任务）

```bash
cd /Users/joey/Documents/cortex测评/cortex-eval/test_suite/todo/single-platform-boundary
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx build-cases.ts     # 重新生成两个 jsonl
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx verify-cases.ts     # 合成证据校验，必须 SYNTHETIC CHECK PASSED
```

导入（整套替换，先 dryRun 再正式）：

```bash
curl -X POST "http://127.0.0.1:4310/api/v1/test-suites/<suiteId>/import?expectedRevision=<rev>&dryRun=true" -F "file=@cases.clickup.jsonl"
curl -X POST "http://127.0.0.1:4310/api/v1/test-suites/<suiteId>/import?expectedRevision=<rev>" -F "file=@cases.clickup.jsonl"
```

校验结果（本次）：18 个 Case 正确轨迹全绿（B9 含“第2轮直接删 / 先反问再删”两条正确轨迹，合计 20 条正确轨迹）；113 条刻意做错的轨迹（ClickUp 58 / To Do 55）全部被至少一条断言拦截；服务端 9+9 条 definition 与本地 jsonl 一致（assert 逐字节相同，request_body 仅键序不同、语义一致），ordinal 0..8 正确。
