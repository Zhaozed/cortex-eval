# Web Reports

## 当前页面边界（2026-09-10）

- Run 只保留 `/runs/:id` 一个详情页。`/execution`、`/report`、`/analysis`、`/statistics` 仅作旧链接重定向，不得恢复独立页面或导航入口。
- 统计、冻结配置、Token 与 Case 列表同页；Case 抽屉只有结果详情和执行链路，A2UI 动态卡片在结果详情内。
- AI 分析是 Run / Case 抽屉内的显式批量操作；结果留在执行链路，AI 关联证据不等于确认根因，不改评测结论。底层报告、分析与导出 API 保留。
- 离线导入也进入统一详情，以保存的 Report 为证据来源；没有平台执行配置时不伪造启动、停止、重跑或耗时。
- 当前实现：`run-dashboard-page.tsx`、`run-imported-dashboard.tsx`（同页数据来源适配）、`run-analysis-control.tsx`、`run-case-drawer.tsx`。
- 当前验证：`run-unified-workspace.test.tsx`、路由测试和 `web-static-routes.test.ts`。

以下为历史阶段记录；其中独立 Report / Analysis 工作台、旧执行视图、截图审核列的描述不再代表当前 UI，不能据此重新添加页面。


## 模块职责

该 Feature 展示完整运行报告、整体统计、By Metric、逐 Case 结果、Assertion 差异和冻结上下文。

模块不在前端重算报告，不从 Markdown 或 Raw Promptfoo 推导业务事实。

## 边界与依赖

页面只读取规范化 Report DTO。Diff 由 Importer 在 Eval 规范化阶段调用 Reporting 纯函数生成，报告阶段只读取和校验；统计由 Reporting 聚合并由 Application 提交。

## 实现状态

P8 已落地平台与离线导入统一 Report 页面、Dashboard 报告指标、Run 来源标签、平台 Retry/Force 动作、服务端分页过滤、Case/Assertion/Diff 详情和 JSON 导出。

## 代码落点

`apps/web/src/features/reports`

## 当前代码事实入口

- [report-page.tsx](../../apps/web/src/features/reports/report-page.tsx)：统一 Report Overview、过滤、详情、Evidence 和导出。
- [dashboard-page.tsx](../../apps/web/src/features/dashboard/dashboard-page.tsx)：最近完整报告指标与最近运行。
- [run-detail-page.tsx](../../apps/web/src/features/runs/run-detail-page.tsx)：平台 Report 入口和 Retry/Force 版本动作。

## 当前样例与测试入口

- `test_suite/current/eval_result/test_example.json`：当前已提交 Promptfoo 结果 Fixture。
- [pf_config.yaml](../../test_suite/current/pf_config.yaml)

## 对外接口

页面支持按 REST 状态、Eval 状态、Metric、业务模块和场景标签过滤 Case，展示脱敏配置、运行来源和 Raw Evidence 是否存在。

Raw Evidence 缺失或 Hash 损坏时显示明确状态，但报告列表、统计和规范化明细仍可查看，不从 Raw 文件重新推导事实。

## 核心流程

用户打开完整报告，查看总体与 Metric 统计，进入 Case 和 Assertion 详情，并导出规范化报告。不完整运行只显示已完成阶段事实。

Dashboard 从最近完整报告 DTO 展示有效通过率、覆盖率和主要 Metric。主要 Metric 是 Reporting 已按 Metric 名称稳定排序后的第一项；没有 Metric 或分母为空时显示空值，不由 Web 猜测优先级。最近运行混合显示平台与离线导入来源，离线导入直接进入只读 Report；Test Suite 最近运行只在当前 Suite ID 关联存在时显示导入事实。

Dashboard 的最近报告查询身份同时包含 Run ID、Status、Stage 和 Updated At。同一 Run 从运行中推进到 `DONE` 时必须使此前的空结果或旧报告缓存失效并重新读取完整 Report，不得仅以 Run ID 维持缓存。

平台终态且冻结上下文完整的 Run 可创建 `RETRY_FAILED` 或 `FORCE` 新版本。页面展示来源 Run、模式、复用/执行数量和新 Run 链接；来源 Run 不修改。离线导入 Run 不提供可执行动作。

## 状态、事务与幂等

报告是只读版本事实。空分母 Rate 显示为空，Error、Skipped 和 Not Evaluated 单独展示。过滤不改变原统计和结果哈希。Raw Evidence 状态只来自 Artifact 检查，不触发重新评估或报告重算。

## 错误收敛

报告缺失或对账未完成时不展示伪造 Summary。Raw Evidence 缺失只影响排障入口，不改变规范化事实。

## 观测与验收

同 Case 同 Metric 最多计数一次。`is-json` 展示路径、预期和实际；`llm-rubric` 展示 Pass、Score 和 Reason。UI 与 CLI 对相同报告保持一致。

## 相关测试

组件测试覆盖统计展示、空分母、过滤、Case 详情、Diff、脱敏上下文、来源、重跑和导出。生产 Playwright 使用真实 Work Package Report、真实导入 API 和 SQLite，验证离线报告进入 Dashboard、Run 列表、Report 和 Test Suite 最近运行。

## A2UI 验收边界

固定回放已停用，仅保留只读历史，其唯一语义见 [A2UI_REVIEWS](../WEB/A2UI_REVIEWS.md)。不改变标准自动 Report、Artifact Manifest 或 Canonical Export。

## 结果优先交互

报告默认显示 Case 结果，统计与冻结上下文收进统计概览，平台来源提供执行与配置入口。REST 和 Evaluation 状态采用闭合选项，不再接收并静默丢弃任意状态文本。筛选仍由服务端执行，不改变原报告统计；无匹配 Case 显示空态。

A2UI 审核列置于 Evaluation 状态之后，未采集并绑定本 Case 实际执行截图时显示非交互的“未采集”，详情解释证据缺口。移除统计中的固定模板附件入口，不提供假绑定或假审核按钮。自动通过率不是人工验收率。

样式要求：长断言、Schema 与资源 ID 在详情抽屉内换行，不撑开网格、不隐藏证据；宽表局部横向滚动；筛选器、分页按钮和状态标记保持可读间距。
