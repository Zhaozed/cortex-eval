# Contracts

## 模块职责

Contracts 保存跨进程和跨入口稳定协议，包括 API DTO、Work Package Schema、结果导入 Schema、Report Schema、Contract Version、Zod 边界 Schema 和稳定 Error Code。

Contracts 不保存业务规则、数据库实体或第三方原始对象的业务解释。

## 边界与依赖

Entrypoint、Web、CLI、Work Package 和 Importer 使用 Contracts。Domain 不依赖 Contracts。Mapper 负责 Contracts 与 Application/Domain 类型转换。

## 实现状态

P1 已落地纯 Contracts Package。P3 补充已注册资源 API 的严格 Request/Response DTO、资源与 Case Cursor、组合查询和闭合 API Error 联合。其余当前实现包含稳定 Error Code 与中文消息、执行限制、冻结 Snapshot、Case/Provider、Evaluator Bridge、Work Package v1、全部阶段 Artifact、Result Import、Analysis Input/Output、Artifact Manifest 和 Canonical Export v1。

Contracts 只冻结协议，不代表对应 API、CLI、Web 或文件运行时已经注册。P7–P9 只能实现 v1 Writer、Reader、Importer 和能力注册，不能修改 Work Package v1 Schema。

## 代码事实入口

- [case-contracts.ts](../../packages/contracts/src/case-contracts.ts)：Case、递归 Assertion 与受控 Rubric 别名归一。
- [provider-contracts.ts](../../packages/contracts/src/provider-contracts.ts)：Endpoint、EnvSecretRef、Gemini/OpenAI-compatible 和 Provider Output。
- [execution-context-contracts.ts](../../packages/contracts/src/execution-context-contracts.ts)：Run/Analysis Snapshot。
- [work-package-contracts.ts](../../packages/contracts/src/work-package-contracts.ts)：完整 Manifest v1、Execution v1、固定依赖图和六类 Artifact 槽位。
- [artifact-contracts.ts](../../packages/contracts/src/artifact-contracts.ts)：REST、Eval、Report、Analysis 与 Artifact Manifest。
- [evaluator-bridge-contracts.ts](../../packages/contracts/src/evaluator-bridge-contracts.ts)：Bridge Capability、Request/Response 和 Provider Capability Error。
- [canonical-export-contracts.ts](../../packages/contracts/src/canonical-export-contracts.ts)：Canonical Export 请求、Manifest、JSONL Entity 与四类对账。
- [error-contracts.ts](../../packages/contracts/src/error-contracts.ts)：稳定 Error Code。
- [resource-api-contracts.ts](../../packages/contracts/src/resource-api-contracts.ts)：P3 资源 Request/Response、Cursor、分页和闭合 API Error。

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- `test_suite/current/eval_result/test_example.json`：当前已提交第三方结果 Fixture。
- [contracts tests](../../packages/contracts/test)：Schema 正反例、137 条能力映射、真实 Fixture、版本、Secret、Snapshot、Manifest 和状态形状。

## 对外接口

协议族包括资源 Request/Response、Cursor Page、Run Progress、规范化 Result、Report、Analysis Input/Output、Evaluator Bridge、Artifact Manifest、完整 Work Package Manifest v1、Execution v1、全部阶段 Artifact、Execution Import 和 Canonical Export v1。

`RunExecutionLimitsV1` 由平台 Create Run 或离线 Create Execution 接受，包含 REST/Eval 并发；`AnalysisExecutionLimitsV1` 由平台 Analysis 请求或离线 Create Execution 接受，包含 Analysis 并发。两者的默认值、范围、冻结点和 Hash 归属是版本化协议，不使用散落配置。

字段定义以当前真实 Schema 和导出类型为准。Analysis Prompt 预览响应的变量联合与 Domain 一致，闭合为 `case_definition`、`provider_output`、`failed_assertions`、`expected_actual_diffs`、`llm_rubric_results`、`run_context` 六项。文档只维护协议语义、版本关系和兼容边界。

## 核心流程

外部 `unknown` 先通过对应版本 Schema，再由 Mapper 进入 Application。输出先由 Application/Domain 类型映射为 DTO，再执行脱敏和序列化。

Endpoint URL 模板只接受 `vars.name`、`vars["任意 JSON 键"]` 和 `vars.items[0]` 三类可组合选择器。选择器只出现在 Path 或非敏感 Query Value，不能替换协议、Host 或端口；任何残留模板表达式都在边界拒绝。

Work Package v1 首版即包含 REST、Eval、Report 和 Analysis 的全部输入、Env Key、依赖图与 Artifact 槽位。阶段能力注册不得修改 v1 Schema。

## 状态、事务与幂等

Contracts 不执行事务。协议身份显式携带 Package ID、Execution ID、Case Key、Hash、Revision 和 Contract Version。兼容性由版本化 Schema 决定，不通过宽泛可空字段猜测旧格式。

## 错误收敛

Schema 错误保留字段路径和稳定 Error Code。未知版本、未知联合成员、额外敏感字段或结构不完整时拒绝进入核心逻辑。

## 观测与验收

序列化结果稳定，不包含展开 Secret、绝对路径和不稳定第三方 metadata。所有状态联合可穷尽，字段可空性与真实语义一致。

## 相关测试

当前测试覆盖 Schema 正反例、版本拒绝、联合穷尽、资源 DTO 严格键集合、Cursor、闭合错误原因、脱敏、Canonical Serialization、Error Code、137 条 Assertion 能力和当前真实 Fixture。
