# Cortex Eval 本地版技术方案

## 1. 文档职责

本文档定义 Cortex Eval 本地版的技术选型、项目架构、模块边界、数据结构、运行状态、离线工作包、REST 与 Promptfoo 集成、报告转换、Case 分析、安全边界和测试策略。

产品行为和验收口径以 `REQ.md` 为准。本文档不包含具体实现代码。

阶段实现状态以 `tasks/00_INDEX.md` 和 `spec/SYSTEM_OVERVIEW.md` 为准。截至 P5，Contracts、Domain、十表 SQLite、资源 Application 用例、Local Server、资源管理 Web，以及平台 Run 创建与 REST 执行闭环已落地；Work Package、Evaluator Bridge 和 Canonical Export 仍只有纯协议。Evaluation、Report、Analysis、Retry/Force、Execution Import、Work Package 文件运行时和目标 CLI 入口按后续阶段推进。

## 2. 总体结论

系统采用 TypeScript 模块化单体架构。本地平台由 Web、本地 HTTP API 和单文件 SQLite 组成；离线 CLI 使用文件工作包执行相同的 REST、评估、报告和分析阶段。

当前只支持并验证 macOS ARM64，运行时固定为 Node.js 24 LTS。生产数据默认位于项目根 `.cortex-eval/`，Local Server 默认监听 `127.0.0.1:4310` 并同源提供 Web 与 `/api/v1`。

当前只实现 SQLite，不同时维护 PostgreSQL 兼容层。未来多用户平台通过版本化导出契约迁移到外置 PostgreSQL，并重新设计租户、授权、调度和 Secret 管理。

平台包含十张业务表：

- `test_suite`
- `test_case`
- `endpoint_config`
- `llm_config`
- `llm_rubric_prompt`
- `case_analysis_prompt`
- `run_log`
- `case_result`
- `eval_result`
- `case_analysis`

系统不建立资源版本、Attempt、Job、独立 Artifact 或 Prompt 关联历史表。Artifact 预期元数据保存在 `run_log.artifact_manifest_json`，每 Case Allowlist Evidence 元数据保存在 `eval_result`；文件当前存在性由边界校验。并发 Token 只用于防止覆盖，不表示历史版本。

API、Web 和 CLI 不承载业务规则。所有业务入口调用 Application Use Case；Domain 保持纯粹；SQLite、文件、REST、Promptfoo 和 LLM 调用位于系统边缘。

## 3. 真实数据入口

- `test_suite/current/cases/loona_promptfoo_tests.json`：Promptfoo 测试集。
- `test_suite/current/run_result/test_example.json`：带 `providerOutput` 的当前已提交 REST 结果。
- `test_suite/current/eval_result/test_example.json`：当前已提交 Promptfoo 完整结果。
- `test_suite/current/llm_config.json`：LLM Evaluator 配置。
- `test_suite/current/provider.json`：REST Endpoint 配置。
- `test_suite/current/rubric_prompt/*.json`：LLM Rubric Prompts。
- `test_suite/current/pf_config.yaml`：生成配置的结构参考。

系统支持 Promptfoo `0.121.18` 能力矩阵列出的全部内置 Assertion。技术方案必须覆盖 `rubricPrompt`、可信内联 JavaScript/Python/Ruby、`transform`、`contextTransform`、嵌套 Assertion Set、组件级 Grading Result 和预计算 `providerOutput`。当前不支持 `file://` 外部代码、外部模块、额外依赖或自定义 Provider 插件。

## 4. 项目架构设计

### 4.1 架构目标

- Domain 不依赖数据库、文件、网络、HTTP、Promptfoo 或 LLM SDK。
- UI、API 和 CLI 复用相同业务用例，不复制状态机、统计和校验逻辑。
- 平台持久化与离线文件存储保持不同接口，不把文件系统伪装成数据库。
- 外部副作用推迟到系统边缘，外部调用期间不持有数据库事务。
- 当前结构服务真实本地需求，不预埋租户、队列和分布式抽象。
- 模块职责清晰，但不把每个业务名词机械拆成独立 npm Package。

### 4.2 运行时架构

平台模式的数据流：

1. Web 通过 API Client 调用本地 HTTP API。
2. HTTP Route 校验协议并映射到 Application Command。
3. Application 读取当前资源，调用 Domain 规则，协调 Repository 和外部 Port。
4. SQLite Repository 保存平台当前资源、运行阶段和导入结果。
5. REST、Promptfoo 和 Analysis Model Adapter 执行外部副作用。
6. Application 提交规范化结果，API 返回稳定 DTO。

离线模式的数据流：

1. CLI 读取不可变 `manifest.json` 和输入文件。
2. Work Package 模块验证版本、路径和文件哈希。
3. 阶段 Use Case 接收冻结的 `ExecutionContext`。
4. REST、Promptfoo、Reporting 和 Analysis 使用与平台相同的 Domain 契约。
5. 阶段产物经 `StageArtifactStore` 原子写入工作包。
6. `result import` 通过本地 API 把规范化结果导回平台。

离线 CLI 不打开平台 SQLite。平台 CLI 命令与 Web 通过相同 HTTP API 操作平台；离线阶段命令只操作工作包。

### 4.3 分层与依赖方向

`domain` 是最内层：

- 保存业务实体、值对象、状态、纯校验、统计、哈希输入和状态归并规则。
- 不依赖 Zod、HTTP DTO、数据库类型或第三方协议。
- 不接收 `unknown`、未校验 JSON 或第三方原始响应。

`reporting` 是纯计算层：

- 只依赖 `domain` 和完成 JSON Schema Diff 所需的纯计算库。
- 不依赖 `contracts`、`application`、数据库、文件、网络或 Entrypoint。
- 返回 Domain Report Model 或结构化对账错误，不返回跨进程 DTO。

`application` 依赖 `domain` 和纯 `reporting`：

- 保存 Use Case、业务 Port、事务边界和跨聚合协调。
- 决定何时读写事实、何时调用外部副作用以及如何收敛错误。
- 不依赖 `contracts`、具体 SQLite、文件或 Provider SDK。

`contracts` 保存跨入口稳定协议：

- API Request/Response DTO。
- Work Package、结果导入和报告 Schema。
- 稳定 Error Code。
- Zod 边界 Schema。

`contracts` 不保存业务规则，也不依赖 `domain`、`reporting` 或 `application`。边界 Mapper 同时依赖 Contracts 与 Application/Domain 类型并负责转换，避免核心层反向依赖跨进程协议。

Infrastructure 实现 Application Port：

- SQLite Repository。
- REST Client。
- Promptfoo 子进程。
- Analysis Model Client。
- Work Package 文件存储。
- Clock 和 ID Generator。

Entrypoint 只负责装配和协议转换：

- `local-server` 负责启动、HTTP Route、生命周期和依赖装配。
- `web` 只依赖 API Client 和 Contracts，不依赖 Domain 或数据库。
- `cli` 负责参数解析、消息展示、平台 API 调用和离线阶段调用。

依赖方向通过 TypeScript Project References、ESLint Import Boundary 和架构测试共同约束。

### 4.4 物理目录

仓库采用 pnpm workspace：

- `apps/local-server`：本地 HTTP Server、Route、Mapper、依赖装配和生命周期。
- `apps/web`：React Web UI。
- `apps/cli`：平台命令和离线工作包命令。
- `packages/domain`：纯业务类型和规则。
- `packages/application`：Use Case、业务 Port 和 Feature 编排。
- `packages/contracts`：跨进程 DTO、Zod Schema 和 Error Code。
- `packages/storage-sqlite`：SQLite Schema、Migration 和 Repository。
- `packages/evaluation-adapters`：REST、Promptfoo 和 Analysis Model 外部 Adapter。
- `packages/reporting`：纯报告聚合、Assertion Diff 和 Markdown Renderer。
- `packages/work-package`：Manifest、Execution、路径安全、文件锁和 Artifact Store。

业务模块位于 `packages/application/src/features`：

- `test-suites`
- `configurations`
- `runs`
- `execution-imports`
- `case-analysis`

只有形成稳定依赖、独立复用或测试隔离边界时，业务模块才升级为独立 Package。

禁止建立模糊的 `shared` 或 `utils` 巨型包。可复用函数必须归属明确业务或技术职责。

生产源码不包含 Fake 和 Mock。测试替身放在各 Package 的 `test-support` 或测试目录，并使用明确的 `Fake*`、`Stub*` 名称。

### 4.5 Web 目录边界

Web 按业务 Feature 组织：

- `features/test-suites`
- `features/configurations`
- `features/runs`
- `features/reports`
- `features/analysis`

`components/ui` 保存 shadcn/ui primitives。Primitive 只负责表现、可访问性和基础交互，不负责请求、状态机、业务校验或错误翻译。

API Query、Form Model、页面状态和业务组件放在对应 Feature 内。跨 Feature 复用必须基于稳定产品概念，不建立通用页面状态容器。

### 4.6 业务模块职责

#### Test Suite

负责测试集和 Case 当前定义、导入导出、筛选派生字段、Rubric 引用和统一写入。

不负责运行结果、Promptfoo 调用或历史版本。

#### Configuration

负责 Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的当前配置。

LLM 配置可以承担 Evaluator 或 Analyzer 角色，角色由评估运行或分析请求显式选择。配置模块不展开或保存 Secret。

#### Run Orchestration

负责冻结输入、运行模式、阶段推进、取消、恢复、计数、最终报告提交和唯一活跃执行约束。

不实现 HTTP 请求、Promptfoo 解析或模型 SDK 协议。

#### REST Execution

负责从冻结 Case 和 Endpoint 配置构造请求、限制并发、校验 Provider Output 并规范化错误。

不读取平台当前资源，不写多个业务聚合。

#### Promptfoo Evaluation

负责生成受控 Promptfoo 输入、启动固定版本子进程、通过本机临时 Evaluator Bridge 调用统一 Evaluator Adapter、导入原始结果和生成规范化 Eval 事实。

不使用 Promptfoo 自带数据库或 UI 作为平台事实。

#### Reporting

负责纯统计、Case Metric 聚合、JSON Schema 解释性 Diff、Report DTO 和 Markdown 渲染。

Report JSON 是事实，Markdown 是派生物。Reporting 不访问数据库和网络。

#### Case Analysis

负责分析输入构造、Prompt 渲染、模型输出校验、当前分析保存和建议应用协调。

模型调用由 `AnalysisModelClient` 实现。Case Analysis 不直接修改 Test Suite，由 Application 在短事务内调用统一 Case Writer。

#### Work Package

负责文件协议、版本、路径安全、不可变 Manifest、Execution 状态、跨进程锁、原子写入和 Artifact Schema。

不负责平台数据库写入。结果导入由 `ImportExecutionResult` Use Case 完成。

#### Storage

负责 SQLite Migration、Repository、事务和查询优化。

Repository 不解析第三方原始响应，不信任工作包 Summary，不跨过 Application 编排业务流程。

#### Local API

Local API 是 `apps/local-server` 内的 Route 和 Mapper，不建立重复 Package。

它负责协议认证边界、输入校验、错误映射、分页和流式进度，不保存业务规则。

### 4.7 核心 Port

Application 只为可替换或带副作用的边界定义 Port：

- `TestSuiteRepository`
- `ConfigurationRepository`
- `RunRepository`
- `CaseAnalysisRepository`
- `TransactionManager`
- `RestExecutor`
- `PromptfooProcess`
- `AnalysisModelClient`
- `WorkPackageStore`
- `StageArtifactStore`
- `Clock`
- `IdGenerator`

报告聚合、JSON Schema Diff、Canonical JSON、SHA-256 输入构造和状态归并是纯函数，不定义无意义 Port。

平台 Repository 与 File Workspace 不实现同一套持久化接口。离线阶段直接接收冻结 `ExecutionContext`，并通过窄接口读取输入和写入阶段产物。

### 4.8 聚合和事务边界

Test Suite 聚合包括当前 Test Suite 和 Cases。所有 Case 写入口共用 `CaseDefinitionWriter`，在一个短事务中：

1. 校验 Case Definition。
2. 解析 Rubric Prompt Keys。
3. 校验引用。
4. 写入 Case 和筛选派生字段。
5. 重算 Case Count 和 Suite Hash。

Run 聚合包括 Run Log、Case Results 和 Eval Results。外部 REST、Promptfoo 和 LLM 调用在事务外执行；阶段开始、进度和阶段提交使用独立短事务。

Case Analysis 是独立事实。应用建议时由 Application 协调：

1. 锁定分析记录。
2. 校验 Analysis Input Hash。
3. 读取并校验当前 Case Definition Hash。
4. 调用 CaseDefinitionWriter。
5. 写入分析决策和应用结果。

结果导入由 `ImportExecutionResult` Use Case 负责：

1. 校验 Package、Execution 和来源身份。
2. 校验规范化明细。
3. 检查 `execution_id` 幂等。
4. 从明细重算统计和哈希。
5. 在一个事务中保存 Run、Case Results 和 Eval Results；同批存在分析结果时再校验并保存当前分析。

相同 Execution ID 且 Result Set Hash 相同视为幂等成功；相同 ID 对应不同结果哈希返回 `EXECUTION_RESULT_CONFLICT`。

分析可以在报告之后单独导入。分析导入先通过 Execution ID 定位 Run，再校验 Final Case Result Hash 和 Analysis Input Hash；相同 Analysis Input Hash 幂等，不同输入按 Case Analysis Revision 条件更新当前分析。

工作包解析与平台数据提交是两个独立职责。

### 4.9 横切关注点

- 外部 `unknown` 先经 Zod 校验，再进入 Application Mapper。
- Domain 返回结构化错误，不返回用户文案。
- Error Code 位于 Contracts。
- 中文用户文案和日志模板放在消息资源中，不在 Domain、Route 或组件中硬编码。
- 日志只记录业务事件名、安全标识、状态、耗时和 Error Code。
- Secret 脱敏在边界完成，脱敏后的 DTO 才能进入快照和响应。
- 取消信号由 Application 管理，Adapter 负责终止自身资源。
- 所有外部进程和临时目录在 `finally` 中回收。
- REST、Evaluator、Analyzer 和 Promptfoo Provider 均显式关闭自动重试。重跑由新的 Run 或 Execution 表达。

### 4.10 未来演进边界

当前 M6 只实现 Canonical Export v1。导出使用版本化 Manifest 和按实体稳定排序的 Canonical JSONL，覆盖当前资源、历史 Run/Case/Eval、当前 Analysis、Contract Versions 和 Artifact 预期元数据。读回执行计数、引用、实体 Hash 和文件 Hash 四类对账；Secret 不展开，Raw Evidence 默认不内嵌，缺失 Raw 记录 `present=false`。

未来 PostgreSQL 平台通过以下方式迁移：

1. 使用版本化 Canonical Export DTO 导出 SQLite 当前资源和历史运行。
2. 新增独立 `storage-postgres` Package 和 PostgreSQL Migration。
3. 执行离线数据校验、转换、导入和对账。
4. 新增 Tenant Context、租户内唯一约束、认证、授权、调度和 Secret Manager。
5. 保留 Domain 的通用评估规则，但允许 Application、Contracts 和 Storage Schema 因多用户需求演进。

Kysely 隔离查询实现，不保证 SQLite Schema 或 Migration 自动转换为 PostgreSQL。

### 4.11 架构验收

- 自动测试阻止 Domain 导入 Contracts、Infrastructure 或 Entrypoint。
- Web 不能导入 Domain 和 Storage。
- Application 只能导入 Domain、Reporting 和自身 Port，不能导入 Contracts 或 Infrastructure。
- Reporting 只能导入 Domain 和纯计算库，不能导入 Contracts、Application、Infrastructure 或 Entrypoint。
- Contracts 不能导入 Domain、Reporting 或 Application。
- Route 和 CLI 不包含统计、状态归并或 Case 写入规则。
- SQLite Repository 与 File Workspace 分别通过自身契约测试。
- 平台和离线阶段对相同 Execution Context 生成相同规范化结果。
- 两个独立进程同时启动平台阶段时只有一个成功。
- 两个 CLI 进程不能同时写同一工作包。
- 千级 Case 查询和报告生成满足性能验收。

## 5. 技术选型

### 5.1 应用栈

- Node.js 24 LTS，仅支持并验证 macOS ARM64。
- TypeScript Strict Mode。
- pnpm Workspace。
- Fastify HTTP API。
- Zod 校验边界 DTO 和外部 JSON。
- Kysely 构建显式 SQL 和 Repository。
- better-sqlite3 访问本地 SQLite。
- React 和 Vite 构建 Web。
- Tailwind CSS 和 shadcn/ui 构建 UI Primitive。
- TanStack Query 管理服务端状态。
- TanStack Table 构建分页和筛选表格。
- React Hook Form 管理表单。
- Commander 构建 CLI。
- Vitest 执行单元和集成测试。
- Promptfoo 使用 Lockfile 中的精确版本 `0.121.18`。

选择 better-sqlite3 是基于本地单写者、短事务、成熟生态和 Kysely 适配能力。同步数据库调用只能出现在短 Repository 操作中，禁止包裹外部调用或大规模 CPU 工作。

不引入第二套 ORM。Kysely 是唯一 SQL Query Builder。

### 5.2 SQLite

SQLite 是当前唯一业务数据库。选择原因：

- 单文件，无独立数据库服务。
- 事务、唯一约束和普通索引足以支持千级单用户数据。
- 适合本地应用状态和备份。
- 可以通过版本化导出 DTO 迁移到未来平台。

连接初始化启用：

- Foreign Keys。
- WAL。
- Busy Timeout。
- 受控同步模式。

当前实现固定使用 Kysely `0.29.3`、better-sqlite3 `12.11.1` 和对应类型 `7.6.13`。只使用 Kysely 托管事务；事务回调可以等待数据库 Promise，但只获得事务绑定 Repository，不获得网络、文件或外部验证 Port。不得混用 better-sqlite3 托管事务或手工 `BEGIN/COMMIT`。

事务管理器只对 `SQLITE_BUSY` 与 `SQLITE_BUSY_SNAPSHOT` 进行最多四次完整短事务重启；每次都创建新的 Kysely 托管事务。耗尽后返回稳定 `STORAGE_TRANSACTION_CONFLICT`，其他异常不重试。该机制只处理数据库锁竞争，不代表 REST、Evaluator、Analyzer 或 Promptfoo 的外部调用重试。

Storage 只接受装配层传入的绝对项目根，不读取或猜测 `process.cwd()`。数据库固定解析为 `<projectRoot>/.cortex-eval/db/cortex-eval.sqlite3`；状态目录收敛为 `0700`，数据库及 WAL/SHM 文件收敛为 `0600`。每个独立连接都验证 Foreign Keys、WAL、5 秒 Busy Timeout 和 `synchronous=FULL`。

应用只允许 local-server 写平台数据库。CLI 平台命令通过 HTTP API，避免多个进程绕过应用级协议。

### 5.3 Promptfoo

Promptfoo 是评估执行器，不是业务数据库、报告事实源或平台 UI。

系统使用固定 CLI 参数启动本地已安装的精确版本，不通过 `npx` 临时下载。启动前校验实际版本与运行上下文一致。

系统不依赖 Promptfoo 未承诺稳定的内部 JS API。原始 JSON 经过严格 Importer 转换后才能进入平台事实。

系统从精确版本生成 Assertion 能力矩阵。矩阵记录每种类型、合法 Payload、是否需要 Evaluator、解释器或外部协议，以及 Importer 对齐规则；测试门禁保证矩阵中每个类型都有对应契约测试。

Assertion 中的内联 JavaScript、Python、Ruby、`transform` 和 `contextTransform` 默认可信，不检测、不提示、不沙箱。`file://` 外部代码、外部模块、额外依赖、Assertion 内嵌 Provider 和 Provider 插件在边界拒绝。

P0 Doctor 冻结发布环境前置：Python 使用 `PROMPTFOO_PYTHON` 或 `python3`，版本不低于 3.7；Ruby 使用 `PROMPTFOO_RUBY` 或 `ruby`，并以真实内联 Assertion Smoke 判定兼容。发布记录实际解释器路径与版本，但不把机器绝对路径写入 Work Package。系统不自动安装解释器或第三方语言依赖。

## 6. 通用类型约定

- 内部 ID 使用应用生成 UUIDv7，SQLite 保存为 `TEXT`。
- 时间保存为 UTC ISO 8601 `TEXT`。
- JSON 保存为规范化 `TEXT`，写入前必须通过强类型 Schema。
- Boolean 保存为受检查约束的 `INTEGER`。
- Count、Ordinal、Duration 和 Token 保存为非负 `INTEGER`。
- Score 和近似 Cost 保存为 `REAL`，不存在的事实保存 `NULL`。
- Hash 使用 RFC 8785 Canonical JSON 和 SHA-256，保存为 64 位小写十六进制 `TEXT`。
- 状态保存为带 Check Constraint 的 `TEXT`，TypeScript 使用穷尽联合类型。

`RunExecutionLimitsV1` 包含 `restConcurrency` 和 `evalConcurrency`。平台 Create Run 和离线 Create Execution 接受该契约；REST 默认来自 Endpoint 配置且新建 Endpoint 默认为 4，Eval 默认 2，范围分别为 1–64 和 1–16。`AnalysisExecutionLimitsV1` 包含 `analysisConcurrency`，默认 1、范围 1–8，在每次 Analysis 请求或离线 Execution 创建时冻结。两类限制都进入对应 Snapshot/Execution Context 和 Hash。
- 第三方未提供事实时保存 `NULL`，不得伪造为零或空对象。

数据层避免 PostgreSQL 专属 ARRAY、JSONB、ENUM、GIN、Advisory Lock 和表达式查询依赖。

## 7. 十张业务表

### 7.1 test_suite

保存当前测试集聚合根。

核心字段：ID、Name、Description、Case Count、Suite Hash、Created At、Updated At。

Name 唯一。Case Count 和 Suite Hash 必须能从当前 Cases 重算。

Revision 是当前聚合并发 Token。任何 Case 写入与 Suite 显示字段更新都执行条件递增；Suite Hash 只包含按 Ordinal 排序的 Case Key、Ordinal 和 Definition Hash，不包含 ID、名称、描述与时间。

### 7.2 test_case

保存测试集中的当前 Case。

核心字段：

- ID、Suite ID。
- Case Key 和 Ordinal。
- Description。
- Business Module 和 Scenario Tag 派生筛选列。
- Assertion Types JSON Array 和 Metrics JSON Array 派生筛选列。
- Definition JSON。
- Rubric Prompt Keys JSON。
- Definition Hash。
- Revision。
- Created At、Updated At。

`(suite_id, case_key)` 和 `(suite_id, ordinal)` 唯一。

Definition JSON 保存完整稳定 Case Definition。版本根、`vars`、`metadata` 和 Assertion 对象使用闭合键集合；未知字段即使具有同步更新的 Hash 也视为脏持久化事实。筛选列只用于查询优化，必须由 CaseDefinitionWriter 从 Definition 统一重算，不能由 API 单独写入。

千级筛选先用 Suite、Business Module、Scenario Tag 等普通复合索引缩小范围。Case Key 与 Description 使用大小写无关的字面子串查询；Assertion Type 和 Metric 使用 SQLite JSON1 `json_each` 对规范化数组做精确成员查询，不使用字符串包含匹配，也不引入 FTS。相关组合查询必须有千级数据性能测试；不满足时再根据真实查询增加派生索引结构。

### 7.3 endpoint_config

保存当前 REST Endpoint 配置。

核心字段：ID、Name、URL Template、Method、Headers JSON、Body Selector、Timeout、Concurrency、Config Hash 和时间字段。

Revision 独立于 Config Hash。Config Hash 包含全部运行语义，但不包含 ID、Name、Revision 和时间。

Header 值是 `LiteralHeaderValue | EnvSecretRef` 判别联合。Header 名必须满足 HTTP Token 语法，按大小写无关语义拒绝重复，并以小写名称进入 Config Hash。只有固定安全列表中的 `Content-Type`、`Accept` 和 `User-Agent` 允许 Literal；其他 Header，包括任意自定义 Header，必须使用 EnvSecretRef。URL 禁止 User Info，名称包含 Key、Token、Secret、Credential、Password 或 Auth 的 Query 参数禁止 Literal。

Method 固定为 `POST`。URL 模板只允许读取 `vars` 下任意层级标量叶子并按单个 URL 组件编码，不能替换协议、Host 或端口。Body Selector 使用 RFC 6901 JSON Pointer，选中值必须为 JSON 对象。

新建 Endpoint 的 Concurrency 默认值为 4，允许范围为 1–64；它是 Create Run 的 REST 并发默认值。

### 7.4 llm_config

保存当前 Evaluator 或 Analyzer LLM 配置。

核心字段：ID、Name、Provider Type、Model、Options JSON、Secret Refs JSON、Config Hash 和时间字段。

Revision 独立于 Config Hash。Config Hash 包含 Provider、Model、统一 Options、Secret 引用名称与结构输出能力，不包含 ID、Name、执行角色、Revision 和时间。

表中不保存固定角色。同一配置可以被不同运行分别选择为 Evaluator 或 Analyzer。

Options JSON 使用 Provider 白名单 Schema，并在读取时拒绝未知字段、非法枚举与认证联合不匹配的 Secret 形状。任意层级出现 `apiKey`、`token`、`secret`、`password`、`credential`、`authorization` 或同义字段时拒绝保存，Secret 只能通过独立 EnvSecretRef 字段提供。四类配置的持久化行都必须重新计算语义 Hash 并与存储值一致。

Provider Type 只允许 `GOOGLE_GEMINI` 和 `OPENAI_COMPATIBLE`。两者统一公开 `model`、`thinkingLevel`、`temperature`、`topP`、`maxOutputTokens` 和 `timeoutMs`。OpenAI-compatible 只实现 Chat Completions，把 `OFF | LOW | MEDIUM | HIGH` 映射为 `reasoning_effort: none | low | medium | high`；Provider 以 400/422 拒绝统一能力参数时返回 `CAPABILITY_UNSUPPORTED`，不得静默忽略。远程 Base URL 必须使用 HTTPS 与 Bearer EnvSecretRef；本地回环可显式选择无认证，此时 SDK 请求必须显式移除 `Authorization`。Analyzer 结构输出能力显式为 `JSON_SCHEMA | JSON_OBJECT`。

### 7.5 llm_rubric_prompt

保存当前 LLM Rubric Prompt。

核心字段：ID、Prompt Key、Name、Messages JSON、Prompt Hash 和时间字段。

Revision 独立于 Prompt Hash。Prompt Hash 包含 Prompt Kind、Key 和有序 Messages，不包含显示 Name、Revision 和时间。

Prompt Key 唯一。当前 Case 引用通过 `test_case.rubric_prompt_keys_json` 维护逻辑关联。

### 7.6 case_analysis_prompt

保存当前 Case 分析 Prompt。

核心字段：ID、Prompt Key、Name、Messages Template JSON、Prompt Hash 和时间字段。

Revision 与 Prompt Hash 的包含、排除规则和 Rubric Prompt 相同。

模板中实际变量由保存时扫描派生，不重复保存 `variables_json`。允许变量集合由版本化 Contract 定义。

### 7.7 run_log

保存平台运行或离线导入运行的身份、冻结上下文、阶段状态、进度和最终 Summary。

核心字段：

- ID、Source Type、Source Package ID、Execution ID、Source Run ID、Rerun Mode。
- Suite、Endpoint 和 Evaluator 当前来源 ID。
- 各类脱敏 Snapshot JSON。
- Run Context Hash、Promptfoo Version、Contract Versions。
- 冻结的 Run Execution Limits JSON。
- Run Mode、Status、Stage、Lock Revision、Cancel Requested At。
- REST 和 Eval Counters。
- Summary JSON、Result Set Hash。
- Artifact Manifest JSON，保存受控相对路径、Kind、预期 Hash、大小和 Contract Version。
- Error Code、Error Message 和阶段时间。

离线导入使用 Execution ID 唯一约束实现幂等。来源资源删除后 ID 可以为空，历史快照保持有效。

`source_run_id` 与 Case/Eval 的 `reused_from_run_id` 对历史 Run 使用 `ON DELETE RESTRICT`；Suite、Endpoint、Evaluator 当前来源 ID 使用 `ON DELETE SET NULL`。当前不提供历史 Run 删除用例，Provenance 不因当前资源删除而丢失。

### 7.8 case_result

保存一个 Run/Case 的 REST 执行事实和不可变 Case 快照。

核心字段：Run ID、Case Key、Ordinal、Case Definition JSON/Hash、REST Status、HTTP Status、Provider Output、Duration、规范化错误、Completed At、Run Result Hash、Reused From Run/Execution ID 和 Reused Result Hash。

主键为 `(run_id, case_key)`，`(run_id, ordinal)` 唯一。

REST `SUCCEEDED` 必须有合法 Provider Output；`ERROR` 必须有规范化错误且 Provider Output 为空。

### 7.9 eval_result

保存一个 Run/Case 的规范化评估事实。

核心字段：

- Run ID、Case Key。
- Eval Status。
- Promptfoo Success、Score 和 Reason。
- Evaluation Error。
- Assertion Results JSON。
- Expected Actual Diffs JSON。
- Metric Results JSON。
- Latency、Token Usage 和 Cost。
- Allowlist Raw Evidence JSON。
- Eval Result Hash、Final Case Result Hash。
- Reused From Run/Execution ID 和 Reused Eval Result Hash。
- Created At、Updated At。

主键为 `(run_id, case_key)`，联合外键引用 Case Result。

REST 阶段完成但 Eval 未开始时不创建 Eval Result。完整报告要求每条 Case Result 都有且仅有一条 Eval Result。

### 7.10 case_analysis

保存一个 Run/Case 的当前分析、建议和用户决策。重新分析覆盖当前记录。

核心字段：

- ID、Run ID、Case Key。
- Final Case Result Hash。
- Analysis Revision。
- Analysis Prompt Key、Hash 和脱敏 Snapshot。
- Analyzer Config Hash、Provider、Model 和脱敏 Snapshot。
- Analysis Input Contract Version、Analysis Output Contract Version 和 Analysis Input Hash。
- 冻结的 Analysis Execution Limits JSON。
- Analysis Status、Classification、Confidence、Evidence、Explanation、Recommended Action。
- Proposal JSON。
- Decision、Apply Status、Base/Applied Definition Hash。
- Error 和时间字段。

`(run_id, case_key)` 唯一，并以同一组字段联合外键引用 `eval_result`。Analysis Revision 从 1 开始，每次重新分析或并发可见写入递增。

`analysis_input_hash` 对完整规范化 Analysis Input 计算。输入包含实际渲染前的全部结构化变量、Final Case Result Hash、Run Context、Diff Contract Version 和 Analysis Input Contract Version，再组合 Analysis Prompt Hash、Analyzer Config Hash 与 Analysis Output Contract Version。

初始 Migration 恰好创建以上十张业务表，并允许 Kysely 自有 `kysely_migration` 与 `kysely_migration_lock` 元数据表；它们不计入业务表数量。

## 8. 运行状态和阶段

Run Mode：

- `STAGED`
- `PIPELINE`

Run Status：

- `READY`：等待开始或等待用户继续下一阶段。
- `RUNNING`：某一阶段正在执行。
- `COMPLETED`：完整报告已提交且无 REST/Eval Error。
- `COMPLETED_WITH_ERRORS`：完整报告已提交但存在 Error 或 Not Evaluated。
- `FAILED`：系统错误导致当前运行无法继续。
- `CANCELLED`：用户取消并完成收口。
- `INTERRUPTED`：进程中断，无法确认当前阶段完整性。

Run Stage：

- `REST`
- `EVALUATION`
- `REPORT`
- `DONE`

分阶段模式在阶段边界使用 `READY` 和下一 Stage 表达稳定等待，不占用唯一活跃执行。Pipeline 在成功提交一个阶段后自动抢占下一阶段。

Analysis 是报告完成后的独立 Case 级流程，不作为 Run Stage。

同一时刻只允许一条 Run Log 为 `RUNNING`。SQLite 使用部分唯一索引和条件更新共同保证，进程内 Mutex 只用于减少冲突，不作为唯一正确性保障。

合法状态转换：

1. 创建运行：写入 `READY/REST`。
2. 启动阶段：`READY/<current stage>` 条件更新为 `RUNNING/<current stage>`。
3. REST 成功收口：提交全部真实 Case Results，转为 `READY/EVALUATION`。全部 REST Error 仍使用相同转换。
4. Evaluation 成功收口：保存规范化 Eval Results，转为 `READY/REPORT`。全部 REST Error 时本阶段不启动 Promptfoo，只生成 Not Evaluated Results。
5. Report 成功收口：无错误转为 `COMPLETED/DONE`，存在 REST、Eval Error 或 Not Evaluated 转为 `COMPLETED_WITH_ERRORS/DONE`。
6. Pipeline 模式在一个阶段提交后自动尝试下一次 `READY -> RUNNING` 抢占；抢占失败不伪造状态。
7. 用户取消：仅 `RUNNING` 可条件更新并最终收敛为 `CANCELLED/DONE`。
8. 系统错误：当前 `RUNNING` 收敛为 `FAILED/DONE`，保留已真实提交的阶段事实。
9. 进程恢复：遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`。
10. 离线完整报告导入：在单一事务中直接建立 `COMPLETED/DONE` 或 `COMPLETED_WITH_ERRORS/DONE`，不伪造中间运行过程。

终态不可重新进入 READY 或 RUNNING。非法转换返回稳定错误 `RUN_STATE_CONFLICT`。所有转换必须同时校验 Status、Stage 和 Lock Revision。

## 9. Work Package 协议

### 9.1 不可变输入

`manifest.json` 保存：

- Package Schema Version。
- Package ID。
- Source Suite ID 和 Suite Hash。
- Case Base Hashes。
- 配置和 Prompt Hashes。
- Promptfoo 和生成 Contract Version。
- 各阶段 Required Env Keys。
- Run/Analysis Execution Limits 的导出默认值与允许范围。
- 输入文件清单和 Hash。

Work Package v1 在 Contracts 阶段一次冻结完整协议，首版即包含 Tests、Endpoint、Evaluator、Analyzer、Rubric Prompts、Analysis Prompt、REST/Eval/Report/Analysis Env Keys、最终阶段依赖图和全部 Artifact 文件槽位。后续阶段只注册能力和写入产物，不修改 v1 Schema。

Manifest 创建后不可修改。阶段状态不能写回 Manifest，避免自引用 Hash 变化。

### 9.2 可变执行状态

每个 `executions/<execution_id>/execution.json` 保存 Execution ID、冻结的 Run/Analysis Execution Limits、Execution Context Hash、阶段状态、时间、Error Code 和输出文件 Hash。Manifest 保存导出默认值与允许范围；CLI 在创建 Execution 时显式传入或采用默认值，首个阶段开始后不可修改。

同一工作包每次新执行生成新 Execution ID。成功提交的阶段产物不可覆盖；重建、失败重跑或强制重跑都必须创建新的 Execution。

### 9.3 文件结构

输入包括 Tests、Endpoint、Evaluator、Analyzer、Rubric Prompts、Case Analysis Prompt 和 `.env.example`。

每次执行的输出保存在 `executions/<execution_id>/`，分为：

- REST Results。
- Raw Promptfoo Evidence。
- Normalized Eval Results。
- Report JSON。
- Report Markdown。
- Analysis Results。

平台只导入规范化事实。Raw Promptfoo 只用于排障。

### 9.4 文件安全和并发

- 根目录和临时目录使用当前用户权限。
- 普通文件仅当前用户可读写。
- 所有相对路径先规范化并确认仍位于工作包根目录。
- 禁止绝对路径、`..` 和符号链接逃逸。可信内联 Assertion 不是工作包文件；`file://` 外部代码、外部模块和额外依赖被 Schema 拒绝。
- 写入先落临时文件，Flush 后原子 Rename。
- 同包使用跨进程 Lock File 或原子独占文件。
- 锁记录 PID、Execution ID 和开始时间。
- 遗留锁只有在确认进程不存在且状态可恢复时才能清理。
- 不同工作包允许并行。
- 后续阶段只能追加当前 Execution 尚未完成的产物。
- `--force` 创建新的 Execution 并全量执行，不提供覆盖已完成阶段的语义。

### 9.5 Secret

配置中的 Secret 统一表示为 `EnvSecretRef`。Manifest 按 REST、Eval、Analyze 阶段保存所需 Key 名称。

`.env.example` 只保存空值 Key 和说明。实际 `.env`、进程环境和展开 Secret 不进入工作包 Hash、导入内容、日志或报告。

## 10. 资源写入

### 10.1 CaseDefinitionWriter

全量导入、手工创建、手工编辑、接受建议和编辑后接受共用同一写入流程：

1. 校验 Case Definition 和禁止字段。
2. 解析 Rubric Prompt Keys。
3. 校验全部 Prompt 引用。
4. 计算筛选派生字段和 Definition Hash。
5. 写入 Test Case。
6. 重算 Test Suite Count 和 Hash。
7. 提交前对账。

任一步失败整笔回滚。

### 10.2 Prompt 删除和 Key 修改

Rubric Prompt 被当前 Case 引用时拒绝删除或修改 Key。

Case Analysis Prompt 不被 Case Definition 直接引用。分析开始时在短事务中读取并冻结所选 Prompt；删除与冻结并发时只允许一方基于完整事实成功。历史分析依赖 Snapshot，不依赖当前记录。

### 10.3 资源删除与冻结

运行冻结在一个短读事务中读取测试集、Cases、Endpoint、Evaluator 和 Rubric Prompts。Analyzer 与 Case Analysis Prompt 由后续分析请求单独冻结。

冻结后外部执行只使用 `FrozenExecutionContext`。资源删除和运行冻结并发时，只允许一方基于完整事实成功，不拼接不同时间的数据。

## 11. REST 执行

REST Executor 只接受已校验 Endpoint 和 Frozen Cases。

Endpoint 只支持 `POST`，不跟随 Redirect。允许固定 Host 的 HTTP/HTTPS；禁止 User Info 和 Fragment。单 Case 请求体最大 5 MiB、响应体最大 10 MiB，读取过程受控计数，超限不截断、不生成 Provider Output。超时默认 60 秒，范围 100 毫秒至 10 分钟。

错误类型固定为：

- `TIMEOUT`
- `NETWORK`
- `HTTP_STATUS`
- `RESPONSE_PARSE`
- `PROVIDER_OUTPUT_INVALID`
- `TEMPLATE_INPUT`
- `CANCELLED`

HTTP 2xx 且 Provider Output 合法视为 REST `SUCCEEDED`，包括业务 `ok=false`。

并发限制只控制当前 Run 内请求数。取消后停止派发，已派发请求等待完成或由 Abort Signal 终止。任一 Worker 的逐 Case 结果回调失败时，Executor 立即停止领取新 Case、Abort 其他在途请求并等待全部 Worker 退出，随后才向 Run Owner 返回原始失败；边界忽略 Abort 时也不能让 Worker 脱离 Owner。

平台可以增量提交已完成 Case Result，但 REST 阶段完成标记必须在所有已派发请求收口并对账后提交。

REST 不自动重试。失败重跑创建新 Run/Execution，复用来源成功事实；`--force` 在新身份下重新执行全部 Cases。

平台 `RetryRunFailed` 和离线 `--retry-failed` 使用同一选择规则：复制 REST `SUCCEEDED`；重新请求 REST `ERROR`；复制与复用 REST 事实对齐的 Eval `PASS/FAIL`；重新评估 `EVALUATION_ERROR`、缺失 Eval 事实，以及 REST 重试后新成功的 `NOT_EVALUATED`。REST 重试仍失败的 Case 保持 `NOT_EVALUATED`。新运行记录每条复用 Provenance 并重新生成 Result Set Hash。`ForceRun`/`--force` 使用来源冻结上下文重新执行全部 REST 和 Eval。

## 12. Promptfoo 执行和导入

### 12.1 配置生成

生成器从 Frozen Execution Context 物化：

- REST 成功 Cases 的 Tests JSON。
- 本机 Evaluator Bridge 的临时 HTTP Provider 配置。
- 引用的 Rubric Prompt 文件。
- 受控 Promptfoo Config。

Secret 只在子进程启动前注入环境，不写入生成文件。

Promptfoo 主 Provider 始终使用 Echo 和预计算 Provider Output。需要 Provider 的 Assertion 统一调用仅绑定随机回环端口的 Evaluator Bridge；Bridge 通过一次性 Capability、Run/Execution 身份、请求 Schema、调用预算、并发和超时限制请求，只能调用冻结的统一 Gemini/OpenAI-compatible SDK Adapter，不能转发任意 Provider、Model、URL、Header 或 Secret。

### 12.2 子进程

- 使用固定可执行文件和参数数组，不启用 Shell。
- 校验 Promptfoo 实际版本。
- 禁用 Share 和非必要本地持久化。
- 显式写 Raw JSON Output。
- 记录安全 Exit Code、耗时和文件 Hash。
- Promptfoo HTTP Provider、Evaluator Bridge 和官方 SDK 都显式关闭重试。
- 取消时先发送 `SIGTERM`，5 秒未退出再发送 `SIGKILL`，随后关闭 Bridge 并回收临时资源。

Assertion 失败对应的 Promptfoo 原始退出码 `100` 是评估事实，CLI Adapter 对外映射为退出码 `1`。进程启动、配置、信号、文件和未知格式错误才是系统错误。该事实由固定版本真实进程探针验证，不从自然语言输出推断。

### 12.3 Importer

Importer：

1. 校验顶层版本和 Schema。
2. 按 Case Key 与 Ordinal 对齐。
3. 按 Assertion Index 和 Definition Hash 对齐组件结果。
4. 提取 Pass、Score、Reason、Metric、Weight、Token、Latency 和 Cost。
5. 对失败 `is-json` 生成解释性 Diff。
6. 生成 Case Metric Results。
7. 丢弃不稳定和敏感字段。
8. 为 REST Error Case 生成 `NOT_EVALUATED`。
9. 所有规范化 Eval、Assertion、Diff 和 Metric 事实稳定后，生成 Eval Result Hash 和 Final Case Result Hash。

未知结构、重复 Case、错位组件或无法可靠识别聚合状态时拒绝完整导入。

## 13. 报告设计

### 13.1 稳定结果

Reporting 只读规范化 Case Result 和 Eval Result，不读取 Raw Promptfoo 内部结构，也不回写 Eval Result。Assertion Diff 和 Case Metric 已由 Importer 在计算 Eval Hash 前生成。

Report JSON 包含：

- 运行身份和脱敏上下文。
- Case、REST 和 Eval 计数。
- 整体有效通过率、已评估通过率和覆盖率。
- By Metric 统计。
- 逐 Case REST、Eval、Assertion 和 Diff 结果。
- Result Set Hash 和 Contract Version。

### 13.2 Metric 聚合

Case 内同名 Metric 聚合优先级：`FAIL`、`ERROR`、`PASS`、`SKIPPED`、`NOT_EVALUATED`。

一条 Case 对同名 Metric 最多贡献一次。By Metric Rate 只使用 PASS 和 FAIL 作为分母，其他状态单独计数。

### 13.3 JSON Schema Diff

对失败 `is-json` Assertion，使用锁定版本的 JSON Schema Validator 基于冻结 Schema 和 Provider Output 重新生成解释性 Diff：

- Instance Path。
- Schema Path。
- Keyword。
- Expected Constraint。
- Actual Value 或 Missing。
- Reason。

Diff 保存 Validator Version、Schema Dialect 和 Diff Contract Version。

Promptfoo Pass/Fail 是评估事实。Diff 只解释失败，不能修改状态。Validator 与 Promptfoo 判定不一致时保留 Promptfoo 状态并记录解释性差异 Error Code。

### 13.4 Markdown Renderer

Markdown 从 Report DTO 单向生成，面向 CLI 阅读，包含总体统计、By Metric、失败 Case 摘要、Assertion 预期/实际差异和 LLM Rubric Reason。

Markdown 不可反向解析为平台事实。

## 14. Case 分析设计

### 14.1 Prompt 模板

Case Analysis Prompt 允许简单变量：

- `case_definition`
- `provider_output`
- `failed_assertions`
- `expected_actual_diffs`
- `llm_rubric_results`
- `run_context`

模板语法只允许完整变量占位，不允许过滤器、函数、任意路径或代码。保存时扫描并校验引用，执行时对结构化 JSON 统一序列化。

### 14.2 输入身份

先构造版本化 `AnalysisInput`：

- 实际使用的完整结构化变量。
- Final Case Result Hash。
- 脱敏 Run Context。
- Diff Contract Version。
- Analysis Input Contract Version。

再计算 Analysis Input Hash，并组合：

- Analysis Prompt Hash。
- Analyzer LLM Config Hash。
- Analysis Output Contract Version。

Analyzer LLM 和 Case Analysis Prompt 在发起分析时选择。分析发生在报告之后，不进入原 Run Snapshot，也不修改原 Run Context Hash。

### 14.3 输出契约

分类固定为：

- `LABEL_ERROR`
- `ADDITIONAL_VALID_RESULT`
- `NORMAL_FAILURE`
- `PARAMETER_VARIANCE`

`PARAMETER_VARIANCE` 表示工具参数存在语义等价表达，不代表重复执行或统计波动。

输出必须包含 Classification、Confidence、Evidence、Explanation 和 Recommended Action，可选包含一个 Proposal。

Proposal 是判别联合：

- `REPLACE_CASE`：Base Definition Hash 和完整 Case Payload。
- `ADD_ASSERTION`：插入位置和 Assertion Payload。
- `REPLACE_ASSERTION`：目标 Assertion Index、目标 Definition Hash 和新 Payload。
- `REMOVE_ASSERTION`：目标 Assertion Index 和目标 Definition Hash。

动作、目标身份和 Payload 必须一致。一次分析最多保存一个 Proposal，不同时保存完整 Case 与独立 Assertion 两套建议。

模型响应在保存前经过严格 Schema 校验。Confidence 是模型自评数值，不作为统计概率。

### 14.4 建议应用

建议应用由 Application 跨聚合协调。锁顺序为 Case Analysis、Test Suite、Test Case、相关 Rubric Prompts。

校验 Final Result、Analysis Revision、Base Definition 和 Prompt 引用后，统一调用 CaseDefinitionWriter。冲突时保存 `CONFLICT`，不自动合并。

Analysis Status 为 `PENDING | RUNNING | SUCCEEDED | ERROR`。Decision 为 `NO_PROPOSAL | PENDING | ACCEPTED | REJECTED | EDITED_AND_ACCEPTED`。Apply Status 为 `NOT_APPLICABLE | NOT_APPLIED | APPLIED | CONFLICT`。

合法转换：

1. 新建或重新分析进入 `PENDING`，抢占后进入 `RUNNING`。
2. 模型或契约失败进入 `ERROR`，Decision 为 `NO_PROPOSAL`，Apply Status 为 `NOT_APPLICABLE`。
3. 成功且无 Proposal 进入 `SUCCEEDED/NO_PROPOSAL/NOT_APPLICABLE`。
4. 成功且有 Proposal 进入 `SUCCEEDED/PENDING/NOT_APPLIED`。
5. 只有 `SUCCEEDED/PENDING` 可以转为 Rejected、Accepted 或 Edited And Accepted。
6. 应用成功写 `APPLIED`；输入或目标冲突写 `CONFLICT`。
7. 重新分析使用 Analysis Revision 条件更新，递增 Revision 并清除旧决策。

## 15. API、UI 和 CLI

### 15.1 API

主要资源：

- `/test-suites`
- `/test-cases`
- `/endpoint-configs`
- `/llm-configs`
- `/llm-rubric-prompts`
- `/case-analysis-prompts`
- `/runs`
- `/runs/:id/cases`
- `/runs/:id/analysis`
- `/runs/:id/retry-failed`
- `/runs/:id/force`
- `/work-packages/export`
- `/executions/import`

列表使用不透明版本化 Cursor 分页，默认 50、最大 200。稳定排序必须包含内部 ID Tie-breaker；Case 默认使用 Ordinal。字段间过滤为 AND，同字段多值为 OR，文本搜索使用转义后的大小写不敏感字面子串，其他筛选使用精确成员。大 JSON 只在详情返回。写请求返回稳定 Error Code 和字段路径。

API 固定前缀为 `/api/v1`，同源默认地址为 `127.0.0.1:4310`。Fastify Schema 生成并提交 OpenAPI JSON。能力采用阶段注册：未闭环的 Run、Eval、Report 或 Analysis Route 不存在于 OpenAPI。

P3 当前只注册 Test Suite、Case、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的资源 CRUD、Case 导入导出、配置验证与 Prompt 预览/引用查询。请求与成功响应均由严格 Zod DTO 投影为 Runtime/OpenAPI Schema；Host/Origin 拒绝可能发生在所有 Route，因此所有操作均声明闭合 403 响应。Case 导入逐项流式校验并写入独立 SQLite staging 文件，multipart 截断事实作为定义流结束条件参与最终提交，随后才在主库同一连接的短事务中整体替换；staging 不是业务表，失败、取消和完成后均按 owner 身份清理。Case 导出先把固定 Suite Revision 的 JSON 流写入 owner-only `0600` 临时文件，完整一致性校验成功后才打开 200 响应；正常完成、取消和准备失败均按 owner 身份清理，内存只保留单 Case 或流缓冲块。SQLite 在创建状态/db 目录或打开数据库前验证 `.cortex-eval`、`db` 与现有数据库/WAL/SHM 不是符号链接并保持 canonical 项目 containment；临时根执行相同约束。无 owner 的新目录未过 TTL 时视为可能仍在初始化，不隔离。

P5 当前注册 Run 预检、创建、倒序分页、详情、逐 Case REST 结果、REST 启动、取消和有限期 SSE 进度。Start/Cancel 使用 Run Revision 条件写并返回小型 `RunProgress`；Run Detail 使用不含冻结 Case 数组和 Prompt 正文的有界投影；逐 Case 写入、轮询和 SSE 只读取小型进度投影，不反复反序列化完整冻结输入。REST Artifact 按结果 Cursor 单遍流式写入并增量计算文件 Hash 与 Result Set Hash，不聚合完整结果数组。SSE 先校验 Run，再以 `text/event-stream` 发送当前 Snapshot，并从独立 SQLite 查询观察 Revision 变化；开流前的 400/403/404/500 保持普通 JSON 错误响应，开流后的轮询、Schema 或写入失败由 Route 结束响应并释放连接，不向已 Hijack 的响应改写 JSON。当前只允许启动 `READY/REST`，REST 提交后停在 `READY/EVALUATION`。一键自动推进、Evaluation、Report、Analysis、Retry/Force 和 Execution Route 均不注册。

### 15.2 Web

Web 使用 shadcn/ui Primitive 构建 Table、Form、Dialog、Sheet、Tabs、Badge、Progress、Alert 和 Toast。

TanStack Query 管理服务端缓存和失效；TanStack Table 管理表格状态；过滤和分页参数由 URL 或 Feature State 显式保存。

页面刷新后通过 API 恢复当前事实，不依赖浏览器内存维持运行。

Web 使用简体中文、浅色本地实验室仪表台视觉和桌面优先布局，只正式验收 1440×900 与 1280×800，并满足 WCAG 2.2 AA。Feature 只在对应后端闭环完成时注册导航和 Dashboard 卡片。

P4 当前注册 Dashboard 资源数量、Test Suite/Case 管理、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 配置页面。Case 结构化编辑与完整 JSON 共享同一已校验 Draft，Assertion 保留完整闭合 JSON；默认每页 50 条，筛选和 Cursor 历史写入 URL。资源写入或删除发生 409 时先读取最新服务端 Snapshot，保留本地意图，并由用户显式选择最新 Revision 重试或采用 Snapshot；Case 编辑 Snapshot 与可见 Draft 分离，冲突待决时不重挂编辑器。若刷新得到稳定 `CASE_NOT_FOUND`，则进入显式 `REMOTE_CASE_DELETED` 状态，不构造 Case Revision：编辑流程先禁用详情 Query，再移除精确详情缓存并刷新 Suite/列表，持续只读展示本地 Draft；删除流程保留确认 Dialog。两者都没有重试动作，只能显式采用远端删除事实后关闭并解除离开门禁。该规则覆盖 Suite 元数据与删除、Case 编辑/创建/复制/删除/导入和四类配置的保存与删除，连续冲突每次重新读取事实，采用 Snapshot 后下一次写入使用其 Revision。Suite 创建/元数据、Case 非编辑写操作、Case 编辑和配置探测、预览、保存使用同步单飞锁，请求在途或冲突待决时冻结对应编辑面并阻止关闭编辑容器。页面级离开门禁同时拦截关闭按钮、Esc、侧栏、应用内返回、浏览器前进后退和页面卸载；应用 History 条目保存单调位置，受阻的已知条目遍历用 `history.go` 回到原位置，不追加条目或截断前进栈；从前进或后退进入第三方或旧版未知 State 时，以 `Navigation.currentEntry.index` 的同源绝对索引恢复原位置。只有写入结束、用户显式完成 Draft/Snapshot 决策，或互斥写入已经成功提交后，应用壳层才恢复或执行导航。配置重试在途仍保留冲突决策，操作层同时拒绝重复决策。Test Suite 删除影响预检本身单飞并占用页面写槽，期间禁用其他 Suite/Case 写入口；其他写入待决时反向禁用删除入口。Suite Snapshot 同步详情与所有已加载 Suite 列表；Case Snapshot 在显式采用前只同步 Case 列表，采用后再替换可见详情；缺少具体 Case Snapshot 时使 Case 列表失效重取。配置保存和删除冲突都同步详情与已加载的同类列表 Query，关闭重开或放弃删除不回退旧 Snapshot。Case 删除移除精确详情缓存，全量导入移除该 Suite 全部 Case 详情缓存；Test Suite 删除移除其详情和全部 Case Query，配置删除移除精确详情 Query，再刷新存活的 Dashboard 与列表。导入关闭、成功或放弃时同步清空原生文件输入，允许再次选择同一文件；导入和删除请求在途或冲突待决时取消按钮禁用。新建 Endpoint 默认 60 秒，新建 LLM 默认 `JSON_OBJECT`；Case Analysis Prompt 从 Contracts 闭合枚举展示六个允许变量。API Client 对成功与错误响应执行 Contracts 校验，取消收敛为稳定客户端错误；Case 和配置本地 Contracts 路径先映射到真实结构化字段、动态 Header、Provider 分支或 Prompt 消息控件，所有 Select 暴露焦点引用，`RUBRIC_PROMPT_IN_USE` 保留 Prompt Key 并映射到 `promptKey` 字段。探测、模板变量和其他字段失败在当前 Sheet/Dialog 内关联并聚焦最近的表单、结构化或完整 JSON 编辑器，请求锁释放后再恢复焦点；Suite 创建/编辑和批量导入错误同样保留字段路径、顺序与 Case ID。Rubric 引用读取在完成前不伪装为空集合，失败时提供显式重试；删除目标切换通过 Abort 与请求代次门禁拒绝迟到结果。

P5 增加 `/runs` 与 `/runs/:id` 页面、Run 导航、Dashboard 最近平台 Run 卡片和测试集列表最近平台 Run 状态。创建页先读取资源候选，再以预检事实展示 Case 数、Rubric 依赖、所需 Env Key、超时和将被冻结的并发限制；选择改变、重新预检或组件卸载会 Abort 旧请求，并以选择代次拒绝迟到响应。重新预检会先失效上一代事实，新请求在途或失败时保持创建门禁；只有当前选择与当前代对应的成功预检后才能创建。创建响应除 Schema 外还必须匹配请求固定的 Suite、Endpoint、Evaluator、Run Mode 和显式执行限制。详情页以服务端 Run Detail 为事实源，启动与取消携带最新 Revision，运行时同时使用有限期 SSE 和查询刷新，流重连或协议错误只触发重新读取事实。页面只展示 REST 计数、真实逐 Case 结果和冻结摘要，不显示 Evaluation、Report、Analysis、Retry/Force 或一键执行动作。

Case 编辑使用显式 Session 同时冻结初始 Definition、Case Revision 与 Suite Revision。每次打开必须等待该 Case 本次详情 Query 成功且身份匹配；刷新失败时即使 Query 保留旧 data，也只展示读取错误。API Client 在 Zod 校验后通过请求上下文验证器继续约束请求已固定的身份：Suite 读取/更新匹配 ID；Case 列表、读取、创建、更新、复制和导入匹配 Suite、目标 Case Key 与 Definition Case ID；配置列表、读取、创建和更新匹配 Kind 及已固定的 ID。首次读取、普通写入和冲突刷新都拒绝契约有效但身份错配的响应，错误事实不能进入 Query 缓存、覆盖 Draft 或触发成功状态。Session 建立后不跟随后台 Query 改写，普通保存只使用 Session Revision；普通冲突显式采用服务端 Snapshot 时才创建新 Session。`REMOTE_CASE_DELETED` 保留原 Session 和同一编辑器实例，因此结构化/完整 JSON 模式、本地文本与 DOM 状态都不被重置。

非编辑 Case 恢复 Hook 是重试终态错误的唯一清洗边界，并以 `ApiClientError` 和最近 Revision Facts 回调原 owner；重试遇到非 Revision 失败时先清除旧冲突，再由创建 Sheet、复制/删除/导入 Dialog 保留输入并显示错误，删除 owner 同步最近 Case Revision。Case 编辑恢复失败使用单调 `eventId` 的一次性事件交给原 `CaseEditor`；组件按已消费 ID 去重，并与普通保存共用字段路径映射和焦点逻辑，父层显式捕获 Promise，不允许未处理拒绝。

Suite 元数据编辑 Session 把打开或显式采用 Snapshot 时的表单事实与 Suite Revision 一起冻结；普通保存不读取实时 Query Revision。Suite 删除确认由冻结的 Suite Snapshot 与随后成功读取的 Impact 组成；普通确认只用该 Snapshot Revision。删除 409 刷新按 Suite、Impact 顺序执行，只有两者都成功后才同步 Query 并原子替换确认事实；恢复 Controller 由组件托管，卸载同时 Abort 并关闭发布门禁，即使边界实现忽略 Abort 返回迟到结果，也不得继续读取 Impact 或同步 Query。预检或 Impact 刷新失败、Abort 和卸载都不发布临时 Snapshot，不允许新 Suite 与旧 Impact 组合成重试事实。

Web Client 的服务端错误码联合直接从闭合 `ApiErrorResponseV1Schema` 推导，客户端传输、协议和互斥错误码单独显式列举；禁止以任意 `string` 绕过冲突恢复分支的类型检查。

`Navigation.currentEntry.index` 是资源 Web 启动硬能力；缺少或无效时只渲染能力错误，不创建 Query 消费者、不挂载 Feature 或写入口。相邻 Test Suite 详情以 Suite ID 作为路由状态生命周期边界，切换时卸载上一 Suite 的筛选、Cursor、编辑器、冲突和请求状态。Case 创建与更新输入直接使用 Contracts Schema 推导类型，不在 Web API 契约层退化为 `unknown`。

生产页面按 Feature 动态加载，静态资源由 Local Server 同源提供。脚本 CSP 只允许 `'self'`；Zod 的 JIT 在应用模块加载前通过同源静态配置关闭，不使用 `'unsafe-eval'`。宽度小于 1024px 只显示可读提示。Report 和 Analysis 页面在对应闭环前不注册路由、导航或 Dashboard 内容。

### 15.3 CLI

平台命令通过本地 API 导出工作包和导入结果。

离线命令调用工作包阶段 Use Case，不与 HTTP Endpoint 一一对应。CLI 与 API 共享结果 DTO、Error Code 和阶段语义，但文件交互与 HTTP 交互保持独立。

CLI 用户文案从消息资源加载。`--json` 使用 NDJSON，stdout 只输出机器协议，诊断写 stderr；普通模式输出中文进度和结果路径。退出码固定为 0 成功、1 Eval Fail、2 输入/配置错误、3 外部或阶段系统错误、4 冲突/锁、130 取消。

离线 Pipeline 在 P9 注册 Analysis 阶段。选择 Analysis 时必须存在 Report Artifact 或同时选择 Report，并提供 Analyzer、Analysis Prompt 和 Case Selector。依赖缺失属于输入错误；Analysis 调用失败返回退出码 3，但不回滚或改变已经完成的 Report Artifact。无可分析 Case 时写入零结果成功事实。

## 16. 并发、取消和恢复

- SQLite 部分唯一索引保证全库最多一条 `RUNNING` Run。
- 阶段启动通过条件更新从 `READY` 抢占为 `RUNNING`。
- 阶段完成通过 Status、Stage 和 Lock Revision 条件提交。
- 取消和最终提交竞争时，只允许先完成条件更新的一方生效。
- READY 阶段不占用全局执行锁。
- Work Package 使用跨进程文件锁。
- 外部调用不持有 SQLite 事务。
- 应用启动把遗留 `RUNNING` 收敛为 `INTERRUPTED`。
- 强制终止遗留临时目录只按固定前缀和 TTL 清理。
- Pipeline 默认 REST、Evaluation、Report，也可显式设置满足依赖的阶段列表；Analysis 只有显式选择范围时执行。
- 平台 Create Run API 接受 `RunExecutionLimitsV1`，默认 REST 取 Endpoint 值、Eval 为 2；平台 Analyze API 接受 `AnalysisExecutionLimitsV1`，默认 1。离线 CLI 在创建 Execution 时接受两类限制。冻结值分别控制 REST、Promptfoo/Bridge 和 Analysis 的最大在途数，平台与离线使用相同契约。

## 17. 安全边界

- 默认监听 `127.0.0.1`。
- 校验 Host 和 Origin。
- Secret 只从环境读取。
- Endpoint、Evaluator 和 Analyzer 使用统一 EnvSecretRef。
- Endpoint Literal Header 只允许固定安全列表；其他 Header 必须使用 EnvSecretRef。
- Endpoint URL 禁止 User Info 和敏感 Query Literal。
- LLM Options 使用 Provider 白名单并递归拒绝 Secret 字段。
- API、Snapshot、Work Package 和日志不包含展开 Secret。
- 外部 JSON、URL Template 和 Body Selector 在边界校验。可信内联 Assertion、Transform 和 Context Transform 交给锁定版 Promptfoo 执行，不做检测、警告或沙箱承诺。
- Promptfoo 仅使用受控配置、Echo Provider 和应用生成路径。
- 子进程禁用 Shell。
- 工作包和临时文件使用最小权限。
- 日志不记录完整 Case、Vars、Provider Output、Prompt 或第三方堆栈。

## 18. 日志和观测

中文业务事件包括：

- 运行输入已冻结。
- REST 阶段已开始/完成。
- 评估阶段已开始/完成。
- 报告已提交/对账失败。
- 运行取消已请求/完成。
- 工作包已导出/校验失败。
- 离线结果已导入/重复导入。
- Case 分析已保存/已过期。
- 分析建议已应用/发生冲突。
- 临时资源清理失败。

日志包含 Run ID、Package ID、Execution ID、Case Key、安全状态、Error Code 和耗时，不包含敏感正文。内部事件结构化，落盘和控制台使用单行中文可读文本；单文件 10 MiB 轮转并保留最近 10 个文件。日志写入失败只向 stderr 输出脱敏降级提示，不改变业务事实。

## 19. 测试策略

### 19.1 Domain

- Case、Assertion、Provider Output 和 Prompt 变量规则。
- 状态机、统计、Metric 聚合和 Hash。
- 四种分析分类契约和建议冲突规则。
- 不测试 Prompt 具体文案和具体配置值。

### 19.2 架构边界

- Package 依赖方向。
- Domain 无外层依赖。
- Web 不依赖 Domain/Storage。
- Route 和 CLI 不包含业务规则。
- 生产源码不引用 Test Support。
- `apps`、`packages` 与 `tooling` 中 TypeScript/TSX 源码和测试单文件最多 1,000 个物理行，超限先按职责拆分。

### 19.3 SQLite Repository

- 十表约束、Migration、索引和删除策略。
- CaseDefinitionWriter 原子写入。
- 唯一活跃 Run 的双进程竞争。
- 阶段条件提交、取消竞争和恢复。
- Execution ID 幂等导入。

### 19.4 Work Package

- Manifest 不可变和文件 Hash。
- Execution 状态和原子写入。
- Env Key 分阶段校验。
- 路径与符号链接逃逸。
- 同包双进程锁、遗留锁恢复和已完成 Execution 不可覆盖。
- 不同工作包并行。

### 19.5 REST

- HTTP、网络、超时、解析和 Provider Output 错误。
- 合法 `ok=false`。
- URL Template、Body Selector 和 EnvSecretRef。
- 部分和全部失败、取消和并发限制。

### 19.6 Promptfoo 契约

- 精确版本检查。
- Echo Provider 和预计算 Provider Output。
- 能力矩阵中全部 Assertion 的正例、非法 Payload 或能力错误和 Importer 对齐。
- 可信内联 JavaScript、Python、Ruby、Transform、Context Transform 和嵌套 Assertion Set 的真实进程执行。
- `file://`、外部模块、额外依赖、Provider 覆盖和 Bridge 滥用的稳定拒绝。
- Assertion Component 对齐。
- Assertion 失败退出码与系统失败区分。
- 当前真实 Fixture 完整导入。

### 19.7 Reporting

- Case 和 By Metric 统计。
- 同 Case 同 Metric 只计一次。
- JSON Schema Diff 的 Const、Contains、Required、AllOf 等真实结构。
- Validator 与 Promptfoo 不一致时不改变评估事实。
- JSON Report 和 Markdown Renderer。

### 19.8 Analysis

- Prompt 变量白名单。
- Analyzer 错误和输出 Schema。
- Analysis Input Hash。
- Parameter Variance 语义契约。
- Current Case 漂移和建议应用冲突。

### 19.9 API、CLI 和 Web

- API Cursor 分页和稳定错误。
- CLI 分阶段、一键流程和结果导入。
- UI Case CRUD、搜索、过滤和分页。
- UI 分阶段执行、中间 REST 结果、报告和分析修改闭环。
- 页面刷新、取消和错误状态。

### 19.10 性能

- 千级 Case 导入和全量 Hash。
- 常用 Case 搜索和组合过滤。
- REST 进度批量提交。
- 千级报告聚合和 Markdown 生成。

固定 1,000 Case、Node 24、本地磁盘，参考环境为至少 4 个逻辑核和至少 8 GiB 可用内存的 macOS ARM64，不做人工资源限速并记录实际硬件。独立门禁为：测试集导入不超过 10 秒；查询预热后 p95 不超过 250 毫秒且 p99 不超过 500 毫秒；报告与 Markdown 不超过 5 秒；Work Package 导出不超过 10 秒；Execution Result 导入不超过 10 秒；目标尺寸关键列表页可交互不超过 2.5 秒。测量协议、样本次数和环境信息由 `tasks/P10_FINAL_HARDENING.md` 固定。

## 20. 实现阶段

Goal 的可执行单一入口为 [tasks/00_INDEX.md](tasks/00_INDEX.md)。阶段按 P0–P10 顺序推进，每阶段先测试、再实现、再运行完整相关门禁并更新 spec。

原 M1–M6 范围保持不变：M1 对应 P1–P2，M2 对应 P3–P4，M3 对应 P5–P7，M4 对应 P8，M5 对应 P9，M6 对应 P10；P0 是正式实现前的事实源和契约基线。

- P0：同步事实源，建立工具链、Promptfoo 契约探针、全 Assertion 能力矩阵和性能 Harness。
- P1：冻结 Contracts、Domain、Evaluator Bridge、Work Package v1 和 Canonical Export v1。
- P2：实现十表 SQLite、Application 基础、Artifact 元数据、删除与冻结一致性。
- P3：实现 Local API、资源管理、OpenAPI、日志与 SSE 基础，不提前注册 Run Route。
- P4：实现简体中文资源 Web、Case 双编辑器、配置页面和可访问性。
- P5：实现 Run 与 REST 闭环，只注册 REST 能力。
- P6：实现 Promptfoo Evaluation、Evaluator Bridge 和全 Assertion 契约，注册 Eval 能力。
- P7：发布完整 Work Package v1、REST/Eval CLI、失败重跑、`--force` 和结果导入基础；Report 导入入口在 P8 注册。
- P8：实现 Reporting、Markdown 和报告 UI/CLI，扩展 Pipeline 到 Report。
- P9：实现 Analysis、Proposal 应用和工作包分析闭环。
- P10：实现 Canonical Export、迁移边界文档、性能、安全、真实 Gemini 和最终文档验收。

## 21. 生效决策

- 当前使用单文件 SQLite，不要求本地 PostgreSQL。
- 当前只支持并验证 macOS ARM64、Node 24 LTS。
- 数据库保持十张职责明确的业务表。
- REST Result 和 Eval Result 分表保存不同阶段事实。
- Case Analysis Prompt 单独建表。
- UI 使用 shadcn/ui。
- UI 使用简体中文、浅色桌面优先设计并满足 WCAG 2.2 AA。
- UI 支持分阶段和一键执行。
- CLI 按不可变离线工作包设计，不直接访问平台 SQLite。
- 工作包不导出任何 API Key，只导出 Env Key 名称和 `.env.example`。
- Promptfoo 是固定版本外部执行器，不是业务事实源。
- Promptfoo 固定为 `0.121.18`，支持能力矩阵中的全部 Assertion；内联可执行 Assertion 默认可信，不检测、不提示、不沙箱。
- Provider 只支持统一接口下的 Gemini 和 OpenAI-compatible Chat Completions，所有调用不自动重试。
- Provider-dependent Assertion 通过本机临时 Evaluator Bridge 使用 Run Evaluator，不能内嵌独立 Provider 或 Secret。
- REST Endpoint 只支持 POST；失败重跑和 `--force` 创建新 Run/Execution，不覆盖来源。
- 运行数据默认位于项目根 `.cortex-eval/`，Local API 固定前缀 `/api/v1`。
- Raw Promptfoo、Normalized Eval、JSON Report 和 Markdown Report 分离。
- Case 参数波动是单次结果下的语义等价判断，不自动重复执行。
- 同一时刻只允许一个平台阶段运行，同一工作包只允许一个 CLI 写进程。
- 未来 PostgreSQL 迁移使用版本化导出 DTO，不承诺只替换数据库 Adapter。
