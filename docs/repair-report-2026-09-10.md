# 评测平台与 Cortex 入口修复报告

日期：2026-09-10（Asia/Shanghai）

## 结论

本次检查确认的平台、入口及本地启动阻塞已修复并部署。平台可访问，Cortex readiness 为 RUNNING / ready=true。原 Run 的 20 条结果可以正常查看；有已保存卡片数据的 6 个 Case 均已在实际页面验证动态渲染。

**这不等于 20 个业务 Case 全部通过。** 历史缺失证据无法从仅重新评测中恢复；新的真实连续对话模式尚未做真实业务验收。没有为了通过率放宽历史预期。

2026-09-11 更新：本报告中“A2UI 审核”一行所述“部分证据可以查看，但不能批准整条 Case”已被取代。人工复核现为最高权限结论，无卡与部分证据同样允许人工定论，覆盖自动结论需归因与说明；执行失败仍不可覆盖。当前口径以 `spec/WEB/RUNS.md` 与 `spec/DECISION_LOG.md` 为准。

本轮修复及走查没有再次调用收费 Agent/Judge，也没有重跑真实待办 REST 或写操作。此前故障恢复阶段已执行过一次整批 Judge-only 重评，以下统计是数据库里保留的该次结果，不是模拟值。

## 一、已修复的问题

| 范围 | 确认的问题 | 修复结果 |
|---|---|---|
| Judge 错误处理 | 错误响应缺少 output/tokenUsage，解析器再次报错，掩盖原始故障 | 容错解析；调用异常保留为评测异常，不当成 Agent 质量不通过 |
| 结果持久化 | importer 保存的 EVALUATION_ERROR 原因与产物/SQLite 读取契约不一致 | 对齐契约，保留异常原因及已有分项结果，报告可以读取 |
| 批次恢复 | 单 Case 错误可能吞掉其他 Case 的成果 | REST 失败且无可用证据的 Case 不强行评测；保留其余有效结果，完成后可为“完成但有异常” |
| 报告恢复 | 报告生成失败时缺少独立恢复入口 | 同 Run 可重新生成报告，只复用已保存结果，不重调 Agent/Judge；使用阶段锁防止重复执行 |
| 部分执行证据 | 后续失败时已完成的输出被失败信封丢弃 | partial parsed output 贯通接口、存储、评测、报告和展示；缺失时不伪造字段 |
| 多轮采集 | 只保留末轮，无法证明取消、确认、删除等完整过程 | 逐轮保存输入、req_id、执行就绪状态、parsed_output；后轮失败保留前轮 |
| 多轮展示 | 回复/Trace/A2UI 只展示末轮，或聚合时重复末轮 | 统一逐轮展示投影；保留原始 JSON 对应路径，不修改历史评测原文 |
| A2UI 采集 | 以“短期数量不变”提前结束，真实出站卡片晚到而漏采 | 等待真实请求结束标志或有界时间预算；跨快照累积、按身份匹配、完整信封去重 |
| A2UI 数据投影 | root/delta 及删除重建缺少可靠处理 | 补齐投影；不支持的数组 delta 明确标记 projection_error，原始帧仍保留 |
| A2UI 审核 | 缺数据与加载失败混淆，部分卡片可能被当完整证据 | 区分未采集与渲染失败；部分证据可以查看，但不能批准整条 Case |
| 入口超时/断开 | Redis/队列/出站读取等待不受控；断开后仍可能继续投递后续轮 | 有界等待；断开取消等待及后续投递。已入队工具无法撤销，不承诺回滚 |
| 会话模式 | source=eval 使用隔离上下文，多句顺序发送不等于真实连续对话 | 新增显式 isolated/client 模式；隔离模式多轮在入队前拒绝，避免无效模型花费 |
| 表单与诊断 | 会话模式无法明确配置、字段重复入口、已知错误不易读 | 加入模式选项，避免重复字段；已知入口错误中文说明与原始错误码并存 |
| 其他平台问题 | 导出遗漏运行名称/描述；部分表单标签及灰字可读性不足 | 补齐导出字段、表单可访问名称，修复相关 CSS 对比度 |
| 本地环境 | 当前 Cortex 代码所需 PG 字段缺失，端口启动但服务未就绪 | 备份后仅补齐 13 个字段，原记录保持一致；重启后 ready=true |

### 多轮模式的使用边界

- `execution_mode=isolated` 为默认值，保留既有单轮隔离语义。
- isolated 收到多个 user 轮：返回 `EVAL_E2E_CONTEXT_MODE_REQUIRED`，不入队。
- `execution_mode=client` 走现有 STANDARD 会话语义，必须显式提供 uid、sid；否则返回 `EVAL_E2E_CLIENT_CONTEXT_REQUIRED`。
- 中间轮未观察到请求结束：返回 `EVAL_E2E_MULTI_TURN_INCOMPLETE`，保存已有证据，不继续下一轮。
- client 会使用真实上下文及焦点，并非新的隔离测试环境。**未自动修改现有测试集为 client，也未验证真实写操作多轮全部可用。**
- 新模式的单元测试及无副作用入参检查通过，不等于已解决所有真实 ResponseGate/focus 场景。

## 二、原 Run 的实际结果与逐 Case 分类

Run：`01a08aee-26b3-7610-861e-6d454cf25915`

测试集：待办｜双平台业务验收

| 总数 | 自动通过 | 自动未通过 | 评测异常 | 未评测 |
|---:|---:|---:|---:|---:|
| 20 | 4 | 5 | 10 | 1 |

运行状态为 `COMPLETED_WITH_ERRORS / DONE`，不是评测阶段没有运行。REST 记录 20 条，其中 1 条异常。20 条历史 REST hash 与重评前基线完全一致。

下表是依据已有记录的人工诊断汇总，不是自动改判；多个问题可能同时存在。

| Case | 保存的自动结论 | 原因/分类 | 下一步 |
|---|---|---|---|
| CU-01 | PASS | 自动检查通过 | 不能据此认定未保存的卡片视觉通过 |
| CU-02 | FAIL | 查到两个同名 Project 1，Agent 澄清而未创建；测试清单不唯一 | 明确目标清单身份，不能要求 Agent 随便选一个写入 |
| CU-03 | EVALUATION_ERROR | 历史多轮整例证据不足 | 下次以真实连续会话及逐轮证据验收 |
| CU-04 | FAIL | 搜索为空，前置创建未完成，缺目标 ID | 先修复前置数据依赖，不把空搜索本身误报为产品缺陷 |
| CU-05 | FAIL | 找不到目标，未实际 update_task | 同上，绑定创建资源身份 |
| CU-06 | EVALUATION_ERROR | 缺第一轮完成操作证据；已完成查询未找到目标 | 补可靠数据及完整逐轮执行记录 |
| CU-07 | EVALUATION_ERROR | 多轮证据不足，同时出现同名清单澄清、缺期望工具证据 | 清单唯一化，重新验收完整多轮 |
| CU-08 | EVALUATION_ERROR | 末轮空搜索不能证明前四轮删除、取消、确认正确 | 逐轮保留删除协议证据 |
| TD-01 | PASS | 自动检查通过 | 有视觉要求时仍需对应展示证据 |
| TD-02 | PASS | 自动检查通过，已有 A2UI 成功渲染 | 产品人工审核卡片 |
| TD-03 | EVALUATION_ERROR | 历史多轮整例证据不足 | 新记录补齐多轮证据 |
| TD-04 | FAIL | 找到任务且回复一致，但缺创建 ID 基线，无法证明为同一任务 | 补跨 Case 资源关联证据，不降低身份核对标准 |
| TD-05 | PASS | 自动检查通过 | 不由自动结论推断“更新后清单显示”视觉问题已修复 |
| TD-06 | EVALUATION_ERROR | 只有后续查询，缺第一轮完成操作证据 | 补多轮证据；已有卡片可独立人工查看 |
| TD-07 | EVALUATION_ERROR | 多轮证据不足，且 Rubric 调用 PROVIDER_REQUEST_FAILED | 区分证据阻断与 Judge 服务异常；仅重评无法补缺失执行 |
| TD-08 | EVALUATION_ERROR | 多轮证据不足，且 Rubric 调用 PROVIDER_REQUEST_FAILED | 同上；已有卡片渲染不证明删除流程通过 |
| MX-01 | EVALUATION_ERROR | “最近”验收规则未正式确定；还缺目标创建身份基线 | 确定产品时间窗口及目标数据；不能以 Judge 对默认窗口的描述代替产品契约 |
| MX-02 | FAIL | 两平台都执行搜索，To Do 有结果，ClickUp 为空；缺两个已创建资源 ID | 修复 ClickUp 前置创建及跨平台目标数据基线 |
| MX-03 | NOT_EVALUATED | 历史 REST PROVIDER_OUTPUT_INVALID，无可评测输出 | 旧丢失证据无法恢复；未来入口保留 partial，需重新执行才能获取新证据 |
| MX-04 | EVALUATION_ERROR | To Do 不支持时分时的降级规则未确定 | 先确认提醒/说明与日期保存规则，再编写确定性断言 |

8 条历史多轮 Case 的冻结规则显式报告 `EVIDENCE_INSUFFICIENT`；2 条产品规则报告 `ACCEPTANCE_RULE_UNDEFINED`。其中 TD-07、TD-08 还有独立 Judge 调用异常，不能合并称为单一原因。

## 三、A2UI 走查

- 原 Run：6 个 Case 有已保存 payload，14 个没有。缺 payload 不等于一定应该发卡，也不等于客户端资源加载失败；是否应该发卡依 Case 契约判断。
- 实际页面逐一动态渲染成功：TD-02、MX-04、CU-05、TD-04、TD-06、TD-08。
- TD-06 多项切换及重新加载验证成功。
- CU-01 未保存出站 A2UI 的提示验证正确；没有伪造卡片。
- 走查 runtime/console errors 为 0。
- **渲染成功不是视觉验收通过，仍由 UI/产品审核。旧记录缺少的卡片不会因仅重新评测而补回。**

## 四、验证记录

| 验证 | 实际结果 | 边界 |
|---|---|---|
| 平台测试 | 1521 通过，1 跳过 | 全量测试执行时的代码状态；随后变更另做针对性验证 |
| 最后新增/修改模块 | 11 通过 | 入口错误展示、Case 表单等 |
| Cortex E2E 单元测试 | 78 通过，2 条 warning | 无真实模型/写入验收；warning 为依赖弃用与 fixture 序列化提醒 |
| 桌面浏览器走查 | 5/5 通过 | 独立数据库/mock服务；Case/配置CRUD、自动流转、离线导入、性能 |
| 浏览器性能 | 最大约 902ms，低于 2.5s 阈值 | 该本地测试环境数据 |
| 原 Run 只读走查 | 报告 HTTP 200，20 条；MX-01 异常依据可查看；页面错误 0 | 使用真实历史数据，无收费重跑 |
| 真实 A2UI 展示 | 6/6 已有 payload 可动态渲染 | 不代表视觉审核通过 |
| 构建与静态检查 | TS、前端构建、架构/文档/OpenAPI、修改范围生产 TS lint、Cortex ruff、两仓 diff 检查通过 | 不声称所有既有测试代码的全仓 lint 都通过 |
| 入口无副作用检查 | 非法 JSON、isolated 多轮、client 缺身份均返回明确错误码 | 入队前校验，不触发业务调用 |
| 服务健康 | 平台 HTTP 200；Cortex RUNNING / ready=true | 交付时检查 |

离线详情仍有一个既有兼容行为：先探测平台 Run API，得到预期 404 后读取离线报告。浏览器测试只允许这个精确 URL 的预期日志，不放过其他 console 错误；离线报告读取通过。本期没有为消除这个探测重做接口。

日志保存在本机：
- `/tmp/eval-suite-complete.log`
- `/tmp/eval-final-extra-tests.log`
- `/tmp/eval-browser-final5.log`
- `/tmp/cortex-mode-tests-final.log`
- `/tmp/eval-real-report-final.log`
- `/tmp/eval-real-a2ui-final.log`

## 五、本地数据库修复与服务

重启时发现本地 schema 落后于当前 Cortex 工作区代码。确认本地数据库、检查连接后，先 pg_dump，再在事务内仅执行 `ADD COLUMN IF NOT EXISTS`，设置短锁等待与语句超时；没有 drop-first、清库或全量约束 repair。

补齐 13 列：
- cortex_rg_pending：expires_ts_ms
- cortex_tasks：proactive_fulfillment_context
- cortex_user_state：active_foreground_conv_row_id、active_foreground_req_id、calendar_scan_paused_until、daily_brief_waiting_for_online、online_deadline_at、presence_event_seq、presence_event_ts_ms、presence_status、prompt_language、question_slot_until、timezone_identity

改动前后原有字段的逐表记录数量及 JSON SHA256 一致。未重启共享 Redis/PG。

备份（含私人数据，权限 600，不应提交 Git）：
`/Users/joey/Documents/cortex测评/cortex-eval/.cortex-eval/tmp/diagnosis/local-cortex-before-column-repair-20260910.dump`

迁移证据：
`/Users/joey/Documents/cortex测评/cortex-eval/.cortex-eval/tmp/diagnosis/local-schema-repair-result.json`

已部署服务：
- 平台：`http://127.0.0.1:4310`，启动日志 `.cortex-eval/logs/restart-2026-09-10-repaired.log`
- Cortex：`http://127.0.0.1:8082`，健康路径 `/health/readiness`，启动日志 `/private/tmp/cortex-restart-20260910-repaired.log`

## 六、后续最小验收前提

1. 确定“最近”的日期窗口和 To Do 时分降级规则。
2. 明确唯一测试清单及资源 ID；不要让查询/修改依赖未成功的创建，也不要仅靠同名判定身份。
3. 需要真实连续对话时显式选择 client 模式及 uid/sid，确认上下文、焦点与可写范围，再小批验证；本轮没有代替用户运行写操作。
4. 对新逐轮证据重新设计多轮断言，去掉“暂不可用”的占位阻断必须有真实验收能力作为依据；不得修改历史冻结规则制造通过。
5. UI/产品审核已有卡片。若需补回原 Run 缺失卡片，只重评不够，必须产生新的执行证据；不覆盖历史。

没有将“完成报告”“服务 ready”“渲染成功”替代业务验收，没有自动批准人工复核，也没有宣称外部 Judge 供应商已不会再失败。
