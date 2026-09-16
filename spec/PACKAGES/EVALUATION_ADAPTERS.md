# Evaluation Adapters

## 模块职责

Evaluation Adapters 实现 REST、Promptfoo 和 Analysis Model 三类外部副作用，将外部协议转换为受控执行结果或结构化错误。P5 已闭合 REST；P6 已落地受控 Promptfoo 配置/进程、Evaluator Bridge v2 和冻结 Evaluator 官方 SDK Adapter。严格 Promptfoo Result Importer 属于依赖 Domain 与 Reporting 的 Application 规范化边界，不放入 Infrastructure Adapter。

模块不读取平台当前资源，不决定 Run 状态机，不写多个业务聚合，不把第三方对象直接作为平台事实。

## 边界与依赖

Package 实现 Application Port，依赖 Contracts 边界 Schema 和外部运行库。输入必须是已校验的冻结上下文。

三个适配边界保留在同一 Package 文档中。真实代码形成独立稳定子模块并需要独立维护时，再拆分文档和更新索引。

## 实现状态

P5 已建立 `packages/evaluation-adapters` 并落地 Fetch REST Executor。当前实现覆盖受控 URL 模板、RFC 6901 Selector、EnvSecretRef、精确请求/响应上限、并发、超时、取消、手动 Redirect、严格 Provider Output 和闭合错误分类。P6 已落地无 Assertion 类型白名单的配置物化、固定版本子进程、Bridge v2、Gemini/OpenAI-compatible Evaluator Client。P9 已完成不经过 Bridge 的 Gemini/OpenAI-compatible Analyzer Client，以及平台和离线 Analysis 入口闭环。

## 代码落点

`packages/evaluation-adapters`

## 当前代码事实入口

- [rest-request-preparer.ts](../../packages/evaluation-adapters/src/rest-request-preparer.ts)：模板、Selector、Header、Secret 与 5 MiB 请求边界。
- [fetch-rest-executor.ts](../../packages/evaluation-adapters/src/fetch-rest-executor.ts)：受控 Fetch、并发、取消、10 MiB 响应和结果映射。
- [promptfoo-config-materializer.ts](../../packages/evaluation-adapters/src/promptfoo-config-materializer.ts)：无类型白名单的 Case Assertion 物化、Rubric Prompt 映射和确定性调用预算。
- [promptfoo-evaluation-process.ts](../../packages/evaluation-adapters/src/promptfoo-evaluation-process.ts)：固定版本、无 Shell、无缓存/分享、退出码、独立进程组和完整后代回收。
- [promptfoo-raw-result-stream.ts](../../packages/evaluation-adapters/src/promptfoo-raw-result-stream.ts)：固定版本 JSON Token 校验与逐 Raw Row 背压解析。
- [promptfoo-raw-file-source.ts](../../packages/evaluation-adapters/src/promptfoo-raw-file-source.ts)：不暴露路径的可重放字节/Row Source 与显式目录回收。
- [promptfoo-temporary-directory.ts](../../packages/evaluation-adapters/src/promptfoo-temporary-directory.ts)：显式项目 Root、逐级 `lstat + realpath` containment、符号链接拒绝和 owner-only 临时目录。
- [promptfoo-runtime-preflight.ts](../../packages/evaluation-adapters/src/promptfoo-runtime-preflight.ts)：冻结 Assertion 解释器依赖投影和阶段前真实内联 Smoke。
- [evaluator-bridge-v2.ts](../../packages/evaluation-adapters/src/evaluator-bridge-v2.ts)：Evaluation 调用期 Capability、预算、FIFO 并发、TTL、超时和取消。
- [frozen-evaluator-model-client.ts](../../packages/evaluation-adapters/src/frozen-evaluator-model-client.ts)：官方 SDK、无自动重试、冻结配置和环境 Secret 边界。
- [evaluator-model-errors.ts](../../packages/evaluation-adapters/src/evaluator-model-errors.ts)：SDK HTTP 状态到闭合 Provider Error Code 的安全映射。
- [frozen-analyzer-model-client.ts](../../packages/evaluation-adapters/src/frozen-analyzer-model-client.ts)：Analyzer 官方 SDK、`JSON_SCHEMA | JSON_OBJECT` 精确映射、严格响应校验、大小、取消和无重试边界。
- [gemini-analysis-output-schema.ts](../../packages/evaluation-adapters/src/gemini-analysis-output-schema.ts)：Gemini 稳定支持的顶层 Analysis/Evidence Schema；递归 Proposal 由响应边界的完整共享契约继续校验。
- [analyzer-model-errors.ts](../../packages/evaluation-adapters/src/analyzer-model-errors.ts)：Analyzer 安全错误收敛。

## 当前样例与测试入口

- [rest-request-preparer.test.ts](../../packages/evaluation-adapters/test/rest-request-preparer.test.ts)：模板、Selector、Secret 和请求边界。
- [rest-http-executor.test.ts](../../packages/evaluation-adapters/test/rest-http-executor.test.ts)：真实本地 HTTP、响应边界、取消与最大在途数。
- [provider.json](../../test_suite/current/provider.json)：当前 Endpoint Fixture。

## 对外接口

当前 REST Executor 接收 Frozen Cases、Endpoint、Abort Signal、冻结并发限制和逐 Case 结果回调。Promptfoo 子模块接收冻结 Case/REST/Evaluator/Prompt 和 Abort Signal。Analysis Model Client 直接接收冻结 Analyzer、Prompt、六个结构化变量和 Abort Signal，不调用 Evaluator Bridge。Gemini `JSON_SCHEMA` 只把 Provider 稳定支持的顶层结构用于生成约束，返回值仍由完整共享 Schema 严格解析；无效 Proposal 不得进入 Domain。

## 核心流程

REST Adapter 解析受控模板语法和 RFC 6901 Selector，展开 EnvSecretRef，限制并发并校验 Provider Output。URL 变量可以选择 `vars` 下任意层级标量叶子，不使用变量名白名单，但不能替换协议、Host 或端口。

单个 Case 在网络前完成模板、Selector、Header、Secret 和 UTF-8 请求大小校验。Fetch 固定 `POST`、`redirect: manual` 和组合 Abort Signal；只有 HTTP 2xx 才读取有界响应并校验 Provider Output。合法 `ok=false` 是已完成的 REST 响应事实，不是业务成功；可选 `parsed_output` 作为部分证据保留。

Promptfoo 的物化不按 Assertion 类型设置平台白名单。锁定版本真实进程探针证明默认 Grading HTTP Provider 请求不携带 Assertion 身份，因此 Bridge v2 不接收 Case、Assertion、Metric 或组件身份，而以 Evaluation 调用期总预算和 FIFO 并发限制保护冻结 Evaluator。Metric、完整 Definition 和组件结构只在 Raw Result/Importer 中对齐。`select-best`、`max-score` 等类型可进入配置；平台不复现、替代或限制其执行流程。排队请求取得并发槽后必须重新校验 TTL；过期时不调用 Evaluator，并释放槽位。官方 SDK 未提供完整 Token Usage 时保持 `null`，Promptfoo HTTP Provider 省略 Usage 映射；Bridge 对调用与超时/关闭信号做受控竞速，上游忽略 Abort 时仍能结束 HTTP 与 Owner，并为迟到 Promise 安装终态处理。

可信内联 Assertion 能读取子进程环境。进程 Adapter 因此只透传运行必需的 `PATH`、用户/临时目录、Locale 与 Python/Ruby 解释器选择器，再注入当前 Capability 和固定关闭开关；父进程其他 Secret 不可见。Contracts 与物化器共享外部引用和配置安全判定；引用协议忽略前导空白与大小写，配置键同时拒绝 Provider/OAuth/认证/Secret、模块和依赖入口。Promptfoo JSON 输出在离开 Adapter 边界前以 Token/Row 流检查固定版本、完整语法、字符串、对象键、逐 Row 大小和完整 Capability；通过后由私有文件 Source 向 Artifact Writer 重放原始字节、向 Importer 逐 Row 重放，不执行整文件 `readFile + JSON.parse`。任何检查失败都拒绝整次输出，Application 不会收到路径或污染 Raw；消费完成、导入失败、Artifact 失败和 Bridge 关闭失败都回收 Source。临时父目录必须是显式项目 Root 的 lexical/canonical 子路径；逐级拒绝符号链接和非目录后才允许创建或改权限。Engine 的整体预算同时派生 Bridge TTL 和进程剩余预算；版本检查与 Eval 共享同一单调截止时间。取消与超时作用于独立 POSIX 进程组；主进程提前关闭时继续等待后代，并保留从首次 TERM 起算的剩余宽限期，耗尽后才 KILL，确认进程组消失后才返回、关闭 Bridge 和回收目录。Evaluation Stage 抢占前始终先用只读子进程校验固定 Promptfoo 精确版本，再只对 REST 成功、未复用、实际进入 Promptfoo 的 Case 所需 Python/Ruby 各运行一个内联 Assertion Smoke；离线 Pipeline 还会在 REST 外部调用前读取完整 Evaluation 输入、验证 Prompt 引用并对完整冻结 Case 集合执行同一预检。

成功的固定版本探测只形成最长 30 秒的进程内证明。复用前重新 `realpath + stat` 并精确比较路径、设备、inode、大小、纳秒修改时间和纳秒变更时间；身份变化或证明过期立即重新运行版本子进程。Local Server 在组装时预热证明，Evaluation Runtime Preflight 仍在 Run 改变前复核身份。离线 Engine 对可重放 Case Source 执行两遍：首遍验证身份、顺序和预算，次遍流式写配置，并以标量计数拒绝两遍漂移。

## 状态、事务与幂等

REST Adapter 不持有数据库事务。取消通过 Abort Signal 传播；Worker 在 Abort 后不再领取新 Case，已领取请求返回 `CANCELLED` 事实。任一逐 Case 结果回调失败时，Executor 记录首个失败、内部 Abort 其他 Worker、停止领取新 Case 并等待所有 Worker 退出；已经忽略 Abort 的边界也必须回到同一 Owner 后才拒绝。失败后的迟到结果不再调用持久化回调。REST 不自动重试。

## 错误收敛

REST 错误闭合为 `TIMEOUT`、`NETWORK`、`HTTP_STATUS`、`RESPONSE_PARSE`、`PROVIDER_OUTPUT_INVALID`、`TEMPLATE_INPUT` 和 `CANCELLED`，不附加原始正文、Secret 或第三方异常。响应超限不暴露截断正文，也不写 Provider Output。

## 观测与验收

上层只记录安全请求身份、耗时和 Error Code，不记录完整 Vars、Provider Output、Prompt、Secret 或第三方堆栈。REST Executor 本身不记录脏输入。

## 相关测试

当前测试覆盖 REST HTTP、网络、状态码、解析、Provider Output、模板、Selector、Secret、合法 `ok=false`、请求/响应大小边界、超时、取消、并发和 Worker 收口。P6/P7 已覆盖无类型白名单的矩阵 Assert 构建、递归 config 安全边界、紧凑组合敏感键及大小写/前导空白外部引用绕过拒绝、Bridge Capability/绑定/预算/FIFO 并发/精确 Host/排队 TTL 复验/非协作上游的超时与关闭、Provider 400/422、双官方 SDK 无重试与无认证 Header、固定 Promptfoo 真实进程、普通 Assert 前的固定版本预检、Raw Row 在完整文档到达前背压交付、固定版本拒绝、版本检查共享整体截止时间、有界诊断输出、Root 外路径与临时父目录符号链接拒绝、主进程提前退出时后代保留剩余 TERM 宽限期、函数返回前完整进程组回收、真实子进程取消到 CLI 130、非零及缺失 Token Usage、内联执行错误清洗、Rubric Prompt 身份恢复和严格 Importer。P9 追加 Gemini/OpenAI-compatible Analyzer 严格结构输出、结构化 Evidence、大小、取消、无自动重试和安全错误收敛。Evaluator Promise 在超时或关闭后若忽略 Abort，HTTP 与 Owner 可以先收口，但真实并发槽持续占用到该 Promise 自身结束；关闭后的统计仍反映无法强制终止的实际在途调用，且监听器关闭后不再接收新调用。平台不逐类复现或限制 Promptfoo Assert 执行；Analyzer 不调用 Bridge。

## 冻结 Evaluator 的瞬态重试与错误分类

[frozen-evaluator-model-client.ts](../../packages/evaluation-adapters/src/frozen-evaluator-model-client.ts) 在 SDK 外层统一处理 Gemini 与 OpenAI-compatible 的 Provider 错误。SDK 内置重试仍关闭；Adapter 对已分类的限流、瞬态 HTTP 和网络故障最多尝试四次，采用有界退避或有上限的 Retry-After，并受 Bridge 的取消与整体超时约束。永久能力/鉴权/请求错误立即失败，不重试。此策略只作用于 Evaluator 模型调用，不扩大为 REST 业务请求、Analyzer 或失败 Run 的自动重跑。

[evaluator-model-errors.ts](../../packages/evaluation-adapters/src/evaluator-model-errors.ts) 是瞬态分类、Retry-After 和诊断清洗的事实入口。Provider 提示经脱敏和长度限制后才可展示；原始异常正文不能跨边界。Bridge 失败响应与 Promptfoo 配置的 grader-error 映射配合，Importer 将其区分为评测错误，而非断言质量失败。

[promptfoo-evaluation-process.ts](../../packages/evaluation-adapters/src/promptfoo-evaluation-process.ts) 禁用上游文件 debug/error logger，仍保留平台有界诊断；超限触发独立的诊断限额错误及进程组回收。这里只提取闭合错误签名，不持久化 stdout/stderr 原文。

测试入口为 [Evaluator Client 测试](../../packages/evaluation-adapters/test/frozen-evaluator-model-client.test.ts)、[Provider 错误测试](../../packages/evaluation-adapters/test/evaluator-model-errors.test.ts)、[Bridge 测试](../../packages/evaluation-adapters/test/evaluator-bridge-v2.test.ts) 和 [Promptfoo 进程测试](../../packages/evaluation-adapters/test/promptfoo-evaluation-process.test.ts)。

## 2026-09-15：模型裁判精简证据

受控配置语义升级为 `cortex.promptfoo-config.v2`，参与 Evaluation Context Hash；平台和离线执行共用该生成链路。REST 原件、Provider Output、Case 快照和确定性断言输入不裁剪，历史结果不改写。

- 对没有显式 `transform` 的 `llm-rubric` / `not-llm-rubric`，物化 Assertion 级 `cortex.grading-evidence.v1` 变换（包括嵌套 Assertion Set）。不使用全局输出变换。
- 只识别包含布尔 `ok` 和对象 `parsed_output` 的 Cortex 输出；从该证据节点及 `turns[].parsed_output` 删除 `llm_calls`。这样移除模型内部提示词、消息历史、工具定义与模型调用遥测，也消除顶层与末轮模型调用记录重复。
- 不做任意深度的同名字段删除，不修改 `tool_executions` 内的业务结果；不截断或摘要工具终态、资源 ID、时间、错误、逐轮回复、A2UI、请求或其他业务字段。非 Cortex 输出原样通过。
- 显式 `transform` 原样保留并优先。专门评估模型内部轨迹的 Rubric 可设置 `transform: output` 保留完整输入；已有自定义投影不被二次裁剪。
- Importer 只将精确匹配内置变换的 Raw Assertion 恢复到冻结身份；任意不同变换仍被身份校验拒绝。旧版无变换的历史 Raw 继续可导入。
- `RETRY_FAILED` 仍遵循原有结果复用语义；已有结果不会因为代码升级自动重评。新发生的模型裁判调用使用新投影。

代码入口：[证据投影](../../packages/application/src/features/evaluation/promptfoo-grading-evidence.ts)、[配置物化](../../packages/evaluation-adapters/src/promptfoo-config-materializer.ts)、[严格导入](../../packages/application/src/features/evaluation/promptfoo-result-importer.ts)。测试入口：[投影单测](../../packages/application/test/promptfoo-grading-evidence.test.ts)、[真实 Promptfoo + 本地模拟裁判集成测试](../../packages/evaluation-adapters/test/promptfoo-grading-evidence.test.ts)。
