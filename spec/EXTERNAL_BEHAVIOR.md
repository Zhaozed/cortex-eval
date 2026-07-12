# 外部行为

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

## 运行行为

- 用户可以选择分阶段模式或一键模式，两种模式保存相同阶段事实。
- REST 阶段完成后可以查看逐 Case 结果，再决定是否评估。
- 部分 REST Error 不阻止成功 Case 评估；全部 REST Error 仍可生成完整 Not Evaluated 报告。
- 页面刷新不影响后端执行和已完成事实。
- 同一时刻只有一个平台运行阶段可以处于 `RUNNING`。
- 取消停止新工作并安全回收当前外部进程，不伪造未完成结果。

## REST 可见语义

Endpoint 只支持 POST。URL 模板可以引用 `vars` 任意层级标量叶子，Body Selector 使用 RFC 6901 JSON Pointer。REST 不自动重试，不跟随 Redirect，并执行已确认的请求、响应和超时上限。

HTTP 2xx 且响应为合法 Provider Output 时，REST 状态为 `SUCCEEDED`。业务 `ok=false` 是合法业务输出，仍进入评估。

HTTP 非 2xx、网络错误、超时、JSON 解析失败或 Provider Output 结构非法时，REST 状态为 `ERROR`，且不存在 `providerOutput`。

## Evaluation 与报告语义

Eval Case 状态为 `PASS`、`FAIL`、`EVALUATION_ERROR` 或 `NOT_EVALUATED`。系统使用 Promptfoo 的结构化结果，不从自然语言 Reason 猜测状态。

支持 Promptfoo `0.121.18` 能力矩阵中的全部 Assertion。内联 JavaScript、Python、Ruby、Transform 和 Context Transform 默认可信执行；不支持外部代码文件、额外依赖、Assertion Provider 覆盖或 Provider 插件。

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
- 当前只支持并验证 macOS ARM64；Web 使用简体中文桌面布局并满足 WCAG 2.2 AA。

## 验收边界

UI 和 CLI 对同一规范化输入生成相同统计。错误返回稳定 Error Code、可读消息和必要字段路径。千级 Case 的分页、搜索、组合过滤和报告生成保持可用。

最终发布门禁为 `pnpm verify:release`，包含完整确定性测试、性能门禁和两条不自动重试的真实 Gemini Smoke。

## 相关模块

- 目标外部行为来源：[REQ.md](../REQ.md) 与 [TECH.md](../TECH.md)
- 当前 REST CLI 入口：[data_scripts/run_promptfoo_rest_cli.ts](../data_scripts/run_promptfoo_rest_cli.ts)
- 当前 REST 用户说明：[data_scripts/run_promptfoo_rest.md](../data_scripts/run_promptfoo_rest.md)
- 当前测试集样例：[test_suite/current/cases/loona_promptfoo_tests.json](../test_suite/current/cases/loona_promptfoo_tests.json)
- 目标 Web、本地 API 和工作包 CLI 入口尚未落地。
- [ENTRYPOINTS/LOCAL_SERVER.md](ENTRYPOINTS/LOCAL_SERVER.md)
- [ENTRYPOINTS/CLI.md](ENTRYPOINTS/CLI.md)
- [WEB/OVERVIEW.md](WEB/OVERVIEW.md)
