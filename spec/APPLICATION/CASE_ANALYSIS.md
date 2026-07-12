# Application Case Analysis

## 模块职责

该 Feature 负责分析输入构造、Prompt 冻结、模型调用协调、结构化输出保存、重新分析和建议应用。

模块不直接修改 Test Suite，不把模型 Confidence 当作统计概率，不从不完整文本猜测建议。

## 边界与依赖

Feature 依赖 Domain Analysis 规则、Run 与 Configuration 查询、Case Analysis Repository、Analysis Model Client、Transaction Manager 和 Test Suites 的统一 Case Definition Writer。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`packages/application/src/features/case-analysis`

## 当前代码事实入口

尚无当前 Case Analysis 实现。

## 当前样例与测试入口

当前仓库没有 Analysis Prompt、模型输出或建议应用测试 Fixture。

## 对外接口

Use Case 覆盖 Start Analysis、Get Current Analysis、Retry Analysis、Reject Proposal、Accept Proposal 和 Edit And Accept Proposal。

## 核心流程

发起分析时读取完整报告 Case、Analyzer 和 Analysis Prompt，构造脱敏版本化 Analysis Input，并计算输入身份。模型调用在事务外执行；Analysis Adapter 边界使用 Contracts 校验外部输出并映射为核心类型，Application 只接收已验证核心结果。应用建议时锁定 Analysis，校验 Revision、Final Result、Base Definition 和 Prompt 引用，再调用 Case Definition Writer。

只有 Eval `FAIL` 或 `EVALUATION_ERROR` 可发起分析。输出 Confidence 范围为 0–1，Evidence 至少一项并包含来源、可选字段路径和结论。一次最多保存一个 Proposal；重新分析递增 Revision、覆盖当前内容并清除旧决策。

每次 Analysis 请求接受并冻结 `AnalysisExecutionLimitsV1`，默认并发 1、范围 1–8。冻结值进入 Analysis Input Identity 和 Hash；重新分析可以选择新限制并形成新输入身份，不修改原 Run Context。

## 状态、事务与幂等

Analysis Status 为 `PENDING`、`RUNNING`、`SUCCEEDED` 或 `ERROR`。Decision 和 Apply Status 按 Proposal 是否存在及用户决策转换。重新分析通过 Revision 条件更新并清除旧决策。

相同 Analysis Input Hash 导入幂等。一次分析最多一个 Proposal。

## 错误收敛

模型或 Schema 失败保存 `ERROR/NO_PROPOSAL/NOT_APPLICABLE`。Case、Prompt、Analyzer、目标 Assertion 或输入身份变化保存 `CONFLICT`，不自动合并或部分应用。

## 观测与验收

日志记录 Run ID、Case Key、Revision、分类、状态和 Error Code，不记录完整分析输入。验收要求四种分类固定、过期建议不可覆盖、无 Proposal 时不可应用。

## 相关测试

目标测试覆盖输入 Hash、Prompt 变量、模型失败、输出 Schema、Revision 竞争、四种分类、四类 Proposal、拒绝、接受、编辑后接受和冲突。
