# Application 层

## 模块职责

Application 保存 Use Case、业务 Port、统一事务原则和跨 Feature 协作规则。它决定何时读取或写入事实、何时调用外部副作用，以及失败如何收敛。

Application 不实现具体 SQLite、文件、REST、Promptfoo、模型 SDK 或入口协议，也不保存可独立表达为 Domain 纯规则的逻辑。

## 边界与依赖

Application 只依赖 Domain、纯 Reporting 和自身定义的 Port。Reporting 只依赖 Domain 和纯计算库。Application 与 Reporting 都不依赖 Contracts；Contracts 与核心类型由 Entrypoint/Adapter Mapper 转换，Infrastructure 在装配时实现 Port。

Feature 内部用例、局部事务、状态变化和错误归对应 Feature 文档；本文档只记录层级共性和跨 Feature 约束。

## 实现状态

P2 已落地 Application 基础 Package、资源 Port、Kysely 托管事务边界、Test Suite/Case/Configuration 用例和离线 Execution 身份幂等原语。P3 补充受控 staging Port、流式 Case 导入、Revision 一致导出和外部配置验证 Adapter 契约。P5–P8 补充平台 Run 预检/冻结、REST/Evaluation/Report 编排、逐 Case 结果、Artifact、取消、恢复、版本化 Retry/Force、统一查询和完整 Execution Report Import。Case Analysis 按 P9 落地。

## 目标代码落点

`packages/application`

目标 Feature 为 `test-suites`、`configurations`、`runs`、`execution-imports` 和 `case-analysis`。

## 当前代码事实入口

- [application-ports.ts](../../packages/application/src/application-ports.ts)：事务绑定 Repository、Clock 和 ID Port。
- [case-definition-writer.ts](../../packages/application/src/features/test-suites/case-definition-writer.ts)：统一 Case 写入。
- [configuration-service.ts](../../packages/application/src/features/configurations/configuration-service.ts)：四类配置资源用例。
- [streaming-case-import-service.ts](../../packages/application/src/features/test-suites/streaming-case-import-service.ts)：逐项 staging 与最终原子提交。
- [case-export-service.ts](../../packages/application/src/features/test-suites/case-export-service.ts)：Revision 一致、背压感知导出。
- [import-execution-identity.ts](../../packages/application/src/features/execution-imports/import-execution-identity.ts)：Execution 身份幂等原语。
- [import-execution-report.ts](../../packages/application/src/features/execution-imports/import-execution-report.ts)：完整离线报告对账与事务导入。
- [platform-run-service.ts](../../packages/application/src/features/runs/platform-run-service.ts)：Run 冻结、REST 编排、取消与恢复。
- [platform-run-ports.ts](../../packages/application/src/features/runs/platform-run-ports.ts)：Run 短事务和 Repository Port。
- [platform-report-service.ts](../../packages/application/src/features/reporting/platform-report-service.ts)：平台与离线统一报告构建和查询。

## 当前样例与测试入口

- [platform-run-service.test.ts](../../packages/application/test/platform-run-service.test.ts)：当前 Run 编排行为证明。
- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)：提供当前 Case 转换规则参考。

## 对外接口

Entrypoint 通过明确 Command、Query 和 Use Case 调用 Application。Application 返回结构化结果或 Domain/Application 错误，不返回 HTTP 响应、CLI 输出或用户文案。

核心 Port 包括资源 Repository、Run Repository、Case Analysis Repository、Transaction Manager、REST Executor、Promptfoo Process、Analysis Model Client、Work Package Store、Stage Artifact Store、Clock 和 ID Generator。

## 核心流程

Use Case 先读取并校验当前事实，在短事务中提交必要状态，再在事务外执行副作用，最后通过条件事务提交结果。跨 Feature 协作由 Application 显式编排，不由 Repository 或 Entrypoint 串联。

## 状态、事务与幂等

事务只覆盖需要原子一致的事实读写。外部调用不持有事务。条件更新必须携带当前状态、阶段或 Revision。幂等依赖稳定业务身份和规范化哈希，不依赖重复请求的时间接近程度。

## 错误收敛

Application 统一区分校验、冲突、外部执行、对账和恢复错误。无意义的 catch-log-reraise 被禁止；错误只在有责任进行转换、补偿或资源回收的边界捕获。

## 观测与验收

关键用例记录中文业务事件、安全身份、状态、耗时和 Error Code。验收要求 Route、CLI 和 Repository 不承载跨聚合业务流程，外部调用期间无数据库事务。

## 相关测试

目标测试覆盖 Port 契约、事务边界、跨 Feature 协调、取消传播、错误收敛和 Fake/Stub 隔离。架构门禁阻止 Application 导入 Contracts/Infrastructure，阻止 Reporting 导入 Contracts/Application/Infrastructure，阻止 Contracts 导入 Domain/Reporting/Application。测试替身只位于 Test Support 或测试目录。
