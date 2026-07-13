# Application Configurations

## 模块职责

该 Feature 管理 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的当前配置、引用约束、脱敏读取和可用性验证。

模块不保存 Secret 展开值，不固定 LLM 的 Evaluator 或 Analyzer 角色，不保存配置历史。

## 边界与依赖

Feature 依赖 Domain 配置规则、Configuration Repository、Transaction Manager 和验证用外部 Port。运行与分析分别显式选择配置角色。

## 实现状态

P2 已落地 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的内部 CRUD、独立 Revision、Domain 校验与语义 Hash、Rubric 引用保护、Prompt 变量预览和事务外外部验证 Port。P3 已映射严格资源 API，并落地 Endpoint `OPTIONS` 连通性探针、Gemini/OpenAI-compatible 固定 SDK 可用性探针和闭合安全错误分类。

## 目标代码落点

`packages/application/src/features/configurations`

## 当前代码事实入口

- [configuration-service.ts](../../packages/application/src/features/configurations/configuration-service.ts)
- [domain-resource-models.ts](../../packages/domain/src/domain-resource-models.ts)
- [domain-resource-hashes.ts](../../packages/domain/src/domain-resource-hashes.ts)

## 当前样例与测试入口

- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- [reply_text_repetition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_repetition_rubric.json)
- [reply_text_transition_rubric.json](../../test_suite/current/rubric_prompt/reply_text_transition_rubric.json)

## 对外接口

Use Case 覆盖四类配置 CRUD、Rubric 引用查询、Prompt 变量预览、Endpoint 连通性验证和 LLM 可用性验证。

## 核心流程

保存时校验 Header、URL、Options、EnvSecretRef、Prompt 消息和模板变量，生成 Config 或 Prompt Hash，再在短事务中提交当前记录。读取时严格校验 JSON 精确键集合、判别联合、枚举和语义 Hash。验证外部服务在事务外进行，成功验证不替代保存校验。

Endpoint Probe 只发送一次无凭据 `OPTIONS`，不发送用户 Body、不跟随 Redirect、不重试。LLM Probe 只解析显式 EnvSecretRef，使用固定 SDK 发出一次最小结构输出请求，Gemini 与 OpenAI-compatible 均禁用自动重试；两类 Provider 都把配置的 `timeoutMs` 与请求取消 Signal 组合后传给 SDK，分别收敛为 `TIMEOUT` 或 `CANCELLED`。

## 状态、事务与幂等

配置内容原位更新，不保留旧版本。Rubric Prompt 被当前 Case 引用时不得删除或修改 Key。Analysis Prompt 删除与分析冻结并发时，只允许一方基于完整事实成功。

LLM 配置只支持统一接口下的 Gemini 和 OpenAI-compatible Chat Completions。两者共享 Model、Thinking Level、Temperature、Top P、Max Output Tokens 和 Timeout；OpenAI-compatible Thinking 明确映射为 `reasoning_effort: none | low | medium | high`，不开放其他 Provider 私有 Options。结构输出能力显式配置，不自动降级或重试。

Endpoint 只支持 POST，新建时 REST Concurrency 默认 4、范围 1–64。该值是 Create Run 的默认值，运行可以在范围内显式选择并冻结。

Rubric Prompt 平台引用统一为 `prompt://<key>`。只在当前 Fixture 导入边界识别受控 `file://rubric_prompt/<key>.json`，不读取任意用户路径。

## 错误收敛

敏感 Literal、大小写重复或非法 Token Header、未知 Provider Option、非法变量、重复名称/Prompt Key 和引用冲突不写入。并发唯一字段冲突返回稳定字段事实，不泄露 SQLite 错误。OpenAI-compatible 远程地址必须 HTTPS 与 Bearer，本地回环才允许无认证；无认证请求显式移除 `Authorization`，不发送占位 Bearer。Provider 以 400/422 拒绝统一 Thinking 或结构输出参数时收敛为 `CAPABILITY_UNSUPPORTED`。外部验证错误返回稳定分类，不记录 Secret 或第三方完整堆栈。

## 观测与验收

日志只记录配置 ID、Provider、Model、安全 Env Key 名称和 Error Code。响应与快照不包含 Secret 展开值。

## 相关测试

当前测试覆盖安全 Header、敏感 Query、递归 Secret 字段、Provider 联合、六个 Analysis Prompt 变量、引用冲突、Revision、Hash、唯一竞争、脱敏、事务外验证、无凭据 Endpoint Probe、Gemini/OpenAI-compatible 四类 Thinking 映射、真实 HTTP 无 Authorization、能力拒绝分类、两种结构输出、真实配置超时与无重试 SDK 参数。
