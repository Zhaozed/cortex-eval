# Evaluation Adapters

## 模块职责

Evaluation Adapters 实现 REST、Promptfoo 和 Analysis Model 三类外部副作用，将外部协议转换为受控执行结果或结构化错误。P5 当前只闭合 REST。

模块不读取平台当前资源，不决定 Run 状态机，不写多个业务聚合，不把第三方对象直接作为平台事实。

## 边界与依赖

Package 实现 Application Port，依赖 Contracts 边界 Schema 和外部运行库。输入必须是已校验的冻结上下文。

三个适配边界保留在同一 Package 文档中。真实代码形成独立稳定子模块并需要独立维护时，再拆分文档和更新索引。

## 实现状态

P5 已建立 `packages/evaluation-adapters` 并落地 Fetch REST Executor。当前实现覆盖受控 URL 模板、RFC 6901 Selector、EnvSecretRef、精确请求/响应上限、并发、超时、取消、手动 Redirect、严格 Provider Output 和闭合错误分类。Promptfoo Process 与 Analysis Model Client 尚未落地。

## 代码落点

`packages/evaluation-adapters`

## 当前代码事实入口

- [rest-request-preparer.ts](../../packages/evaluation-adapters/src/rest-request-preparer.ts)：模板、Selector、Header、Secret 与 5 MiB 请求边界。
- [fetch-rest-executor.ts](../../packages/evaluation-adapters/src/fetch-rest-executor.ts)：受控 Fetch、并发、取消、10 MiB 响应和结果映射。

## 当前样例与测试入口

- [rest-request-preparer.test.ts](../../packages/evaluation-adapters/test/rest-request-preparer.test.ts)：模板、Selector、Secret 和请求边界。
- [rest-http-executor.test.ts](../../packages/evaluation-adapters/test/rest-http-executor.test.ts)：真实本地 HTTP、响应边界、取消与最大在途数。
- [provider.json](../../test_suite/current/provider.json)：当前 Endpoint Fixture。

## 对外接口

当前 REST Executor 接收 Frozen Cases、Endpoint、Abort Signal、冻结并发限制和逐 Case 结果回调。Promptfoo Process 与 Analysis Model Client 的 Port 已由目标架构定义，但当前无运行时能力。

## 核心流程

REST Adapter 解析受控模板语法和 RFC 6901 Selector，展开 EnvSecretRef，限制并发并校验 Provider Output。URL 变量可以选择 `vars` 下任意层级标量叶子，不使用变量名白名单，但不能替换协议、Host 或端口。

单个 Case 在网络前完成模板、Selector、Header、Secret 和 UTF-8 请求大小校验。Fetch 固定 `POST`、`redirect: manual` 和组合 Abort Signal；只有 HTTP 2xx 才读取有界响应并校验 Provider Output。合法 `ok=false` 是成功事实。

Promptfoo 的物化、固定 `0.121.18` 子进程和 Evaluator Bridge 属于 P6。Evaluator 与 Analysis Adapter 属于后续阶段。

## 状态、事务与幂等

REST Adapter 不持有数据库事务。取消通过 Abort Signal 传播；Worker 在 Abort 后不再领取新 Case，已领取请求返回 `CANCELLED` 事实。任一逐 Case 结果回调失败时，Executor 记录首个失败、内部 Abort 其他 Worker、停止领取新 Case 并等待所有 Worker 退出；已经忽略 Abort 的边界也必须回到同一 Owner 后才拒绝。失败后的迟到结果不再调用持久化回调。REST 不自动重试。

## 错误收敛

REST 错误闭合为 `TIMEOUT`、`NETWORK`、`HTTP_STATUS`、`RESPONSE_PARSE`、`PROVIDER_OUTPUT_INVALID`、`TEMPLATE_INPUT` 和 `CANCELLED`，不附加原始正文、Secret 或第三方异常。响应超限不暴露截断正文，也不写 Provider Output。

## 观测与验收

上层只记录安全请求身份、耗时和 Error Code，不记录完整 Vars、Provider Output、Prompt、Secret 或第三方堆栈。REST Executor 本身不记录脏输入。

## 相关测试

当前测试覆盖 REST HTTP、网络、状态码、解析、Provider Output、模板、Selector、Secret、合法 `ok=false`、`5 MiB-1/5 MiB/+1` 请求、`10 MiB-1/10 MiB/+1` 响应、100 毫秒超时、取消、并发上限、停止派发，以及结果持久化失败后等待忽略 Abort 的 Worker 收口。Promptfoo、Bridge、Importer 和 Analysis 测试随 P6–P9 补充。
