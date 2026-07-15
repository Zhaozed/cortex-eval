# Web Analysis

## 模块职责

该 Feature 发起 Case 分析，展示分类、证据、解释、建议和模型自评 Confidence，并完成拒绝、接受或编辑后接受闭环。

模块不调用模型、不校验 Proposal 业务契约、不直接写 Test Case。

## 边界与依赖

页面依赖 Case Analysis Application API，并通过 Test Suites Feature 进入统一 Case 编辑流程。

## 实现状态

P9 已完成 `/runs/:runId/analysis`，冲突刷新、Case/配置完整 Cursor 分页以及新 Proposal 与旧冲突 Draft 独立展示均已通过完整门禁和独立变更复审。

## 目标代码落点

`apps/web/src/features/analysis`

## 当前代码事实入口

- [analysis-page.tsx](../../apps/web/src/features/analysis/analysis-page.tsx)：选择、启动、当前版本、结构化 Evidence 和 Proposal 决策工作台。
- [run-api.ts](../../apps/web/src/lib/run-api.ts)：Analysis 启动、读取和三类决策的严格客户端契约。
- [web-route.ts](../../apps/web/src/lib/web-route.ts)：Analysis 路由解析。

## 当前样例与测试入口

- [analysis-page.test.tsx](../../apps/web/test/analysis-page.test.tsx)：启动、结构化 Evidence、完整身份、严格编辑和冲突保留。
- [run-api.test.ts](../../apps/web/test/run-api.test.ts)：五个 Analysis 操作及身份校验。
- [run-rest.spec.ts](../../apps/web/e2e/run-rest.spec.ts)：真实离线 Report→Analysis 浏览器闭环。

## 对外接口

只有 Eval `FAIL` 或 `EVALUATION_ERROR` Case 可分析。`all` 表示全部可分析 Case，不包含 PASS、NOT_EVALUATED 或仅 REST Error。

用户显式选择 `failed | errors | all`、Analyzer、Analysis Prompt 和并发。页面展示脱敏输入范围、当前 Analysis 版本、四种固定分类、模型自评 Confidence、结构化 Evidence、Explanation、Recommended Action 和可选 Proposal。每项 Evidence 展示固定来源、`fieldPath` 或“整个来源”和结论；页面不解析字符串 Evidence，也不把结论反推为来源事实。

## 核心流程

发起分析后查询当前 Analysis。Case 列表通过服务端 Cursor 逐页追加；Analyzer 与 Analysis Prompt 同样遍历全部配置 Cursor 后提供选项，不假设任何第一页包含全集。任一已经使用的 Cursor 再次出现时停止继续读取，避免循环请求。存在 Proposal 时，用户拒绝、直接接受或进入编辑器修改后接受。重新分析替换当前展示结果。

## 状态、事务与幂等

页面展示 `PENDING`、`RUNNING`、`SUCCEEDED`、`ERROR` 和决策状态。提交决策携带 Analysis Revision；重复或过期提交由服务端拒绝或幂等收敛。决策冲突后立即重取服务端当前 Analysis，显示最新 Revision、Decision 和 Apply Status；编辑后接受的原始 Draft 按 Run/Case 作为独立只读事实保留，即使并发重新分析产生新的 Analysis ID，也不被最新 Proposal 覆盖。新 Analysis 的 `PENDING` Proposal 使用独立编辑状态，仍可拒绝、接受或编辑后接受；新 Analysis 无 Proposal 时，旧 Draft 也保持只读可见。

## 错误收敛

模型或结构错误展示稳定分析错误，不展示猜测结果。当前 Analysis 404 显示为未分析。Case、Prompt 或 Analyzer 已变化时展示冲突，并保留用户编辑内容，不自动合并。编辑后接受先严格解析 Proposal 判别联合，再携带可见 Suite/Case/Analysis/Result 身份提交。

## 观测与验收

Confidence 明确标为模型自评。一次只展示一个 Proposal。过期分析不能覆盖当前 Case，参数等价分类不描述为统计波动。

## 相关测试

当前测试覆盖分析发起、结构化 Evidence、Cursor 续页与循环停止、完整接受身份、严格 Proposal JSON、冲突后服务端终态刷新、新 Analysis ID 下的精确 Draft 保留、API 身份校验和真实离线 Report→Analysis 浏览器闭环。
