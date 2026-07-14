# Web Runs

## 模块职责

该 Feature 提供平台 Run 预检、创建、REST/Evaluation 启动、进度、两阶段逐 Case 结果、取消和刷新恢复界面。当前不提供 Report、Analysis 或重跑动作。

模块不在浏览器推进状态机，不直接控制 REST 请求，也不把缓存视为运行事实。

## 边界与依赖

页面只依赖 Local Server Run API 和 Contracts。服务端 Run 状态是唯一事实源；TanStack Query 与 SSE 只负责及时重新读取事实。

## 实现状态

已注册 `/runs`、`/runs/:id`、导航和 Dashboard 最近平台 Run 卡片。详情支持 Evaluation 启动、结果查询及 Pipeline 自动推进后的刷新恢复。Report、Analysis、Retry/Force 和 Work Package 入口保持未注册。

## 代码落点

`apps/web/src/features/runs`

## 当前代码事实入口

- [run-list-page.tsx](../../apps/web/src/features/runs/run-list-page.tsx)：资源选择、预检门禁、执行限制和 Run 列表。
- [run-detail-page.tsx](../../apps/web/src/features/runs/run-detail-page.tsx)：状态、REST/Evaluation 分类进度、逐 Case 结果、启动与取消。
- [run-ui.ts](../../apps/web/src/features/runs/run-ui.ts)：状态和阶段的展示映射。
- [run-api.ts](../../apps/web/src/lib/run-api.ts)：严格 Run API、身份校验、Cursor 和 SSE Envelope 边界。

## 当前样例与测试入口

- [run-pages.test.tsx](../../apps/web/test/run-pages.test.tsx)：创建门禁、详情、启动、取消和页面能力隔离。
- [run-api.test.ts](../../apps/web/test/run-api.test.ts)：请求、响应身份和 SSE Schema。
- [run-test-fixture.ts](../../apps/web/test/run-test-fixture.ts)：测试专用 Run DTO 工厂。

## 对外接口

创建运行时选择 Test Suite、Endpoint、Evaluator 和 `STAGED`/`PIPELINE` 模式，可覆盖 `RunExecutionLimitsV1`。页面先调用 Preflight，展示 Case 数、Rubric 依赖、REST/Evaluation 所需 Env Key、Endpoint 超时和将被冻结的并发限制；选择改变、重新预检或卸载会 Abort 旧请求，并以单调请求代次和当前选择键共同拒绝迟到成功。重新预检在发请求前失效上一代事实；本代在途或失败时不展示旧事实、不允许创建。只有当前选择与当前代对应的预检成功后才能创建。

Run 列表使用服务端倒序 Cursor。详情只展示有界冻结摘要、阶段计数、Artifact 可用性和真实已完成 REST/Evaluation Case 结果，不加载冻结 Case 数组或 Prompt 正文。Evaluation 表逐 Case 展示 Status、Score、Reason、Evaluation Error、Metric；每条 Assertion 展示 Type、Metric、Status、Weight、Score 和 Reason。空值明确显示为无，不把错误文案推断成状态。

## 核心流程

1. 用户选择三个当前资源，页面取消旧预检并读取新选择的服务端事实。
2. 用户确认模式和限制后创建 `READY/REST` Run，并进入详情页。
3. Start 携带当前 `lockRevision`；接受后立即用小型进度事实更新展示，再读取完整详情。
4. REST 阶段展示总/完成/成功/错误；Evaluation 及后续阶段展示总/完成/PASS/FAIL/Error/Not Evaluated。批处理执行中完成数为真实的 0，原子提交后一次显示完整分类，不从当前分页明细推算。终态 `DONE` 不再猜测阶段：存在已提交 Evaluation 完成事实时显示 Evaluation 分类，否则显示 REST 计数，并且不请求不存在的 Evaluation 明细。
4. `RUNNING` 时页面订阅有限期 SSE，并保留查询刷新。每个 Snapshot/Event 必须通过 Schema 且绑定当前 Run ID；流结束、重连或错误只触发重新查询，不在浏览器推断新状态。
5. Cancel 携带最新 Revision。页面显示服务端已确认的取消请求和最终状态，不提前伪造 `CANCELLED`。

`STAGED` REST 完成后页面显示 `READY/EVALUATION` 并允许按最新 Revision 启动；Evaluation 完成后显示 `READY/REPORT`，不出现未闭环 Report 动作。

## 状态、事务与幂等

浏览器刷新或路由切换后重新查询 Run。`READY/REST` 或 `READY/EVALUATION` 显示对应阶段启动，`RUNNING` 显示取消；`READY/REPORT` 和终态不提供未闭环动作。重复点击由客户端单飞与服务端 Revision/状态条件共同收敛。

## 错误收敛

预检错误阻止创建。创建成功响应除 Schema 外还必须匹配请求固定的 Suite、Endpoint、Evaluator、Run Mode 和显式执行限制，否则按 `CLIENT_RESPONSE_INVALID` 拒绝。Run 不存在、Revision 冲突、全局运行冲突和未闭环 Stage 使用稳定错误显示。SSE 内容、Run ID 或响应 Schema 不合法时同样重新读取，不把脏数据放入 Query 缓存。

## 观测与验收

REST 展示总数、完成、成功和错误；逐 Case 表只显示真实结果。Dashboard 和 Test Suite 聚合只使用平台 `sourceType=PLATFORM` 事实。页面刷新不影响执行，部分或全部 REST Error 均按服务端事实展示。

## 相关测试

当前测试覆盖预检门禁、选择改变 Abort、迟到响应拒绝、创建参数和身份、Run 列表、详情、REST/Evaluation 启动与取消 Revision、Pipeline 刷新恢复、SSE 身份、两阶段逐 Case 结果、导航、Dashboard 和未来动作隔离。Report、Analysis 和 Retry/Force 随后续阶段补充。
