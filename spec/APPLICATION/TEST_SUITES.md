# Application Test Suites

## 模块职责

该 Feature 管理当前 Test Suite 和 Test Case，负责创建、查询、编辑、删除、导入导出、筛选派生字段、Rubric 引用和统一 Case Definition 写入。

模块不负责运行结果、Promptfoo 调用、报告或历史版本。

## 边界与依赖

Feature 依赖 Domain Case 规则、Configuration 查询 Port、Test Suite Repository 和 Transaction Manager。所有 Case 写入口共用 Case Definition Writer。

## 实现状态

P2 已落地 Suite CRUD、Case 创建/编辑/复制/删除/全量替换、建议应用共用 Writer、Ordinal 导出、Cursor/组合过滤、Rubric 引用校验、派生字段、Hash 和独立 Revision。Case Key 与描述使用大小写无关的字面子串搜索。P3 才映射为资源 API。

## 目标代码落点

`packages/application/src/features/test-suites`

## 当前代码事实入口

- [convert_loona_to_promptfoo.py](../../data_scripts/convert_loona_to_promptfoo.py)
- [case-definition-writer.ts](../../packages/application/src/features/test-suites/case-definition-writer.ts)
- [test-suite-service.ts](../../packages/application/src/features/test-suites/test-suite-service.ts)

## 当前样例与测试入口

- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)
- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [loona_test_cases_export.jsonl](../../test_suite/current/raw/loona_test_cases_export.jsonl)

## 对外接口

Use Case 覆盖 Suite CRUD、按 Suite-local Case Key 精确读取的 Case CRUD、复制、导入、导出、Cursor 查询、组合过滤和引用影响查询。返回 Domain/Application 类型，由 Entrypoint 映射为 DTO。

## 核心流程

Case Definition Writer 校验禁止字段和 Definition，解析 Rubric Keys，校验引用，派生筛选字段与 Definition Hash，写入 Case，重算 Suite Count 与 Suite Hash，并在提交前对账。

全量导入先校验全部 Cases，再在一个短事务中替换。任一错误整笔回滚，错误携带输入顺序、Case Key 和底层字段/引用事实。Case 删除在同一事务中重排后续 Ordinal，并把新 Ordinal 与对应 Case Revision、Suite Count、Hash 和 Revision 一并持久化；任一重排失败整体回滚。

## 状态、事务与幂等

`metadata.case_id` 是 Suite 内稳定业务键，Ordinal 保持冻结顺序。`(suite_id, case_key)` 和 `(suite_id, ordinal)` 唯一。并发 Token 只防止覆盖，不建立版本历史。

## 错误收敛

非法 Case、重复身份、禁止运行字段、Rubric 引用缺失和并发冲突均不产生部分写入。批量错误保留 Case 顺序、Case ID 和字段路径。

## 观测与验收

记录 Suite ID、Case Key、操作、计数和 Error Code，不记录完整 Case Vars。验收要求所有写入口执行相同校验，资源删除不改变历史快照，千级过滤可用。

## 相关测试

目标测试覆盖五类写入口、导入原子性、身份与 Ordinal、引用、筛选派生、Hash、删除、Cursor 和组合过滤。
