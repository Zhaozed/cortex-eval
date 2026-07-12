# Web Reports

## 模块职责

该 Feature 展示完整运行报告、整体统计、By Metric、逐 Case 结果、Assertion 差异和冻结上下文。

模块不在前端重算报告，不从 Markdown 或 Raw Promptfoo 推导业务事实。

## 边界与依赖

页面只读取规范化 Report DTO。Diff 由 Importer 在 Eval 规范化阶段调用 Reporting 纯函数生成，报告阶段只读取和校验；统计由 Reporting 聚合并由 Application 提交。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`apps/web/src/features/reports`

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

- `test_suite/current/eval_result/result.json`：当前未跟踪 Promptfoo 结果 Fixture。
- [pf_config.yaml](../../test_suite/current/pf_config.yaml)

## 对外接口

页面支持按 REST 状态、Eval 状态、Metric、业务模块和场景标签过滤 Case，展示脱敏配置、运行来源和 Raw Evidence 是否存在。

Raw Evidence 缺失或 Hash 损坏时显示明确状态，但报告列表、统计和规范化明细仍可查看，不从 Raw 文件重新推导事实。

## 核心流程

用户打开完整报告，查看总体与 Metric 统计，进入 Case 和 Assertion 详情，并导出规范化报告。不完整运行只显示已完成阶段事实。

## 状态、事务与幂等

报告是只读事实。空分母 Rate 显示为空，Error、Skipped 和 Not Evaluated 单独展示。过滤不改变原统计和结果哈希。

## 错误收敛

报告缺失或对账未完成时不展示伪造 Summary。Raw Evidence 缺失只影响排障入口，不改变规范化事实。

## 观测与验收

同 Case 同 Metric 最多计数一次。`is-json` 展示路径、预期和实际；`llm-rubric` 展示 Pass、Score 和 Reason。UI 与 CLI 对相同报告保持一致。

## 相关测试

目标测试覆盖统计展示、空分母、过滤、Case 详情、Diff、脱敏上下文、不完整运行和导出。
