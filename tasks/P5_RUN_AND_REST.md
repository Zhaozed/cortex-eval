# P5：Run 与 REST 闭环

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P4

## 目标

交付真实可用的 REST 阶段、运行事实、进度、取消和恢复；只注册 REST 能力。

## 实现清单

- 实现冻结上下文、Run 状态机、唯一 `RUNNING`、阶段选择、锁 Revision、取消和启动恢复。
- Create Run API/Web 接受 `RunExecutionLimitsV1`；REST 默认来自 Endpoint、Eval 默认 2，冻结到 Run Snapshot 与 Context Hash。
- 注册 Run REST API、事实快照、SSE 进度和 Web REST 阶段页面。
- 建立基于来源冻结上下文创建新 Run 的内部重跑编排基础，但在 Eval 复用规则落地前不注册 Retry/Force 入口。
- REST 仅支持 POST；URL 可引用 `vars` 任意层级标量叶子，禁止替换协议/Host/端口。
- Body Selector 使用 RFC 6901 JSON Pointer；固定 Header Allowlist，其他 Header 使用 EnvSecretRef。
- 实现 HTTP/HTTPS、禁止 Redirect、Provider Output 联合、部分/全部失败和合法 `ok=false`。
- 保存 REST Artifact 元数据并提供中间逐 Case 结果。
- 为 Dashboard 注册最近平台 Run、阶段、状态和 Source Type 卡片；测试集列表显示最近平台 Run 状态。

## TDD 与验证

- 本地 Stub 覆盖 HTTP、网络、解析、超时、Provider Output、模板、Selector、Secret 和取消。
- 请求测试 `5 MiB-1`、恰好 `5 MiB`、超 1；响应测试 `10 MiB-1`、恰好 `10 MiB`、超 1。
- 超时测试 100 ms、10 分钟及上下越界；超限不得截断或写 Provider Output。
- 多进程测试唯一运行、取消/提交竞争、重启 Interrupted 和冻结/删除竞争。
- 验证停止派发、AbortSignal、临时资源清理和日志脱敏。
- 验证 REST 并发默认 4、范围 1–64、最大在途数和冻结后不可修改。

## Spec 更新

- `spec/APPLICATION/RUNS.md`
- `spec/PACKAGES/EVALUATION_ADAPTERS.md`
- `spec/WEB/RUNS.md`
- `spec/SYSTEM_FLOWS.md`
- `spec/ERROR_HANDLING.md`

## 完成标准

- REST 阶段可在 API 和 Web 完整执行并刷新恢复。
- Eval、Report、Analysis 入口仍未注册。
- 所有大小、超时、取消和并发门禁通过。

## 完成记录

- Contracts、Domain、Application、SQLite、REST Adapter、Local API、OpenAPI 与 Web 已形成同一 P5 闭环。
- Run 创建冻结 Suite、Endpoint、Evaluator、Rubric Prompts、执行限制与语义 Hash；启动、逐 Case 结果、Artifact、取消、跨进程唯一运行和启动恢复使用真实 SQLite 事实。
- Run Detail、动作、SSE、取消轮询和逐 Case 写入使用有界投影；Artifact 按 Cursor 单遍流式写入并增量计算 Hash。Shutdown/阶段提交和轮询拒绝竞态均由 Owner 收敛，Web 预检取消、创建响应身份、SSE 媒体类型与闭合 Run 生命周期日志已纳入回归。
- REST Worker 的结果持久化回调失败会内部 Abort、停止领取并等待全部 Worker 收口；SSE OpenAPI 分别声明 200 `text/event-stream` 与开流前 JSON 错误；Web 预检以单调请求代次拒绝 A→B→A 的迟到成功。
- SSE 开流后任意轮询、Schema 或写入失败都会结束响应并释放 Controller；同选择重新预检会立即失效上一代事实，本代失败不重新开放创建。
- 当前只允许启动 `REST`；REST 提交后停在 `READY/EVALUATION`。Evaluation、Report、Analysis、Retry/Force、Work Package 与目标 CLI 均未注册。
- 确定性阶段回归通过 100 个 Vitest 文件、541 项测试；完整 `pnpm verify` 的 V8 覆盖率为 Statements 90.33%、Branches 85.06%、Functions 91.81%、Lines 93.14%；生产 Playwright E2E 通过 7 项测试，并覆盖真实 REST Run 的创建、启动、刷新恢复、Case 明细与聚合展示。完整 `pnpm verify` 已通过。
- 四轮独立变更审查发现的有界读取、Shutdown/轮询、OpenAPI/日志、预检代次、Worker Owner 和 SSE 终止问题均已按 TDD 闭环；最后一项异步写侧监听是针对已定位问题的直接修复，由新增失败测试、类型、Lint 和完整门禁验证。阶段 Commit 由本文件所在提交记录。

## 阻塞条件

REST POST 不自动重试。外部副作用不确定时只保存 Error；平台重跑使用新 Run，离线重跑使用新 Execution。
