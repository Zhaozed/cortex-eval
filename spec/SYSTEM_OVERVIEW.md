# 系统总览

## 系统职责

Cortex Eval 是面向本地单用户的测试集管理、REST 结果获取、Promptfoo 评估、报告查看和失败分析工具。系统提供本地平台和离线 CLI 工作包两种运行形态，两者共享 Case、结果、报告、错误和分析契约。

系统不提供资源版本历史、运行 Attempt 历史、分析历史、认证授权、多人协作、持久任务队列或多实例调度。

当前只支持并验证 macOS ARM64 与 Node.js 24 LTS。默认运行数据目录是项目根 `.cortex-eval/`，默认服务地址是 `http://127.0.0.1:4310/api/v1`。

## 实现状态

当前仓库已完成 P0–P10。Node 24 工具链、137 条 Assertion 能力契约、资源/API/Web、平台与离线 REST→Evaluation→Report→显式 Analysis Pipeline、不可变 Eval/Report/Analysis Artifact、结构化 Evidence、规范化 Hash、Case Metric、Ajv 2020-12 Diff、纯报告聚合与 Markdown、严格 Importer、SQLite 原子提交、受控 Promptfoo/Bridge 链、Analyzer 官方 SDK、Work Package v2 导出与安全文件运行时、平台与离线 Retry/Force、连续 Retry Evidence 追溯、完整 Execution Report/Analysis Import、固定 Promptfoo 版本、真实取消到 CLI 130 和 Promptfoo Raw 有界流式 Source 已生效。

当前 OpenAPI 与 Web 包含资源、平台 REST、Evaluation、Report、Analysis、Retry/Force 和 Execution Report/Analysis Import 闭环；Work Package 与 Canonical Export API 已注册。Bridge v2 只绑定一次 Evaluation 调用期，以确定性总预算和并发限制保护冻结 Evaluator，不识别 Assertion、Metric 或组件身份；结果身份由 Promptfoo Raw Result 的 Metric、完整 Definition 和组件结构承担。Case 构建不按类型拒绝 `select-best`、`max-score` 或其他 Assertion，平台也不复现或预判其执行流程。Analyzer 直接使用官方 SDK，不经过 Bridge。Canonical Export 通过 SQLite Backup 短快照、十实体稳定 JSONL、Artifact 状态和服务器/CLI 双重对账闭环；不注册 Canonical Import 或 Web 页面。

P10 的日志轮转、资源压力、千级性能、生产依赖审计、OpenAPI 漂移、WCAG、完整 E2E、Runtime Doctor 和独立变更复审已经通过。使用 `GOOGLE_API_KEY` 的真实 Gemini `llm-rubric` 和真实 Analyzer 结构输出已在同一次完整 `pnpm verify:release` 中通过；P10 与当前 Goal 已完成。

本文档描述 [REQ.md](../REQ.md) 和 [TECH.md](../TECH.md) 已确认的目标系统。未落地路径统一称为目标代码落点，不视为当前代码事实。

## 运行形态

本地平台由 Web、本地 HTTP API 和单文件 SQLite 组成，默认只监听 `127.0.0.1`。Web 与平台 CLI 通过 HTTP API 操作资源和运行事实，只有本地服务写平台数据库。

离线 CLI 使用平台导出的不可变工作包。离线表示不依赖平台服务和平台数据库，不表示断网；REST Endpoint、Evaluator 和 Analyzer 仍可能访问外部服务。离线结果通过本地 HTTP API 导回平台，CLI 不直接打开平台 SQLite。

## 分层

Domain 保存业务实体、状态、纯校验、统计、哈希输入和状态归并规则，不依赖外部协议或基础设施。

Application 依赖 Domain，保存 Use Case、Port、事务边界和跨聚合协调。外部副作用由 Port 表达，并推迟到事务之外执行。

Contracts 保存跨入口 DTO、边界 Schema、Contract Version 和稳定 Error Code，不保存业务规则。未校验的外部数据在 Mapper 处转换后才能进入 Application 和 Domain。

Infrastructure 实现 SQLite、文件、REST、Promptfoo、分析模型、Clock 和 ID 等 Port。Entrypoint 只负责装配、协议转换、生命周期和用户交互。

## 代码模块

- `apps/local-server`：本地 HTTP Server、资源与 Run/Evaluation Route、Run SSE、生产 Web 静态入口、Mapper、安全入口、日志、OpenAPI、依赖装配和生命周期。
- `apps/web`：Dashboard、测试集/Case、四类配置管理、平台 Run/REST/Evaluation/Report/Analysis、结构化 Evidence 决策和平台 Retry/Force。
- `apps/cli`：Work Package 导出/校验、Canonical `data export`、REST、Evaluation、Report、Analyze、默认三阶段与显式 Analysis Pipeline、Report/Analysis 结果导入。
- `packages/canonical-export`：独立 NDJSON 读取、稳定描述符文件接收、四类磁盘对账和原子目录发布。
- `packages/domain`：纯业务类型和规则，P1 已落地。
- `packages/application`：资源 Use Case、Port、流式导入导出、平台 Run/REST/Evaluation/Report 编排、严格 Importer、对外 Retry/Force 和 Execution Report Import Use Case。
- `packages/contracts`：DTO、Schema、Contract Version 和 Error Code，P1 已落地。
- `packages/storage-sqlite`：SQLite Schema、Migration、资源/Run Repository、事务和外部 Case staging，以及原子 Eval/Report 提交、离线完整导入、查询和复用 Provenance 对账。
- `packages/evaluation-adapters`：REST Adapter、受控 Promptfoo 配置/进程、Bridge v2 和 Gemini/OpenAI-compatible Evaluator SDK Adapter。
- `packages/application/src/features/evaluation`：Evaluation 编排、严格 Promptfoo Importer、Eval 模型与持久化 Port。
- `packages/reporting`：锁定 Ajv 2020-12 的纯 Diff、有界报告聚合、Report Result Set Hash 和单向 Markdown Renderer。
- `packages/work-package`：Manifest、Execution、原生安全目录、文件锁、Artifact Store、Retry 证据，以及严格 Evaluation/Report Result Reader 与 Writer。

## 依赖边界

- Domain 不依赖 Contracts、数据库、文件、网络、HTTP、Promptfoo 或 LLM SDK。
- Reporting 只依赖 Domain 和纯计算库，不依赖 Contracts、Application 或 Infrastructure。
- Application 只依赖 Domain、Reporting 和自身 Port，不依赖 Contracts、具体 SQLite、文件、Provider SDK 或 Entrypoint。
- Contracts 不承载业务规则，也不依赖 Domain、Reporting 或 Application；Domain 不接收 `unknown` 或第三方原始对象。
- Web 不依赖 Domain 和 Storage，只依赖 API Client 与 Contracts。
- Route、CLI 和 UI 不实现统计、状态归并、Case 写入和导入对账规则。
- SQLite Repository 与文件工作包不实现同一套持久化接口。
- 外部调用期间不持有 SQLite 事务。

## 技术边界

目标系统使用 Node.js 24 LTS、TypeScript Strict Mode、pnpm Workspace、Fastify、Zod、Kysely、better-sqlite3、React、Vite、TanStack Query、TanStack Table、React Hook Form、Commander 和 Vitest。Promptfoo 固定为 `0.121.18`。

Evaluator 与 Analyzer 只支持统一接口下的 Gemini 和 OpenAI-compatible Chat Completions。系统支持精确 Promptfoo 版本能力矩阵中的全部 Assertion；内联可执行 Assertion 默认可信，不检测、不警告、不沙箱，但不支持外部代码文件、额外依赖或 Provider 插件。

目标系统数据库方案仅支持 SQLite，当前资源与运行约束的十表数据库基础已落地。未来 PostgreSQL 迁移依赖版本化导出契约，并需要重新设计租户、授权、调度和 Secret 管理，不承诺仅替换数据库 Adapter。

## 事实入口

- 目标产品行为：[REQ.md](../REQ.md)
- 目标技术架构：[TECH.md](../TECH.md)
- 当前离线 CLI：[apps/cli/src](../apps/cli/src)
- 当前 Work Package 文件运行时：[packages/work-package/src](../packages/work-package/src)
- 当前 Work Package Golden Fixture：[packages/work-package/test-fixtures/work-package-v2](../packages/work-package/test-fixtures/work-package-v2)
- 当前转换实现：[data_scripts/convert_loona_to_promptfoo.py](../data_scripts/convert_loona_to_promptfoo.py)
- Goal 执行入口：[tasks/00_INDEX.md](../tasks/00_INDEX.md)
- P0 工具链入口：[package.json](../package.json)
- P0 Runtime Doctor：[tooling/src/runtime-doctor.ts](../tooling/src/runtime-doctor.ts)
- P10 Release Gate：[tooling/src/release-gate.ts](../tooling/src/release-gate.ts) 与 [tooling/src/release-gate-production.ts](../tooling/src/release-gate-production.ts)
- P10 显式 Live 配置：[tooling/facts/p10-live-gemini.json](../tooling/facts/p10-live-gemini.json)
- Promptfoo 能力矩阵：[tooling/facts/promptfoo-0.121.18-capabilities.json](../tooling/facts/promptfoo-0.121.18-capabilities.json)
- P0 测试入口：[tooling/test](../tooling/test)
- P1 Contracts 入口：[packages/contracts/src](../packages/contracts/src)
- P1 Domain 入口：[packages/domain/src](../packages/domain/src)
- P1 测试入口：[packages/contracts/test](../packages/contracts/test) 与 [packages/domain/test](../packages/domain/test)
- P2–P5 Application 入口：[packages/application/src](../packages/application/src)
- P2–P5 SQLite 入口：[packages/storage-sqlite/src](../packages/storage-sqlite/src)
- P5 REST Adapter 入口：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- P3–P7 Local Server 入口：[apps/local-server/src](../apps/local-server/src)
- 当前 OpenAPI：[apps/local-server/openapi.json](../apps/local-server/openapi.json)
- P3–P7 测试入口：[apps/local-server/test](../apps/local-server/test)
- P4–P5 Web 入口：[apps/web/src](../apps/web/src)
- P4–P5 组件与协议测试：[apps/web/test](../apps/web/test)
- P4–P5 生产 E2E：[apps/web/e2e](../apps/web/e2e)
- P7 CLI 测试入口：[apps/cli/test](../apps/cli/test)
- P7 Work Package 测试入口：[packages/work-package/test](../packages/work-package/test)
- P10 Canonical Export 入口：[packages/canonical-export/src](../packages/canonical-export/src)
- P10 Release Gate 测试：[tooling/test/release-gate.test.ts](../tooling/test/release-gate.test.ts) 与 [tooling/test/release-gate-production.test.ts](../tooling/test/release-gate-production.test.ts)
