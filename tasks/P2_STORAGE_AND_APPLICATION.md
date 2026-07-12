# P2：SQLite 与 Application 基础

## 状态与依赖

- 状态：`PENDING`
- 依赖：P1

## 目标

落地十张业务表、短事务、Repository 和资源用例，并证明并发、删除、冻结与 Artifact 元数据一致性。

## 实现清单

- 使用 Kysely 与 better-sqlite3 实现 Migration、外键、WAL、Busy Timeout、索引和 Repository。
- `run_log` 保存版本化 `artifact_manifest_json`；`eval_result` 保存每 Case Allowlist Evidence 元数据，不新增 Artifact 表。
- 实现 Test Suite、Case、Endpoint、LLM、Rubric Prompt、Analysis Prompt 当前资源用例。
- 实现 CaseDefinitionWriter、全量导入事务、引用校验、Suite Hash、并发 Revision 和资源冻结。
- 实现 READY/RUNNING 删除拒绝、终态快照独立、Suite 当前 Case 级联和 Prompt 引用限制。
- 为平台重跑保存 `source_run_id`、Rerun Mode，并为 Case/Eval 复用事实保存来源 Run/Execution ID 与 Result Hash。
- 默认数据目录为项目根 `.cortex-eval/`，首次启动创建对应目录和数据库。

## TDD 与验证

- 每个测试使用独立数据库；并发正确性使用独立连接或进程。
- 覆盖十表约束、回滚、并发抢占、删除/冻结竞争、Artifact Manifest 和幂等导入基础。
- 覆盖重跑来源外键、复用 Provenance、不修改来源事实和来源资源删除后的快照独立。
- 运行 1,000 Case 导入、Hash 和查询基准，建立后续性能基线。

## Spec 更新

- `spec/PACKAGES/STORAGE_SQLITE.md`
- `spec/APPLICATION/OVERVIEW.md`
- `spec/APPLICATION/TEST_SUITES.md`
- `spec/APPLICATION/CONFIGURATIONS.md`
- `spec/INTERNAL_BEHAVIOR.md`
- `spec/SYSTEM_FLOWS.md`

## 完成标准

- 外部调用期间没有数据库事务。
- 十表与所有关键约束能由 Migration/Repository 测试证明。
- Raw Artifact 缺失不会删除数据库中的预期 Hash、大小和类型事实。

## 阻塞条件

需要新增第十一张业务表或破坏现有数据时，必须先证明十表无法表达并请求用户确认。
