# Reporting

## 模块职责

Reporting 提供纯报告聚合、解释性 JSON Schema Diff 和 Markdown Renderer。Importer 在规范化阶段调用 Diff 纯函数并把结果纳入 Eval Result Hash；Report 构建只读取和校验已经规范化的 Diff。

模块是纯计算边界，不访问数据库、文件或网络，不读取 Raw Promptfoo，不回写 Eval Result。

## 边界与依赖

Reporting 只依赖 Domain 结果类型和 JSON Schema Diff 所需的纯计算库，不依赖 Contracts、Application、数据库、文件或网络。Promptfoo Importer 调用 Diff 纯函数，Runs Application 调用报告聚合与 Renderer；边界 Mapper 再把 Domain Report Model 转换为 Contracts Report DTO。

## 实现状态

目标 Package 尚未落地。当前仓库存在 Promptfoo 原始结果 Fixture，但没有目标规范化 Reporting 实现。

## 目标代码落点

`packages/reporting`

## 当前代码事实入口

尚无当前 Reporting 代码入口。

## 当前样例与测试入口

- `test_suite/current/eval_result/result.json`：当前未跟踪 Promptfoo 原始结果 Fixture。
- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)

## 对外接口

纯函数接收完整规范化明细和冻结运行上下文，返回 Domain Report Model 或对账错误。Markdown Renderer 只接收已验证 Domain Report Model。

## 核心流程

Importer 在 Eval 规范化阶段调用 Diff 纯函数，并在 Diff、Metric 与 Assertion 事实稳定后计算 Eval Result Hash 和 Final Case Result Hash。

Report 构建先验证每个冻结 Case 的 REST、Eval 和既有 Diff 事实，再从明细计算 Case 计数、整体有效通过率、已评估通过率、覆盖率和 By Metric，最后生成 Result Set Hash 与 Domain Report Model。Report 构建不得重新生成或回写 Diff。

Diff 纯函数使用锁定版本 Validator，基于冻结 Schema 和 Provider Output 生成 Instance Path、Schema Path、Keyword、Expected Constraint、Actual Value 或 Missing、Reason。Diff 只解释 Promptfoo 失败，不改变评估状态。

Markdown 单向呈现总体、Metric、失败 Case、Diff 和 Rubric Reason，不能反向解析为平台事实。

## 状态、事务与幂等

Reporting 不执行事务。相同规范化输入和 Contract Version 必须生成相同统计与 Hash。分母为零时 Rate 为空。一条 Case 对同名 Metric 最多贡献一次。

## 错误收敛

明细缺失、计数、身份、Hash 或 Validator 对账失败时返回结构化错误，不生成完整报告。Validator 与 Promptfoo 判断不一致时保留 Promptfoo 状态并记录解释性差异 Error Code。

## 观测与验收

调用方记录 Run ID、Case 数、Metric 数、耗时、Result Set Hash 和 Error Code。验收要求 UI 与 CLI 对相同 DTO 一致、Markdown 可重新生成、千级报告满足性能要求。

## 相关测试

目标测试覆盖四种 Eval 状态、三个 Rate、空分母、Metric 优先级、同名去重、真实 JSON Schema 结构、Validator 差异、对账和 Markdown。
