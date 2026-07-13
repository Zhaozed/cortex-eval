# P3：Local API 与资源管理

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P2

## 目标

交付同源 Local API、资源管理闭环和横切基础设施，不提前暴露 Run 能力。

## 实现清单

- Fastify 同源提供 Web 静态资源和 `/api/v1`；默认 `127.0.0.1:4310`。
- 实现 Host、Origin、Request ID、统一 Error Response、OpenAPI 生成与漂移检查。
- 实现资源 CRUD、测试集整体导入/导出、配置验证、Prompt 引用查询、Cursor 分页和开发 Seed。
- 建立中文消息资源、业务事件、脱敏、单行文本日志格式和写失败 stderr 降级。
- 建立内部 SSE Event Hub 与 Snapshot 抽象，但不注册 Run Route 或 SSE URL。
- 测试集导入采用流式计数与受控临时文件。

## TDD 与验证

- API 集成测试覆盖分页、字段路径、并发冲突、Host/Origin、脱敏和 OpenAPI。
- 测试导入大小 `200 MiB-1`、恰好 `200 MiB`、`200 MiB+1`，以及取消和异常后的临时文件清理。
- 验证未实现 Run API 不存在于 OpenAPI。

## Spec 更新

- `spec/ENTRYPOINTS/LOCAL_SERVER.md`
- `spec/EXTERNAL_BEHAVIOR.md`
- `spec/ERROR_HANDLING.md`
- `spec/APPLICATION/TEST_SUITES.md`
- `spec/APPLICATION/CONFIGURATIONS.md`

## 完成标准

- 资源管理可以只通过 HTTP API 完成。
- API 不泄露 Secret、堆栈、SQL 或第三方原始错误。
- Run、Report、Analysis 能力尚未在入口层暴露。

## 完成证据

- `pnpm verify` 在 macOS ARM64、Node 24 下通过：65 个 Vitest 文件、252 个测试，Python 回归 5/5、TypeScript 回归 5/5，以及 Runtime Doctor、格式、Lint、架构、Strict TypeScript、OpenAPI 漂移、文档、Secret 和构建门禁全部通过。
- 全仓覆盖率为语句 90.05%、分支 85.45%、函数 90.27%、行 92.56%，未调整阈值。
- 真实 SQLite 与 HTTP 测试证明资源 CRUD、Cursor/过滤、导入导出、配置 Probe、Prompt 预览/引用、Host/Origin、稳定错误、默认日志和未注册未来 Route。
- Case 导入覆盖 `200 MiB-1`、恰好 `200 MiB`、合法数组后尾随空白达到 `200 MiB+1`、取消和异常清理；超限不提交 Case 或 Revision。导出在 200 前完成 Revision 校验，使用 owner-only 临时文件并覆盖正常、失败与取消清理。
- 真实回环 HTTP 证明 OpenAI-compatible `NONE` 不发送 Authorization；双 Provider 四档 Thinking、结构输出、配置超时与能力拒绝均由测试证明。
- 状态根、db、主库、WAL/SHM、临时根和工作区的 symlink/containment、owner 初始化窗口、PID 复用及失败回收均有真实文件系统测试；独立最终变更复审未发现 P0/P1/P2/P3。

## 阻塞条件

若大文件边界需要无界内存或无法保证清理，不交付导入接口，先修复流式边界。
