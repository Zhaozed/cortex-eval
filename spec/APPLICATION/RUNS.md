# Application Runs

## 模块职责

该 Feature 负责运行创建、输入冻结、运行模式、阶段推进、取消、恢复、进度计数和唯一活跃执行约束。P5 当前只闭合 REST 阶段。

模块不实现 HTTP 请求、Promptfoo 协议、模型 SDK 或报告纯计算。

## 边界与依赖

Feature 当前依赖 Domain Run 规则、资源与 Run Repository、Transaction Manager、REST Executor、Run Artifact Store、Clock 和 ID Generator。Promptfoo Process 与 Reporting Port 在对应阶段闭环时接入。

能力按阶段注册。REST、Eval、Report 和 Analysis 只有在各自闭环落地后才进入 API、CLI、Web 导航和 OpenAPI；未实现能力不提供占位入口。

## 实现状态

P5 已落地平台 Run 预检与创建、冻结上下文、REST 阶段抢占和执行、逐 Case 结果、Artifact 提交、取消、Runtime Shutdown、启动恢复、分页查询和 Artifact 检查。全库唯一 `RUNNING`、跨进程取消与提交竞争由真实 SQLite 条件写和部分唯一索引收敛。

当前 REST 成功提交后 Run 停在 `READY/EVALUATION`。Evaluation、Report、Retry/Force 和离线完整导入仍未注册。

## 目标代码落点

`packages/application/src/features/runs`

## 当前代码事实入口

- [platform-run-service.ts](../../packages/application/src/features/runs/platform-run-service.ts)：Run 预检、冻结、REST 编排、取消与恢复。
- [platform-run-models.ts](../../packages/application/src/features/runs/platform-run-models.ts)：冻结 Run、结果、分页和执行限制模型。
- [platform-run-ports.ts](../../packages/application/src/features/runs/platform-run-ports.ts)：短事务、资源读取与 Run Repository Port。
- [run-artifact-port.ts](../../packages/application/src/features/runs/run-artifact-port.ts)：不可变 Run Artifact 边界。
- [run-rest-models.ts](../../packages/application/src/features/runs/run-rest-models.ts)：REST Executor 输入与受控结果。

## 当前样例与测试入口

- [platform-run-service.test.ts](../../packages/application/test/platform-run-service.test.ts)：冻结、提交、取消、Shutdown 与 Artifact 失败。
- [sqlite-platform-run-repository.test.ts](../../packages/storage-sqlite/test/sqlite-platform-run-repository.test.ts)：真实 SQLite 抢占、竞争、恢复与查询。
- [run-api.test.ts](../../apps/local-server/test/run-api.test.ts)：真实 SQLite、HTTP、Artifact 与逐 Case REST 闭环。

## 对外接口

当前 Use Case 覆盖 Preflight、Create Run、仅启动 REST、Get Progress、Cancel Run、Run 查询、逐 Case REST 查询和 Artifact 可用性检查。查询返回有界冻结摘要、阶段事实和安全进度，不返回完整冻结 Case 数组或 Prompt 正文。

Run Pipeline、Build Report、Retry Run Failed 和 Force Run 仍是后续阶段目标，当前入口不存在。

## 核心流程

创建运行在一个短事务中读取并冻结 Suite、Cases、Endpoint、Evaluator、被引用 Rubric Prompts 和执行限制，计算上下文 Hash，写入 `READY/REST`。启动通过 Status、Stage、Revision 条件写抢占 `RUNNING/REST`，只在抢占时读取一次完整冻结执行输入；事务外执行 REST Adapter。每个真实结果幂等落库并推进计数，写入只校验目标冻结 Case 身份并返回小型进度，不重新加载完整 Run。完整结果对账后按 Cursor 单遍读取，增量计算 Result Set Hash 并流式写入不可变 Artifact，随后条件提交为 `READY/EVALUATION`。

Artifact 文件先写到 Run 专属受控路径，Manifest 只有在数据库阶段提交成功后才成为持久事实；提交竞争失败会删除未提交文件。启动清理只删除未被任何持久 Manifest 引用的受控 Artifact。

Retry Run Failed 与 Force Run 的来源模型已在 Domain 和存储中保留，但 Eval 复用规则闭环前不注册创建入口。

## 状态、事务与幂等

合法 Run Status 为 `READY`、`RUNNING`、`COMPLETED`、`COMPLETED_WITH_ERRORS`、`FAILED`、`CANCELLED` 和 `INTERRUPTED`。Stage 为 `REST`、`EVALUATION`、`REPORT` 和 `DONE`。所有转换校验 Status、Stage 和 Lock Revision。

全库最多一条 `RUNNING`。终态不可重入。冻结后只使用 Snapshot，不读取当前资源。

平台 Create Run 接受并冻结 `RunExecutionLimitsV1`：REST 默认来自 Endpoint 配置且新建 Endpoint 默认为 4，Eval 默认 2，范围 1–64 和 1–16。限制进入 Run Snapshot 与 Context Hash；REST Adapter 的最大在途数服从冻结值。Analysis 限制由独立 Analysis 请求冻结，不属于原 Run Context。

## 错误收敛

单 Case REST Error 作为结果事实继续收口。阶段系统错误将当前 Run 收敛为 `FAILED/DONE`。逐 Case 持久化失败由 REST Executor 内部 Abort 并等待全部 Worker 退出后才返回 Application，因此后台 Owner 不会在外部 POST 或回调仍运行时释放。用户取消先持久化请求，再 Abort 本地 Owner；跨进程 Owner 在 25–50 毫秒轮询内观察请求。取消轮询的拒绝在创建时立即收口为受控失败并 Abort Executor，不产生未处理 Promise。Runtime Shutdown 设置 Owner 中断门禁，在 Artifact 写入后和 REST 提交后都重新检查，并最终把尚未 `DONE` 的本地 Owner 收敛为 `INTERRUPTED/DONE`，不允许竞态停在 `READY/EVALUATION`，也不冒充用户取消。启动恢复把遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`。

## 观测与验收

记录 Run ID、Stage、Status、计数、时间和 Error Code，不记录完整 Vars、Provider Output、Prompt 或 Secret。创建冻结、REST 开始、REST 完成、取消请求和取消完成使用闭合中文业务事件；日志边界失败不得改变 Run 结果。计数非负且不超过总数，阶段时间不逆序。双进程同时启动阶段时只有一个成功。

## 相关测试

当前测试覆盖状态机、REST Result Hash、冻结一致性、阶段抢占、双进程唯一运行、跨进程取消/提交竞争、逐 Case结果、Artifact 流式提交/失败/孤儿清理、小型查询投影、轮询拒绝、Shutdown 提交竞态、大小/超时/并发边界和真实 HTTP API。Pipeline、Eval 复用、Retry/Force 和报告提交随对应阶段补充。
