# Application Test Suites

## 模块职责

该 Feature 管理当前 Test Suite 和 Test Case，负责创建、查询、编辑、删除、导入导出、筛选派生字段、Rubric 引用和统一 Case Definition 写入。

模块不负责运行结果、Promptfoo 调用、报告或历史版本。

## 边界与依赖

Feature 依赖 Domain Case 规则、Configuration 查询 Port、Test Suite Repository 和 Transaction Manager。所有 Case 写入口共用 Case Definition Writer。

## 实现状态

P2 已落地 Suite CRUD、Case 创建/编辑/复制/删除/全量替换、建议应用共用 Writer、Cursor/组合过滤、Rubric 引用校验、派生字段、Hash 和独立 Revision。P3 补充 Revision 一致的流式导出、受控 staging 全量导入、增量 Suite Hash，并映射为严格资源 API。Case Key 与描述使用大小写无关的字面子串搜索。

## 目标代码落点

`packages/application/src/features/test-suites`

## 当前代码事实入口

- [convert_loona_to_promptfoo.py](../../data_scripts/convert_loona_to_promptfoo.py)
- [case-definition-writer.ts](../../packages/application/src/features/test-suites/case-definition-writer.ts)
- [case-definition-preparer.ts](../../packages/application/src/features/test-suites/case-definition-preparer.ts)
- [streaming-case-import-service.ts](../../packages/application/src/features/test-suites/streaming-case-import-service.ts)
- [case-export-service.ts](../../packages/application/src/features/test-suites/case-export-service.ts)
- [test-suite-service.ts](../../packages/application/src/features/test-suites/test-suite-service.ts)

## 当前样例与测试入口

- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)
- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [batch1.jsonl](../../test_suite/current/raw/batch1.jsonl)

## 对外接口

Use Case 覆盖 Suite CRUD、按 Suite-local Case Key 精确读取的 Case CRUD、复制、导入、导出、Cursor 查询、组合过滤和引用影响查询。返回 Domain/Application 类型，由 Entrypoint 映射为 DTO。

## 核心流程

Case Definition Writer 校验禁止字段和 Definition，解析 Rubric Keys，校验引用，派生筛选字段与 Definition Hash，写入 Case，重算 Suite Count 与 Suite Hash，并在提交前对账。

全量导入在边界按背压逐项解析，Application 逐项准备并写入独立 staging，同时增量计算与完整 RFC 8785 输入一致的 Suite Hash。全部项目、Rubric 引用、Suite Revision 和 multipart 未截断事实通过后，最终短事务整体替换主库 Cases；合法 JSON 数组后只有尾随空白的超限文件同样在提交前拒绝。任一错误不产生部分主库事实。错误携带输入顺序、Case Key 和底层字段/引用事实。

导出先冻结当前 Suite Revision，再按 Ordinal 与内部 ID 逐 Case 短事务读取，不保留完整数组；Entrypoint 把 JSON 流写入 owner-only `0600` 临时文件，只有全部读取和 Revision 校验完成才打开 200。导出期间 Revision 改变可在响应前返回 409，避免混合版本或把断流伪装成错误响应。Case 删除在同一事务中重排后续 Ordinal，并把新 Ordinal 与对应 Case Revision、Suite Count、Hash 和 Revision 一并持久化；任一重排失败整体回滚。

## 状态、事务与幂等

`metadata.case_id` 是 Suite 内稳定业务键，Ordinal 保持冻结顺序。`(suite_id, case_key)` 和 `(suite_id, ordinal)` 唯一。并发 Token 只防止覆盖，不建立版本历史。

## 错误收敛

非法 Case、重复身份、禁止运行字段、Rubric 引用缺失和并发冲突均不产生部分写入。合法 Case 列表查询先确认 Suite 存在，不把缺失 Suite 伪装为空页。批量错误保留 Case 顺序、Case ID 和字段路径；staging 清理失败不覆盖已经确定的导入结果。

## 观测与验收

记录 Suite ID、Case Key、操作、计数和 Error Code，不记录完整 Case Vars。验收要求所有写入口执行相同校验，资源删除不改变历史快照，千级过滤可用。

## 相关测试

当前测试覆盖五类写入口、流式导入原子性/取消/重复/引用、尾随空白超限不提交、Revision 一致导出与响应前冲突、导出文件权限/正常完成/取消清理、身份与 Ordinal、筛选派生、增量与完整 Hash 一致、删除、Cursor 和组合过滤。
