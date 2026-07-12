# Web Configurations

## 模块职责

该 Feature 管理 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的当前配置、预览、引用信息和可用性验证。

模块不展开 Secret，不在前端实现安全白名单、Prompt 引用或模板变量业务规则。

## 边界与依赖

页面依赖 Configurations Application API。表单只发送普通配置和 EnvSecretRef，服务端执行完整 Schema 与引用校验。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`apps/web/src/features/configurations`

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- [reply_text_repetition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_repetition_rubric.json)
- [reply_text_transition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_transition_rubric.json)

## 对外接口

Endpoint 页面展示普通配置和 Secret 引用名称。LLM 页面说明 Evaluator 与 Analyzer 使用位置。Rubric 页面展示消息预览和当前 Case 引用。Analysis Prompt 页面展示允许变量、实际引用和渲染前结构。

## 核心流程

用户编辑当前配置并请求服务端校验或连通性验证。Prompt 内容可以原位更新；Prompt Key 的修改和删除受当前引用约束。

## 状态、事务与幂等

配置保存使用并发 Token 防覆盖，不产生版本历史。运行或分析一旦冻结配置，后续页面修改不改变历史快照。

LLM 页面只提供统一 Gemini/OpenAI-compatible 接口和共享推理参数。OpenAI-compatible 显式选择结构输出能力和认证模式；Secret 只展示 Env Key。Endpoint 页面固定 POST，并编辑任意 `vars` 标量 URL 引用与 RFC 6901 Body Selector。

## 错误收敛

Secret Literal、非法 URL、Header、Options、Prompt 变量或引用冲突定位到具体字段。验证外部服务失败不自动保存配置。

## 观测与验收

页面和响应不包含 Secret 展开值。Prompt Key 更新不被内容编辑隐式触发。引用影响在删除前明确展示。

## 相关测试

目标测试覆盖四类资源 CRUD、Secret 脱敏、角色说明、Prompt 预览、引用查询、删除冲突和验证失败。
