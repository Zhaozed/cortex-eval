# Application Runs

## 模块职责

该 Feature 负责运行创建、输入冻结、REST/Evaluation/Report 阶段推进、取消、恢复、进度计数、版本化重跑和唯一活跃执行约束。

模块不实现 HTTP 请求、Promptfoo 协议、模型 SDK 或报告纯计算。

## 边界与依赖

Feature 当前依赖 Domain Run 规则、资源与 Run/Eval Repository、Transaction Manager、REST/Evaluation Engine、纯 Reporting 边界、Run Artifact Store、Clock 和 ID Generator。

能力按阶段注册。REST、Eval、Report 和 Analysis 只有在各自闭环落地后才进入 API、CLI、Web 导航和 OpenAPI；未实现能力不提供占位入口。

## 实现状态

平台 Run 已闭合预检与创建、冻结上下文、REST/Evaluation/Report 抢占和执行、逐 Case 结果、Artifact 提交、Pipeline 自动推进、取消、Runtime Shutdown、启动恢复、分页查询、Artifact 检查和对外 Retry/Force。全库唯一 `RUNNING`、跨进程取消与提交竞争由真实 SQLite 条件写和部分唯一索引收敛。完整 Report 提交后进入 `COMPLETED/DONE` 或 `COMPLETED_WITH_ERRORS/DONE`；离线完整报告通过 Execution Imports 原子建立只读终态 Run。

## 目标代码落点

`packages/application/src/features/runs`

## 当前代码事实入口

- [platform-run-service.ts](../../packages/application/src/features/runs/platform-run-service.ts)：Run 预检、冻结、REST 编排、取消与恢复。
- [platform-run-models.ts](../../packages/application/src/features/runs/platform-run-models.ts)：冻结 Run、结果、分页和执行限制模型。
- [platform-run-ports.ts](../../packages/application/src/features/runs/platform-run-ports.ts)：短事务、资源读取与 Run Repository Port。
- [run-artifact-port.ts](../../packages/application/src/features/runs/run-artifact-port.ts)：不可变 Run Artifact 边界。
- [run-rest-models.ts](../../packages/application/src/features/runs/run-rest-models.ts)：REST Executor 输入与受控结果。
- [platform-rerun-planner.ts](../../packages/application/src/features/runs/platform-rerun-planner.ts)：`RETRY_FAILED` 与 `FORCE` 的纯内部逐 Case 选择规则。
- [platform-rerun-service.ts](../../packages/application/src/features/runs/platform-rerun-service.ts)：创建新版本 Run、预置可复用 REST 事实并保持来源不可变。
- [platform-report-service.ts](../../packages/application/src/features/reporting/platform-report-service.ts)：平台 Report 对账、Artifact 发布、终态提交和统一查询。
- [report-aggregation-boundary.ts](../../packages/application/src/features/reporting/report-aggregation-boundary.ts)：Application 对纯 Reporting 的稳定依赖边界。
- [platform-eval-models.ts](../../packages/application/src/features/evaluation/platform-eval-models.ts)：规范化平台 Eval 结果、分页、进度和复用来源模型。
- [platform-eval-ports.ts](../../packages/application/src/features/evaluation/platform-eval-ports.ts)：完整 Eval 集合原子提交与查询 Port。
- [platform-evaluation-service.ts](../../packages/application/src/features/evaluation/platform-evaluation-service.ts)：Evaluation 抢占、外部执行、Artifact、取消、复用和提交编排。
- [platform-evaluation-reuse-reader.ts](../../packages/application/src/features/evaluation/platform-evaluation-reuse-reader.ts)：沿 Run Provenance 读取实际 Artifact 支撑的多代可复用 Eval 事实。
- [promptfoo-result-importer.ts](../../packages/application/src/features/evaluation/promptfoo-result-importer.ts)：固定版本 Raw Result、实际评分 Output 与冻结 REST Output、完整 Definition Hash、Assertion Set 展开、Guardrail 特殊聚合、三种 `is-json` Schema、Diff、Metric、结果 Hash 和通用重复/缺失/错位对齐的严格 Application 规范化边界。

## 当前样例与测试入口

- [platform-run-service.test.ts](../../packages/application/test/platform-run-service.test.ts)：冻结、提交、取消、Shutdown 与 Artifact 失败。
- [sqlite-platform-run-repository.test.ts](../../packages/storage-sqlite/test/sqlite-platform-run-repository.test.ts)：真实 SQLite 抢占、竞争、恢复与查询。
- [run-api.test.ts](../../apps/local-server/test/run-api.test.ts)：真实 SQLite、HTTP、Artifact 与逐 Case REST 闭环。
- [promptfoo-result-importer.test.ts](../../packages/application/test/promptfoo-result-importer.test.ts)：严格成功导入、完整身份、集合展开/聚合、三种 JSON Schema、Validator 差异和未闭环 Bridge 证据拒绝。
- [platform-rerun-planner.test.ts](../../packages/application/test/platform-rerun-planner.test.ts)：REST/Eval 复用、重评、重试、Force、顺序与来源对齐。

## 对外接口

当前 Use Case 覆盖 Preflight、Create Run、按 Stage 启动 REST/Evaluation/Report、Pipeline 自动推进、Get Progress、Cancel Run、Run 查询、逐 Case REST/Eval 查询、Report Overview/分页/详情，以及 Retry Run Failed/Force Run 创建。查询返回有界冻结摘要、阶段事实、REST/Eval 分类计数和完整 Report Summary，不返回完整冻结 Case 数组或 Prompt 正文。

## 核心流程

创建运行在一个短事务中读取并冻结 Suite、Cases、Endpoint、Evaluator、被引用 Rubric Prompts 和执行限制，计算上下文 Hash，写入 `READY/REST`。启动通过 Status、Stage、Revision 条件写抢占 `RUNNING/REST`，只在抢占时读取一次完整冻结执行输入；事务外执行 REST Adapter。每个真实结果幂等落库并推进计数，写入只校验目标冻结 Case 身份并返回小型进度，不重新加载完整 Run。完整结果对账后按 Cursor 单遍读取，增量计算 Result Set Hash 并流式写入不可变 Artifact，随后条件提交为 `READY/EVALUATION`。

Artifact 文件先写到 Run 专属受控路径，Manifest 只有在数据库阶段提交成功后才成为持久事实；提交竞争失败会删除未提交文件。启动清理只删除未被任何持久 Manifest 引用的受控 Artifact。

Retry Run Failed 与 Force Run Use Case 已固定逐 Case 复用、重评和重试规则。SQLite 对复用的 REST/Eval 来源 Run、Case、状态、Manifest 和语义 Hash 做精确对账；Artifact Store 在重跑规划与实际 Evaluation 两处校验立即来源 Normalized 文件，并沿 Provenance 追溯真正持有 Raw 的祖先文件，全部为 `PRESENT` 且 Hash/大小匹配才复用。缺失、损坏、断链或循环时不复用 Eval。Eval 复用必须绑定已复用的 REST。Use Case 只接受具有完整冻结上下文且不处于 `READY/RUNNING` 的平台来源，创建新 Run 版本；REST/Evaluation 只派发未复用 Case，Force 全量执行。单 Case Eval Result Hash 可复用，但完整 Evaluation 与 Report Result Set Hash 显式绑定新 Run 和本次上下文，所以全复用路径也生成新版本。来源 Run 不修改。

Report Start 以 Status、Stage 和 Revision 抢占 `READY/REPORT`，按 Cursor 对齐冻结 Case、REST 与 Evaluation 事实，在内存只保留计数和 Metric 桶。JSON 与 Markdown Artifact 成对发布，数据库只在两者完整且 Summary/Hash 对账成功后提交终态。Pipeline 自动交接 Report；STAGED 由显式动作启动。任一缺失、错位、重复 Metric 或 Hash 失败不提交伪造 Report。

Normalized Evaluation Artifact Writer 只接受与冻结结果顺序一致的单遍流：Ordinal 必须从 `0` 连续递增、Case Key 唯一。它在临时文件内验证每项 Schema，并用同一 Owner 与 Evaluation Context Hash 复算 Result Set Hash；任一错位、重复或 Hash 不一致都清理临时文件，不发布 Artifact。

PIPELINE 在 REST 提交后的固定交接 Revision 启动 Evaluation。Starter 返回失败或直接拒绝 Promise 都进入同一收口；只有 Run 仍处于该 `READY/EVALUATION` Revision 时才写入 `EVALUATION_STAGE_FAILED`，其他 Owner 已推进时保持最新事实。

Evaluation Start 先在短事务中读取候选 Run 并校验 Stage/Revision，再读取当前 REST 与可复用 Eval 事实；事务外只对 REST 成功、未复用且会进入 Promptfoo 的冻结 Case 所需 Python/Ruby 执行真实内联能力检查。REST Error 与完整复用 Case 不要求解释器。失败不抢占 Stage；检查通过后才以新的短事务执行全局运行与 Revision 条件抢占，竞态仍由 CAS 收敛。

Importer 把 Promptfoo Raw 视为脏边界。`failureReason=2` 只有在非空 Error、`gradingResult=null`、`score=0`、无 Response、非负耗时/成本、空 Named Scores 与合法 Token Usage 全部符合固定版本形状时才归一化；矛盾或缺失字段拒绝整次导入。规范化 Evaluation Error 只保存稳定 Code，Hash、Artifact 和 SQLite 不保存消息；Web 用消息资源显示可读说明。

## 状态、事务与幂等

合法 Run Status 为 `READY`、`RUNNING`、`COMPLETED`、`COMPLETED_WITH_ERRORS`、`FAILED`、`CANCELLED` 和 `INTERRUPTED`。Stage 为 `REST`、`EVALUATION`、`REPORT` 和 `DONE`。所有转换校验 Status、Stage 和 Lock Revision。

全库最多一条 `RUNNING`。终态不可重入。冻结后只使用 Snapshot，不读取当前资源。

平台 Create Run 接受并冻结 `RunExecutionLimitsV1`：REST 默认来自 Endpoint 配置且新建 Endpoint 默认为 4，Eval 默认 2，范围 1–64 和 1–16。限制进入 Run Snapshot 与 Context Hash；REST Adapter 的最大在途数服从冻结值。Analysis 限制由独立 Analysis 请求冻结，不属于原 Run Context。

## 错误收敛

单 Case REST Error 作为结果事实继续收口。阶段系统错误将当前 Run 收敛为 `FAILED/DONE`。逐 Case 持久化失败由 REST Executor 内部 Abort 并等待全部 Worker 退出后才返回 Application，因此后台 Owner 不会在外部 POST 或回调仍运行时释放。用户取消先持久化请求，再 Abort 本地 Owner；跨进程 Owner 在 25–50 毫秒轮询内观察请求。取消轮询的拒绝在创建时立即收口为受控失败并 Abort Executor，不产生未处理 Promise。Runtime Shutdown 设置 Owner 中断门禁，在 Artifact 写入后和 REST 提交后都重新检查，并最终把尚未 `DONE` 的本地 Owner 收敛为 `INTERRUPTED/DONE`，不允许竞态停在 `READY/EVALUATION`，也不冒充用户取消。启动恢复把遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`。

Report Artifact 生成完成不等于 Report 已提交。Application 在发布 Artifact 后重新读取持久取消/中断事实；若输出因此被丢弃，取消或中断终态使用观察到该请求之后重新获取的时间，禁止沿用 Artifact 生成时间，也禁止终态时间早于取消请求。只有 Report 事务成功提交时，Artifact 生成完成时间才进入已提交的 Report 版本事实。

## 观测与验收

记录 Run ID、Stage、Status、计数、时间和 Error Code，不记录完整 Vars、Provider Output、Prompt 或 Secret。创建冻结、REST 开始、REST 完成、取消请求和取消完成使用闭合中文业务事件；日志边界失败不得改变 Run 结果。计数非负且不超过总数，阶段时间不逆序。双进程同时启动阶段时只有一个成功。

## 相关测试

当前测试覆盖状态机、REST/Eval/Report Result Hash、冻结一致性、阶段抢占、三阶段 Pipeline、双进程唯一运行、跨进程取消/提交竞争、逐 Case结果、Artifact 提交/失败/孤儿清理、小型查询投影、轮询拒绝、Shutdown 竞态、大小/超时/并发边界、真实 HTTP API、Eval/Report 原子提交/回滚/分页、REST/Eval Provenance、官方模型 SDK 和对外 Retry/Force。
