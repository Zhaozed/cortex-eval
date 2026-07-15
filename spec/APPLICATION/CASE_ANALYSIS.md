# Application Case Analysis

## 模块职责

该 Feature 负责分析输入构造、Prompt 冻结、模型调用协调、结构化输出保存、重新分析和建议应用。

模块不直接修改 Test Suite，不把模型 Confidence 当作统计概率，不从不完整文本猜测建议。

## 边界与依赖

Feature 依赖 Domain Analysis 规则、Run 与 Configuration 查询、Case Analysis Repository、Analysis Model Client、Transaction Manager 和 Test Suites 的统一 Case Definition Writer。

## 实现状态

P9 已完成。结构化输入/输出、版本 Hash、两遍有界 Engine、平台生命周期、当前 Analysis Repository、建议决策、API/Web/CLI、Work Package Writer/Importer 与显式离线 Pipeline 已通过完整门禁和独立变更复审。

## 目标代码落点

`packages/application/src/features/case-analysis`

## 当前代码事实入口

- [analysis-contracts.ts](../../packages/contracts/src/analysis-contracts.ts)：Analysis Input/Output、结构化 Evidence 与 Artifact 契约。
- [domain-analysis.ts](../../packages/domain/src/domain-analysis.ts)：Evidence、Proposal 与输出不变量。
- [frozen-analysis-engine.ts](../../packages/application/src/features/case-analysis/frozen-analysis-engine.ts)：选择、两遍对账、并发与逐 Case 隔离。
- [case-analysis-decision-service.ts](../../packages/application/src/features/case-analysis/case-analysis-decision-service.ts)：拒绝、接受、编辑后接受和冲突保护。
- [platform-case-analysis-service.ts](../../packages/application/src/features/case-analysis/platform-case-analysis-service.ts)：平台当前 Analysis 生命周期、精确所有权恢复和批次汇总。
- [frozen-analyzer-model-client.ts](../../packages/evaluation-adapters/src/frozen-analyzer-model-client.ts)：直接 Analyzer 官方 SDK 边界。
- [sqlite-case-analysis-repository.ts](../../packages/storage-sqlite/src/sqlite-case-analysis-repository.ts)：当前 Analysis CAS、恢复与决策持久化。

## 当前样例与测试入口

- [packages/domain/test](../../packages/domain/test)：输出、Proposal、状态机与 Hash。
- [packages/application/test](../../packages/application/test)：输入、Engine、Proposal 应用与决策协调。
- [packages/evaluation-adapters/test](../../packages/evaluation-adapters/test)：双官方 SDK、结构输出、取消与无重试。
- [packages/storage-sqlite/test](../../packages/storage-sqlite/test)：Migration、当前 Analysis CAS、恢复与决策。

## 对外接口

Use Case 覆盖 Start Analysis、Get Current Analysis、重新 Analysis、Reject Proposal、Accept Proposal 和 Edit And Accept Proposal。HTTP 对应 `POST /api/v1/runs/:runId/analyses`、`GET /api/v1/runs/:runId/analyses/:caseKey` 及三个 Proposal 决策动作；Web 对应 `/runs/:runId/analysis`。

## 核心流程

发起分析时读取完整报告 Case、Analyzer 和 Analysis Prompt，构造脱敏版本化 Analysis Input，并计算输入身份。模型调用在事务外执行；Analysis Adapter 边界使用 Contracts 校验外部输出并映射为核心类型，Application 只接收已验证核心结果。应用建议时锁定 Analysis，校验 Revision、Final Result、Base Definition 和 Prompt 引用，再调用 Case Definition Writer。

Engine 对每个模型调用只等待模型结果、取消或 Sink 失败三者中的确定结果。取消和 Sink 失败先触发 Abort，再及时收敛 Engine 自己持有的工作；如果外部 SDK 忽略 Abort 且 Promise 永不结束，不继续等待该不可强杀 Promise，也不把它声明为已经回收。协作式 Adapter 仍负责关闭自身网络资源。

只有 Eval `FAIL` 或 `EVALUATION_ERROR` 可发起分析。输出 Confidence 范围为 0–1。Evidence 是非空结构化数组；每项使用固定来源、必填的 RFC 6901 `fieldPath` 或 `null`、非空 `conclusion`。字符串 Evidence、未知来源和非法路径整体拒绝，不做兼容转换。一次最多保存一个 Proposal；重新分析递增 Revision、覆盖当前内容并清除旧决策。

每次 Analysis 请求接受并冻结 `AnalysisExecutionLimitsV1`，默认并发 1、范围 1–8。冻结值进入 Analysis Input Identity 和 Hash；重新分析可以选择新限制并形成新输入身份，不修改原 Run Context。

## 状态、事务与幂等

Analysis Status 为 `PENDING`、`RUNNING`、`SUCCEEDED` 或 `ERROR`。Decision 和 Apply Status 按 Proposal 是否存在及用户决策转换。每次平台调用生成新的 Analysis ID、Input Hash 与 Result Hash；重新分析通过 Revision 条件替换当前记录并清除旧决策，不保留历史行。并发请求只能恢复自己已抢占的 ID/Revision，不能把另一个请求的 `RUNNING` 记录改为 `ERROR`。Local Server 在开放请求前把进程崩溃遗留的 `PENDING/RUNNING` 统一恢复为 `ANALYSIS_INTERRUPTED/ERROR`，避免当前行永久阻塞重新分析或导入。

相同 Analysis Input Hash 和 Result Hash 导入幂等；相同输入但不同输出冲突；不同输入按当前 Analysis Revision 替换。导入按显式 Package、Execution、Analysis Artifact、Analysis Result Set、Final Case Result 和 Case Key 身份对账，不使用 `select max`。一次分析最多一个 Proposal。

## 错误收敛

模型或 Schema 失败保存 `ERROR/NO_PROPOSAL/NOT_APPLICABLE`。离线 Analysis 在阶段认领前取消不修改阶段，认领后取消保存 `ANALYSIS_CANCELLED/ERROR`；CLI 对两者都返回 130。Artifact 错误只接收闭合 Error Code；离线携带的错误文案不是平台事实，导入时由覆盖 Analyzer Case 与平台 Analysis 错误的同一解析器按 Error Code 重建。Case、Prompt、Analyzer、目标 Assertion 或输入身份变化保存 `CONFLICT`，不自动合并或部分应用。

## 观测与验收

日志记录 Run ID、Case Key、Revision、分类、状态和 Error Code，不记录完整分析输入。验收要求四种分类固定、过期建议不可覆盖、无 Proposal 时不可应用。

## 相关测试

目标测试覆盖输入 Hash、Prompt 变量、模型失败、输出 Schema、Revision 竞争、四种分类、四类 Proposal、拒绝、接受、编辑后接受和冲突。
