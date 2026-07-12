# Web Runs

## 模块职责

该 Feature 提供运行创建、输入预检、分阶段执行、一键执行、进度查看、中间结果、取消和刷新恢复界面。

模块不在浏览器推进状态机，不直接控制 REST 请求或 Promptfoo 子进程。

## 边界与依赖

页面依赖 Runs Application API。服务端运行状态是唯一事实源，前端缓存只用于展示。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`apps/web/src/features/runs`

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

- [run_promptfoo_rest.test.ts](../../data_scripts/run_promptfoo_rest.test.ts)
- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)

## 对外接口

创建运行时选择测试集、Endpoint、Evaluator、模式和 `RunExecutionLimitsV1`。启动前展示 Case 数、Rubric 依赖、所需 Env Key、REST/Eval 并发与 REST 超时；提交后冻结限制。

## 核心流程

分阶段页面依次展示已注册的 REST、Evaluation 和 Report 状态，允许在阶段边界查看事实并人工继续。Web Run Pipeline 默认 REST、Evaluation、Report，也可显式选择满足依赖的 Run Stage。Analysis 不属于 Run Stage，P9 完整闭环后只在 Report 完成页面提供独立入口。

## 状态、事务与幂等

页面刷新后重新查询 Run。`READY` 表示可继续，`RUNNING` 表示当前阶段执行中，终态不可再次启动。重复点击由服务端条件状态转换收敛。

具有完整冻结上下文且不处于 READY/RUNNING 的来源 Run 提供“重跑系统失败”和“强制全量重跑”。操作创建新 Run，页面展示 Source Run、Rerun Mode、复用数量和新 Run 链接，不修改来源页面事实。

## 错误收敛

系统错误停止自动推进并展示稳定 Error Code 与已完成事实。取消显示请求中和最终状态，不把未确认状态提前标为已取消。

## 观测与验收

REST 展示总数、完成、成功和错误；Evaluation 展示通过、失败、错误和未评估。页面刷新不影响执行，部分或全部 REST Error 均按服务端事实展示。

## 相关测试

目标测试覆盖创建预检、分阶段、一键、刷新恢复、阶段冲突、取消、部分失败、全部失败、平台 Retry/Force、来源与复用展示和进度计数。
