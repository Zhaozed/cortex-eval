# Web Configurations

## 模块职责

该 Feature 管理 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的当前配置、预览、引用信息和可用性验证。

模块不展开 Secret，不在前端实现安全白名单、Prompt 引用或模板变量业务规则。

## 边界与依赖

页面依赖 Configurations Application API。表单只发送普通配置和 EnvSecretRef，服务端执行完整 Schema 与引用校验。

## 实现状态

P4 已落地 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 当前配置管理。

## 目标代码落点

`apps/web/src/features/configurations`

## 当前代码事实入口

- [configuration-list-page.tsx](../../apps/web/src/features/configurations/configuration-list-page.tsx)：四类配置列表、Cursor、详情 Sheet、删除与 Rubric 引用影响。
- [configuration-editor.tsx](../../apps/web/src/features/configurations/configuration-editor.tsx)：Endpoint、LLM 结构化表单、探测、字段错误和冲突决策。
- [prompt-configuration-editor.tsx](../../apps/web/src/features/configurations/prompt-configuration-editor.tsx)：两类 Prompt 的消息编辑、预览、字段错误、引用展示和冲突决策。
- [resource-api.ts](../../apps/web/src/lib/resource-api.ts)：配置 Snapshot 的详情/列表 Query 同步和删除详情缓存清理。
- [configuration-form-mappers.ts](../../apps/web/src/features/configurations/configuration-form-mappers.ts)：表单与严格 DTO 的纯双向映射。

## 当前样例与测试入口

- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- [reply_text_repetition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_repetition_rubric.json)
- [reply_text_transition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_transition_rubric.json)
- [Configuration component tests](../../apps/web/test/configuration-editor.test.tsx)
- [Configuration list tests](../../apps/web/test/configuration-list-page.test.tsx)
- [P4 resource E2E](../../apps/web/e2e/resource-management.spec.ts)

## 对外接口

Endpoint 页面展示普通配置和 Secret 引用名称，新建默认超时 60 秒。LLM 页面说明 Evaluator 与 Analyzer 使用位置，新建默认结构输出为 `JSON_OBJECT`。Rubric 页面展示消息预览和当前 Case 引用。Analysis Prompt 页面从 Contracts 闭合枚举展示六个允许变量，并展示实际引用和渲染前结构。

## 核心流程

用户编辑当前配置并请求服务端校验或连通性验证。Prompt 内容可以原位更新；Prompt Key 的修改和删除受当前引用约束。

Endpoint 和 LLM 探测不自动保存。Rubric 预览显示服务端消息，Analysis 预览显示服务端返回的实际变量集合。Rubric 删除前先读取引用；读取完成前保持确认禁用，有引用时展示 Suite/Case 并禁止删除。

## 状态、事务与幂等

配置保存使用并发 Token 防覆盖，不产生版本历史。运行或分析一旦冻结配置，后续页面修改不改变历史快照。

四类配置保存或删除发生 409 时都读取最新服务端 Snapshot，保留本地 Draft 或删除意图，并要求用户显式重试或采用 Snapshot；重试再次冲突时重新进入同一读取与决策流程，不复用旧 Revision。验证、预览、保存请求在途或冲突待决时冻结完整编辑面；重试在途时保留决策面板，并同时禁用重试与采用 Snapshot，操作层单飞锁拒绝重复请求。请求在途或冲突待决时阻止关闭当前 Sheet/Dialog，并通过页面级门禁拦截 Esc、侧栏、浏览器历史和页面卸载；失败保持原容器并允许恢复，只有显式完成决策后才能离开。

保存或删除冲突刷新都会同步目标详情 Query 和所有已加载的同类列表项；采用服务端 Snapshot 会同时更新当前编辑器的 Revision 基线，关闭重开或放弃删除后不会回退到冲突前缓存。删除成功直接移除精确详情 Query，再刷新 Dashboard 与同类列表。Rubric 编辑必须等待引用查询成功；加载中展示进度，失败展示错误和重试，只有成功返回空列表时才显示无引用。Rubric 删除引用查询绑定目标 ID、AbortSignal 与请求代次，切换目标后迟到结果不能覆盖当前事实。

LLM 页面只提供统一 Gemini/OpenAI-compatible 接口和共享推理参数。OpenAI-compatible 显式选择结构输出能力和认证模式；Secret 只展示 Env Key。Endpoint 页面固定 POST，并编辑任意 `vars` 标量 URL 引用与 RFC 6901 Body Selector。

## 错误收敛

Secret Literal、非法 URL、Header、Options、Prompt 变量或引用冲突定位到具体字段；本地 Contracts 路径先映射到当前动态 Header、Provider 分支或 Prompt 消息的真实控件并聚焦，所有 Select 暴露 React Hook Form 焦点引用。`RUBRIC_PROMPT_IN_USE` 保留服务端 Prompt Key 并关联、聚焦 `promptKey`。Endpoint 探测与 Analysis 聚合变量错误同样关联并聚焦表单字段；请求返回字段错误时在编辑锁释放后恢复焦点。验证外部服务失败不自动保存配置。

## 观测与验收

页面和响应不包含 Secret 展开值。Prompt Key 更新不被内容编辑隐式触发。引用影响在删除前明确展示。

## 相关测试

目标测试覆盖四类资源 CRUD、Secret 脱敏、角色说明、Prompt 预览、引用查询、删除冲突和验证失败。
