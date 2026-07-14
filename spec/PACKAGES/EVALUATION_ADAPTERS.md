# Evaluation Adapters

## 模块职责

Evaluation Adapters 实现 REST、Promptfoo 和 Analysis Model 三类外部副作用，将外部协议转换为受控执行结果或结构化错误。P5 已闭合 REST；P6 已落地受控 Promptfoo 配置/进程、Evaluator Bridge v2 和冻结 Evaluator 官方 SDK Adapter。严格 Promptfoo Result Importer 属于依赖 Domain 与 Reporting 的 Application 规范化边界，不放入 Infrastructure Adapter。

模块不读取平台当前资源，不决定 Run 状态机，不写多个业务聚合，不把第三方对象直接作为平台事实。

## 边界与依赖

Package 实现 Application Port，依赖 Contracts 边界 Schema 和外部运行库。输入必须是已校验的冻结上下文。

三个适配边界保留在同一 Package 文档中。真实代码形成独立稳定子模块并需要独立维护时，再拆分文档和更新索引。

## 实现状态

P5 已建立 `packages/evaluation-adapters` 并落地 Fetch REST Executor。当前实现覆盖受控 URL 模板、RFC 6901 Selector、EnvSecretRef、精确请求/响应上限、并发、超时、取消、手动 Redirect、严格 Provider Output 和闭合错误分类。P6 已落地无 Assertion 类型白名单的配置物化、固定版本子进程、Bridge v2、Gemini/OpenAI-compatible Evaluator Client；Analysis Model Client 属于后续阶段。

## 代码落点

`packages/evaluation-adapters`

## 当前代码事实入口

- [rest-request-preparer.ts](../../packages/evaluation-adapters/src/rest-request-preparer.ts)：模板、Selector、Header、Secret 与 5 MiB 请求边界。
- [fetch-rest-executor.ts](../../packages/evaluation-adapters/src/fetch-rest-executor.ts)：受控 Fetch、并发、取消、10 MiB 响应和结果映射。
- [promptfoo-config-materializer.ts](../../packages/evaluation-adapters/src/promptfoo-config-materializer.ts)：无类型白名单的 Case Assertion 物化、Rubric Prompt 映射和确定性调用预算。
- [promptfoo-evaluation-process.ts](../../packages/evaluation-adapters/src/promptfoo-evaluation-process.ts)：固定版本、无 Shell、无缓存/分享、退出码、独立进程组和完整后代回收。
- [promptfoo-temporary-directory.ts](../../packages/evaluation-adapters/src/promptfoo-temporary-directory.ts)：显式项目 Root、逐级 `lstat + realpath` containment、符号链接拒绝和 owner-only 临时目录。
- [promptfoo-runtime-preflight.ts](../../packages/evaluation-adapters/src/promptfoo-runtime-preflight.ts)：冻结 Assertion 解释器依赖投影和阶段前真实内联 Smoke。
- [evaluator-bridge-v2.ts](../../packages/evaluation-adapters/src/evaluator-bridge-v2.ts)：Evaluation 调用期 Capability、预算、FIFO 并发、TTL、超时和取消。
- [frozen-evaluator-model-client.ts](../../packages/evaluation-adapters/src/frozen-evaluator-model-client.ts)：官方 SDK、无自动重试、冻结配置和环境 Secret 边界。
- [evaluator-model-errors.ts](../../packages/evaluation-adapters/src/evaluator-model-errors.ts)：SDK HTTP 状态到闭合 Provider Error Code 的安全映射。

## 当前样例与测试入口

- [rest-request-preparer.test.ts](../../packages/evaluation-adapters/test/rest-request-preparer.test.ts)：模板、Selector、Secret 和请求边界。
- [rest-http-executor.test.ts](../../packages/evaluation-adapters/test/rest-http-executor.test.ts)：真实本地 HTTP、响应边界、取消与最大在途数。
- [provider.json](../../test_suite/current/provider.json)：当前 Endpoint Fixture。

## 对外接口

当前 REST Executor 接收 Frozen Cases、Endpoint、Abort Signal、冻结并发限制和逐 Case 结果回调。Promptfoo 子模块接收冻结 Case/REST/Evaluator/Prompt 和 Abort Signal；Analysis Model Client 尚无运行时能力。

## 核心流程

REST Adapter 解析受控模板语法和 RFC 6901 Selector，展开 EnvSecretRef，限制并发并校验 Provider Output。URL 变量可以选择 `vars` 下任意层级标量叶子，不使用变量名白名单，但不能替换协议、Host 或端口。

单个 Case 在网络前完成模板、Selector、Header、Secret 和 UTF-8 请求大小校验。Fetch 固定 `POST`、`redirect: manual` 和组合 Abort Signal；只有 HTTP 2xx 才读取有界响应并校验 Provider Output。合法 `ok=false` 是成功事实。

Promptfoo 的物化不按 Assertion 类型设置平台白名单。锁定版本真实进程探针证明默认 Grading HTTP Provider 请求不携带 Assertion 身份，因此 Bridge v2 不接收 Case、Assertion、Metric 或组件身份，而以 Evaluation 调用期总预算和 FIFO 并发限制保护冻结 Evaluator。Metric、完整 Definition 和组件结构只在 Raw Result/Importer 中对齐。`select-best`、`max-score` 等类型可进入配置；平台不复现、替代或限制其执行流程。排队请求取得并发槽后必须重新校验 TTL；过期时不调用 Evaluator，并释放槽位。官方 SDK 未提供完整 Token Usage 时保持 `null`，Promptfoo HTTP Provider 省略 Usage 映射；Bridge 对调用与超时/关闭信号做受控竞速，上游忽略 Abort 时仍能结束 HTTP 与 Owner，并为迟到 Promise 安装终态处理。

可信内联 Assertion 能读取子进程环境。进程 Adapter 因此只透传运行必需的 `PATH`、用户/临时目录、Locale 与 Python/Ruby 解释器选择器，再注入当前 Capability 和固定关闭开关；父进程其他 Secret 不可见。Contracts 与物化器共享外部引用和配置安全判定；引用协议忽略前导空白与大小写，配置键同时拒绝 Provider/OAuth/认证/Secret、模块和依赖入口。Promptfoo JSON 输出在离开临时目录前递归检查字符串值和对象键；若包含完整 Capability，则以稳定系统错误拒绝整次输出，Application 不会收到或持久化污染 Raw。临时父目录必须是显式项目 Root 的 lexical/canonical 子路径；逐级拒绝符号链接和非目录后才允许创建或改权限。Engine 的整体预算同时派生 Bridge TTL 和进程剩余预算；版本检查与 Eval 共享同一单调截止时间。取消与超时作用于独立 POSIX 进程组；主进程提前关闭时继续等待后代，并保留从首次 TERM 起算的剩余宽限期，耗尽后才 KILL，确认进程组消失后才返回、关闭 Bridge 和回收目录。Evaluation Stage 抢占前通过同一固定 Promptfoo 进程，只对 REST 成功、未复用、实际进入 Promptfoo 的 Case 所需 Python/Ruby 各运行一个内联 Assertion Smoke。

## 状态、事务与幂等

REST Adapter 不持有数据库事务。取消通过 Abort Signal 传播；Worker 在 Abort 后不再领取新 Case，已领取请求返回 `CANCELLED` 事实。任一逐 Case 结果回调失败时，Executor 记录首个失败、内部 Abort 其他 Worker、停止领取新 Case 并等待所有 Worker 退出；已经忽略 Abort 的边界也必须回到同一 Owner 后才拒绝。失败后的迟到结果不再调用持久化回调。REST 不自动重试。

## 错误收敛

REST 错误闭合为 `TIMEOUT`、`NETWORK`、`HTTP_STATUS`、`RESPONSE_PARSE`、`PROVIDER_OUTPUT_INVALID`、`TEMPLATE_INPUT` 和 `CANCELLED`，不附加原始正文、Secret 或第三方异常。响应超限不暴露截断正文，也不写 Provider Output。

## 观测与验收

上层只记录安全请求身份、耗时和 Error Code，不记录完整 Vars、Provider Output、Prompt、Secret 或第三方堆栈。REST Executor 本身不记录脏输入。

## 相关测试

当前测试覆盖 REST HTTP、网络、状态码、解析、Provider Output、模板、Selector、Secret、合法 `ok=false`、请求/响应大小边界、超时、取消、并发和 Worker 收口。P6 已覆盖无类型白名单的矩阵 Assert 构建、递归 config 安全边界、紧凑组合敏感键及大小写/前导空白外部引用绕过拒绝、Bridge Capability/绑定/预算/FIFO 并发/精确 Host/排队 TTL 复验/非协作上游的超时与关闭、Provider 400/422、双官方 SDK 无重试与无认证 Header、固定 Promptfoo 真实进程、版本检查共享整体截止时间、有界诊断输出、Root 外路径与临时父目录符号链接拒绝、主进程提前退出时后代保留剩余 TERM 宽限期、函数返回前完整进程组回收、非零及缺失 Token Usage、内联执行错误清洗、Rubric Prompt 身份恢复和严格 Importer。Evaluator Promise 在超时或关闭后若忽略 Abort，HTTP 与 Owner 可以先收口，但真实并发槽持续占用到该 Promise 自身结束；关闭后的统计仍反映无法强制终止的实际在途调用，且监听器关闭后不再接收新调用。平台不逐类复现或限制 Promptfoo Assert 执行；Analysis 测试属于后续阶段。
