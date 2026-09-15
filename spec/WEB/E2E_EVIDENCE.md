# E2E 多轮证据展示

## 职责与边界

Run 工作区将已执行对话轮次与输入、回复、Trace、Token 和 A2UI 卡片关联，保留原始证据。展示投影不改变 Provider Output、断言输入、Artifact 或历史 Hash，不生成不存在的逐轮 PASS/FAIL。

`ok=false` 可以保留部分执行证据，但仍属于业务执行异常；HTTP 200 与证据存在都不等于业务通过。未执行轮次不能作为已执行结果展示。

## 代码入口

- [e2e-evidence.ts](../../packages/contracts/src/e2e-evidence.ts)：单轮与多轮读取、展示展平和采集完整性判断。
- [run-output-model.ts](../../apps/web/src/features/runs/run-output-model.ts)：轮次、输入、回复与交付证据映射。
- [run-case-rounds.tsx](../../apps/web/src/features/runs/run-case-rounds.tsx)：按轮次展示输入、回复、卡片和链路跳转。
- [run-trace-analysis-model.ts](../../apps/web/src/features/runs/run-trace-analysis-model.ts)：Trace 与分析证据锚点。
- [run-card-replay-model.ts](../../apps/web/src/features/runs/run-card-replay-model.ts)：出站 A2UI 帧到回放卡片映射。
- [run-progress-model.ts](../../apps/web/src/features/runs/run-progress-model.ts)：执行阶段计数、耗时与吞吐估算。
- [run-execution-issue.ts](../../apps/web/src/features/runs/run-execution-issue.ts)：执行异常与部分失败的用户提示。

## 展示语义

原始 `turns` 是多轮顺序来源。展示投影为跨轮集合附加 `_eval_turn_index` 并保留请求身份；Trace、工具调用、模型调用和卡片不能因跨轮聚合而丢失来源。缺少历史采集元数据保持未知，已明确不完整的采集如实提示。

按轮次展示优先区分已交付回复与仅见于生成记录的内容。生成记录不能冒充用户已收到；输入与执行轮次无法配对时明确提示，不猜测对应关系。用户可查看每轮原始 JSON 和完整原始记录。

多轮界面的轮次用于证据定位，不等于每轮都有独立断言结论。`docs/attribution-bridge-2026-09-14.md` 仍是设计稿，其完整归属算法不作为已实现承诺。

阶段进度来自 Run 的持久状态和完成计数，不用墙钟时间伪造完成度。剩余时间只在 REST 运行中按已完成吞吐估算，不能表示服务端承诺。

## 人工结论边界

人工结论遵循 [RUNS](RUNS.md) 的现行规则：执行成功的 Case 可覆盖自动评测结论，覆盖需归因和说明；执行失败不能被人工通过改写为成功。无卡、采集不完整与渲染不可用必须分别展示，不把缺证据自动解释为质量失败或通过。

## 验收与测试入口

- [E2E 证据测试](../../packages/contracts/test/e2e-evidence.test.ts)：单轮、多轮、顺序和完整性语义。
- [输出模型测试](../../apps/web/test/run-case-output.test.ts)：部分失败、轮次输入与回复交付区分。
- [抽屉测试](../../apps/web/test/run-case-drawer.test.tsx)：多轮视图、原始证据和复核边界。
- [Trace 工作区测试](../../apps/web/test/run-trace-workspace.test.tsx)：轮次定位与证据可见性。
- [卡片回放测试](../../apps/web/test/run-card-replay-model.test.ts)：真实出站卡片与来源保留。
- [阶段进度测试](../../apps/web/test/run-progress-model.test.ts)：持久阶段计数、计时与估算。
- [执行异常测试](../../apps/web/test/run-execution-issue.test.ts)：传输异常与 Provider 业务失败区分。
