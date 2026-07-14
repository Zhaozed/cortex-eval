# 外部行为

## 当前实现边界

当前可通过同源 Web 和 Local Server HTTP API 管理 Test Suite、Case、Endpoint、LLM 和两类 Prompt，并创建平台 Run、执行 REST 与 Evaluation、查看两阶段逐 Case 结果和进度、取消及刷新恢复。`PIPELINE` 在 REST 提交后自动进入 Evaluation；`STAGED` 可按 Stage 显式启动。提交的 OpenAPI 与 Web 只暴露已闭环的 Evaluation 能力。Report、Analysis、Retry/Force、Work Package 文件运行时和目标 CLI 不存在占位入口。

## 使用方式

本地平台允许用户通过 Web 管理资源、执行 REST、评估和报告阶段，并对失败结果发起分析。平台 CLI 通过本地 HTTP API 导出工作包和导入结果。

离线 CLI 工作包冻结全部非秘密输入。阶段命令可以独立执行，也可以按 REST、Evaluation、Report、Analysis 顺序执行完整管线。

Pipeline 默认执行 REST、Evaluation 和 Report，也可以显式选择满足依赖的阶段。Analysis 只有显式选择失败范围时执行。失败重跑和 `--force` 都创建新的 Run/Execution，不覆盖来源。

## 资源行为

- 测试集支持创建、查看、编辑、删除、导入和导出当前定义。
- Case 支持创建、复制、编辑、删除、搜索、过滤和服务端分页。
- Endpoint、LLM、Rubric Prompt 和 Case Analysis Prompt 保存当前配置，不保留版本历史。
- 全量 Case 替换必须整体校验、整体提交，不允许部分成功。
- 被当前 Case 引用的 Rubric Prompt 不允许删除或修改 Prompt Key。
- Secret 只展示环境变量引用名称，不返回展开值。
- Web Dashboard 展示六类当前资源数量和最近平台 Run；Test Suite 列表显示对应最新平台 Run 状态。Case 筛选、Cursor 和历史页状态可由 URL 刷新恢复；跨 Test Suite 详情导航不复用上一 Suite 的页面状态。写冲突保留 Draft 并展示最新 Snapshot，不自动覆盖；冲突刷新确认远端 Case 已删除时保留只读 Draft 或删除意图，不再重取详情，也不提供无效重试，只有显式采用删除事实后才关闭。写入或冲突待决时，关闭、Esc、应用导航、浏览器历史和页面卸载均不能隐式丢弃 Draft。浏览器缺少 `Navigation.currentEntry.index` 时只显示能力错误，不挂载资源或 Run 页面。

## 运行行为

- 用户可以创建 `STAGED` 或 `PIPELINE` Run；`STAGED` 分阶段启动，`PIPELINE` 在 REST 提交后自动启动 Evaluation。
- REST 与 Evaluation 执行中和完成后都可查看真实逐 Case 结果；Evaluation 完成后进入 `READY/REPORT`。
- 部分或全部 REST Error 都保存为真实 Case 事实并完成 REST 阶段。
- 页面刷新不影响后端执行和已完成事实。
- 同一时刻只有一个平台运行阶段可以处于 `RUNNING`。
- 取消停止新工作并安全回收当前外部进程，不伪造未完成结果。
- 运行中页面使用有限期 SSE 和查询刷新；断流或页面刷新不改变服务端事实。

## REST 可见语义

Endpoint 只支持 POST。URL 模板可以引用 `vars` 任意层级标量叶子，Body Selector 使用 RFC 6901 JSON Pointer。REST 不自动重试，不跟随 Redirect，并执行已确认的请求、响应和超时上限。

HTTP 2xx 且响应为合法 Provider Output 时，REST 状态为 `SUCCEEDED`。业务 `ok=false` 是合法业务输出，仍进入评估。

HTTP 非 2xx、网络错误、超时、JSON 解析失败或 Provider Output 结构非法时，REST 状态为 `ERROR`，且不存在 `providerOutput`。

## Evaluation 与报告语义

Eval Case 状态为 `PASS`、`FAIL`、`EVALUATION_ERROR` 或 `NOT_EVALUATED`。普通 Assertion 不满足条件是 `FAIL`；固定版本结构化 Row Error 和内联解释器执行失败是清洗后的 `EVALUATION_ERROR`，不展示第三方堆栈或绝对路径。系统不从一般自然语言 Reason 猜测状态。

Case 构建不按 Assertion 类型设置平台白名单，Promptfoo `0.121.18` 能力矩阵中的全部 Assertion 都可进入受控配置。平台不在单输出流程中复现或限制 `select-best`、`max-score` 等原生执行语义。内联 JavaScript、Python、Ruby、Transform 和 Context Transform 默认可信执行；开放的 Assertion `config` 任意层级仍不支持外部代码文件、额外依赖、Provider、认证/Secret 或 Provider 插件。

每个 Run ID 或离线 Execution ID 表示一次独立、不可覆盖的执行版本。其 Raw/Normalized Evaluation Artifact 与 Result Set Hash 表示绑定冻结 Evaluator 和契约版本的评估版本；当前不提供 Attempt 历史。

报告展示整体有效通过率、已评估通过率、评估覆盖率、Error、Not Evaluated 和 By Metric 统计。分母为零时 Rate 为空，不伪造为零。

一条 Case 对同名 Metric 最多计数一次。失败 `is-json` 展示约束路径、预期约束和实际值；`llm-rubric` 展示 Pass、Score、Reason、Metric 和 Weight。

JSON Report 是导入事实，Markdown 只由规范化 JSON 派生，不能反向导入。

## Analysis 可见语义

分析分类固定为 `LABEL_ERROR`、`ADDITIONAL_VALID_RESULT`、`NORMAL_FAILURE` 和 `PARAMETER_VARIANCE`。Confidence 是模型自评，不是校准概率。

用户可以拒绝、接受或编辑后接受单个 Proposal。Case、Prompt、Analyzer 或分析输入已经变化时返回冲突，不自动 Rebase 或合并。

## CLI 工作包行为

- 工作包包含冻结 Cases、非秘密配置、Prompts、Contract Version、Promptfoo 版本和阶段所需 Env Key。
- 每次执行使用独立 Execution ID；成功阶段产物不可覆盖。
- 缺少当前阶段环境变量时在阶段开始前失败。
- 同包同时只有一个写进程，不同包可以并行。
- 相同 Execution 和相同结果重复导入幂等；同一身份对应不同结果被拒绝。
- Work Package v1 从第一版包含 Report 与 Analysis 输入、Env Key 和 Artifact 槽位；后续能力不能修改同一版本 Manifest。

## 安全与限制

- 本地服务默认监听 `127.0.0.1`，校验 Host 和 Origin。
- Secret 不进入数据库、工作包、日志、快照或 API 响应。
- 外部 JSON、URL 模板和 Selector 在进入核心逻辑前校验。可信内联 Assertion 不做代码检测或沙箱承诺。
- 工作包可能包含敏感业务数据，目录和普通文件仅当前用户可访问。
- 当前不支持认证、租户、多人协作、资源历史、Attempt 历史、自动断点续跑、外部 Assertion 文件、Provider 插件或额外脚本依赖。
- 当前只支持并验证 macOS ARM64；Web 使用简体中文桌面布局并满足 WCAG 2.2 AA，目标浏览器必须提供同源 Navigation Entry 绝对索引。

## 验收边界

UI 和 CLI 对同一规范化输入生成相同统计。错误返回稳定 Error Code、可读消息和必要字段路径。千级 Case 的分页、搜索、组合过滤和报告生成保持可用。

最终发布门禁为 `pnpm verify:release`，包含完整确定性测试、性能门禁和两条不自动重试的真实 Gemini Smoke。

## 相关模块

- 目标外部行为来源：[REQ.md](../REQ.md) 与 [TECH.md](../TECH.md)
- 当前 Run/REST API 入口：[apps/local-server/src](../apps/local-server/src)
- 当前 REST Adapter：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- 当前测试集样例：[test_suite/current/cases/loona_promptfoo_tests.json](../test_suite/current/cases/loona_promptfoo_tests.json)
- 当前 Local Server 入口：[apps/local-server/src](../apps/local-server/src)
- 当前 P5 OpenAPI：[apps/local-server/openapi.json](../apps/local-server/openapi.json)
- 当前 P5 Web：[apps/web/src](../apps/web/src)
- 当前 P4–P5 生产 E2E：[apps/web/e2e](../apps/web/e2e)
- 工作包 CLI 入口尚未落地。
- [ENTRYPOINTS/LOCAL_SERVER.md](ENTRYPOINTS/LOCAL_SERVER.md)
- [ENTRYPOINTS/CLI.md](ENTRYPOINTS/CLI.md)
- [WEB/OVERVIEW.md](WEB/OVERVIEW.md)
