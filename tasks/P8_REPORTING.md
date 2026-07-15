# P8：Reporting 闭环

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P7

## 目标

从规范化结果生成可对账 JSON 报告、Markdown 和完整 UI/CLI 报告流程，且不依赖 Raw Evidence。

## 实现清单

- 实现整体有效通过率、已评估通过率、覆盖率、Error/Not Evaluated 和 By Metric 聚合。
- 一条 Case 对同名 Metric 最多贡献一次；空分母保持空值。
- 复用 P6 已生成并纳入 Eval Result Hash 的 Ajv JSON Schema 2020-12 Diff；P8 只映射、统计和展示，不重新计算或改写。
- 生成 Report JSON、Result Set Hash 和单向 Markdown。
- 注册 Report API、Web、CLI 和 Work Package Artifact Writer；Pipeline 扩展到 Report。
- 完成 Execution Import 的 Report 明细重算与对账，并注册 `result import` CLI/API；P9 再扩展可选 Analysis Import 分支。
- 注册平台 `RetryRunFailed`、`ForceRun` API 与 Web。只允许具有完整冻结上下文且不处于 READY/RUNNING 的来源 Run；展示 Source Run、Rerun Mode、复用数量和新 Run 链接。
- 实现报告分页过滤、Case/Assertion 详情、导出和 Evidence 存在/缺失/损坏展示。
- 为 Dashboard 注册最近完整报告的有效通过率、覆盖率和主要 Metric 指标卡，数据来自规范化 Report DTO。
- `result import` 成功后扩展最近运行 Dashboard、Run 列表来源标签和测试集最近运行状态，区分平台本地运行与离线导入。
- 保持 Case Assert 构建开放：覆盖 Promptfoo 全部 Assert 表示不限制 Case Assert 构建，不要求平台复现或限制 Assert 执行；Report 不调用或干预 Bridge。
- 显式区分 Run/Execution 执行版本、Evaluation 版本和 Report 版本；导入只使用 Execution/Package/Result Set Hash/Manifest 身份，不使用 `select max`、最大时间或最近记录推断。
- 离线导入始终保留冻结 Suite Snapshot；只有当前数据库存在同 ID Suite 时建立最近运行关联，不从名称或快照猜测。

## TDD 与验证

- 单元/属性测试覆盖统计、Metric 优先级、空分母、对账和 Hash。
- Fixture 测试覆盖 Const、Contains、Required、AllOf、Validator 不一致和 LLM Rubric。
- 验证 Raw 文件存在、缺失、损坏均不影响历史规范化报告。
- P8 使用 P7 Golden Package 追加 Report，不修改 Manifest。
- Playwright 验证真实离线 Report 导入后的最近运行、来源标签、报告指标和测试集最近运行状态。
- 端到端覆盖终态 `EVALUATION_ERROR`、来源缺少 Eval Artifact、新 REST 成功后补 Eval、REST 仍失败保持 NOT_EVALUATED、复用 Provenance、新 Result Set Hash、Force 全量执行和来源 Run 不变。
- 1,000 Case 报告与 Markdown 中位数不超过 5 秒。

## Spec 更新

- `spec/PACKAGES/REPORTING.md`
- `spec/WEB/REPORTS.md`
- `spec/EXTERNAL_BEHAVIOR.md`
- `spec/APPLICATION/RUNS.md`
- `spec/APPLICATION/EXECUTION_IMPORTS.md`
- `spec/TEST.md`
- `spec/SYSTEM_OVERVIEW.md`
- `spec/INTERNAL_BEHAVIOR.md`
- `spec/WEB/RUNS.md`
- `spec/WEB/TEST_SUITES.md`
- `spec/APPLICATION/TEST_SUITES.md`
- `spec/PACKAGES/STORAGE_SQLITE.md`
- `spec/PACKAGES/WORK_PACKAGE.md`
- `spec/ENTRYPOINTS/LOCAL_SERVER.md`
- `spec/ENTRYPOINTS/CLI.md`
- `spec/DECISION_LOG.md`

## 完成标准

- UI、CLI 对同一 Report DTO 统计一致。
- Markdown 不能反向成为导入事实。
- Dashboard 只在本阶段注册真实报告指标卡。

## 阻塞条件

对账失败不得生成伪造完整报告；保留已完成阶段事实和稳定错误。
