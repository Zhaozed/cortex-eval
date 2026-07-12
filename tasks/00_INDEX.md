# Cortex Eval Goal 任务索引

## 执行目标

在 macOS ARM64 上实现 `REQ.md` 第 1–16 节和 `TECH.md` M1–M6 的全部当前功能，并按本轮已确认决策修正文档。未来的 PostgreSQL、多用户、认证授权、Worker、Secret Manager、资源版本历史和 Attempt 历史不在本 Goal 内。

## 执行规则

- 严格按 P0 到 P10 顺序推进，同一时间只允许一个阶段为 `IN_PROGRESS`。
- 每阶段先提交失败测试，再实现，再运行该阶段全部相关测试和已有回归测试。
- 每阶段同步更新 `REQ.md`、`TECH.md` 和由 `spec/00_INDEX.md` 索引的相关 spec；文档不得领先代码声明已经实现。
- 未实现能力不得出现在 API、OpenAPI、CLI Help、Web 导航或 Dashboard 中。
- 阶段门禁通过后更新本索引，并创建一个包含代码、测试、文档和任务状态的 Conventional Commit。
- 不 Push、不创建 PR、不改写已有提交，不回退用户现有修改。
- 普通失败必须定位根因，不得删除测试、放宽类型、降低覆盖率或提高性能阈值。
- 无法解决的问题先隔离依赖链，继续完成其他解耦任务；存在必需未完成项时不得声明 Goal 完成。

## 全局门禁

- `pnpm verify`：格式、Lint、架构边界、Strict TypeScript、单元/集成、Promptfoo 契约、Playwright、性能、构建、OpenAPI 与 spec 一致性。
- `pnpm verify:release`：在 `pnpm verify` 基础上执行一次真实 Gemini `llm-rubric` 和一次真实 Analyzer 结构化输出。
- 核心 Packages 行/函数覆盖率不低于 90%，分支不低于 85%；全仓行/函数不低于 85%，分支不低于 80%。
- Promptfoo 固定为 `0.121.18`；Node 固定为 24 LTS；运行目标仅 macOS ARM64。
- 最终性能门禁使用固定 1,000 Case 数据集与已确认测量协议。

## 阶段状态

- [ ] [P0：事实源、工具链与契约探针](P0_BASELINE_AND_CONTRACTS.md) — `PENDING`
- [ ] [P1：Contracts 与 Domain](P1_CONTRACTS_AND_DOMAIN.md) — `PENDING`
- [ ] [P2：SQLite 与 Application 基础](P2_STORAGE_AND_APPLICATION.md) — `PENDING`
- [ ] [P3：Local API 与资源管理](P3_LOCAL_API_AND_RESOURCES.md) — `PENDING`
- [ ] [P4：Web 资源管理界面](P4_WEB_RESOURCE_UI.md) — `PENDING`
- [ ] [P5：Run 与 REST 闭环](P5_RUN_AND_REST.md) — `PENDING`
- [ ] [P6：Promptfoo Evaluation 闭环](P6_PROMPTFOO_EVALUATION.md) — `PENDING`
- [ ] [P7：Work Package、CLI、重跑与导入基础](P7_WORK_PACKAGE_AND_CLI.md) — `PENDING`
- [ ] [P8：Reporting 闭环](P8_REPORTING.md) — `PENDING`
- [ ] [P9：Case Analysis 闭环](P9_CASE_ANALYSIS.md) — `PENDING`
- [ ] [P10：Canonical Export 与最终硬化](P10_FINAL_HARDENING.md) — `PENDING`

## 最终交付记录

Goal 完成前在此记录阶段 Commit、`pnpm verify:release` 结果、性能实测、Gemini Live 结果、依赖审计、剩余未完成项和工作区状态。
