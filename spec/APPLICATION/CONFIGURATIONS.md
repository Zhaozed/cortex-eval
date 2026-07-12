# Application Configurations

## 模块职责

该 Feature 管理 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的当前配置、引用约束、脱敏读取和可用性验证。

模块不保存 Secret 展开值，不固定 LLM 的 Evaluator 或 Analyzer 角色，不保存配置历史。

## 边界与依赖

Feature 依赖 Domain 配置规则、Configuration Repository、Transaction Manager 和验证用外部 Port。运行与分析分别显式选择配置角色。

## 实现状态

目标 Feature 尚未落地。当前仅存在配置 Fixture。

## 目标代码落点

`packages/application/src/features/configurations`

## 当前代码事实入口

当前没有配置 Repository 或 Use Case 实现。

## 当前样例与测试入口

- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- [reply_text_repetition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_repetition_rubric.json)
- [reply_text_transition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_transition_rubric.json)

## 对外接口

Use Case 覆盖四类配置 CRUD、Rubric 引用查询、Prompt 变量预览、Endpoint 连通性验证和 LLM 可用性验证。

## 核心流程

保存时校验 Header、URL、Options、EnvSecretRef、Prompt 消息和模板变量，生成 Config 或 Prompt Hash，再在短事务中提交当前记录。验证外部服务在事务外进行，成功验证不替代保存校验。

## 状态、事务与幂等

配置内容原位更新，不保留旧版本。Rubric Prompt 被当前 Case 引用时不得删除或修改 Key。Analysis Prompt 删除与分析冻结并发时，只允许一方基于完整事实成功。

LLM 配置只支持统一接口下的 Gemini 和 OpenAI-compatible Chat Completions。两者共享 Model、Thinking Level、Temperature、Top P、Max Output Tokens 和 Timeout；不开放 Provider 私有 Options。结构输出能力显式配置，不自动降级或重试。

Endpoint 只支持 POST，新建时 REST Concurrency 默认 4、范围 1–64。该值是 Create Run 的默认值，运行可以在范围内显式选择并冻结。

Rubric Prompt 平台引用统一为 `prompt://<key>`。只在当前 Fixture 导入边界识别受控 `file://rubric_prompt/<key>.json`，不读取任意用户路径。

## 错误收敛

敏感 Literal、未知 Provider Option、非法变量、重复 Prompt Key 和引用冲突不写入。OpenAI-compatible 远程地址必须 HTTPS 与 Bearer，本地回环才允许无认证。外部验证错误返回稳定分类，不记录 Secret 或第三方完整堆栈。

## 观测与验收

日志只记录配置 ID、Provider、Model、安全 Env Key 名称和 Error Code。响应与快照不包含 Secret 展开值。

## 相关测试

目标测试覆盖安全 Header、敏感 Query、递归 Secret 字段、Prompt 变量、引用删除、并发冻结、脱敏和外部验证失败。
