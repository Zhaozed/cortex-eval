# P9：Case Analysis 闭环

## 状态与依赖

- 状态：`PENDING`
- 依赖：P8

## 目标

交付失败 Case 的模型分析、当前分析、建议决策和 Case 修改闭环，并完成 Work Package v1 的 Analysis 能力。

## 实现清单

- 仅允许 Eval FAIL/EVALUATION_ERROR；`all` 表示全部可分析 Case。
- 平台 Analysis 请求接受并冻结 `AnalysisExecutionLimitsV1`，默认 1、范围 1–8，进入 Analysis Input Identity；离线使用 Execution 创建时冻结值。
- 构造版本化脱敏 Analysis Input、Prompt Hash、Analyzer Config Hash 和 Final Result Hash。
- Gemini/OpenAI-compatible Analyzer 复用统一 SDK Adapter，不经 Evaluator Bridge；严格 JSON Schema/JSON Object 输出。
- 实现四种分类、0–1 Confidence、非空结构化 Evidence、Explanation、Recommended Action 和单个 Proposal。
- 实现当前 Analysis Revision、重新分析覆盖、拒绝、接受、编辑后接受和冲突保护。
- 通过 CaseDefinitionWriter 应用建议，可接受可信可执行 Assertion，但必须完整校验。
- 注册 Analyze API、Web、CLI、Work Package Writer/Importer 和显式 Selector。
- 把 Analysis 注册到离线 Pipeline：必须已有或同时选择 Report，必须提供 Analyzer、Analysis Prompt 和 `failed | errors | all` Selector，不自动补跑缺失依赖。

## TDD 与验证

- Stub 覆盖输出 Schema、分类、Evidence、Proposal、取消、无重试和资源回收。
- 覆盖 Case/Prompt/Analyzer/Result 漂移、Revision 竞争、无 Proposal 和可执行 Assertion Proposal。
- 使用 P7 Golden Package 不修改 Manifest 完成 Report/Analyze 并成功导入。
- 验证 P7 已有 REST/Eval Execution 只能追加尚未完成 Artifact，不能覆盖已完成阶段。
- 覆盖 Pipeline 缺少 Report/Analyzer/Prompt/Selector、无可分析 Case、Analysis 失败退出码 3，以及失败不改变已完成 Report JSON/Markdown/Hash。
- 验证 Analysis 并发默认 1、范围 1–8、最大在途数、冻结后不可修改和平台/CLI 一致。

## Spec 更新

- `spec/APPLICATION/CASE_ANALYSIS.md`
- `spec/APPLICATION/EXECUTION_IMPORTS.md`
- `spec/WEB/ANALYSIS.md`
- `spec/PACKAGES/EVALUATION_ADAPTERS.md`
- `spec/SYSTEM_FLOWS.md`
- `spec/ERROR_HANDLING.md`

## 完成标准

- 过期分析不能覆盖当前 Case，不自动 Rebase。
- 重新分析只保留当前事实并递增 Revision。
- Analyzer 单次请求无自动重试。
- 离线 Pipeline 可以显式完成 Analysis，且 Analysis 失败不破坏 Report 事实。

## 阻塞条件

模型输出不符合 Schema 时保存稳定分析错误，不从残缺文本猜测分类或 Proposal。
