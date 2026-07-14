# Storage SQLite

## 模块职责

Storage SQLite 保存平台当前资源、运行、结果和当前分析事实，负责 Migration、Repository、事务、约束和查询优化。

平台仍保持十张业务表。Run 级 Artifact 预期元数据保存在 `run_log.artifact_manifest_json`，每 Case Allowlist Evidence 元数据保存在 `eval_result`，不新增 Artifact 表。

模块不解析第三方原始响应，不信任工作包 Summary，不跨过 Application 编排业务流程。

## 边界与依赖

Package 使用 Kysely 构建显式 SQL，使用 better-sqlite3 访问当前唯一数据库。Repository 实现 Application Port，数据库行在边界映射为强类型数据。

## 实现状态

P2 已落地十张业务表、Kysely Migration、连接策略、Repository、托管事务、严格行映射、Revision 条件更新、JSON1 查询、Execution 幂等原语和删除/Provenance 约束。P3 补充资源分页 Repository、外部 Case staging 和 owner-aware 临时目录清理。P5 补充平台 Run Repository、冻结行映射、逐 Case REST 结果、阶段 CAS、取消/恢复、Artifact Manifest、Run Cursor，以及测试集最新平台 Run 的专用部分倒序索引。P6 补充完整 Eval 集合的短事务对账、原子写入、分页查询和 REST/Eval 复用 Provenance 校验。Run Detail 与 Run Progress 使用独立有界 SQL 投影；逐 Case 结果写入只按 Ordinal 读取目标冻结 Case 身份，不加载整个 Suite JSON。Case、Configuration、Run 和 Eval 读取都在边界清洗脏行。

## 目标代码落点

`packages/storage-sqlite`

## 当前代码事实入口

- [sqlite-initial-migration.ts](../../packages/storage-sqlite/src/sqlite-initial-migration.ts)：十表、约束和索引。
- [sqlite-database.ts](../../packages/storage-sqlite/src/sqlite-database.ts)：绝对项目根、权限、PRAGMA、Migration 和连接生命周期。
- [sqlite-application-repositories.ts](../../packages/storage-sqlite/src/sqlite-application-repositories.ts)：Application Port 实现。
- [sqlite-platform-run-repository.ts](../../packages/storage-sqlite/src/sqlite-platform-run-repository.ts)：平台 Run 短事务、阶段 CAS、结果与查询。
- [sqlite-platform-run-mappers.ts](../../packages/storage-sqlite/src/sqlite-platform-run-mappers.ts)：冻结 Run 和 REST Result 脏行清洗。
- [sqlite-platform-eval-repository.ts](../../packages/storage-sqlite/src/sqlite-platform-eval-repository.ts)：完整 Eval 集合对账、原子提交、阶段推进与分页查询。
- [sqlite-platform-eval-mappers.ts](../../packages/storage-sqlite/src/sqlite-platform-eval-mappers.ts)：Eval 状态、JSON、Hash 和 Provenance 脏行清洗。
- [sqlite-platform-run-index-migration.ts](../../packages/storage-sqlite/src/sqlite-platform-run-index-migration.ts)：测试集最新平台 Run 查询索引。
- [sqlite-row-mappers.ts](../../packages/storage-sqlite/src/sqlite-row-mappers.ts)：脏持久化边界清洗。
- [sqlite-case-import-staging.ts](../../packages/storage-sqlite/src/sqlite-case-import-staging.ts)：外部 staging、同连接最终事务、DETACH 与清理。
- [case-import-workspace.ts](../../packages/storage-sqlite/src/case-import-workspace.ts)：owner 身份、存活确认、隔离与受控删除。

## 当前样例与测试入口

[storage-sqlite tests](../../packages/storage-sqlite/test) 覆盖 Migration、跨字段约束、四类配置、Case Writer、权限、双连接/双进程竞争、Execution 幂等、平台 Run 抢占/取消/提交/恢复和千级性能。

P3 staging 测试额外覆盖只读附加、无 journal sidecar、并发旧 Revision 仅一方提交、DETACH、状态根/db/数据库/工作区/临时根符号链接拒绝、owner 伪造、PID 复用、未过 TTL 的 owner 初始化窗口、清理竞争，以及 owner/SQLite writer 初始化失败后的句柄关闭和目录回收。

## 对外接口

Repository、Transaction Manager 和查询对象实现 Application 定义的窄 Port。调用方只传入已校验的强类型数据，不接触数据库行、SQL、连接或事务对象。

## 数据主事实

`test_suite` 保存当前测试集聚合根；`test_case` 保存当前 Case Definition、身份、顺序、筛选派生事实和 Hash。

`endpoint_config`、`llm_config`、`llm_rubric_prompt` 和 `case_analysis_prompt` 保存当前配置，不保存历史和 Secret 展开值。

`run_log` 保存运行身份、脱敏快照、阶段、REST 进度、Evaluation 总完成/PASS/FAIL/Error/Not Evaluated 原子汇总、Summary 和错误。P5 已发布的 001 Migration 全文保持不可变；P6 的 003 只新增 PASS、FAIL、Not Evaluated 三列、分类完整性触发器和 REST/Eval Provenance 单一来源身份触发器，保证干净安装与历史升级具有相同行为。002 升级测试先对完整历史 Schema 计算冻结 Hash，再执行 003 并核对新增列与约束。`case_result` 保存冻结 Case 与 REST 事实；`eval_result` 保存规范化评估、Assertion、Diff、Metric 和结果 Hash；`case_analysis` 保存 Run/Case 当前分析与决策。

字段和约束的代码权威来源是当前 Migration、Schema 类型和 Repository 映射，不由本文档复制完整清单。Kysely 自有两张 Migration 元数据表不计入十张业务表。

## 写入与读取路径

资源由 Test Suites 和 Configurations Feature 写入。P5 Runs 写入冻结 Run、逐 Case REST Result、REST Result Set Hash 和 Artifact Manifest；P6 已接入平台 Eval Result、绑定 Run/Evaluation Context 的 Eval Result Set Hash，以及显式保存同一 Context Hash 的 Raw/Normalized Artifact Manifest 原子提交，Summary 在 P8 接入。Execution Imports 原子导入完整规范化结果。Case Analysis 写入当前分析和决策。

Web、API 和 CLI 不直接查询数据库；所有读取通过 Application Repository Port。只有阶段抢占返回完整冻结执行输入；详情、动作、SSE、取消轮询和结果写入分别使用有界 Detail/Progress/目标 Case 投影，避免 Case 数增长导致重复全量 JSON 解析。

## 状态、事务与幂等

资源写入、运行冻结、阶段提交和结果导入使用短事务。外部调用不持有数据库事务。Case Key、Ordinal、Execution ID、Run Status 和联合外键使用数据库约束保护。

部分唯一索引保证全库最多一条 `RUNNING`。条件更新同时校验 Status、Stage、Lock Revision 或 Analysis Revision。REST 结果以 `(run_id, case_key)` 幂等写入并核对冻结 Ordinal/Definition Hash；Eval 阶段在同一短事务中复算每条 Eval/Final Hash，并用目标 Run、Evaluation Context Hash 和有序 Case Hash 复算 Result Set Hash，再对账 REST 与 Raw Evidence 描述，把 Raw/Normalized Eval 描述追加到既有且唯一的 REST Artifact Manifest，整体写入并推进到 `READY/REPORT`。REST 描述不得被 Eval 调用方覆盖或删除。REST/Eval Provenance 只能选择一个来源身份；平台复用必须命中来源 Run 的同 Case、同状态和同语义 Hash，Eval 还必须对齐目标已复用 REST。测试集列表的最新平台 Run 只查询 `source_type='PLATFORM'`，按 `created_at DESC, id DESC` 确定排序，不混入离线导入。

Case 全量导入的 staging SQLite 位于受控外部工作目录，不计入十张业务表。Writer 阶段文件为 `0600` 且关闭 journal；最终提交前收敛为 `0400`，通过主库 Kysely 租用连接 `ATTACH`，在一个 `BEGIN IMMEDIATE` 短事务中校验并 `INSERT ... SELECT`，随后验证 `DETACH`。主库正常业务事务仍使用 Kysely 托管事务；这一手工事务只限 ATTACH 生命周期内的 staging 最终提交。

## 错误收敛

唯一、外键、Check、Busy 和条件更新失败映射为稳定存储或业务冲突，不泄露 SQL 和本地路径。唯一字段竞争返回领域冲突；SQLite Busy 只允许最多四次完整短事务重启，耗尽返回 `STORAGE_TRANSACTION_CONFLICT`。事务失败整体回滚，不做 catch-log-reraise。

## 观测与验收

每个连接启用 Foreign Keys、WAL、5 秒 Busy Timeout 和 `synchronous=FULL`。装配层必须传入绝对项目根；Storage 不读取 `cwd`，默认数据库位于 `<projectRoot>/.cortex-eval/db/cortex-eval.sqlite3`。目录权限收敛为 `0700`，数据库与 WAL/SHM 收敛为 `0600`。千级 Case 导入低于 10 秒，查询预热 5 次后测量 30 次并执行 p95 250 毫秒、p99 500 毫秒失败门禁。

SQLite 初始化先 canonicalize 显式项目根，再逐级以 `lstat + realpath` 验证 `.cortex-eval` 和 `db` 为真实目录且保持 containment；现有数据库、WAL、SHM 是符号链接或非普通文件时拒绝。只有预检通过后才 chmod 或打开数据库。staging owner 严格保存 PID、进程启动时间和 nonce。临时根必须同时满足 lexical 与 canonical 项目 containment；根或直接父级是符号链接时在 chmod、readdir、rename、rm 前拒绝。启动清理超过 TTL 的目录前，以无 Shell 的 `/bin/ps` 校验 PID 启动身份并再次读取 nonce；无 owner 目录未过 TTL 时保留，避免与并发 owner 初始化竞争，过 TTL 后才作为非法 owner 隔离。其他非法 owner 与工作区符号链接先隔离，路径必须通过 realpath containment。导入和导出使用闭合的独立工作区前缀，共用相同 owner/containment 规则。owner 文件、权限、realpath、SQLite 打开、PRAGMA 或建表任一步初始化失败时，关闭已打开 writer，并在重新验证 containment/owner 后回收部分工作区。删除失败发出闭合 `TEMP_CLEANUP_FAILED`，由默认 Local Server 日志接收。better-sqlite3 当前连接未启用 SQLite URI 文件名解析，因此不能依赖 `mode=ro&immutable=1` 的 ATTACH URI；P3 使用 canonical realpath 与 OS `0400` 强制只读，并以真实 `SQLITE_READONLY` 测试证明。

## 相关测试

当前测试覆盖十表 Migration、约束、索引、删除、严格行映射、Case Writer、真实 SQLite Case 首/中/末删除和重排失败回滚、双连接 Revision/唯一字段/Execution 竞争、双进程唯一运行、Execution 身份幂等、平台 Run 阶段条件提交、跨进程取消/提交竞争、启动恢复、Run 有界投影、结果写入不触发完整 Run 读取、分页/Case 查询/Manifest、Eval 原子提交与回滚、Eval 行映射、复用 Provenance 和千级查询。
