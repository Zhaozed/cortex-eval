# 真实 A2UI 采集与渲染验证

执行日志时间：2026-09-11 00:04–00:12（Asia/Shanghai，本机日志）。

## 结论

本次两个真实只读请求、共三轮执行，A2UI 采集与前端渲染验证通过。
这不是 HTTP 200 检查：核对了请求结束标志、实际查询工具终态、原始 Redis 出站记录、A2UI 内容数量，以及平台渲染器的可见输出。

| 场景 | 执行模式 | 实际耗时 | 轮次 | 原始出站记录 | A2UI payload |
|---|---|---:|---:|---:|---:|
| Microsoft To Do 清单查询 | isolated | 17.56 秒 | 1 | 2 | 2 |
| 清单查询 → 不限截止日期的未完成任务查询 | client | 24.65 秒 | 2 | 5 | 4 |

共 6 份 A2UI payload：3 份工具执行提示卡、3 份查询结果卡，不是 6 份独立业务结果。

## 证据

- 三轮 `execution_ready=true`，出站采集均为 `COLLECTED`，均观察到 `is_req_end=1`。
- 两轮请求 `expected_turns=observed_turns=completed_turns=2`，`complete=true`。
- 直接对这三轮已观察到的候选 Redis 流执行只读 XRANGE，与入口保存记录逐项比较：7 条出站记录一致，缺失 0、额外 0；6 份 A2UI 内容一致。
- 三轮 A2UI 结构校验均无 error、无 validator error。
- 实际工具只有 `list_task_collections`、`list_tasks`，终态成功；没有任务创建、修改、删除调用。
- 第二轮查询工具结果有 25 条任务；A2UI 对应任务数组为 25 条，回复也说明 25 条。
- 保存了三轮回复、Trace，以及 9 次模型调用记录（每轮 Router 1 次、Planner 2 次，含每次已记录 usage/耗时）。审计自身的 completeness 仍是 UNKNOWN，不能宣称取得了所有底层审计信息或完整账单。

## 前端验证方式与结果

使用平台实际的 `outboundA2ui`、`cardReplayFrames` 和已运行的隔离渲染服务，将本次真实新采集 payload 按轮、按 surface 回放。

- 单轮 3 个回放视图、两轮 6 个回放视图，全部 READY 且有可见 surface。
- 9 个视图包括工具提示、结果卡和组合回放，不是 9 张不同业务卡。
- 浏览器 runtime/console 错误 0。
- 使用平台现有本地 Cortex 资源快照，未关闭 CSP，未回退其他环境资源。
- 这是生产渲染链路的诊断展示容器，不是新建 Run 后对整个抽屉的全流程验收；没有伪造评测结论写入平台数据库。
- 渲染成功不等于产品视觉审核批准。

验证脚本曾因诊断脚本自身的参数编码、浏览器回调序列化和独立渲染端口被 CSP 拦截而调整；入参错误均在入队前拒绝。最终使用平台既有允许的渲染服务验证通过，没有因此修改或放宽生产安全策略。

## 副作用与限制

- 本次真实执行两个入口请求，共三轮，有 Agent 模型用量；Judge 调用 0。
- 没有重跑原 20 Case，没有改原 Run；20 条 REST hash 与重评前基线一致。
- client 模式会写正常会话/执行记录并使用账号焦点；“只读”指待办业务操作，不代表完全不写内部日志或会话。
- 没有验收删除确认、跨 Case ID 传递、长链路失败恢复，也没有证明所有任务类型都能完整采集。
- Redis 比较覆盖本次观察到、仍保留的候选出站流；不证明未来瞬时换流、裁剪、超时场景绝不会丢帧。
- 历史 Run 已丢失的 A2UI 不会因本次验证恢复。

## 本机证据文件

目录：`/Users/joey/Documents/cortex测评/cortex-eval/.cortex-eval/tmp/diagnosis/live-capture-20260911/`

- `single-response.json`、`multi-response.json`：真实入口响应，包含个人任务数据，不提交 Git。
- `stream-verification.json`：逐轮原始流比对结果。
- `render-verification.json`：9 个回放视图及浏览器错误记录。
- `usage-summary.json`：已记录模型用量及旧 REST hash 校验结果。
- `single-render.png`、`multi-render.png`：诊断截图，仅作本次验证证据，不接回产品截图评测能力。
