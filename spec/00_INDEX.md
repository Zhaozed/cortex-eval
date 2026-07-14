# Cortex Eval Spec 索引

## 文档目标

`spec/` 是 Cortex Eval 目标系统的稳定事实入口，服务人类工程师和 AI coding agent。产品行为以 [REQ.md](../REQ.md) 为来源，技术架构以 [TECH.md](../TECH.md) 为来源，文档组织规则以 [SPEC_DOC.md](../SPEC_DOC.md) 为来源。

当前仓库已完成 P0–P7，P8 尚未开始。平台与离线 REST→Evaluation、Work Package v1 导出/校验、安全文件运行时、Retry/Force、连续 Evidence 追溯、Pipeline 写前完整 Evaluation 输入/Prompt/Runtime 预检、固定 Promptfoo 版本、真实取消到 CLI 130、Promptfoo Raw 有界流式 Source、Raw/Normalized Artifact、严格读取、完整 Artifact Manifest 导入身份、发布后同步失败的可见性补偿、当前命令未登记 Artifact 清理、Ajv Diff、SQLite 原子提交和受控 Promptfoo/Bridge/官方 SDK 链已闭环。Case Assert 构建不设类型白名单，平台不复现或限制 Assert 执行；Bridge 只执行冻结 Evaluator 调用，不识别 Assertion/Metric。Report、Analysis、对外平台 Retry/Force、完整结果导入入口和 Canonical Export 尚未闭环。当前状态由 [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) 统一说明。

Goal 分阶段执行方案以 [tasks/00_INDEX.md](../tasks/00_INDEX.md) 为入口。每个阶段必须同步更新本索引和直接相关 spec，未落地能力不得提前改写为代码事实。

## 全局规则
- 先阅读本索引，再按变更范围读取直接相关文档。
- 全局文档只保存跨模块稳定事实；模块内部事实保存在对应模块文档。
- 目标代码落点不是当前代码事实入口，不建立指向不存在路径的链接。
- 类型、Schema、Migration、协议对象和测试落地后成为字段与结构的单一事实源。
- 协议、状态、数据、错误、模块边界或测试口径变化时同步更新相关文档和本索引。
- 文档不保存实现代码、完整字段清单、临时方案或假想扩展。

## 文档更新规则
### 1. 定位与边界
- 记录稳定事实： 专注记录长期稳定的系统级事实（业务规则、模块边界、接口协议、核心流程、状态语义、异常降级、测试口径、核心决策）。
- 忽略易变与细节： 拒写易变内容（配置/UI样式/提示词/配置参数等）。
- 拒绝空泛占位： 严禁使用“后续完善、按需扩展、灵活处理”等无实质信息的废话。

### 2. 单一事实源与代码关联 (SSOT)
- 代码即定义： 代码（类型/Schema/IDL/迁移文件/枚举）是结构与字段的唯一事实源。字段语义写在代码注释中。
- 文档即语义： 文档负责描述业务约束、读写路径和变更影响。严禁在文档中重复罗列字段清单或粘贴实现代码。
- 强制入口映射： 每篇文档必须提供直接相关的代码事实入口（指向稳定类型、服务、配置或测试），拒绝引用临时 helper。
- 冲突解决： 文档与代码事实冲突时，必须先修正不一致源，再提交变更。

### 3. 拓扑与导航
- 唯一总索引： `spec/00_INDEX.md` 是全局唯一导航入口，能定位全部事实。
- 单跳可达原则： 链路严格限制为两级（索引 ➔ 文档 ➔ 代码/测试入口）。跨文档引用仅限直接依赖，严禁形成连续跳转追链。

### 4. 行文与格式：AI和阅读友好
- 极简确定表达： 采用高密度、短句、确定性描述；严禁出现营销话术、情绪表达、模糊判断，禁止使用流程图、表格和 Emoji。
- 表达直白朴素、易懂
- 结构顺位： 结论优先 ➔ 其次约束 ➔ 最后细节。流程描述严格按事实变化时序展开。
- 单一原则： 一段落只表达一个事实；同一概念全局使用唯一名称。
- 精准映射： 状态、枚举、字段、接口名必须使用代码中的真实英文名称；模块职责正向描述，边界明确排除。

### 5. 模块核心要素核对清单
文档在描述具体模块时，必须完整交代以下必填项：
- 模块： 核心职责、明确边界、代码入口、测试入口（测试目录/测试族/定位脚本）。
- 接口： 协议事实入口、错误语义、验收场景。
- 数据与状态： 权威定义来源、读写路径、一致性约束；状态的来源、值域、转移规则及非法状态处理。
- 异常与错误： 错误分类收敛、是否落盘写入、重试/补偿机制、降级策略、外部可见性表现。
- 核心决策： 决策原因、影响范围、当前状态。

## 结构与划分

- 根目录文档记录跨模块职责、流程、不变量、错误、决策和测试。
- `ENTRYPOINTS/` 对应本地服务和 CLI 入口。
- `WEB/` 对应 Web 应用及其稳定业务 Feature。
- `APPLICATION/` 对应 Application 层及其稳定业务 Feature。
- `PACKAGES/` 对应其余独立 Package。
- 文档目录最多一层。模块按稳定职责拆分，不按类、函数、单表或单接口拆分。
- 当前目标不包含常驻 Worker、任务队列或分布式调度，因此不建立空模块文档。

## 全局事实入口

- [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md)：系统职责、实现状态、分层、目标模块和依赖边界。
- [SYSTEM_FLOWS.md](SYSTEM_FLOWS.md)：跨模块主流程、事实提交点、取消和恢复流程。
- [EXTERNAL_BEHAVIOR.md](EXTERNAL_BEHAVIOR.md)：Web、HTTP API 和 CLI 共同对外呈现的行为。
- [INTERNAL_BEHAVIOR.md](INTERNAL_BEHAVIOR.md)：事务、并发、幂等、哈希、快照和状态不变量。
- [ERROR_HANDLING.md](ERROR_HANDLING.md)：错误分类、收敛、重试、补偿、恢复和外部表现。
- [DECISION_LOG.md](DECISION_LOG.md)：当前仍生效的产品和技术决策。
- [TEST.md](TEST.md)：测试分层、断言模型、隔离规则、测试入口和验收口径。
- [MIGRATION_BOUNDARY.md](MIGRATION_BOUNDARY.md)：Canonical Export 与未来 PostgreSQL、多用户、调度、授权、Secret 和 Artifact 迁移边界。

## Entrypoint 事实入口

- [ENTRYPOINTS/LOCAL_SERVER.md](ENTRYPOINTS/LOCAL_SERVER.md)：本地 HTTP Server、Route、Mapper、装配和生命周期。
- [ENTRYPOINTS/CLI.md](ENTRYPOINTS/CLI.md)：平台命令、离线阶段命令和机器输出边界。

## Web 事实入口

- [WEB/OVERVIEW.md](WEB/OVERVIEW.md)：Web 应用公共依赖、状态管理和 Feature 边界。
- [WEB/TEST_SUITES.md](WEB/TEST_SUITES.md)：测试集与 Case 管理页面行为。
- [WEB/CONFIGURATIONS.md](WEB/CONFIGURATIONS.md)：Endpoint、LLM 和 Prompt 配置页面行为。
- [WEB/RUNS.md](WEB/RUNS.md)：运行创建、分阶段、一键执行和进度页面行为。
- [WEB/REPORTS.md](WEB/REPORTS.md)：报告查询、过滤和结果展示行为。
- [WEB/ANALYSIS.md](WEB/ANALYSIS.md)：Case 分析、建议决策和编辑闭环行为。

## Application 事实入口

- [APPLICATION/OVERVIEW.md](APPLICATION/OVERVIEW.md)：Application 层职责、Port、事务和跨 Feature 协作。
- [APPLICATION/TEST_SUITES.md](APPLICATION/TEST_SUITES.md)：测试集、Case 和统一定义写入用例。
- [APPLICATION/CONFIGURATIONS.md](APPLICATION/CONFIGURATIONS.md)：Endpoint、LLM 与 Prompt 当前配置用例。
- [APPLICATION/RUNS.md](APPLICATION/RUNS.md)：输入冻结、阶段编排、取消、恢复和运行提交。
- [APPLICATION/EXECUTION_IMPORTS.md](APPLICATION/EXECUTION_IMPORTS.md)：离线结果校验、幂等导入和冲突处理。
- [APPLICATION/CASE_ANALYSIS.md](APPLICATION/CASE_ANALYSIS.md)：分析执行、当前分析保存和建议应用协调。

## Package 事实入口

- [PACKAGES/DOMAIN.md](PACKAGES/DOMAIN.md)：纯业务类型、状态、不变量、统计和哈希输入。
- [PACKAGES/CONTRACTS.md](PACKAGES/CONTRACTS.md)：跨入口 DTO、Schema、Contract Version 和 Error Code。
- [PACKAGES/STORAGE_SQLITE.md](PACKAGES/STORAGE_SQLITE.md)：SQLite 主事实、Migration、Repository 和一致性约束。
- [PACKAGES/EVALUATION_ADAPTERS.md](PACKAGES/EVALUATION_ADAPTERS.md)：REST、Promptfoo 和分析模型外部适配边界。
- [PACKAGES/REPORTING.md](PACKAGES/REPORTING.md)：报告聚合、解释性 Diff、对账和 Markdown 派生。
- [PACKAGES/WORK_PACKAGE.md](PACKAGES/WORK_PACKAGE.md)：工作包协议、Execution、文件安全、锁和 Artifact Store。

## 当前代码、测试与样例入口

- [packages/contracts/src](../packages/contracts/src)：P1 跨入口协议、版本化 Schema、Error Code、Work Package v1、Bridge 与 Canonical Export v1。
- [packages/contracts/test](../packages/contracts/test)：P1 Contracts 正反例、真实 Fixture 和能力映射测试。
- [packages/domain/src](../packages/domain/src)：P1 纯业务类型、状态机、统计、Proposal 和哈希输入。
- [packages/domain/test](../packages/domain/test)：P1 Domain 单元、边界、竞争和回归测试。
- [packages/application/src](../packages/application/src)：资源 Use Case、流式 Case 导入导出、Run/REST/Evaluation 编排、严格 Promptfoo Result Importer、Eval 持久化 Port 和内部重跑 Use Case。
- [packages/storage-sqlite/src](../packages/storage-sqlite/src)：P2–P5 十表 SQLite、资源/Run Repository、事务与外部 Case staging，以及 P6 原子 Eval 提交和复用 Provenance 对账。
- [packages/evaluation-adapters/src](../packages/evaluation-adapters/src)：REST 请求准备/执行及 Promptfoo、Bridge、冻结 Evaluator SDK Adapter。
- [packages/evaluation-adapters/test](../packages/evaluation-adapters/test)：REST 与 Evaluation Adapter 边界测试。
- [packages/reporting/src](../packages/reporting/src)：P6 锁定 Ajv 版本的 JSON Schema Diff 基础。
- [packages/reporting/test](../packages/reporting/test)：P6 Diff、Missing、非法 Schema 与 Validator 差异测试。
- [apps/local-server/src](../apps/local-server/src)：Fastify、资源/Run REST/Evaluation Route、Run SSE、生产 Web 静态入口、协议 Mapper、安全入口、日志与装配。
- [apps/local-server/openapi.json](../apps/local-server/openapi.json)：由真实当前 Route 与 Schema 确定生成的 OpenAPI。
- [apps/local-server/test](../apps/local-server/test)：HTTP、OpenAPI、安全、流式边界、Run/REST/Evaluation、生命周期与真实 SQLite 集成测试。
- [apps/cli/src](../apps/cli/src)：P7 Work Package 导出/校验、离线 REST/Evaluation/Pipeline、Retry/Force 和机器协议入口。
- [apps/cli/test](../apps/cli/test)：P7 命令注册、Help、Secret、真实阶段执行、重跑和 Pipeline 测试。
- [apps/web/src](../apps/web/src)：资源与 Run REST/Evaluation Web、API Client、路由、Feature 注册和 shadcn/ui Primitive。
- [apps/web/test](../apps/web/test)：组件、表单映射、Run、错误定位、冲突、URL 状态和缓存失效测试。
- [apps/web/e2e](../apps/web/e2e)：P4 生产构建上的完整资源流程、键盘、无障碍、CSP、Reduced Motion 和目标尺寸测试。
- [packages/work-package/src](../packages/work-package/src)：P7 Manifest/Execution、安全文件运行时、Artifact、Retry 证据和严格 Evaluation Result Reader。
- [packages/work-package/test](../packages/work-package/test)：P7 文件安全、大小、并发、恢复、Artifact、Retry 和导入读取测试。
- [packages/work-package/test-fixtures/work-package-v1](../packages/work-package/test-fixtures/work-package-v1)：P7 固定 Manifest Hash、无 Secret 的 Golden Work Package v1。
- [data_scripts/convert_loona_to_promptfoo.py](../data_scripts/convert_loona_to_promptfoo.py)：当前原始数据转换入口。
- [data_scripts/test_convert_loona_to_promptfoo.py](../data_scripts/test_convert_loona_to_promptfoo.py)：当前转换测试族。
- [package.json](../package.json)：Node 24 下的格式、Lint、架构、类型、测试、覆盖率、文档和构建门禁。
- [tooling/src/runtime-doctor.ts](../tooling/src/runtime-doctor.ts)：Node、Python 与 Ruby 运行时事实检查。
- [tooling/src/promptfoo-process-probe.ts](../tooling/src/promptfoo-process-probe.ts)：固定版本预计算输出、退出码、组件、解释器和 Bridge 无 Assertion 身份真实进程探针。
- [tooling/src/promptfoo-special-assertion-probe.ts](../tooling/src/promptfoo-special-assertion-probe.ts)：固定版本比较 Assertion 延迟追加、最终聚合与 Reason 覆盖真实进程探针。
- [tooling/facts/promptfoo-0.121.18-capabilities.json](../tooling/facts/promptfoo-0.121.18-capabilities.json)：Assertion 能力矩阵。
- [tooling/facts/p0-environment.json](../tooling/facts/p0-environment.json)：P0 macOS ARM64 环境与性能基线。
- [test_suite/current/cases/loona_promptfoo_tests.json](../test_suite/current/cases/loona_promptfoo_tests.json)：当前测试集 Fixture。
- [test_suite/current/provider.json](../test_suite/current/provider.json)：当前 Endpoint Fixture。
- [test_suite/current/llm_config.json](../test_suite/current/llm_config.json)：当前 LLM 配置 Fixture。
- [test_suite/current/pf_config.yaml](../test_suite/current/pf_config.yaml)：当前 Promptfoo 配置结构参考。
- [test_suite/current/rubric_prompt/reply_text_repetition_rubric.json](../test_suite/current/rubric_prompt/reply_text_repetition_rubric.json)：当前 Rubric Prompt Fixture。
- [test_suite/current/rubric_prompt/reply_text_transition_rubric.json](../test_suite/current/rubric_prompt/reply_text_transition_rubric.json)：当前 Rubric Prompt Fixture。
- [test_suite/current/run_result/test_example.json](../test_suite/current/run_result/test_example.json)：当前已提交 REST 结果 Fixture，持续纳入 Secret 扫描。
- [test_suite/current/eval_result/test_example.json](../test_suite/current/eval_result/test_example.json)：当前已提交 Promptfoo 结果 Fixture，持续纳入 Secret 扫描。
