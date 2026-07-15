# Application Execution Imports

## 模块职责

该 Feature 负责离线结果的平台身份、幂等和冲突事务。Work Package Parser 负责文件、结构、明细和 Hash 清洗；Application 只接收强类型导入身份和已经验证的结果。

模块不把 Raw Promptfoo 写入平台业务事实，不信任工作包 Summary，不负责工作包阶段执行。

## 边界与依赖

Feature 依赖 Domain 身份规则、Run Repository 和 Transaction Manager。Work Package Parser 先使用 Contracts 校验外部 DTO，完成两遍文件与语义校验后再映射为 Application Command；Application 不导入 Contracts，也不读取任意文件路径。

## 实现状态

P7 已落地 Package ID、Execution ID、Result Set Hash 与完整 Artifact Manifest 绑定的身份登记，以及 Work Package Evaluation Result 的严格双遍读取基础。P8 已闭合完整 Report 双遍读取、明细重算、Run/REST/Eval 原子持久化，以及 `result import` HTTP/CLI 入口。SQLite 显式保存并清洗 `source_type='OFFLINE_IMPORT'`、`source_package_id`、Execution/Report 版本和 Artifact Manifest。

## 当前代码事实入口

- [execution-import-models.ts](../../packages/application/src/features/execution-imports/execution-import-models.ts)：强类型导入身份与存储联合。
- [import-execution-identity.ts](../../packages/application/src/features/execution-imports/import-execution-identity.ts)：Package/Execution/Result Set 身份、Owner 和 Artifact 路径冲突处理。
- [work-package-evaluation-result-reader.ts](../../packages/work-package/src/work-package-evaluation-result-reader.ts)：REST、Raw、Normalized 的双遍严格读取和 Hash 重算。
- [work-package-report-import-reader.ts](../../packages/work-package/src/work-package-report-import-reader.ts)：Report Artifact、Summary 和明细的严格导入读取。
- [import-execution-report.ts](../../packages/application/src/features/execution-imports/import-execution-report.ts)：完整报告导入用例与事务边界。
- [sqlite-imported-execution-store.ts](../../packages/storage-sqlite/src/sqlite-imported-execution-store.ts)：唯一约束、完整 Run/REST/Eval 写入与幂等事务实现。

## 当前测试入口

- [sqlite-import-identity.test.ts](../../packages/storage-sqlite/test/sqlite-import-identity.test.ts)：幂等、Package/Owner 冲突、来源映射和并发。
- [work-package-evaluation-retry-reader.test.ts](../../packages/work-package/test/work-package-evaluation-retry-reader.test.ts)：来源证据缺失、恢复和损坏。
- [work-package-execution-session.test.ts](../../packages/work-package/test/work-package-execution-session.test.ts)：严格结果准备与损坏拒绝。
- [work-package-report-reader.test.ts](../../packages/work-package/test/work-package-report-reader.test.ts)：Report 双遍读取、篡改和取消。
- [sqlite-import-report.test.ts](../../packages/storage-sqlite/test/sqlite-import-report.test.ts)：完整导入、幂等、冲突、关联和事务回滚。

## 对外接口

完整导入用例在 P7 身份语义基础上接收已验证 Manifest、REST/Normalized/Report Artifact 和明细，返回新建 Run、幂等成功或 `EXECUTION_RESULT_CONFLICT`。HTTP 接口只接收受控工作包路径与版本化请求，CLI 不直接打开平台数据库。

## 核心流程

1. 校验成功 Evaluation 阶段声明的 Raw/Normalized 描述符、实际 Hash 和大小。
2. 流式读取 REST 与 Normalized，按 Manifest、Ordinal、Case Key 和 Base Hash 对齐。
3. 校验每个评估 Case 引用存在且已登记的 Raw；`NOT_EVALUATED` 不得伪造 Raw 引用。
4. 重算 Eval、Final Case 和 Owner/Context Result Set Hash。
5. 在实际消费时再次执行语义读取，拒绝预检后文件变化。
6. 读取并对账 JSON Report；Markdown 只校验 Artifact 完整性，不作为反向导入事实。
7. 从明细重新聚合 Summary 与 Report Result Set Hash，不信任工作包 Summary。
8. 进入事务前校验 Package、Execution、Artifact Owner、Kind 和受控路径，在单一事务中保存终态 Run、REST 和 Eval 事实。

## 状态、事务与幂等

幂等身份是 Package ID、Execution ID、Result Set Hash 和规范化 Artifact Manifest 的联合事实。Manifest 比较覆盖 Contract Version、Owner，以及每个 Artifact 的 Kind、受控路径、Hash、大小和 Payload Contract Version；只有全部相同才幂等成功。相同 Execution ID 对应任一不同事实都返回 `EXECUTION_RESULT_CONFLICT`。不同 Execution 即使输入和单 Case Eval Hash 相同，也表示不同执行版本。

文件解析与平台事务分离。Reader 在预检和实际消费两遍都验证文件，避免检查后替换；任一文件、身份、语义或 Summary 错误都不得写数据库。唯一约束竞争由事务内重新读取权威事实后分类，不使用 `select max`、最大时间或最近记录推断导入身份。

导入始终保存冻结 Suite 快照。仅当当前数据库存在同 ID Test Suite 时写入可空 `suite_id` 关联；不存在时仍导入为独立历史 Run，不伪造名称或阻止报告查看。不同 Execution ID 永远建立不同执行版本；Report Result Set Hash 另行绑定 Execution Owner、Evaluation 版本和上下文。

## 错误收敛

路径、大小、Hash、结构、顺序、Owner、Raw 引用或重算失败统一在 Work Package 边界收敛为 `WORK_PACKAGE_INVALID`。身份复用冲突收敛为 `EXECUTION_RESULT_CONFLICT`。取消保持取消语义，不伪装成损坏。

## 观测与验收

日志只记录 Package ID、Execution ID、Result Set Hash、导入结果和 Error Code。验收证明严格双遍读取、重复幂等、Package/Owner 冲突、并发唯一、`OFFLINE_IMPORT` 映射、完整 Report 导入、Summary 重算、当前 Suite 可选关联和事务回滚。
