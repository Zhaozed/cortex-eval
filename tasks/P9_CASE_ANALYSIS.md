# P9：Case Analysis 闭环

## 状态与依赖

- 状态：`COMPLETED`
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

## 当前进展

- 已完成 Analysis Contracts、Domain、输入与结果 Hash、两遍有界 Engine、Gemini/OpenAI-compatible 官方 SDK Adapter、SQLite 当前 Analysis Migration/Repository，以及拒绝、接受、编辑后接受的原子 Case Writer 协调。
- Evidence 已冻结为结构化对象数组。每项必须包含固定 `source`、必填 `fieldPath: string | null` 和非空 `conclusion`；字符串 Evidence 不兼容、不保存、不猜测转换。
- 已注册平台 Analysis 启动、当前结果、拒绝、接受、编辑后接受 API/OpenAPI，以及 Execution Analysis Import；并发启动冲突不会恢复或覆盖其他请求持有的 `RUNNING` 版本。
- 已注册 Web `/runs/:runId/analysis`，使用 Cursor 续页展示全部可分析 Case；Proposal 冲突后重取服务端当前版本与终态，保留并锁定用户编辑文本，不自动 Rebase。
- 已注册 `analyze run`、`result import --type analysis` 和显式 `pipeline run --analysis-selector failed | errors | all`。默认 Pipeline 仍止于 Report，不隐式执行 Analysis。
- 已在不修改 Manifest v1 的前提下完成 Analysis Artifact 流式 Writer、严格 Reader/Importer、平台原子导入和真实离线 Report→Analysis 浏览器闭环。
- Analysis Import 在主库写事务外把完整 Case 流写入 owner-only SQLite staging；最终短事务只做确定性依赖/冲突校验、集合写入和导入身份提交，Busy 重试复用已完成 staging。
- Analyzer 取消和结果 Sink 失败采用有界竞速；即使外部 SDK 忽略 Abort 且 Promise 永不结束，Engine 自己持有的任务仍按稳定错误及时收敛，不把不可强杀的外部 Promise 当作清理完成。
- Analysis Artifact Error Code 使用闭合枚举，错误文案有长度上限；平台导入忽略 Artifact 文案并按 Error Code 从平台消息资源重建。SQLite Mapper 重算 Result Hash，并与数据库触发器共同拒绝非法状态组合。
- Local Server 在开放请求前把崩溃遗留的 Analysis 恢复为 `ANALYSIS_INTERRUPTED/ERROR`；Analyzer Case 与平台 Analysis 错误共用组合消息解析器。
- 离线 Analysis 在阶段认领前取消保持 `PENDING/REQUEST_ABORTED`，认领后保存 `ANALYSIS_CANCELLED/ERROR`，CLI 均映射为 130；Web 遍历 Analyzer 与 Analysis Prompt 的完整配置 Cursor。
- Gemini 与 OpenAI-compatible Analyzer 按冻结配置精确区分 `JSON_SCHEMA` 和 `JSON_OBJECT`；Web 对 Case Cursor 循环停止续读，并在并发重新分析产生新 ID 时仍按 Case 保留冲突 Draft。
- 冲突 Draft 与新 Analysis Proposal 分离：旧 Draft 始终只读保留；新 Analysis 为 `PENDING` 且含 Proposal 时仍可独立编辑、拒绝或接受；新 Analysis 无 Proposal 时旧 Draft 也不消失。
- macOS ARM64 上完整 `pnpm verify` 通过：198 个测试文件、1150 个测试；Statements 90.08%（12333/13690）、Branches 85.23%（8197/9617）、Functions 92.51%（2596/2806）、Lines 93.36%（11452/12266）；Playwright 8 通过、1 按设计跳过；Python 7 通过；格式、Lint、架构、类型、OpenAPI、文档链接、Secret Scan、ARM64 Native 与 Web Build 全部通过。
- 最终独立变更复审通过，P0/P1/P2/P3 均无问题。

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
