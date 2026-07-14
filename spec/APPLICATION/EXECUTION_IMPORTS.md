# Application Execution Imports

## 模块职责

该 Feature 负责离线结果的平台身份、幂等和冲突事务。Work Package Parser 负责文件、结构、明细和 Hash 清洗；Application 只接收强类型导入身份和已经验证的结果。

模块不把 Raw Promptfoo 写入平台业务事实，不信任工作包 Summary，不负责工作包阶段执行。

## 边界与依赖

Feature 依赖 Domain 身份规则、Run Repository 和 Transaction Manager。Work Package Parser 先使用 Contracts 校验外部 DTO，完成两遍文件与语义校验后再映射为 Application Command；Application 不导入 Contracts，也不读取任意文件路径。

## 实现状态

P7 已落地 Package ID、Execution ID、Result Set Hash 与完整 Artifact Manifest 绑定的身份登记，以及 Work Package Evaluation Result 的严格双遍读取基础。SQLite 显式保存并清洗 `source_type='OFFLINE_IMPORT'`、`source_package_id` 和 Artifact Manifest。完整 Report 对账、Run/Case/Eval 持久化和 `result import` HTTP/CLI 入口等待 P8，因此当前不暴露导入能力。

## 当前代码事实入口

- [execution-import-models.ts](../../packages/application/src/features/execution-imports/execution-import-models.ts)：强类型导入身份与存储联合。
- [import-execution-identity.ts](../../packages/application/src/features/execution-imports/import-execution-identity.ts)：Package/Execution/Result Set 身份、Owner 和 Artifact 路径冲突处理。
- [work-package-evaluation-result-reader.ts](../../packages/work-package/src/work-package-evaluation-result-reader.ts)：REST、Raw、Normalized 的双遍严格读取和 Hash 重算。
- [sqlite-application-repositories.ts](../../packages/storage-sqlite/src/sqlite-application-repositories.ts)：唯一约束与事务实现。

## 当前测试入口

- [sqlite-import-identity.test.ts](../../packages/storage-sqlite/test/sqlite-import-identity.test.ts)：幂等、Package/Owner 冲突、来源映射和并发。
- [work-package-evaluation-retry-reader.test.ts](../../packages/work-package/test/work-package-evaluation-retry-reader.test.ts)：来源证据缺失、恢复和损坏。
- [work-package-execution-session.test.ts](../../packages/work-package/test/work-package-execution-session.test.ts)：严格结果准备与损坏拒绝。

## 对外接口

P7 内部身份用例接受 Package ID、Execution ID、Result Set Hash 和受控 Artifact Manifest，返回新登记、幂等成功或 `EXECUTION_RESULT_CONFLICT`。P8 完整导入用例将在同一身份基础上接收已验证 Report 与明细，不改变 P7 身份语义。

## 核心流程

1. 校验成功 Evaluation 阶段声明的 Raw/Normalized 描述符、实际 Hash 和大小。
2. 流式读取 REST 与 Normalized，按 Manifest、Ordinal、Case Key 和 Base Hash 对齐。
3. 校验每个评估 Case 引用存在且已登记的 Raw；`NOT_EVALUATED` 不得伪造 Raw 引用。
4. 重算 Eval、Final Case 和 Owner/Context Result Set Hash。
5. 在实际消费时再次执行语义读取，拒绝预检后文件变化。
6. 进入事务前校验 Package、Execution、Artifact Owner、Kind 和受控路径；P8 再在单一事务中保存完整 Run 事实。

## 状态、事务与幂等

幂等身份是 Package ID、Execution ID、Result Set Hash 和规范化 Artifact Manifest 的联合事实。Manifest 比较覆盖 Contract Version、Owner，以及每个 Artifact 的 Kind、受控路径、Hash、大小和 Payload Contract Version；只有全部相同才幂等成功。相同 Execution ID 对应任一不同事实都返回 `EXECUTION_RESULT_CONFLICT`。不同 Execution 即使输入和单 Case Eval Hash 相同，也表示不同执行版本。

文件解析与平台事务分离。任一文件、身份或语义错误都不得写数据库；唯一约束竞争由事务内重新读取权威事实后分类。

## 错误收敛

路径、大小、Hash、结构、顺序、Owner、Raw 引用或重算失败统一在 Work Package 边界收敛为 `WORK_PACKAGE_INVALID`。身份复用冲突收敛为 `EXECUTION_RESULT_CONFLICT`。取消保持取消语义，不伪装成损坏。

## 观测与验收

日志只记录 Package ID、Execution ID、Result Set Hash、导入结果和 Error Code。P7 验收证明严格读取、重复幂等、Package/Owner 冲突、并发唯一和 `OFFLINE_IMPORT` 映射；P8 继续证明完整 Report 导入、Summary 重算和事务回滚。
