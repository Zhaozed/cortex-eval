# Cortex Eval 本地版需求说明

## 1. 文档职责

本文档定义 Cortex Eval 本地版的产品目标、使用方式、业务对象、用户流程、UI 与 CLI 能力、报告口径、异常行为和验收标准。

阶段实现状态以 `tasks/00_INDEX.md` 和 `spec/SYSTEM_OVERVIEW.md` 为准。截至 P3，纯 Contracts/Domain、SQLite、资源 Application 用例和 Local Server 资源 API 已落地；OpenAPI 只注册资源管理闭环。Web、Run、Execution Import、Report、Analysis 和目标 CLI 仍未注册。

技术选型、项目架构、模块边界、数据字段、工作包协议、事务、并发和测试设计以 `TECH.md` 为准。本文档不包含具体实现代码。

当前版本只支持并验证 macOS ARM64。运行数据默认位于项目根目录 `.cortex-eval/`，本地服务默认通过 `127.0.0.1:4310` 同源提供 Web 和 `/api/v1`。Linux、Windows、x64、Docker、安装器和桌面应用封装不在当前验收范围。

## 2. 产品结论

Cortex Eval 是面向本地单用户的测试集管理、REST 结果获取、Promptfoo 评估、报告查看和失败分析工具。

产品提供两种互补方式：

- 本地平台：通过 Web UI 管理资源，按阶段或一键执行完整流程，在本地 SQLite 中保存当前资源和运行事实。
- 离线 CLI 工作包：从本地平台导出不可变输入快照，在不连接 Cortex 平台或数据库的环境中执行 REST、评估、报告和分析，再把结果导回平台。

“离线”只表示 CLI 不依赖 Cortex 平台服务和平台数据库，不表示断网。REST Endpoint、Promptfoo 的 LLM Rubric 和 Case 大模型分析仍可能访问外部服务。

UI 和 CLI 使用同一套 Case、REST 结果、评估结果、报告和分析契约。两种方式生成的规范化结果具有相同统计口径和错误语义。

系统不提供资源版本历史、运行 attempt 历史或分析历史。每次运行保存独立的冻结输入和结果事实，保证历史报告不随当前资源变化。

## 3. 核心目标

- 稳定管理和运行千级 Promptfoo JSON 测试集。
- 在 UI 中完成测试集和 Case 的增删查改、过滤、搜索和分页查看。
- 让 UI 和 CLI 都能完成 REST、Promptfoo 评估、报告和 Case 分析流程。
- 让 CLI 工作包包含运行所需的全部非秘密配置，并能安全导回结果。
- 区分 REST 传输错误与合法的 `providerOutput.ok=false` 业务结果。
- 部分 REST 请求失败时继续评估成功 Case。
- 保存可对账的 Case、Assertion 和 Metric 结果。
- 在报告中直观展示失败 Assertion 的约束与实际值差异。
- 使用大模型分析失败结果，区分标注问题、合理扩展、真实失败和参数等价表达。
- 允许用户从分析结果进入 Case 编辑，并阻止过期建议覆盖当前 Case。
- 当前保持单用户、单文件、低运维成本，为未来多用户平台保留清晰迁移边界，但不预埋租户复杂度。

## 4. 使用方式

### 4.1 本地平台

本地平台由 Web UI、本地 HTTP API 和单文件 SQLite 组成，默认只监听本机地址。

用户可以：

- 管理测试集、Case、Endpoint、评估 LLM、分析 LLM、LLM Rubric Prompt 和 Case Analysis Prompt。
- 创建一次运行并选择“分阶段执行”或“一键执行”。
- 在 REST 阶段完成后先查看结果，再决定是否开始评估。
- 在评估完成后生成规范化报告。
- 对失败或评估错误 Case 发起大模型分析。
- 查看离线执行导回的报告和分析结果。

### 4.2 离线 CLI 工作包

用户从本地平台导出工作包。工作包冻结测试集、配置和 Prompt，不再读取平台当前数据。

CLI 可以：

- 校验工作包完整性和环境依赖。
- 获取每个 Case 的 REST 结果。
- 使用 Promptfoo 执行评估。
- 把原始评估结果转换为规范化结果和可读报告。
- 使用大模型分析 Case 评估结果。
- 一次执行全部阶段。
- 将规范化结果导回本地平台。

CLI 不直接打开平台 SQLite。平台导出和结果导入均通过本地 HTTP API 完成。

## 5. 业务对象和输入契约

### 5.1 测试集

`test_suite/current/cases/loona_promptfoo_tests.json` 是当前测试集样例。输入是 Promptfoo JSON 数组，每个元素是一条测试 Case。

测试集保存当前 Case 集合，不保存历史版本。导入可以创建新测试集，也可以全量替换指定测试集的当前 Cases。全量替换必须整体校验、整体提交，不能部分成功。

Case 支持以下顶层信息：

- `description`：可读描述。
- `threshold`：Promptfoo Case 聚合阈值。
- `vars`：REST 和 Promptfoo 使用的输入变量。
- `metadata`：Case 身份和筛选信息。
- `assert`：Assertion 定义数组。

测试定义不得包含 `providerOutput`、REST 执行 metadata 或其他运行结果字段。

### 5.2 Case 身份和变量

`metadata.case_id` 是测试集内唯一、长期稳定的业务键。系统内部 ID 与业务 Case ID 分离。

导入、人工编辑、分析建议和结果导入均不得静默修改 `case_id`。

当前筛选信息包括：

- `req_id`
- `task_id`
- `business_module`
- `scenario_tag`

当前输入变量包括：

- `task`：Endpoint URL 模板使用的任务类型。
- `request_body`：发送给 REST Endpoint 的 JSON 对象。

系统不拆分建模 `request_body` 内部业务字段。

### 5.3 Assertion

系统支持锁定 Promptfoo `0.121.18` 提供的全部内置 Assertion 类型，包括 Assertion Set、模型评分、内联 JavaScript、Python、Ruby、`transform` 和 `contextTransform`。能力范围以版本化 Assertion 能力矩阵为单一事实源。

每条 Assertion 必须有非空 `type` 和 `metric`。`weight` 可选，有效权重不得为负数。

`llm-rubric.rubricPrompt` 在平台内统一使用 `prompt://<prompt-key>`。导入当前 Fixture 时只额外接受 `file://rubric_prompt/<prompt-key>.json` 并规范化；其他文件路径被拒绝。

Assertion 和内联可执行表达式默认可信，执行权限等同当前用户。系统不做可信标记、运行警告、额外授权或可执行内容检测。当前不支持 `file://` 外部脚本、外部模块、额外 npm/pip 依赖、Assertion 内嵌 Provider 或 Provider 插件。需要 Provider 的 Assertion 统一使用 Run 选择的 Evaluator。

### 5.4 Endpoint 配置

`test_suite/current/provider.json` 是当前 Endpoint 配置样例。

Endpoint 配置包含：

- URL 模板。
- HTTP Method，当前固定为 `POST`。
- Headers。
- Body Selector。
- 单 Case 超时。
- REST 默认并发数，新建 Endpoint 默认 4。

Header 值使用普通值或环境变量秘密引用的显式判别类型。Header 名必须是合法 HTTP Token，按大小写无关语义拒绝重复并以小写名称参与 Endpoint Hash。只有 `Content-Type`、`Accept`、`User-Agent` 等固定安全 Header 允许普通值；Authorization、API Key、Token 及其他自定义 Header 必须使用环境变量引用。秘密值不得保存在数据库、导出文件、日志或 UI 响应中。

URL 模板可以引用 `vars` 下任意层级的标量叶子。变量值作为单个 URL 组件安全编码，不能替换协议、Host 或端口；缺失、`null`、对象或数组返回 `TEMPLATE_INPUT`。Body Selector 使用 RFC 6901 JSON Pointer，根对象固定为 Case `vars`，选中值必须是 JSON 对象。

Endpoint 支持 HTTP 和 HTTPS，包括本地与内网 HTTP；禁止 User Info、Fragment 和 Redirect。单 Case 请求体最大 5 MiB，响应体最大 10 MiB；超限拒绝且不截断。超时默认 60 秒，可配置范围为 100 毫秒至 10 分钟。系统不自动重试 REST POST。

### 5.5 LLM 配置

`test_suite/current/llm_config.json` 是当前 LLM 配置样例。

LLM 配置统一支持 `GOOGLE_GEMINI` 和 `OPENAI_COMPATIBLE`。OpenAI-compatible 严格表示 Chat Completions 协议，不支持 Responses、Assistants、Azure 专用参数或厂商私有扩展。

两类 Provider 使用相同推理接口和参数：`model`、`thinkingLevel`、`temperature`、`topP`、`maxOutputTokens` 和 `timeoutMs`。`thinkingLevel` 固定为 `OFF | LOW | MEDIUM | HIGH`，由 Adapter 映射到 Provider 协议；不支持时返回能力错误，不静默忽略。实现优先使用 Gemini 和 OpenAI 官方 SDK，不重复实现通用 Client。

Gemini 使用环境变量 Secret 引用。OpenAI-compatible 使用 Base URL、`BEARER_ENV | NONE` 认证和环境变量 Secret 引用；远程地址必须使用 HTTPS 和 Bearer，`NONE` 只允许回环地址且请求不得携带 `Authorization`。Base URL 禁止 User Info、Query、Fragment 和任意自定义 Header。

Analyzer 结构输出能力显式配置为 `JSON_SCHEMA` 或 `JSON_OBJECT`，默认 `JSON_OBJECT`。执行不自动降级、不自动重试；所有响应最终通过统一结构契约。

评估和分析可以选择同一条 LLM 配置，也可以选择不同配置。每次执行必须明确配置角色：

- Evaluator：供 Promptfoo 的 LLM Rubric 使用。
- Analyzer：供 Case 结果分析使用。

### 5.6 LLM Rubric Prompt

`test_suite/current/rubric_prompt/*.json` 中每个文件对应一个 LLM Rubric Prompt。

Rubric Prompt 包含唯一 Prompt Key、名称和消息数组。消息必须通过角色和内容校验。

Rubric Prompt 被当前 Case 引用时不得删除或修改 Prompt Key；名称和内容可以原位更新，不保留旧版本。

### 5.7 Case Analysis Prompt

Case Analysis Prompt 单独管理，不与 LLM Rubric Prompt 混表。

它包含唯一 Prompt Key、名称和消息模板，并通过变量引用获得分析输入。允许的变量由系统固定，不支持任意路径、过滤器、表达式或代码。

当前变量语义包括：

- Case 定义。
- Provider Output。
- 失败 Assertions。
- 预期约束与实际值差异。
- LLM Rubric 结果。
- 必要的脱敏运行上下文。

系统保存 Prompt 时校验模板变量，执行时再次校验并构造结构化输入。

### 5.8 REST 结果

`test_suite/current/run_result/loona_promptfoo_tests.json` 是 REST 结果样例。

HTTP 2xx 响应必须解析为 JSON 对象，并满足以下业务结构之一。

业务成功：

- `ok=true`
- `task_name` 为非空字符串。
- `resolved_config` 为 JSON 对象。
- `parsed_output` 为 JSON 对象。

业务失败：

- `ok=false`
- `err_msg` 为非空字符串。

HTTP 2xx 且结构合法统一视为 REST `SUCCEEDED`。`ok=false` 是合法业务输出，仍进入 Promptfoo 评估。

HTTP 非 2xx、网络错误、超时、JSON 解析失败或结构校验失败才是 REST `ERROR`，此时没有 `providerOutput`。

### 5.9 Promptfoo 结果

`test_suite/current/eval_result/result.json` 是 Promptfoo 完整结果样例。

系统从原始结果中提取并校验稳定事实：

- Case pass、score 和 reason。
- 结构化评估错误。
- Assertion pass、score、reason、metric 和 weight。
- Metric 聚合。
- Latency、Token Usage 和 Cost。

随机 ID、内部索引、绝对路径、Secret、重复 Case/Vars 和无业务意义的内部 metadata 不作为平台业务事实。

## 6. 当前范围

### 6.1 UI 资源管理

- 测试集创建、查看、编辑、删除、导入和导出。
- Case 创建、查看、编辑、删除、搜索、过滤和分页。
- Endpoint 配置创建、查看、编辑、删除和连通性验证。
- LLM 配置创建、查看、编辑、删除和可用性验证。
- LLM Rubric Prompt 创建、查看、编辑、删除、预览和引用查询。
- Case Analysis Prompt 创建、查看、编辑、删除和变量预览。

### 6.2 UI 和 CLI 执行

- 获取 Case REST 结果。
- 使用 Promptfoo 运行评估。
- 生成规范化 JSON 报告。
- 生成 CLI 可读 Markdown 报告。
- 查看 Case 和 Assertion 详情。
- 使用大模型分析 Case 评估结果。
- 将离线结果导回平台。
- 基于来源运行创建新的失败重跑或 `--force` 全量重跑，不覆盖原运行。

平台 Retry 与离线 `--retry-failed` 使用同一集合：复制 REST `SUCCEEDED`，重新请求 REST `ERROR`；复制与复用 REST 事实对齐的 Eval `PASS/FAIL`；重新评估 `EVALUATION_ERROR`、缺失 Eval 事实，以及 REST 重试后新成功的 `NOT_EVALUATED`。REST 重试仍失败时保持 `NOT_EVALUATED`。新 Run/Execution 记录来源和每条复用 Hash，并重新计算 Result Set Hash。Force 使用来源冻结上下文重新执行全部 REST 和 Eval。

### 6.3 UI 修改闭环

- 从分析结果查看分类、证据、原因和建议。
- 直接进入当前 Case 编辑页面。
- 接受建议、编辑后接受或拒绝建议。
- 保存前重新校验当前 Case、Prompt 引用和分析输入身份。

### 6.4 明确不做

- 测试集、Case、配置和 Prompt 的版本历史、Diff 和回滚。
- REST Attempt、Eval Attempt、分析历史和旧报告历史。
- 断点续跑或未知外部副作用的自动推测恢复。
- 持久任务队列、多实例 Worker、Redis 和消息队列。
- 用户认证、权限、租户和多人协作。
- `file://` 外部 Assertion 脚本、外部模块、额外 npm/pip 依赖和自定义 Provider 插件。
- Assertion 内嵌独立 Provider、Secret 或任意 Header。
- 外部调用自动重试。
- CLI 中编辑工作包的冻结测试输入并作为新平台资源导入。
- 自动重复执行 Case 来统计判断“参数波动”。
- Linux、Windows、x64、Docker、安装器、桌面封装、完整移动端和深色主题。

## 7. UI 需求

Web 使用简体中文，面向宽度不低于 1024px 的桌面技术用户，正式验收 1440×900 和 1280×800。视觉采用浅色本地实验室仪表台风格，并满足 WCAG 2.2 AA、键盘操作、可见焦点、表单错误关联和 Reduced Motion。小屏只提供可读提示，不实现完整移动流程。

### 7.1 总览

- 展示测试集、Case、配置和 Prompt 数量。
- 展示最近运行、阶段、状态和来源。
- 展示最近完整报告的 Case 通过率、评估覆盖率和主要 Metric 通过率。
- 区分平台本地运行和离线导入运行。

### 7.2 测试集页面

- 列表展示名称、描述、Case 数、更新时间和最近运行状态。
- 支持创建空测试集、从 JSON 导入和导出当前定义。
- Case JSON 导入上限为 200 MiB；大小判定必须在主库最终提交前完成，包含“合法数组后仅有尾随空白”的超限输入，拒绝时不得产生 Case 或 Revision 变化。导出必须保持同一 Suite Revision，完整校验成功后才打开成功响应，并使用受控临时文件保持有界内存。
- 删除前展示影响范围并二次确认。
- 正在运行使用的测试集禁止删除。

### 7.3 Case 管理页面

- 使用分页表格展示 Case ID、描述、业务模块、场景标签、Assertion 类型、Metrics 和更新时间。
- 支持按 Case ID 和描述关键词搜索。
- 支持按业务模块、场景标签、Assertion 类型和 Metric 做条件过滤和组合过滤。
- 支持创建、复制、编辑和删除 Case。
- 编辑器同时支持结构化字段和 JSON 内容，保存时使用同一套完整校验。
- 校验错误必须定位到字段路径，批量导入错误还要包含 Case 顺序和 Case ID。
- 删除和批量替换不能改变历史运行快照。

Case 列表使用不透明版本化 Cursor，默认每页 50 条、最大 200 条，默认按 Ordinal 和内部 ID 稳定排序。字段之间组合过滤使用 AND，同一字段多值使用 OR；Case ID 和描述使用转义后的大小写不敏感字面子串，其他筛选使用精确成员匹配。

### 7.4 配置和 Prompt 页面

- Endpoint 页面展示普通配置和 Secret 引用名称，不显示 Secret 值。
- LLM 配置页面明确 Evaluator 和 Analyzer 的使用位置。
- Rubric Prompt 页面展示消息预览和当前 Case 引用。
- Case Analysis Prompt 页面展示允许变量、实际引用变量和渲染前预览结构。
- Prompt 内容更新不修改 Prompt Key。

### 7.5 新建运行页面

用户选择：

- 测试集。
- Endpoint 配置。
- Evaluator LLM 配置。
- 分阶段或一键执行模式。
- REST 与 Eval 并发；默认分别来自 Endpoint 配置和系统默认值 2。

启动前展示 Case 数、Rubric 依赖、评估阶段所需环境变量名称、REST/Eval 并发和 REST 超时，并完成结构校验。Run 创建时把 `RunExecutionLimits` 与运行上下文一起冻结。Analyzer LLM、Case Analysis Prompt 和 Analysis 并发在用户发起分析时选择并冻结，不进入原评估运行上下文。

### 7.6 分阶段运行页面

- REST 阶段显示总数、完成数、成功数、错误数和逐 Case 结果。
- REST 阶段完成后允许查看结果，再启动评估。
- 评估阶段显示总数、完成数、通过数、失败数、错误数和未评估数。
- 评估完成后允许生成报告。
- 报告完成后允许发起 Case 分析。
- 页面刷新不影响后端执行和已完成事实。
- 终态或已中断 Run 提供“重跑系统失败”和“强制全量重跑”，两者创建新 Run，并展示来源 Run 和复用结果数量。

### 7.7 一键运行页面

一键模式按 REST、评估、报告顺序自动推进，仍保存与分阶段模式相同的阶段事实。

阶段发生系统错误时停止自动推进，展示已真实完成的结果和稳定错误码。用户取消时停止派发新工作并安全回收当前外部进程。

### 7.8 报告页面

- 展示整体统计和 By Metric 统计。
- 支持按 REST 状态、Eval 状态、Metric、业务模块和场景标签过滤 Case。
- 展示冻结的脱敏配置和运行来源。
- 展示原始证据文件是否存在，但默认只呈现规范化结果。
- 完整报告可导出；不完整运行只能查看已完成阶段事实。

### 7.9 分析页面

- 发起分析时选择 Analyzer LLM 配置和 Case Analysis Prompt。
- 展示分析使用的脱敏输入范围。
- 展示分类、模型自评置信度、证据、原因、建议动作和建议 Case/Assertion。
- 明确标注置信度是模型自评，不是校准后的统计概率。
- 支持重新分析、拒绝、接受和编辑后接受。
- 当前 Case 已变化时显示冲突，不自动合并。

## 8. CLI 工作包

### 8.1 导出内容

工作包必须包含后续阶段需要的全部非秘密输入：

- 测试集和 Cases。
- Endpoint 配置。
- Evaluator LLM 配置。
- Analyzer LLM 配置。
- LLM Rubric Prompts。
- Case Analysis Prompt。
- Promptfoo 精确版本和生成契约版本。
- 各阶段所需环境变量名称。

工作包不得包含任何 API Key、Authorization 值或其他 Secret 展开值。

### 8.2 工作包身份

每个导出包有唯一 `package_id`，代表一次不可变输入快照。

每次离线执行有唯一 `execution_id`。同一工作包可以执行多次，每次执行写入独立的 `executions/<execution_id>/` 目录并形成独立结果。

Manifest 保存导出的执行限制默认值与允许范围。创建 Execution 时由 CLI 接受或使用默认 `RunExecutionLimits` 与 `AnalysisExecutionLimits`，在首个阶段开始前写入 `execution.json` 并纳入 Execution Context Hash；后续阶段不得修改。

Execution 中已经成功提交的阶段产物不可覆盖。重新执行必须创建新的 `execution_id`，不得让同一 Execution 身份对应两组不同结果。

工作包保存源测试集 ID、Suite Hash、每个 Case 的 Base Definition Hash、配置哈希和文件哈希。

### 8.3 环境变量

工作包只提供 `.env.example`，其中只有空值 Key 和用途说明。

CLI 从当前进程环境或用户显式指定的 Env 文件读取 Secret。Env 文件不是工作包内容，不参与导入。

使用 Python/Ruby Assertion 时，运行前必须能解析对应解释器。Python 通过 `PROMPTFOO_PYTHON` 或 `python3` 选择，最低为 Promptfoo 文档要求的 Python 3.7；Ruby 通过 `PROMPTFOO_RUBY` 或 `ruby` 选择，并必须通过内联 Assertion Doctor Smoke。系统不自动安装解释器、Gem 或 Python Package。

环境依赖按阶段校验：

- REST 阶段只校验 Endpoint 所需变量。
- Eval 阶段只校验 Evaluator 所需变量。
- Analyze 阶段只校验 Analyzer 所需变量。
- Pipeline 启动前一次校验全部阶段变量。

### 8.4 阶段命令

- `package export`：通过本地 API 导出工作包。
- `package validate`：校验版本、路径、输入哈希和结构。
- `rest run`：生成 REST 结果。
- `eval run`：执行 Promptfoo 并生成原始和规范化评估结果。
- `report build`：生成规范化 JSON 和可读 Markdown 报告。
- `analyze run`：生成 Case 分析结果文件。
- `pipeline run`：按顺序执行全部阶段。
- `result import`：通过本地 API 导入规范化结果。
- `--retry-failed <source-execution-id>`：创建新 Execution，按统一重跑集合复用成功事实并补齐系统错误或缺失 Eval 事实。
- `--force <source-execution-id>`：使用相同冻结输入创建新 Execution 并重新执行全部 Cases。

Pipeline 默认执行 REST、Evaluation 和 Report，也可以显式设置阶段列表。Analysis 只有显式选择并指定 Case 范围时执行。阶段列表必须满足 Artifact 依赖，系统不自动补跑未选择阶段。

离线 Pipeline 包含 Analysis 时必须已有或同时选择 Report，并提供 Analyzer、Analysis Prompt 和 `failed | errors | all` Selector。Analysis 失败使 CLI 返回阶段系统错误，但不改变已完成 Report JSON、Markdown 或导入事实。无可分析 Case 时 Analysis 以零结果成功结束。

每个阶段可以独立执行。后续阶段通过 `execution_id` 读取同一执行的既有产物。已完成阶段不可覆盖；重建、失败重跑或强制重跑都必须创建新的 Execution。正在执行的工作包锁不能绕过。

### 8.5 结果导入

平台只接受与输入快照匹配的规范化结果。原始 Promptfoo 文件只作为排障证据，不作为直接入库事实。

相同 `execution_id` 且结果集合哈希相同的重复导入必须幂等；相同 ID 但结果哈希不同必须拒绝为冲突。不同 `execution_id` 即使输入相同，也保存为不同运行。

平台导入时重新校验：

- Package 和 Execution 身份。
- 文件哈希和结果结构。
- Case 顺序与 Base Hash。
- REST 与 Eval 对齐关系。
- 明细计数、Summary 和结果集合哈希。

平台从明细重新计算统计，不信任工作包内的 Summary。

导出后平台当前 Case 即使已经修改，历史结果仍可导入。只有应用分析建议时才校验 Base Definition Hash 并产生冲突。

报告和分析可以分两次导入。报告导入先按 Execution ID 建立 Run；后续分析导入必须绑定已经存在的 Final Case Result Hash。相同 Analysis Input Hash 重复导入幂等，不同分析输入按“当前分析”覆盖规则处理。

### 8.6 Canonical Data Export

平台通过 API 和 CLI `data export` 输出版本化 Manifest 和稳定排序的 Canonical JSONL。导出包含当前资源、历史 Runs、Case/Eval 规范化结果、当前 Analysis、Contract Versions 和 Artifact 预期元数据，不包含展开 Secret，默认不内嵌 Raw Evidence。

系统重新读取导出并完成计数、引用、实体 Hash 和文件 Hash 四类对账。Raw Artifact 缺失不阻止导出，但必须标记不存在并保留预期 Hash 与大小。当前不实现 Canonical Import、PostgreSQL Adapter 或备份恢复。

## 9. 执行流程

### 9.1 创建运行

1. 用户选择资源和执行模式。
2. 系统校验资源、Prompt 引用和环境变量名称。
3. 系统冻结测试集、Endpoint、Evaluator 和 Rubric Prompts 的脱敏快照。
4. 系统计算运行上下文哈希。
5. 运行进入 REST 待执行状态。

冻结后执行只使用运行快照，不重新读取当前资源。

### 9.2 REST 阶段

1. 按 Endpoint 并发限制派发 Case。
2. 每个 Case 使用冻结定义和配置。
3. 合法 `providerOutput` 保存为成功，无论业务 `ok` 为真或假。
4. 传输、状态码、解析和结构错误规范化为 REST Error。
5. 单个错误不停止其他 Cases。
6. 阶段完成后可以人工继续或由一键模式自动继续。

### 9.3 Promptfoo 阶段

1. 只把 REST 成功 Cases 交给 Promptfoo。
2. 使用预计算 `providerOutput`，不重新请求 Endpoint。
3. 使用系统生成的受控配置和固定 Promptfoo 版本。
4. 校验 Case 和 Assertion 对齐关系。
5. 规范化 Assertion，生成解释性 Diff 和 Case Metric。
6. 为 REST Error Cases 生成 `NOT_EVALUATED` 规范化结果。
7. 按冻结 Case 顺序合并完整结果集合，全部稳定事实生成后再计算结果哈希。

Promptfoo 因 Assertion 失败返回的失败退出码属于评估事实，不等同于系统执行失败。固定版本 `0.121.18` 的真实进程探针确认该原始退出码为 `100`；平台和 CLI Adapter 必须识别该事实，目标 CLI 对外仍映射为退出码 `1`。进程启动、配置、文件或未知输出结构错误才属于系统失败。

如果全部 REST 请求失败，则跳过 Promptfoo，全部 Cases 标记为 `NOT_EVALUATED`，仍允许生成完整错误报告。

### 9.4 报告阶段

1. 校验每条冻结 Case 都有 REST 结果。
2. 校验完整报告中的每条 Case 都有 Eval 结果。
3. 校验规范化阶段已经生成的 Assertion Diff、Case Metric 和结果哈希。
4. 重算整体和 By Metric 统计。
5. 生成结果集合哈希。
6. 生成 JSON 事实和 Markdown 派生报告。

任一对账失败时不得提交伪造的完整报告。

### 9.5 分析阶段

1. 用户选择失败或评估错误 Case。
2. 系统构造脱敏、结构化的分析输入。
3. 系统使用 Case Analysis Prompt 和 Analyzer LLM。
4. 系统严格校验模型结构化输出。
5. 系统保存分析分类、证据、解释和建议。
6. 用户在 UI 查看结果并决定是否修改当前 Case。

分析不是运行完整报告的必要条件，可以在报告生成后独立执行和重新执行。

### 9.6 取消和中断

- 取消后停止派发新的 REST Case。
- 取消后终止 Promptfoo 子进程。
- 在途 REST 请求等待安全收口或超时。
- 已真实完成的阶段事实可以保留。
- 未执行的 Case 不生成伪造结果。
- 进程重启后遗留的运行中状态收敛为 `INTERRUPTED`，不自动推测或续跑。
- REST、Evaluator 和 Analyzer 均不自动重试。Promptfoo 先接收 `SIGTERM`，5 秒未退出再接收 `SIGKILL`。

## 10. 报告口径

### 10.1 Case 状态

Eval Case 状态包括：

- `PASS`
- `FAIL`
- `EVALUATION_ERROR`
- `NOT_EVALUATED`

Case Pass/Fail 使用 Promptfoo 的结构化聚合结果，不从自然语言 Reason 猜测。

### 10.2 整体统计

- 整体有效通过率：`PASS / 全部 Case 数`。
- 已评估通过率：`PASS / (PASS + FAIL)`。
- 评估覆盖率：`(PASS + FAIL) / 全部 Case 数`。
- Error 和 Not Evaluated 数量必须单独展示。

分母为零时 Rate 为空，不伪造为零。

### 10.3 By Metric 统计

一条 Case 对同名 Metric 最多贡献一次。

同一 Case 内同名 Metric 的 Assertion 状态聚合优先级为：

1. `FAIL`
2. `ERROR`
3. `PASS`
4. `SKIPPED`
5. `NOT_EVALUATED`

Metric 通过率为 `Metric PASS Case 数 / (Metric PASS Case 数 + Metric FAIL Case 数)`。Error、Skipped 和 Not Evaluated 单独展示，不进入通过率分母。

### 10.4 Assertion 差异

`is-json` 失败时展示：

- Instance Path。
- Schema Path。
- JSON Schema Keyword。
- Expected Constraint。
- Actual Value 或 `MISSING`。
- Reason。

差异是对失败原因的解释，不反向改变 Promptfoo 的 Pass/Fail 事实。

`llm-rubric` 展示：

- Pass。
- Score。
- Reason。
- Metric。
- Weight。

## 11. Case 大模型分析

### 11.1 分类

- `LABEL_ERROR`：Case 标注、预期或约束本身错误或不一致。
- `ADDITIONAL_VALID_RESULT`：实际结果合理，但 Case 未覆盖该类额外合法结果。
- `NORMAL_FAILURE`：实际结果确实违反业务预期，应优先修复被测系统。
- `PARAMETER_VARIANCE`：工具调用参数表达不同但语义等价。

`PARAMETER_VARIANCE` 例如搜索关键词可以是“北京新闻”，也可以是“北京的最近新闻”。它是模型基于当前 Case、上下文和单次结果做出的语义判断，不是随机波动的统计证明。

当差异只集中在工具参数的等价表达时优先使用 `PARAMETER_VARIANCE`；其他合理但未覆盖的输出使用 `ADDITIONAL_VALID_RESULT`。

### 11.2 分析输出

分析结果必须包含：

- Classification。
- 模型自评 Confidence。
- Evidence。
- Explanation。
- Recommended Action。
- 可选的单个结构化 Proposal。

Proposal 使用判别联合明确动作和目标：

- 替换完整 Case：携带 Base Definition Hash 和完整 Case Payload。
- 新增 Assertion：携带插入位置和 Assertion Payload。
- 替换 Assertion：携带目标 Assertion Index、目标 Assertion Definition Hash 和新 Payload。
- 删除 Assertion：携带目标 Assertion Index 和目标 Assertion Definition Hash。

一次分析最多给出一个 Proposal。动作、目标和 Payload 不完整时不得直接应用。

模型输出不满足结构契约时保存稳定分析错误，不从不完整文本猜测建议。

### 11.3 建议应用

用户可以：

- 拒绝。
- 直接接受。
- 编辑后接受。

接受前必须重新校验：

- 分析输入哈希。
- 分析 Prompt 和 Analyzer 配置身份。
- 当前 Case Definition Hash。
- Case ID。
- Rubric Prompt 引用。
- Assertion 和禁止字段。

任一输入变化时返回冲突，不自动 Rebase 或合并。

## 12. 数据保留和删除

- 当前资源只保存当前数据。
- 每次运行保存独立冻结快照和结果事实。
- 重新分析覆盖同一运行 Case 的当前分析和决策。
- 删除或替换当前 Case 不改变历史运行快照。
- 无活跃运行引用的资源可以删除，历史运行继续使用快照。
- Rubric Prompt 被当前 Case 引用时禁止删除或修改 Prompt Key。
- Case Analysis Prompt 被历史分析引用时仍可修改当前内容，历史分析保留当次 Prompt Hash 和脱敏快照。
- 并发控制 Token 只用于防止覆盖，不表示版本历史。
- Test Suite、Test Case、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 分别保存独立 Revision。名称等不进入运行语义 Hash 的显示字段变化仍递增 Revision；Case 写入同时校验 Suite Revision，编辑既有 Case 时再校验 Case Revision。

## 13. 并发和一致性

- 同一时刻只允许一个平台运行阶段处于 `RUNNING`。
- 两个独立进程同时启动平台执行时，只允许一个成功。
- 分阶段运行在等待用户继续时不占用运行互斥。
- 资源写入、运行冻结和结果导入使用短事务。
- REST、Promptfoo 和 LLM 外部调用期间不得持有数据库事务。
- 最终报告从落库明细重新计算并对账。
- 同一工作包同一时刻只允许一个 CLI 进程写入。
- 不同工作包可以并行执行。
- 已完成 Execution 不允许覆盖；重建必须创建新的 Execution。
- 版本化 `RunExecutionLimits` 包含 REST/Eval 并发，在平台 Run 或离线 Execution 创建时冻结；REST 默认采用 Endpoint 值且新建 Endpoint 默认为 4，Eval 默认 2，范围为 1–64、1–16。`AnalysisExecutionLimits` 在每次平台 Analysis 请求或离线 Execution 创建时冻结，默认 1、范围 1–8。冻结值进入对应 Snapshot、Manifest/Execution 和 Hash，之后不可修改。

## 14. 安全要求

- 本地服务默认只监听 `127.0.0.1`。
- 校验 Host 和 Origin，默认拒绝跨域状态修改请求。
- Secret 只从环境读取，不进入数据库、工作包、日志、快照或响应。
- UI 只展示 Secret 环境变量名称。
- 工作包目录默认仅当前用户可访问，文件默认仅当前用户可读写。
- 工作包虽然不含 API Key，但可能包含 Case、请求、Provider Output 和模型分析等敏感业务数据。
- 外部 JSON 在进入核心逻辑前必须完成结构校验。可信内联 Assertion 由 Promptfoo 执行，不做代码安全检测或沙箱承诺。
- 平台状态根、数据库目录、临时目录和文件使用受控名称；任何 mkdir、chmod、数据库打开或清理前必须拒绝路径逃逸和符号链接逃逸，不得修改项目根外内容。
- Promptfoo 使用固定参数启动，不通过 Shell 拼接用户输入。
- 日志不记录完整 Vars、Provider Output、Prompt、Secret 或第三方堆栈。
- 日志以单行中文可读文本记录安全字段，单文件 10 MiB 轮转并保留最近 10 个文件；日志写入失败只做脱敏 stderr 降级，不改变业务事实。

## 15. 非功能需求

- 单个测试集按千级 Case 设计。
- Case 和报告列表使用服务端分页。
- 常用搜索和组合过滤在千级数据下保持交互可用。
- 所有计数非负且不超过对应总数。
- 阶段时间不得逆序。
- 工作包写入采用临时文件和原子替换，避免半写文件。
- CLI 和 UI 对同一规范化输入生成相同统计结果。
- 错误提供稳定 Error Code、可读消息和必要字段路径。
- 测试集 JSON 导入最大 200 MiB；边界读取必须受控并在取消或失败后清理临时文件。
- 在 Node 24、至少 4 个逻辑核、至少 8 GiB 可用内存、本地磁盘的 macOS ARM64 参考环境中，不做人工 CPU/内存限速并记录实际硬件：1,000 Case 测试集导入不超过 10 秒，查询 p95 不超过 250 毫秒且 p99 不超过 500 毫秒，报告与 Markdown 不超过 5 秒，工作包导出不超过 10 秒，Execution Result 导入不超过 10 秒，关键列表页可交互不超过 2.5 秒。所有对象独立计时。

## 16. 验收标准

### 16.1 数据和资源

- 当前真实测试集、REST 结果、Promptfoo 结果、Endpoint、LLM 配置和 Rubric Prompts 均能通过对应契约校验。
- Test Suite 和 Test Case 清晰分离。
- Case Analysis Prompt 独立保存和管理。
- 当前资源编辑不产生版本历史。
- 资源删除不破坏历史运行快照。

### 16.2 UI Case 管理

- 可以完成测试集和 Case 增删查改。
- 可以按 Case ID、描述、业务模块、场景标签、Assertion 类型和 Metric 搜索过滤。
- 可以分页查看千级 Cases。
- 导入错误能定位 Case 和字段路径。
- 所有 Case 写入口执行相同校验。

### 16.3 UI 执行

- 可以逐阶段执行 REST、Eval 和 Report。
- REST 完成且 Eval 未开始时可以查看逐 Case REST 结果。
- 可以一键执行相同阶段链。
- 页面刷新不影响执行。
- 部分 REST Error 不阻止成功 Cases 评估。
- 全部 REST Error 可以生成完整 Not Evaluated 报告。
- 平台失败重跑和 Force 创建新 Run，来源快照与结果不可变，复用 Provenance 可查询。

### 16.4 CLI 工作包

- 导出包包含全部非秘密输入和 `.env.example`。
- 导出包不包含 Endpoint、Evaluator 或 Analyzer Secret 值。
- 缺少当前阶段环境变量时在执行前失败。
- 每个阶段可独立运行，也可一键运行。
- 同包并发写入被拒绝，不同包可以并行。
- 原始 Promptfoo、规范化结果、JSON 报告、Markdown 报告和分析结果分开保存。
- 相同 Execution 重复导入幂等。
- 平台当前 Case 变化不阻止历史结果导入，但阻止过期建议应用。
- 失败重跑与 `--force` 创建新 Execution，来源 Execution 和已完成 Artifact 保持不可变。

### 16.5 报告

- 报告包含整体 Case 通过率和 By Metric 通过率。
- 一条 Case 对同名 Metric 最多计数一次。
- Is-json 失败展示约束路径、预期约束和实际值。
- LLM Rubric 展示 Pass、Score 和 Reason。
- UI 和 CLI 报告统计一致。
- Markdown 只由规范化 JSON 派生，不能反向作为导入事实。

### 16.6 分析

- 分析结果只接受四种固定分类。
- 参数波动按工具参数语义等价定义，不自动重复执行 Case。
- 分析输出包含证据、解释和修改建议。
- UI 可以从分析结果进入 Case 编辑。
- 过期分析不能覆盖当前 Case。
- Prompt 或 Analyzer 配置变化会形成新的分析输入身份。

### 16.7 并发、恢复和安全

- 两个独立进程不能同时启动平台运行阶段。
- 取消不生成伪造结果。
- 重启能把遗留运行收敛为 Interrupted。
- 工作包半写、Hash 错误和路径逃逸被稳定拒绝。
- Secret 不出现在数据库、工作包、日志、快照或 API 响应中。
- Promptfoo `0.121.18` 能力矩阵中的每个 Assertion 类型都有契约测试；可信内联 JavaScript、Python、Ruby、Transform、Context Transform 和嵌套 Assertion Set 能真实执行。
- `pnpm verify:release` 在 macOS ARM64 上通过，并包含一次真实 Gemini `llm-rubric` 和一次真实 Analyzer 结构输出；任何层不得自动重试。

### 16.8 Canonical Export 和迁移边界

- Canonical Export 的计数、引用、实体 Hash 和文件 Hash 四类对账全部通过。
- Secret 不展开，Raw Evidence 默认不内嵌，缺失 Raw Artifact 被准确标记。
- `spec/MIGRATION_BOUNDARY.md` 明确可迁移事实和必须重新设计的租户、授权、调度、Secret 与 Artifact 边界。
- 不把 PostgreSQL、多用户、Worker、认证授权或 Secret Manager 冒充为当前已实现能力。

## 17. 未来范围

- 多用户、租户、认证、权限和协作。
- 外置 PostgreSQL。
- 多实例 Worker、持久任务队列和分布式调度。
- Secret Manager 和平台级 Secret 授权。
- 资源版本、Diff、回滚和 Attempt 审计。
- 对参数或模型随机性的多次采样与统计分析。

未来多用户平台不是简单替换数据库连接。它还需要重新设计租户上下文、唯一约束、授权、调度和秘密管理。当前版本只保证业务契约、规范化结果和导出数据具有明确迁移边界。
