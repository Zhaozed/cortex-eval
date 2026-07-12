# Evaluation Adapters

## 模块职责

Evaluation Adapters 实现 REST、Promptfoo 和 Analysis Model 三类外部副作用，将外部协议转换为受控执行结果或结构化错误。

模块不读取平台当前资源，不决定 Run 状态机，不写多个业务聚合，不把第三方对象直接作为平台事实。

## 边界与依赖

Package 实现 Application 的 Rest Executor、Promptfoo Process 和 Analysis Model Client Port，依赖 Contracts 边界 Schema和外部运行库。输入必须是已校验的冻结上下文。

三个适配边界当前保留在同一 Package 文档中。真实代码形成独立稳定子模块并需要独立维护时，再拆分文档和更新索引。

## 实现状态

目标 Package 尚未落地。当前 REST 运行器实现了局部请求、并发、超时、续跑和原子文件输出，其 Provider Output 与错误契约比目标系统宽松。

## 目标代码落点

`packages/evaluation-adapters`

## 当前代码事实入口

- [run_promptfoo_rest.ts](../../data_scripts/run_promptfoo_rest.ts)
- [run_promptfoo_rest_types.ts](../../data_scripts/run_promptfoo_rest_types.ts)

## 当前样例与测试入口

- [run_promptfoo_rest.test.ts](../../data_scripts/run_promptfoo_rest.test.ts)
- [provider.json](../../test_suite/current/provider.json)
- [pf_config.yaml](../../test_suite/current/pf_config.yaml)
- `test_suite/current/run_result/loona_promptfoo_tests.json`：当前未跟踪 REST 结果 Fixture。
- `test_suite/current/eval_result/result.json`：当前未跟踪 Promptfoo 结果 Fixture。

## 对外接口

REST Executor 接收 Frozen Cases、Endpoint、Abort Signal 和执行限制。Promptfoo Process 接收受控生成输入、版本和环境。Analysis Model Client 接收已渲染消息、模型配置和输出 Schema。

## 核心流程

REST Adapter 解析受控模板语法和 RFC 6901 Selector，展开 EnvSecretRef，限制并发并校验 Provider Output。URL 变量可以选择 `vars` 下任意层级标量叶子，不使用变量名白名单，但不能替换协议、Host 或端口。

Promptfoo Adapter 物化 REST 成功 Cases 和 Rubric Prompts，使用固定 `0.121.18` 可执行文件与参数数组启动子进程。主 Provider 使用预计算输出；Provider-dependent Assertion 通过临时回环 Evaluator Bridge 调用冻结 Run Evaluator，再由 Importer 对齐和规范化。

Evaluator 与 Analysis Adapter 使用统一 Gemini/OpenAI-compatible 官方 SDK 接口。Analysis Adapter 渲染允许变量，注入 Analyzer Secret，调用模型并返回待 Contracts 校验的结构化输出。

## 状态、事务与幂等

Adapter 不持有数据库事务。取消通过 Abort Signal 或子进程终止传播。Promptfoo 先 `SIGTERM`，5 秒后仍未退出则 `SIGKILL`。Adapter 不覆盖已完成 Artifact，REST、Evaluator、Analyzer、Bridge 和 Promptfoo Provider 均不自动重试。

## 错误收敛

REST 错误使用固定分类。Promptfoo Assertion 失败与系统失败严格区分。模型网络、Provider 和输出错误结构化返回。所有临时目录、文件句柄、Abort 资源和子进程在回收路径处理。

## 观测与验收

日志记录安全请求身份、版本、退出码、耗时、文件 Hash 和 Error Code，不记录完整 Vars、Provider Output、Prompt、Secret 或第三方堆栈。子进程不启用 Shell。

## 相关测试

目标测试覆盖 REST 全部错误与精确大小/超时边界、合法 `ok=false`、并发取消、Promptfoo 版本与退出码、全 Assertion 能力矩阵、可信内联语言、Bridge 身份与滥用防护、真实 Fixture Import、Analysis Schema、单次 SDK 调用、Secret 注入和资源回收。
