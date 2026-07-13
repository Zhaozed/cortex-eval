# 系统总览

## 系统职责

Cortex Eval 是面向本地单用户的测试集管理、REST 结果获取、Promptfoo 评估、报告查看和失败分析工具。系统提供本地平台和离线 CLI 工作包两种运行形态，两者共享 Case、结果、报告、错误和分析契约。

系统不提供资源版本历史、运行 Attempt 历史、分析历史、认证授权、多人协作、持久任务队列或多实例调度。

当前只支持并验证 macOS ARM64 与 Node.js 24 LTS。默认运行数据目录是项目根 `.cortex-eval/`，默认服务地址是 `http://127.0.0.1:4310/api/v1`。

## 实现状态

当前仓库已完成 P0–P5。Node 24/pnpm Workspace、严格 TypeScript、格式/Lint/架构/文档/覆盖率门禁、Runtime Doctor、真实 Fixture 契约与 Secret 扫描、Promptfoo 固定版本进程探针、137 条完全展开的 Assertion 能力契约和确定性 Benchmark Harness 已生效。Contracts 与 Domain 已冻结并实现纯协议和业务规则；十表 SQLite、资源 Repository、Test Suite/Case/Configuration Application 用例、流式 Case 导入导出、Local Server、资源管理 Web，以及平台 Run 创建与 REST 执行闭环已落地。

当前 OpenAPI 与 Web 包含 Test Suite、Case、Endpoint、LLM、LLM Rubric Prompt、Case Analysis Prompt 和平台 Run/REST 闭环。平台可预检并冻结资源创建 Run，通过真实 HTTP 执行 REST、保存逐 Case 结果与不可变 Artifact、查询进度、取消并恢复遗留运行；Dashboard 和 Test Suite 列表读取最近平台 Run。Evaluation、Report、Analysis、Retry/Force、Work Package 文件运行时、Execution Import、Canonical Export 执行和目标 CLI 均未注册；测试数据转换脚本与旧 REST 运行脚本继续作为回归基线。

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

- `apps/local-server`：P3–P5 已落地的本地 HTTP Server、资源与 Run Route、Run SSE、生产 Web 静态入口、Mapper、安全入口、日志、OpenAPI、依赖装配和生命周期。
- `apps/web`：P5 已落地 Dashboard、测试集/Case、四类配置管理和平台 Run/REST；后续 Feature 按报告和分析组织。
- `apps/cli`：平台 API 命令和离线工作包命令。
- `packages/domain`：纯业务类型和规则，P1 已落地。
- `packages/application`：P2–P5 已落地资源 Use Case、Port、流式导入导出和平台 Run/REST 编排。
- `packages/contracts`：DTO、Schema、Contract Version 和 Error Code，P1 已落地。
- `packages/storage-sqlite`：P2–P5 已落地 SQLite Schema、Migration、资源/Run Repository、事务和外部 Case staging。
- `packages/evaluation-adapters`：P5 已落地 REST Adapter；Promptfoo 和分析模型 Adapter 随后续阶段实现。
- `packages/reporting`：纯报告聚合、Diff 和 Markdown Renderer。
- `packages/work-package`：Manifest、Execution、路径安全、文件锁和 Artifact Store。

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
- 当前 REST 类型：[data_scripts/run_promptfoo_rest_types.ts](../data_scripts/run_promptfoo_rest_types.ts)
- 当前 REST 实现：[data_scripts/run_promptfoo_rest.ts](../data_scripts/run_promptfoo_rest.ts)
- 当前转换实现：[data_scripts/convert_loona_to_promptfoo.py](../data_scripts/convert_loona_to_promptfoo.py)
- Goal 执行入口：[tasks/00_INDEX.md](../tasks/00_INDEX.md)
- P0 工具链入口：[package.json](../package.json)
- P0 Runtime Doctor：[tooling/src/runtime-doctor.ts](../tooling/src/runtime-doctor.ts)
- Promptfoo 能力矩阵：[tooling/facts/promptfoo-0.121.18-capabilities.json](../tooling/facts/promptfoo-0.121.18-capabilities.json)
- P0 测试入口：[tooling/test](../tooling/test)
- P1 Contracts 入口：[packages/contracts/src](../packages/contracts/src)
- P1 Domain 入口：[packages/domain/src](../packages/domain/src)
- P1 测试入口：[packages/contracts/test](../packages/contracts/test) 与 [packages/domain/test](../packages/domain/test)
- P2–P5 Application 入口：[packages/application/src](../packages/application/src)
- P2–P5 SQLite 入口：[packages/storage-sqlite/src](../packages/storage-sqlite/src)
- P5 REST Adapter 入口：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- P3–P5 Local Server 入口：[apps/local-server/src](../apps/local-server/src)
- P5 OpenAPI：[apps/local-server/openapi.json](../apps/local-server/openapi.json)
- P3–P5 测试入口：[apps/local-server/test](../apps/local-server/test)
- P4–P5 Web 入口：[apps/web/src](../apps/web/src)
- P4–P5 组件与协议测试：[apps/web/test](../apps/web/test)
- P4–P5 生产 E2E：[apps/web/e2e](../apps/web/e2e)
