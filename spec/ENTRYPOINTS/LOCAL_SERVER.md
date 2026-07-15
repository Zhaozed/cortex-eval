# Local Server

## 模块职责

Local Server 启动本地 HTTP 服务，装配 Application、Repository 和外部 Adapter，负责 Route、协议 Mapper、生命周期和安全入口。

模块不保存业务规则，不直接计算统计、转换运行状态或解析第三方业务结果。

## 边界与依赖

Local Server 依赖 Contracts、Application 和具体 Infrastructure 实现。Route 只接收已校验 DTO，Mapper 负责 DTO 与 Application 输入输出转换。

只有 Local Server 写平台 SQLite。Web 和平台 CLI 均通过 HTTP API 访问平台事实。

## 实现状态

Fastify Local Server 已装配真实 SQLite、资源与 Run REST/Evaluation/Report Route、Work Package v1 流式导出、Execution Report Import、平台 Retry/Force、严格请求/响应 Schema、OpenAPI、生产 Web 静态入口、安全边界、中文业务日志和有限期 Run SSE。当前不注册 Analysis、Analysis Import 或 Canonical Export；CLI 是独立进程入口，不属于 Local Server Route。

## 当前代码事实入口

- [local-server.ts](../../apps/local-server/src/local-server.ts)：Route 注册、Host/Origin、请求生命周期和严格 Schema。
- [local-operation-schemas.ts](../../apps/local-server/src/local-operation-schemas.ts)：资源与 Run 操作的 Runtime/OpenAPI Schema。
- [application-resource-handlers.ts](../../apps/local-server/src/application-resource-handlers.ts)：DTO/Application Mapper 与稳定错误映射。
- [application-run-handlers.ts](../../apps/local-server/src/application-run-handlers.ts)：Run DTO/Application Mapper 与稳定错误映射。
- [run-api-routes.ts](../../apps/local-server/src/run-api-routes.ts)：Run REST/Evaluation/Report、Retry/Force、Execution Import Route 和 Snapshot-first SSE。
- [execution-report-import-service.ts](../../apps/local-server/src/execution-report-import-service.ts)：受控工作包读取与完整 Report 导入装配。
- [imported-report-export.ts](../../apps/local-server/src/imported-report-export.ts)：统一报告 JSON 导出流与取消边界。
- [run-artifact-store.ts](../../apps/local-server/src/run-artifact-store.ts)：Run 专属不可变 Artifact 与孤儿清理。
- [case-export-staging.ts](../../apps/local-server/src/case-export-staging.ts)：响应前一致性校验、0600 导出文件和取消清理。
- [work-package-export-handler.ts](../../apps/local-server/src/work-package-export-handler.ts)：Work Package 导出请求/响应协议边界。
- [work-package-export-service.ts](../../apps/local-server/src/work-package-export-service.ts)：冻结快照、受控目录发布、NDJSON 导出与清理。
- [local-server-runtime.ts](../../apps/local-server/src/local-server-runtime.ts)：SQLite、Application、Adapter 和生命周期装配。
- [configuration-probe-adapters.ts](../../apps/local-server/src/configuration-probe-adapters.ts)：Endpoint 与 LLM 可用性验证。
- [local-logger.ts](../../apps/local-server/src/local-logger.ts)：安全字段、中文单行日志、轮转与 stderr 降级。
- [openapi.json](../../apps/local-server/openapi.json)：由真实当前 Route 和 Schema 生成的提交事实。
- [local-server-cli.ts](../../apps/local-server/src/local-server-cli.ts)：默认装配生产 `apps/web/dist` 静态根。

## 当前样例与测试入口

[local-server tests](../../apps/local-server/test) 覆盖真实 SQLite 资源与 Run/REST 闭环、安全入口、OpenAPI、流式导入边界、配置探针、日志、Run Artifact、Work Package 导出、SSE、生命周期和能力隔离。

## 对外接口

当前 `/api/v1` 包含 Test Suites、Suite-local Cases、Endpoint Configs、LLM Configs、Rubric Prompts、Analysis Prompts、Runs、`POST /work-packages/export` 和 `POST /execution-results/import`。资源能力覆盖 CRUD、Suite 影响查询、Case 搜索/组合过滤/Cursor 分页、全量导入导出、配置验证、Prompt 预览与引用查询；Run 能力覆盖预检、创建、倒序分页、详情、REST/Evaluation/Report 启动、取消、进度流、逐 Case 结果、Report Overview/过滤/详情/导出和 Retry/Force；Work Package Route 返回冻结、校验后的 v1 NDJSON 导出流，Execution Import 只接受完整对账报告。Route 按完成阶段注册，未闭环能力不出现在 OpenAPI。

列表使用 Cursor 分页，大 JSON 只在详情返回。写请求返回稳定 Error Code 和必要字段路径。

## 核心流程

启动时先对项目状态根、db 目录和既有 SQLite/WAL/SHM 做无副作用 symlink/canonical containment 预检，通过后才 mkdir、chmod 或打开数据库；随后验证临时根，清理具有 Owner/PID 启动身份的失活导入/导出 staging，恢复遗留 `RUNNING`，并扫描未被持久 Manifest 引用的 Run Artifact。启动扫描没有发布时 device/inode 句柄，因此保留并报告这些文件，不按路径或 Manifest 差集删除，再注册已闭环 Route。临时根或父级为符号链接时在 chmod/扫描前拒绝；未过 TTL 的无 owner 目录不作为损坏条目隔离。请求先校验原始 Host；非安全方法再校验同源 Origin。服务端生成 UUIDv7 Request ID，严格 Schema 清洗脏数据后才调用 Application。Host/Origin 的 403 是所有操作的公开响应事实。关闭时先停止 HTTP，再让 Run Owner Abort 并等待中断收敛；即使 Artifact 或阶段提交与 Shutdown 竞争，也必须修正为 `INTERRUPTED/DONE`，随后 Flush 日志并关闭 SQLite。

## 状态、事务与幂等

Route 不持有业务事务。Application 决定事务边界和幂等语义。Case 导入只保留单项内存，逐项写外部 staging；multipart 截断检查属于定义流完成条件，只有确认未超限后才最终原子替换主库。导出先冻结 Suite Revision，再逐 Case 短事务读取并写 owner-only 临时文件；Revision 变化在打开 200 前返回 409，完整文件再按背压发送。Run Start/Cancel 使用 Revision DTO 并只返回小型进度事实；进度、列表和详情包含持久 REST 与 Evaluation 分类计数，Run Detail 和 Case Detail 分开读取，避免大快照进入列表或动作响应。

## 错误收敛

协议错误映射为闭合 HTTP 状态、Error Code、外化中文消息和必要字段事实。批量导入错误包含输入顺序、Case Key、闭合原因码和可用字段路径。未知内部错误只返回 `INTERNAL_ERROR` 与 Request ID，不暴露 Secret、SQL、路径、第三方正文或堆栈。

## 观测与验收

默认监听 `127.0.0.1:4310` 并同源提供生产 Web 与 API。资源页、`/runs` 和 `/runs/:runId` 注册 SPA 回退，未来页面路径仍返回 404。Run SSE 先验证 Run，再以 `text/event-stream` 和当前 Snapshot 开流；REST 的开始/进度/完成及 Evaluation 的开始/完成由持久 Stage/Revision 推导，不暴露无持久计数支撑的 Evaluation Progress 事件。若一次轮询跨过多个 Stage，则以同一最新 `lockRevision` 按 REST Start/Progress/Complete、Evaluation Start/Complete 的顺序发送全部可证明事件，客户端仍以随后重读 Snapshot 为事实源。开流前保留 400/403/404/500 普通 JSON 错误，开流后的轮询拒绝、脏响应或写流错误只结束已 Hijack 响应并释放 Controller。单连接最多 5 秒、250 毫秒查询一次、声明 1 秒重连，跨进程变化最坏可见时间约 6 秒。静态响应使用不含 `'unsafe-eval'` 的脚本 CSP；响应序列化编译时只移除 fast-json-stringify 不支持的 `propertyNames`，Route Runtime Schema 和 OpenAPI 保持原严格事实。默认数据目录是项目根 `.cortex-eval/`。写请求 Body 使用 Route 级上限；Case JSON 文件上限 200 MiB。默认 composition root 把请求、staging 安全事件和闭合 Run 生命周期事件接入 owner-only 日志，单文件 10 MiB、保留 10 个轮转文件；写失败输出外化 stderr 提示且不改变业务结果。Runtime 关闭在 SQLite 前等待日志队列 flush。

## 相关测试

当前测试覆盖生命周期、真实 SQLite 装配、Host、Origin、Request ID、分页/过滤、错误映射、脱敏、取消、OpenAPI 精确路径与所有操作 403、生产静态资源、CSP、未注册未来 Route、流式大小/RSS 门禁、临时资源清理、Work Package 导出，以及 Run 预检、创建、REST→Evaluation→Report、Artifact、逐 Case 结果、Report 查询/导出、Retry/Force、完整离线导入、SSE 和启动恢复。
