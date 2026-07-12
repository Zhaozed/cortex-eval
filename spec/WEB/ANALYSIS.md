# Web Analysis

## 模块职责

该 Feature 发起 Case 分析，展示分类、证据、解释、建议和模型自评 Confidence，并完成拒绝、接受或编辑后接受闭环。

模块不调用模型、不校验 Proposal 业务契约、不直接写 Test Case。

## 边界与依赖

页面依赖 Case Analysis Application API，并通过 Test Suites Feature 进入统一 Case 编辑流程。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`apps/web/src/features/analysis`

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

当前仓库没有 Case Analysis Fixture 或测试。

## 对外接口

只有 Eval `FAIL` 或 `EVALUATION_ERROR` Case 可分析。`all` 表示全部可分析 Case，不包含 PASS、NOT_EVALUATED 或仅 REST Error。

用户选择失败或评估错误 Case、Analyzer 和 Analysis Prompt。页面展示脱敏输入范围、四种固定分类、Confidence、Evidence、Explanation、Recommended Action 和可选 Proposal。

## 核心流程

发起分析后查询当前 Analysis。存在 Proposal 时，用户拒绝、直接接受或进入编辑器修改后接受。重新分析替换当前展示结果。

## 状态、事务与幂等

页面展示 `PENDING`、`RUNNING`、`SUCCEEDED`、`ERROR` 和决策状态。提交决策携带 Analysis Revision；重复或过期提交由服务端拒绝或幂等收敛。

## 错误收敛

模型或结构错误展示稳定分析错误，不展示猜测结果。Case、Prompt 或 Analyzer 已变化时展示冲突，并保留用户编辑内容，不自动合并。

## 观测与验收

Confidence 明确标为模型自评。一次只展示一个 Proposal。过期分析不能覆盖当前 Case，参数等价分类不描述为统计波动。

## 相关测试

目标测试覆盖分析发起、四种分类、无 Proposal、模型错误、重新分析、拒绝、接受、编辑后接受和冲突保留。
