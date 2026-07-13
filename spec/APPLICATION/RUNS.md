# Application Runs

## 模块职责

该 Feature 负责运行创建、输入冻结、运行模式、阶段推进、取消、恢复、进度计数、最终报告提交和唯一活跃执行约束。

模块不实现 HTTP 请求、Promptfoo 协议、模型 SDK 或报告纯计算。

## 边界与依赖

Feature 依赖 Domain Run 规则、资源与 Run Repository、Transaction Manager、REST Executor、Promptfoo Process、Reporting、Clock 和 ID Generator。

能力按阶段注册。REST、Eval、Report 和 Analysis 只有在各自闭环落地后才进入 API、CLI、Web 导航和 OpenAPI；未实现能力不提供占位入口。

## 实现状态

P2 已落地十表 Run 持久化约束、当前资源 READY/RUNNING 删除保护、历史来源删除策略、全库唯一 `RUNNING` 部分索引和独立进程竞争证明。Create Run、资源冻结写入、阶段编排、取消与恢复仍从 P5 开始实现，未暴露任何 Run 入口。

## 目标代码落点

`packages/application/src/features/runs`

## 当前代码事实入口

- [run_promptfoo_rest.ts](../../data_scripts/run_promptfoo_rest.ts)
- [run_promptfoo_rest_types.ts](../../data_scripts/run_promptfoo_rest_types.ts)

## 当前样例与测试入口

- [run_promptfoo_rest.test.ts](../../data_scripts/run_promptfoo_rest.test.ts)
- `test_suite/current/run_result/test_example.json`：当前已提交 REST 结果 Fixture。
- `test_suite/current/eval_result/test_example.json`：当前已提交 Promptfoo 结果 Fixture。

## 对外接口

Use Case 覆盖 Create Run、Start Current Stage、Run Pipeline、Get Progress、Cancel Run、Build Report、Retry Run Failed 和 Force Run。查询接口返回冻结上下文、来源 Run、复用 Provenance、阶段事实和安全进度。

## 核心流程

创建运行在短事务中冻结资源并写入 `READY/REST`。阶段启动通过条件更新抢占 `RUNNING`，事务外执行 Adapter，再通过条件事务提交真实结果。Pipeline 在阶段成功提交后尝试抢占下一阶段。

Retry Run Failed 与 Force Run 只接受具有完整冻结上下文且不处于 READY/RUNNING 的来源 Run。两者复制来源 Snapshot 并创建新 Run ID。Retry 复制 REST `SUCCEEDED` 和对齐的 Eval `PASS/FAIL`，重新执行 REST `ERROR`、`EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED`；Force 重新执行全部 REST/Eval。每条复用事实保存来源身份与 Hash，新 Run 重新生成 Result Set Hash。

## 状态、事务与幂等

合法 Run Status 为 `READY`、`RUNNING`、`COMPLETED`、`COMPLETED_WITH_ERRORS`、`FAILED`、`CANCELLED` 和 `INTERRUPTED`。Stage 为 `REST`、`EVALUATION`、`REPORT` 和 `DONE`。所有转换校验 Status、Stage 和 Lock Revision。

全库最多一条 `RUNNING`。终态不可重入。冻结后只使用 Snapshot，不读取当前资源。

平台 Create Run 接受并冻结 `RunExecutionLimitsV1`：REST 默认来自 Endpoint 配置且新建 Endpoint 默认为 4，Eval 默认 2，范围 1–64 和 1–16。限制进入 Run Snapshot 与 Context Hash，Adapter 和 Bridge 的最大在途数必须服从冻结值。Analysis 限制由独立 Analysis 请求冻结，不属于原 Run Context。

## 错误收敛

单 Case REST Error 作为结果事实继续收口。阶段系统错误将当前 Run 收敛为 `FAILED/DONE`。取消只保留真实结果。启动恢复把遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`。

## 观测与验收

记录 Run ID、Stage、Status、计数、耗时和 Error Code。计数非负且不超过总数，阶段时间不逆序。双进程同时启动阶段时只有一个成功。

## 相关测试

目标测试覆盖状态机、冻结一致性、部分与全部 REST Error、Pipeline、阶段抢占、双进程竞争、取消提交竞争、恢复、平台 Retry/Force、来源缺少 Eval Artifact、新 REST 成功后补 Eval、复用 Provenance、新 Result Set Hash 和报告提交。
