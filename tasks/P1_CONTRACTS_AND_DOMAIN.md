# P1：Contracts 与 Domain

## 状态与依赖

- 状态：`PENDING`
- 依赖：P0

## 目标

冻结跨入口协议和纯业务不变量，使外部脏数据、持久化与执行器不能污染 Domain。

## 实现清单

- 建立版本化 Zod DTO、稳定 Error Code、消息资源、Cursor、UUIDv7、UTC 时间和 RFC 8785/SHA-256 契约。
- 冻结完整 Work Package Manifest v1、Execution v1、全部阶段 Artifact、Result Import、Artifact Manifest 和 Canonical Export v1。
- 冻结 Evaluator Bridge Request/Response、一次性 Capability、Provider Capability Error 契约。
- 冻结 `RunExecutionLimitsV1` 与 `AnalysisExecutionLimitsV1`：API/CLI 输入、默认值、范围、Snapshot/Execution/Manifest 字段、冻结点和 Hash 归属。
- 实现 Case、全 Promptfoo Assertion 通用结构、Provider Output、Run/Analysis 状态、Metric 聚合、Rate、Hash 输入和 Proposal 判别联合。
- 规范 Rubric 引用为 `prompt://<key>`；只在边界接受当前受控 Fixture 的文件式别名。
- 实现双 Provider 的统一配置契约：`model`、`thinkingLevel`、`temperature`、`topP`、`maxOutputTokens`、`timeoutMs`。

## TDD 与验证

- Domain 纯单元测试、联合穷尽测试和非法状态测试。
- Canonical JSON、Hash、版本拒绝、Secret 字段拒绝和 Cursor 属性测试。
- 架构测试冻结唯一依赖图：Domain 不导入外层；Reporting 只导入 Domain 和纯计算库；Application 只导入 Domain、Reporting 和自身 Port；Contracts 不导入 Domain/Reporting/Application；Entrypoint Mapper 才能同时依赖 Contracts 与核心类型。
- 能力矩阵中的每个 Assertion 必须映射到契约测试标识。

## Spec 更新

- `spec/PACKAGES/CONTRACTS.md`
- `spec/PACKAGES/DOMAIN.md`
- `spec/INTERNAL_BEHAVIOR.md`
- `spec/ERROR_HANDLING.md`
- `spec/DECISION_LOG.md`

## 完成标准

- Work Package v1 在本阶段冻结，P7–P9 不得修改其 Schema。
- Domain 不接收 `unknown`、第三方对象或持久化类型。
- 所有关键状态和错误均有显式强类型契约。

## 阻塞条件

若完整 Work Package v1 或 Evaluator Bridge 无法在不破坏已确认边界的情况下表达，停止相关协议实现并报告冲突，不以宽泛可空字段兼容。
