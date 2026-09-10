# Reporting

## 模块职责

Reporting 提供纯报告聚合、解释性 JSON Schema Diff 和 Markdown Renderer。Importer 在规范化阶段调用 Diff 纯函数并把结果纳入 Eval Result Hash；Report 构建只读取和校验已经规范化的 Diff。

模块是纯计算边界，不访问数据库、文件或网络，不读取 Raw Promptfoo，不回写 Eval Result。

## 边界与依赖

Reporting 只依赖 Domain 结果类型和 JSON Schema Diff 所需的纯计算库，不依赖 Contracts、Application、数据库、文件或网络。Promptfoo Importer 调用 Diff 纯函数，Runs Application 调用报告聚合与 Renderer；边界 Mapper 再把 Domain Report Model 转换为 Contracts Report DTO。

## 实现状态

P6 已建立 `packages/reporting`，锁定 Ajv `8.20.0` 与 Draft 2020-12，实现纯 JSON Schema Diff、Missing 表达、Validator 对账和结构化错误。P8 已实现有界流式报告对账、整体与 By Metric 聚合、Owner 绑定的 Report Result Set Hash 和单向 Markdown Renderer。

## 代码落点

`packages/reporting`

## 当前代码事实入口

- [json-schema-diff.ts](../../packages/reporting/src/json-schema-diff.ts)：Ajv 2020-12 解释性 Diff 与 Promptfoo 判断对账。
- [report-aggregation.ts](../../packages/reporting/src/report-aggregation.ts)：有界 Case 对账、统计和 Report Result Set Hash。
- [report-markdown.ts](../../packages/reporting/src/report-markdown.ts)：只读 Report Model 的 Markdown 派生。

## 当前样例与测试入口

- [json-schema-diff.test.ts](../../packages/reporting/test/json-schema-diff.test.ts)：嵌套结构、Missing、非法 Schema 和 Validator 差异。
- [report-aggregation.test.ts](../../packages/reporting/test/report-aggregation.test.ts)：Rate、Metric 去重、顺序、Hash 和对账。
- [report-markdown.test.ts](../../packages/reporting/test/report-markdown.test.ts)：稳定事实呈现与 Markdown 单向性。
- [test_example.json](../../test_suite/current/eval_result/test_example.json)：当前已提交 Promptfoo 原始结果 Fixture。
- [test_example2.json](../../test_suite/current/cases/test_example2.json)

## 对外接口

纯聚合器接收 Report Owner、Run/Evaluation Context Hash、Evaluation Result Set Hash、冻结 Case 身份解析器和按 Ordinal 到达的规范化明细，返回整体 Summary、按 Metric 名称排序的 By Metric 和 Report Result Set Hash。Markdown Renderer 只接收已验证 Report Model。

## 核心流程

Importer 在 Eval 规范化阶段调用 Diff 纯函数，并在 Diff、Metric 与 Assertion 事实稳定后计算 Eval Result Hash 和 Final Case Result Hash。

Report 构建先验证每个冻结 Case 的 Ordinal、Case Key、REST/Eval 对齐、语义 Hash 和既有 Diff 事实，再从明细计算 Case 计数、整体有效通过率、已评估通过率、覆盖率和 By Metric，最后生成 Result Set Hash 与 Report Model。Report 构建不得重新生成或回写 Diff。

整体有效通过率为 `PASS / total`，已评估通过率为 `PASS / (PASS + FAIL)`，覆盖率为 `(PASS + FAIL) / total`。Error 与 Not Evaluated 独立计数。Evaluation 已按 `FAIL > ERROR > PASS > SKIPPED > NOT_EVALUATED` 把同 Case 同 Metric 归并为唯一事实；Reporting 拒绝重复 Metric，不再次解释 Assertion。Metric 通过率只使用 PASS 与 FAIL，空分母保持 `null`。

Diff 纯函数使用锁定版本 Validator，基于冻结 Schema 和 Provider Output 生成 Instance Path、Schema Path、Keyword、Expected Constraint、Actual Value 或 Missing、Reason。Diff 只解释 Promptfoo 失败，不改变评估状态。

Markdown 单向呈现总体、Metric、失败 Case、Diff 和 Rubric Reason，不能反向解析为平台事实。

## 状态、事务与幂等

Reporting 不执行事务。相同 Owner、上下文、Evaluation 版本、规范化明细和 Contract Version 必须生成相同统计与 Hash。不同 Run/Execution Owner 或 Evaluation 版本生成独立 Report 版本，不使用数据库最大 ID 或时间推断身份。分母为零时 Rate 为空。一条 Case 对同名 Metric 最多贡献一次。

## 错误收敛

明细缺失、计数、身份、Hash 或 Validator 对账失败时返回结构化错误，不生成完整报告。Validator 与 Promptfoo 判断不一致时保留 Promptfoo 状态并记录解释性差异 Error Code。

## 观测与验收

调用方记录 Run ID、Case 数、Metric 数、耗时、Result Set Hash 和 Error Code。验收要求 UI 与 CLI 对相同 DTO 一致、Markdown 可重新生成、千级报告满足性能要求。

## 相关测试

当前已覆盖真实 JSON Schema 结构、Missing、非法 Schema 和 Validator 差异，以及四种 Eval 状态、三个 Rate、空分母、同名 Metric 拒绝、Owner/上下文/版本 Hash、顺序与完整性对账和 Markdown。固定 1,000 Case 的 JSON 与 Markdown 联合构建在 macOS ARM64 上执行 5 秒门禁。
