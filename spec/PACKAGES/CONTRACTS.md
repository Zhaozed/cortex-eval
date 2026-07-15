# Contracts

## 模块职责

Contracts 保存跨进程和跨入口稳定协议，包括 API DTO、Work Package Schema、结果导入 Schema、Report Schema、Contract Version、Zod 边界 Schema 和稳定 Error Code。

Contracts 不保存业务规则、数据库实体或第三方原始对象的业务解释。

## 边界与依赖

Entrypoint、Web、CLI、Work Package 和 Importer 使用 Contracts。Domain 不依赖 Contracts。Mapper 负责 Contracts 与 Application/Domain 类型转换。

## 实现状态

P1 已落地纯 Contracts Package；P3–P6 补充资源、Run/REST/Evaluation API 和使用 `runId + runContextHash` 的平台 Raw/Normalized Eval Artifact。P8 已注册 Report、Retry/Force、统一最近运行和 Execution Report Import 契约。P9 已注册严格结构化 Evidence、平台当前 Analysis、Proposal 决策、Analysis Artifact 和 Execution Analysis Import 契约。P10 已按真实复合 Result 身份、显式引用、Artifact Presence/Inclusion、独立 Transport 和 CLI 机器事件闭环 Canonical Export，并新增不展开 Secret 的显式 Live Release Gate 配置契约。

Contracts 只冻结协议，不代表对应 API、CLI、Web 或文件运行时已经注册。P7–P9 只能实现 v1 Writer、Reader、Importer 和能力注册，不能修改 Work Package v1 Schema。

## 代码事实入口

- [case-contracts.ts](../../packages/contracts/src/case-contracts.ts)：Case、递归 Assertion 与受控 Rubric 别名归一。
- [provider-contracts.ts](../../packages/contracts/src/provider-contracts.ts)：Endpoint、EnvSecretRef、Gemini/OpenAI-compatible 和 Provider Output。
- [execution-context-contracts.ts](../../packages/contracts/src/execution-context-contracts.ts)：Run/Analysis Snapshot。
- [work-package-contracts.ts](../../packages/contracts/src/work-package-contracts.ts)：完整 Manifest v1、Execution v1、固定依赖图和六类 Artifact 槽位。
- [artifact-contracts.ts](../../packages/contracts/src/artifact-contracts.ts)：REST、Eval、Report、Analysis 与 Artifact Manifest。
- [evaluator-bridge-contracts.ts](../../packages/contracts/src/evaluator-bridge-contracts.ts)：Bridge Capability、Request/Response 和 Provider Capability Error。
- [canonical-export-contracts.ts](../../packages/contracts/src/canonical-export-contracts.ts)：Canonical Export 请求、十类文件、复合 Entity Key、Manifest、Artifact 状态、Raw 授权与规范路径、独立 Transport 与四类对账。
- [release-gate-contracts.ts](../../packages/contracts/src/release-gate-contracts.ts)：真实 Gemini Rubric/Analyzer 的显式模型、Prompt 引用、Env Secret 引用和结构输出模式。
- [error-contracts.ts](../../packages/contracts/src/error-contracts.ts)：稳定 Error Code。
- [resource-api-contracts.ts](../../packages/contracts/src/resource-api-contracts.ts)：P3 资源 Request/Response、Cursor、分页和闭合 API Error。
- [run-api-contracts.ts](../../packages/contracts/src/run-api-contracts.ts)：Run Request/Response、Cursor、REST/Evaluation 分类进度、Case 结果和 SSE Envelope。
- [analysis-contracts.ts](../../packages/contracts/src/analysis-contracts.ts)：结构化 Evidence、Analysis 输入/输出、当前结果与 Proposal 决策。
- [result-import-contracts.ts](../../packages/contracts/src/result-import-contracts.ts)：完整 Execution Report/Analysis Import 请求、结果和版本身份。

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- `test_suite/current/eval_result/test_example.json`：当前已提交第三方结果 Fixture。
- [contracts tests](../../packages/contracts/test)：Schema 正反例、137 条能力映射、真实 Fixture、版本、Secret、Snapshot、Manifest 和状态形状。

## 对外接口

协议族包括资源 Request/Response、Cursor Page、Run 预检/创建/详情/进度/逐 Case结果/SSE、规范化 Result、Report、Analysis Input/Output、Evaluator Bridge、Artifact Manifest、完整 Work Package Manifest v1、Execution v1、全部阶段 Artifact、Execution Import 和 Canonical Export v1。Run 进度显式包含 REST 总/完成/成功/错误和 Evaluation 总/完成/PASS/FAIL/Error/Not Evaluated，并校验分类之和等于完成数。Run SSE 的 Evaluation 事件只包含 Started/Completed；当前没有逐 Case持久进度事实，因而不声明 `EVALUATION_PROGRESS`。

`RunExecutionLimitsV1` 由平台 Create Run 或离线 Create Execution 接受，包含 REST/Eval 并发；`AnalysisExecutionLimitsV1` 由平台 Analysis 请求或离线 Create Execution 接受，包含 Analysis 并发。两者的默认值、范围、冻结点和 Hash 归属是版本化协议，不使用散落配置。

字段定义以当前真实 Schema 和导出类型为准。Assertion `type` 不设白名单，`config` 保持开放 JSON；边界递归拒绝其中的 Provider、OAuth/认证/Secret、模块/依赖字段。外部引用统一忽略前导空白和大小写后识别 `file://`、`package:`、`module:`、`node:`、`npm:`、`pip:`，敏感键按分隔符、camelCase 与紧凑敏感词组合识别，防止开放 Payload 绕过平台持有的执行边界。该边界不解释或限制 Promptfoo Assert 执行语义。Canonical Export Manifest 只有在全局 Raw 开关为真、Artifact Kind 为 `RAW_PROMPTFOO_EVIDENCE` 且路径精确等于对应 Run 的规范路径时才接受 `included=true`；接收器还必须用本次请求事实校验同一开关。Analysis Prompt 预览响应的变量联合与 Domain 一致，闭合为 `case_definition`、`provider_output`、`failed_assertions`、`expected_actual_diffs`、`llm_rubric_results`、`run_context` 六项。Analysis Artifact Error Code 使用闭合枚举，错误文案限制最大长度；平台注册 `ANALYSIS_CANCELLED` 与 `ANALYSIS_INTERRUPTED`，平台展示文案不由 Artifact 提供。文档只维护协议语义、版本关系和兼容边界。

## 核心流程

外部 `unknown` 先通过对应版本 Schema，再由 Mapper 进入 Application。输出先由 Application/Domain 类型映射为 DTO，再执行脱敏和序列化。

Endpoint URL 模板只接受 `vars.name`、`vars["任意 JSON 键"]` 和 `vars.items[0]` 三类可组合选择器。选择器只出现在 Path 或非敏感 Query Value，不能替换协议、Host 或端口；任何残留模板表达式都在边界拒绝。

Work Package v1 首版即包含 REST、Eval、Report 和 Analysis 的全部输入、Env Key、依赖图与 Artifact 槽位。阶段能力注册不得修改 v1 Schema。

## 状态、事务与幂等

Contracts 不执行事务。协议身份显式携带 Package ID、Execution ID、Case Key、Hash、Revision 和 Contract Version。Raw/Normalized Evaluation Artifact 显式携带 Evaluation Context Hash；Promptfoo `0.121.18` Raw Artifact 的原生退出码只接受 `0 | 100`。Evaluation Result Set Hash 绑定 Run/Execution Owner 与该 Context；Report Result Set Hash 再绑定 Report Owner、Evaluation 版本和 Report Contract，不把可复用单 Case语义 Hash误当执行或报告版本。Normalized Artifact 的 Case 数组按连续 Ordinal 排列且 Case Key 唯一；Writer 在提交边界验证该集合约束，Schema 不接受已经写坏的公开事实。`EVALUATION_ERROR` 只携带进入 Hash 的稳定 Error Code，不把中文文案或第三方错误正文写入跨进程事实；展示层使用自己的消息资源。兼容性由版本化 Schema 决定，不通过宽泛可空字段猜测旧格式。

## 错误收敛

Schema 错误保留字段路径和稳定 Error Code。未知版本、未知联合成员、未知 Analysis Error Code、超长错误文案、字符串 Evidence、额外敏感字段或结构不完整时拒绝进入核心逻辑。

## 观测与验收

序列化结果稳定，不包含展开 Secret、绝对路径和不稳定第三方 metadata。所有状态联合可穷尽，字段可空性与真实语义一致。

## 相关测试

当前测试覆盖 Schema 正反例、版本拒绝、联合穷尽、资源与 Run DTO 严格键集合、Cursor、SSE、Artifact Manifest、闭合错误原因、脱敏、Canonical Serialization、Error Code、137 条 Assertion 能力、外部引用归一化与当前真实 Fixture。
