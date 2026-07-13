# Storage SQLite

## 模块职责

Storage SQLite 保存平台当前资源、运行、结果和当前分析事实，负责 Migration、Repository、事务、约束和查询优化。

平台仍保持十张业务表。Run 级 Artifact 预期元数据保存在 `run_log.artifact_manifest_json`，每 Case Allowlist Evidence 元数据保存在 `eval_result`，不新增 Artifact 表。

模块不解析第三方原始响应，不信任工作包 Summary，不跨过 Application 编排业务流程。

## 边界与依赖

Package 使用 Kysely 构建显式 SQL，使用 better-sqlite3 访问当前唯一数据库。Repository 实现 Application Port，数据库行在边界映射为强类型数据。

## 实现状态

P2 已落地十张业务表、Kysely Migration、连接策略、Repository、托管事务、严格行映射、Revision 条件更新、JSON1 查询、Execution 幂等原语和删除/Provenance 约束。Case 与四类 Configuration 读取会核对闭合键集合、派生字段和语义 Hash，不接受形状合法但事实不一致的脏行。

## 目标代码落点

`packages/storage-sqlite`

## 当前代码事实入口

- [sqlite-initial-migration.ts](../../packages/storage-sqlite/src/sqlite-initial-migration.ts)：十表、约束和索引。
- [sqlite-database.ts](../../packages/storage-sqlite/src/sqlite-database.ts)：绝对项目根、权限、PRAGMA、Migration 和连接生命周期。
- [sqlite-application-repositories.ts](../../packages/storage-sqlite/src/sqlite-application-repositories.ts)：Application Port 实现。
- [sqlite-row-mappers.ts](../../packages/storage-sqlite/src/sqlite-row-mappers.ts)：脏持久化边界清洗。

## 当前样例与测试入口

[storage-sqlite tests](../../packages/storage-sqlite/test) 覆盖 Migration、跨字段约束、四类配置、Case Writer、权限、双连接/双进程竞争、Execution 幂等和千级性能。

## 对外接口

Repository、Transaction Manager 和查询对象实现 Application 定义的窄 Port。调用方只传入已校验的强类型数据，不接触数据库行、SQL、连接或事务对象。

## 数据主事实

`test_suite` 保存当前测试集聚合根；`test_case` 保存当前 Case Definition、身份、顺序、筛选派生事实和 Hash。

`endpoint_config`、`llm_config`、`llm_rubric_prompt` 和 `case_analysis_prompt` 保存当前配置，不保存历史和 Secret 展开值。

`run_log` 保存运行身份、脱敏快照、阶段、进度、Summary 和错误；`case_result` 保存冻结 Case 与 REST 事实；`eval_result` 保存规范化评估、Assertion、Diff、Metric 和结果 Hash；`case_analysis` 保存 Run/Case 当前分析与决策。

字段和约束的代码权威来源是当前 Migration、Schema 类型和 Repository 映射，不由本文档复制完整清单。Kysely 自有两张 Migration 元数据表不计入十张业务表。

## 写入与读取路径

资源由 Test Suites 和 Configurations Feature 写入。Runs 写入 Run、Case Result、Eval Result 和 Summary。Execution Imports 原子导入完整规范化结果。Case Analysis 写入当前分析和决策。

Web、API 和 CLI 不直接查询数据库；所有读取通过 Application Repository Port。

## 状态、事务与幂等

资源写入、运行冻结、阶段提交和结果导入使用短事务。外部调用不持有数据库事务。Case Key、Ordinal、Execution ID、Run Status 和联合外键使用数据库约束保护。

部分唯一索引保证全库最多一条 `RUNNING`。条件更新同时校验 Status、Stage、Lock Revision 或 Analysis Revision。

## 错误收敛

唯一、外键、Check、Busy 和条件更新失败映射为稳定存储或业务冲突，不泄露 SQL 和本地路径。唯一字段竞争返回领域冲突；SQLite Busy 只允许最多四次完整短事务重启，耗尽返回 `STORAGE_TRANSACTION_CONFLICT`。事务失败整体回滚，不做 catch-log-reraise。

## 观测与验收

每个连接启用 Foreign Keys、WAL、5 秒 Busy Timeout 和 `synchronous=FULL`。装配层必须传入绝对项目根；Storage 不读取 `cwd`，默认数据库位于 `<projectRoot>/.cortex-eval/db/cortex-eval.sqlite3`。目录权限收敛为 `0700`，数据库与 WAL/SHM 收敛为 `0600`。千级 Case 导入低于 10 秒，查询预热 5 次后测量 30 次并执行 p95 250 毫秒、p99 500 毫秒失败门禁。

## 相关测试

当前测试覆盖十表 Migration、约束、索引、删除、严格行映射、Case Writer、真实 SQLite Case 首/中/末删除和重排失败回滚、双连接 Revision/唯一字段/Execution 竞争、双进程唯一运行、Execution 身份幂等和千级查询。阶段条件提交、取消竞争与恢复随 P5 Run 编排落地。
