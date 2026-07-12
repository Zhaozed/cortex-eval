# P6：Promptfoo Evaluation 闭环

## 状态与依赖

- 状态：`PENDING`
- 依赖：P5

## 目标

使用 Promptfoo `0.121.18`、预计算 Provider Output 和统一 Evaluator Adapter 完成全部 Assertion 的可验证评估闭环。

## 实现清单

- Promptfoo 主 Provider 只使用 Echo/预计算输出，不重新请求业务 Endpoint。
- 启动仅绑定随机回环端口的 Evaluator Bridge；Promptfoo 内置 HTTP Provider 通过一次性 Capability 调用 Bridge。
- Bridge 严格绑定 Run/Execution、Schema、调用预算、并发、超时和取消，不能作为任意转发器。
- Bridge 只调用冻结的 Gemini/OpenAI-compatible 官方 SDK Adapter；三层显式关闭自动重试。
- 生成配置拒绝 Assertion 内嵌 Provider、Secret、`file://`、外部模块和额外依赖。
- 支持能力矩阵中的全部类型、可信内联 JS/Python/Ruby、Transform、Context Transform 和嵌套 Assert Set。
- Importer 对齐 Case、Assertion、组件结果，生成 Not Evaluated、Hash 和结构化错误。
- 注册平台 Eval API、Web 和 REST→Eval Pipeline；离线 Eval CLI 统一在 P7 注册。
- 实现平台 `CreateRerunPlan` 选择规则与内部 Application Use Case：复制 REST `SUCCEEDED` 和对齐 Eval `PASS/FAIL`，重试 REST `ERROR`，重新评估 `EVALUATION_ERROR`、缺失 Eval 和新 REST 成功后的 `NOT_EVALUATED`，记录来源/复用 Hash 并生成新 Result Set Hash。Report 终态尚未闭环，本阶段不注册 Retry/Force API 或 Web 入口。

## TDD 与验证

- 数据驱动测试要求能力矩阵每项至少有正例、非法 Payload/能力错误和 Importer 对齐验证。
- 真实进程测试 JS/Python/Ruby、解释器缺失、Transform、Context Transform 和嵌套集合。
- 阶段启动前运行解释器能力检查；Python 与 Ruby 都必须在当前 macOS ARM64 环境成功执行内联 Assertion，并验证显式环境变量覆盖命令。
- Bridge 测试非法 Token、错误绑定、超预算、外部 Host、Schema、取消、超时和并发端口。
- Stub 断言一次评分只触发一次 SDK 调用；日志、临时配置和 Raw Evidence 不得含 Secret。
- Promptfoo SIGTERM，5 秒未退出 SIGKILL，并验证子进程、句柄和临时目录回收。
- 验证 Eval 并发默认 2、范围 1–16、Bridge/SDK 最大在途数、冻结后不可修改，以及内部重跑用例不修改来源 Run。
- 覆盖来源缺少完整 Eval Artifact、新 REST 成功后补 Eval、REST 仍失败保持 NOT_EVALUATED、复用 Provenance 和新 Result Set Hash。

## Spec 更新

- `spec/PACKAGES/EVALUATION_ADAPTERS.md`
- `spec/PACKAGES/CONTRACTS.md`
- `spec/APPLICATION/RUNS.md`
- `spec/WEB/RUNS.md`
- `spec/TEST.md`

## 完成标准

- 能力矩阵无未测试类型。
- Promptfoo 不能绕过统一 Evaluator Adapter 或覆盖 Provider。
- Assertion FAIL 与阶段系统失败严格区分。
- 平台重跑选择规则和内部用例完整，Retry/Force 入口等待 P8 终态 Report 闭环后注册。

## 阻塞条件

若 Promptfoo 内置 HTTP Provider 无法满足统一 Bridge 契约，提供最小复现并请求用户调整契约，不新增自定义 Provider 插件绕过决定。
