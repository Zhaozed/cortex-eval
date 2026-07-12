# Contracts

## 模块职责

Contracts 保存跨进程和跨入口稳定协议，包括 API DTO、Work Package Schema、结果导入 Schema、Report Schema、Contract Version、Zod 边界 Schema 和稳定 Error Code。

Contracts 不保存业务规则、数据库实体或第三方原始对象的业务解释。

## 边界与依赖

Entrypoint、Web、CLI、Work Package 和 Importer 使用 Contracts。Domain 不依赖 Contracts。Mapper 负责 Contracts 与 Application/Domain 类型转换。

## 实现状态

目标 Package 尚未落地。当前 TypeScript 接口只覆盖独立 REST 运行器。

## 目标代码落点

`packages/contracts`

## 当前代码事实入口

- [run_promptfoo_rest_types.ts](../../data_scripts/run_promptfoo_rest_types.ts)

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [provider.json](../../test_suite/current/provider.json)
- [llm_config.json](../../test_suite/current/llm_config.json)
- `test_suite/current/eval_result/result.json`：当前未跟踪第三方结果 Fixture。

## 对外接口

协议族包括资源 Request/Response、Cursor Page、Run Progress、规范化 Result、Report、Analysis Input/Output、Evaluator Bridge、Artifact Manifest、完整 Work Package Manifest v1、Execution v1、全部阶段 Artifact、Execution Import 和 Canonical Export v1。

`RunExecutionLimitsV1` 由平台 Create Run 或离线 Create Execution 接受，包含 REST/Eval 并发；`AnalysisExecutionLimitsV1` 由平台 Analysis 请求或离线 Create Execution 接受，包含 Analysis 并发。两者的默认值、范围、冻结点和 Hash 归属是版本化协议，不使用散落配置。

字段定义以未来真实 Schema 和导出类型为准。文档只维护协议语义、版本关系和兼容边界。

## 核心流程

外部 `unknown` 先通过对应版本 Schema，再由 Mapper 进入 Application。输出先由 Application/Domain 类型映射为 DTO，再执行脱敏和序列化。

Work Package v1 首版即包含 REST、Eval、Report 和 Analysis 的全部输入、Env Key、依赖图与 Artifact 槽位。阶段能力注册不得修改 v1 Schema。

## 状态、事务与幂等

Contracts 不执行事务。协议身份显式携带 Package ID、Execution ID、Case Key、Hash、Revision 和 Contract Version。兼容性由版本化 Schema 决定，不通过宽泛可空字段猜测旧格式。

## 错误收敛

Schema 错误保留字段路径和稳定 Error Code。未知版本、未知联合成员、额外敏感字段或结构不完整时拒绝进入核心逻辑。

## 观测与验收

序列化结果稳定，不包含展开 Secret、绝对路径和不稳定第三方 metadata。所有状态联合可穷尽，字段可空性与真实语义一致。

## 相关测试

目标测试覆盖 Schema 正反例、版本拒绝、联合穷尽、脱敏、Canonical Serialization、Error Code 和当前真实 Fixture。
