# P5：Run 与 REST 闭环

## 状态与依赖

- 状态：`PENDING`
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

## 阻塞条件

REST POST 不自动重试。外部副作用不确定时只保存 Error；平台重跑使用新 Run，离线重跑使用新 Execution。
