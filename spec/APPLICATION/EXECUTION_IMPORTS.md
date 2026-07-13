# Application Execution Imports

## 模块职责

该 Feature 把离线工作包中的规范化报告和分析结果导入平台，负责身份、结构、明细、哈希、幂等和冲突校验。

模块不导入 Raw Promptfoo，不信任工作包 Summary，不负责工作包阶段执行。

## 边界与依赖

Feature 依赖 Domain 对账规则、Run Repository、Case Analysis Repository 和 Transaction Manager。Entrypoint/Work Package Parser 先使用 Contracts 校验外部 DTO，再由 Mapper 转换为 Application Core Import Command；Application 不导入 Contracts。工作包解析与平台数据提交保持独立。

## 实现状态

P2 仅落地 Execution ID 与 Result Set Hash 的事务幂等登记原语，以及版本化快照和 Artifact Manifest 的最小持久化。工作包解析、明细校验、统计重算、Case/Eval/Analysis 完整导入仍属于 P7–P9，当前不暴露导入入口。

## 目标代码落点

`packages/application/src/features/execution-imports`

## 当前代码事实入口

- [import-execution-identity.ts](../../packages/application/src/features/execution-imports/import-execution-identity.ts)：P2 身份幂等原语。
- [sqlite-application-repositories.ts](../../packages/storage-sqlite/src/sqlite-application-repositories.ts)：Execution 唯一约束的存储实现。

## 当前样例与测试入口

- `test_suite/current/run_result/loona_promptfoo_tests.json`：当前未跟踪 REST 结果 Fixture。
- `test_suite/current/eval_result/result.json`：当前未跟踪 Promptfoo 结果 Fixture。

## 对外接口

Use Case 接受版本化的规范化 Execution Result 和可选 Analysis Result，返回新建 Run、幂等成功或稳定冲突。

## 核心流程

系统校验 Package 与 Execution 身份、文件 Hash、Case 顺序、Base Hash、REST/Eval 对齐和 Contract Version，从明细重算统计与 Result Set Hash，再在单一事务中保存 Run、Case Results 和 Eval Results。

分析可以后续单独导入，先定位 Execution 对应 Run，再校验 Final Case Result Hash 和 Analysis Input Hash。

## 状态、事务与幂等

相同 Execution ID 与相同 Result Set Hash 幂等成功；相同 ID 对应不同结果返回 `EXECUTION_RESULT_CONFLICT`。不同 Execution 即使输入相同也保存为不同 Run。

离线完整报告直接建立 `COMPLETED/DONE` 或 `COMPLETED_WITH_ERRORS/DONE`，不伪造中间运行过程。

## 错误收敛

任一身份、结构、明细或对账失败时整笔不提交。平台当前 Case 已变化不阻止历史结果导入，但会在应用分析建议时产生冲突。

## 观测与验收

日志记录 Package ID、Execution ID、Result Set Hash、导入结果和 Error Code，不记录结果正文。验收要求重复导入幂等、冲突稳定、Summary 由明细重算。

## 相关测试

目标测试覆盖完整导入、报告与分析分次导入、Hash、错位明细、重复幂等、冲突、当前资源漂移和事务回滚。
